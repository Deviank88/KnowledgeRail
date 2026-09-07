import { posix } from "node:path";
import { manifestStrings, manifestTable, parseManifestToml } from "../manifest-toml.js";
import type { CodeImportContext, ProjectManifest, ProjectManifestSpec } from "../types.js";
import { nearestProjectManifest } from "../project-structure.js";
import { addName, localPath } from "./paths.js";
import { literalGlob } from "../literal-glob.js";

interface PythonConfig { declared: boolean; directories: Record<string, string>; packages?: string[]; modules?: string[]; where?: string[]; include?: string[]; exclude?: string[] }
const moduleName = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u;
function config(dirs: unknown, packages: unknown, modules: unknown, find?: unknown): PythonConfig {
  const directories = manifestTable(dirs), discovery = manifestTable(find);
  if (Object.entries(directories).some(([name, value]) => (name !== "" && !moduleName.test(name)) || typeof value !== "string" || !localPath(".", value))) {
    throw new Error("Invalid Python package directory.");
  }
  const selected = manifestStrings(packages), pyModules = manifestStrings(modules);
  if ([...(selected ?? []), ...(pyModules ?? [])].some((name) => !moduleName.test(name))) throw new Error("Invalid Python module name.");
  const where = manifestStrings(discovery.where), include = manifestStrings(discovery.include), exclude = manifestStrings(discovery.exclude);
  if (where?.some((p) => !localPath(".", p)) || [...(include ?? []), ...(exclude ?? [])].some((p) => !/^[\w.*?-]+$/u.test(p))) throw new Error("Unsupported Python discovery pattern.");
  return { declared: Object.keys(directories).length > 0 || selected !== undefined || pyModules !== undefined || find !== undefined,
    directories: directories as Record<string, string>, packages: selected, modules: pyModules, where, include, exclude };
}
const PYPROJECT: ProjectManifestSpec = { fileName: "pyproject.toml", parse(content) {
  const root = parseManifestToml(content, ["package-dir", "packages", "py-modules"].map((field) => ["tool", "setuptools", field]));
  const setuptools = manifestTable(manifestTable(root.tool).setuptools);
  const packages = setuptools.packages;
  return config(setuptools["package-dir"], Array.isArray(packages) ? packages : undefined,
    setuptools["py-modules"], !Array.isArray(packages) ? manifestTable(packages).find : undefined);
} };
const SETUP: ProjectManifestSpec = { fileName: "setup.cfg", parse(content) {
  const sections: Record<string, Record<string, string>> = Object.create(null) as Record<string, Record<string, string>>;
  let section = "", current = "";
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim() || /^\s*[#;]/u.test(line)) continue;
    const header = /^\[([^\]]+)\]\s*$/u.exec(line);
    if (header) { section = header[1]!; current = ""; sections[section] ??= Object.create(null) as Record<string, string>; continue; }
    if (section !== "options" && section !== "options.packages.find") continue;
    if (/^\s/u.test(line) && current) { sections[section]![current] += `\n${line.trim()}`; continue; }
    const pair = /^([\w-]+)\s*=\s*(.*)$/u.exec(line);
    if (!pair || Object.hasOwn(sections[section]!, pair[1]!)) throw new Error("Invalid setup.cfg option.");
    current = pair[1]!; sections[section]![current] = pair[2]!;
  }
  const options = sections.options ?? {}, discovery = sections["options.packages.find"] ?? {};
  const list = (v: string | undefined) => v === undefined ? undefined : v.split(/[\n,]/u).map((p) => p.trim()).filter(Boolean);
  const directories: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of list(options.package_dir) ?? []) {
    const match = /^([^=]*)=\s*(.*)$/u.exec(pair);
    if (!match || Object.hasOwn(directories, match[1]!.trim())) throw new Error("Invalid setup.cfg package_dir.");
    directories[match[1]!.trim()] = match[2]!.trim();
  }
  if (options.packages?.trim() === "find_namespace:") throw new Error("Implicit Python namespace packages are unsupported.");
  return config(directories, options.packages?.trim() === "find:" ? undefined : list(options.packages), list(options.py_modules), options.packages?.trim() === "find:" || Object.keys(discovery).length ? {
    ...(discovery.where !== undefined ? { where: list(discovery.where) } : {}),
    ...(discovery.include !== undefined ? { include: list(discovery.include) } : {}),
    ...(discovery.exclude !== undefined ? { exclude: list(discovery.exclude) } : {}),
  } : undefined);
} };
export const PYTHON_PROJECT_MANIFESTS = [PYPROJECT, SETUP];

