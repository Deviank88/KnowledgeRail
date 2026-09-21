import { posix } from "node:path";
import { manifestStrings, manifestTable, parseManifestToml } from "../manifest-toml.js";
import type { CodeImportContext, ProjectManifest, ProjectManifestSpec } from "../types.js";
import { nearestProjectManifest } from "../project-structure.js";
import { addName, localPath } from "./paths.js";
import { literalGlob } from "../literal-glob.js";
import { dependencyNames } from "./classification.js";

interface PythonConfig { declared: boolean; directories: Record<string, string>; packages?: string[]; modules?: string[]; where?: string[]; include?: string[]; exclude?: string[];
  mappings?: Array<[string, string]>; dependencies?: string[]; notices?: string[]; physicalIncludes?: string[]; singleModules?: Array<[string, string]> }
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
  const root = parseManifestToml(content, [
    ...["package-dir", "packages", "py-modules"].map((field) => ["tool", "setuptools", field]),
    ["build-system", "build-backend"], ["project", "name"],
    ...["name", "packages"].map((field) => ["tool", "poetry", field]),
    ["tool", "hatch", "build", "targets", "wheel", "packages"], ["tool", "hatch", "build", "targets", "wheel", "sources"],
    ["tool", "hatch", "build", "sources"], ["tool", "flit", "module", "name"],
    ["tool", "pdm", "build", "package-dir"], ["tool", "pdm", "build", "includes"],
  ]);
  const tool = manifestTable(root.tool), project = manifestTable(root.project);
  const dependencies: string[] = [], dependencyNotices: string[] = [];
  for (const fields of [["project", "dependencies"], ["tool", "poetry", "dependencies"], ["tool", "pdm", "dev-dependencies"]]) {
    try {
      const value = fields.reduce<unknown>((value, key) => manifestTable(value)[key], parseManifestToml(content, [fields]));
      const requirements = fields[1] === "dependencies" ? manifestStrings(value) ?? []
        : fields[1] === "pdm" ? Object.values(manifestTable(value)).flatMap((entry) => manifestStrings(entry) ?? []) : [];
      dependencies.push(...requirements.flatMap((entry) => /^[A-Za-z0-9_][\w.-]*/u.exec(entry)?.[0] ?? []),
        ...(fields[1] === "poetry" ? dependencyNames(value).filter((name) => name !== "python") : []));
    } catch { dependencyNotices.push("unsupported_python_dependencies"); }
  }
  const backendValue = manifestTable(root["build-system"])["build-backend"];
  const backend = typeof backendValue === "string" ? ({ setuptools: "setuptools", poetry: "poetry", flit_core: "flit", hatchling: "hatch", pdm: "pdm" } as Record<string, string>)[backendValue.split(".")[0]!] : undefined;
  const declared = ["setuptools", "poetry", "hatch", "flit", "pdm"].filter((name) => tool[name] !== undefined);
  const selected = backend ?? (declared.length === 1 ? declared[0] : undefined);
  if ((!backend && declared.length > 1) || (backend && declared.some((name) => name !== backend))) {
    return { declared: true, directories: {}, mappings: [], dependencies, notices: [...dependencyNotices, "conflicting_python_backends"] } satisfies PythonConfig;
  }
  if (selected && selected !== "setuptools") {
    const value = manifestTable(tool[selected]);
    const result: PythonConfig = { declared: true, directories: {}, mappings: [], dependencies, notices: [...dependencyNotices] };
    const add = (name: string, directory: string) => {
      if (!moduleName.test(name) || !localPath(".", directory) || /[*?{}\[\]]/u.test(directory)) { result.notices!.push("unsupported_python_package"); return; }
      result.mappings!.push([name, directory]);
    };
    const defaultName = value.name ?? project.name;
    if (selected === "poetry") {
      if (value.packages !== undefined && !Array.isArray(value.packages)) throw new Error("Invalid Poetry packages.");
      if (Array.isArray(value.packages)) for (const entry of value.packages) {
        const pkg = manifestTable(entry), include = pkg.include, from = pkg.from ?? ".";
        if (pkg.format !== undefined && !(typeof pkg.format === "string" ? pkg.format === "wheel" : Array.isArray(pkg.format) && pkg.format.includes("wheel"))) continue;
        if (typeof include !== "string" || typeof from !== "string" || pkg.to !== undefined) { result.notices!.push("unsupported_poetry_package"); continue; }
        add(include.replace(/\//gu, "."), posix.join(from, include));
      } else if (typeof defaultName === "string") add(defaultName.replace(/-/gu, "_"), defaultName.replace(/-/gu, "_"));
    } else if (selected === "flit") {
      const name = manifestTable(value.module).name ?? project.name;
      if (typeof name !== "string") throw new Error("Flit requires a declared module/project name.");
      const logical = name.replace(/-/gu, "_"), physical = logical.replace(/\./gu, "/");
      add(logical, physical); add(logical, `src/${physical}`);
      result.singleModules = [[logical, physical + ".py"], [logical, `src/${physical}.py`]];
    } else if (selected === "hatch") {
      const build = manifestTable(value.build), wheel = manifestTable(manifestTable(build.targets).wheel);
      const sources = wheel.sources ?? build.sources;
      const rewrites = Array.isArray(sources) ? (manifestStrings(sources) ?? []).map((entry) => [entry, ""] as [string, string])
        : Object.entries(manifestTable(sources)).map(([from, to]) => { if (typeof to !== "string") throw new Error("Invalid Hatch source mapping."); return [from, to] as [string, string]; });
      const packages = manifestStrings(wheel.packages);
      if (packages) for (const directory of packages) {
        const mapping = rewrites.filter(([from]) => directory === from || directory.startsWith(from + "/")).sort((a, b) => b[0].length - a[0].length)[0];
        const logical = mapping ? posix.join(mapping[1], posix.relative(mapping[0], directory)) : posix.basename(directory);
        add(logical.replace(/\//gu, "."), directory);
      } else for (const [from, to] of rewrites) {
        if (!localPath(".", from) || (to && !moduleName.test(to.replace(/\//gu, ".")))) { result.notices!.push("unsupported_hatch_sources"); continue; }
        result.mappings!.push([to.replace(/\//gu, "."), from]);
      }
      if (!result.mappings!.length) result.notices!.push("undeclared_hatch_packages");
    } else {
      const build = manifestTable(value.build), directory = build["package-dir"];
      if (typeof directory !== "string" || !localPath(".", directory)) result.notices!.push("undeclared_pdm_package_directory");
      else result.mappings!.push(["", directory]);
      result.physicalIncludes = manifestStrings(build.includes);
    }
    result.notices = [...new Set(result.notices)];
    return result;
  }
  if (backendValue !== undefined && !backend) return { declared: true, directories: {}, mappings: [], dependencies, notices: [...dependencyNotices, "unsupported_python_backend"] } satisfies PythonConfig;
  const setuptools = manifestTable(tool.setuptools);
  const packages = setuptools.packages;
  return { ...config(setuptools["package-dir"], Array.isArray(packages) ? packages : undefined,
    setuptools["py-modules"], !Array.isArray(packages) ? manifestTable(packages).find : undefined), dependencies, notices: dependencyNotices };
}, notices: (value) => (value as PythonConfig).notices ?? [] };
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
  const mappings = cfg.mappings ?? Object.entries(cfg.directories);
  if (!mappings.length && !cfg.mappings) mappings.push(...(cfg.where ?? ["."]).map((dir) => ["", dir] as [string, string]));
  for (const [name, file] of cfg.singleModules ?? []) {
    const path = localPath(root, file);
    if (path && context.paths.has(path) && pythonManifest(context, path)?.path === manifest.path) addName(names, name, path);
  }
  const isPackage = (directory: string) => context.paths.has(posix.join(directory, "__init__.py")) || context.paths.has(posix.join(directory, "__init__.pyi"));
  const includes = cfg.include?.map((pattern) => literalGlob(pattern, { questionMark: true }));
  const excludes = cfg.exclude?.map((pattern) => literalGlob(pattern, { questionMark: true }));
  const physicalIncludes = cfg.physicalIncludes?.map((pattern) => literalGlob(pattern, { pathPrefix: true, questionMark: true }));
  for (const path of context.paths) {
    if (!/\.pyi?$/u.test(path) || pythonManifest(context, path)?.path !== manifest.path || (path.endsWith(".pyi") && context.paths.has(path.slice(0, -1)))) continue;
    if (physicalIncludes && !physicalIncludes.some((matches) => matches(posix.relative(root, path)))) continue;
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