export function pythonManifest(context: CodeImportContext, source: string): ProjectManifest | undefined {
  if (!context.structure) return;
  return ["pyproject.toml", "setup.cfg"].flatMap((name) => {
    const manifest = nearestProjectManifest(context.structure!, source, name);
    return manifest && (manifest.warning || (manifest.value as PythonConfig).declared) ? [manifest] : [];
  }).sort((a, b) => b.path.split("/").length - a.path.split("/").length ||
    Number(b.fileName === "pyproject.toml") - Number(a.fileName === "pyproject.toml"))[0];
}

/** Build logical module names from declared roots and verified regular packages.
 * Mapping keys can rename physical directories without leaking their basenames. */
export function pythonDeclaredNames(context: CodeImportContext, manifest: ProjectManifest): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  if (manifest.warning) return names;
  const cfg = manifest.value as PythonConfig, root = posix.dirname(manifest.path);
  const mappings = Object.entries(cfg.directories);
  if (!mappings.length) mappings.push(...(cfg.where ?? ["."]).map((dir) => ["", dir] as [string, string]));
  const isPackage = (directory: string) => context.paths.has(posix.join(directory, "__init__.py")) || context.paths.has(posix.join(directory, "__init__.pyi"));
  const includes = cfg.include?.map((pattern) => literalGlob(pattern, { questionMark: true }));
  const excludes = cfg.exclude?.map((pattern) => literalGlob(pattern, { questionMark: true }));
  for (const path of context.paths) {
    if (!/\.pyi?$/u.test(path) || pythonManifest(context, path)?.path !== manifest.path || (path.endsWith(".pyi") && context.paths.has(path.slice(0, -1)))) continue;
    for (const [prefix, dir] of mappings) {
      const base = localPath(root, dir); if (base === undefined) continue;
      const relative = posix.relative(base, path);
      if (relative.startsWith("../") || relative === "..") continue;
      const pieces = relative.replace(/\.pyi?$/u, "").split("/");
      if (pieces.at(-1) === "__init__") pieces.pop();
      const name = [prefix, ...pieces].filter(Boolean).join(".");
      if (!moduleName.test(name) || (prefix && !isPackage(base))) continue;
      let valid = true;
      const directories = posix.relative(base, posix.dirname(path)).split("/").filter((p) => p && p !== ".");
      for (let n = 1; n <= directories.length; n++) if (!isPackage(posix.join(base, ...directories.slice(0, n)))) valid = false;
      if (!valid) continue;
      // More specific mappings replace parent mappings for that logical package.
      if (mappings.some(([other]) => other.length > prefix.length && (name === other || name.startsWith(`${other}.`)))) continue;
      const packageName = /\/__init__\.pyi?$/u.test(`/${path}`) ? name : name.split(".").slice(0, -1).join(".");
      if (cfg.packages && !cfg.packages.includes(packageName) && !cfg.modules?.includes(name)) continue;
      if (cfg.modules && !cfg.packages && !packageName && !cfg.modules.includes(name)) continue;
      if (includes && !includes.some((matches) => matches(packageName))) continue;
      if (excludes?.some((matches) => matches(packageName))) continue;
      addName(names, name, path);
    }
  }
  return names;
}
