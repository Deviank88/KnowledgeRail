import { posix } from "node:path";
import { parseManifestJson } from "../manifest-json.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { CodeImportContext, CodeImportResolver, ProjectManifest, ProjectManifestSpec } from "../types.js";
import { dependencyNames } from "./classification.js";
import { localPath, uniqueImport } from "./paths.js";

interface PackageConfig { name?: string; main?: string; exports?: unknown; imports?: Record<string, unknown>; workspaces?: string[]; dependencies: string[] }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function workspacePaths(value: unknown): string[] | undefined {
  if (value === undefined) return;
  const paths = object(value) ? value.packages : value;
  if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string" || !localPath(".", entry.replace(/^!/u, "")))) throw new Error("Invalid declared workspaces.");
  return paths as string[];
}
function workspacePatterns(value: unknown, path: string): string[] {
  return ((value as PackageConfig).workspaces ?? []).map((entry) => {
    const negative = entry.startsWith("!");
    const target = localPath(posix.dirname(path), posix.join(entry.replace(/^!/u, ""), "package.json"));
    if (!target) throw new Error("Workspace outside repository.");
    return (negative ? "!" : "") + target;
  });
}
export const PACKAGE_MANIFEST: ProjectManifestSpec = {
  fileName: "package.json", referencePatterns: workspacePatterns,
  parse(content): PackageConfig {
    const value = parseManifestJson(content);
    if (!object(value) || (value.name !== undefined && typeof value.name !== "string") || (value.imports !== undefined && !object(value.imports))) throw new Error("Invalid package manifest.");
    return { name: value.name as string | undefined, main: typeof value.main === "string" ? value.main : undefined,
      exports: value.exports, imports: value.imports as Record<string, unknown> | undefined, workspaces: workspacePaths(value.workspaces),
      dependencies: [...new Set([...dependencyNames(value.dependencies), ...dependencyNames(value.devDependencies), ...dependencyNames(value.peerDependencies), ...dependencyNames(value.optionalDependencies)])] };
  },
};
export const PNPM_WORKSPACE_MANIFEST: ProjectManifestSpec = {
  fileName: "pnpm-workspace.yaml", referencePatterns: workspacePatterns,
  parse(content) {
    const workspaces: string[] = [];
    let collecting = false;
    for (const line of content.split(/\r?\n/u)) {
      if (/^packages:\s*(?:#.*)?$/u.test(line)) { collecting = true; continue; }
      if (!collecting || /^\s*(?:#.*)?$/u.test(line)) continue;
      if (/^\S/u.test(line)) { collecting = false; continue; }
      const match = /^\s+-\s+(?:'([^']+)'|"([^"\\]+)"|([^\s#]+))\s*(?:#.*)?$/u.exec(line);
      if (!match) throw new Error("Only literal pnpm workspace packages are supported.");
      workspaces.push(match[1] ?? match[2] ?? match[3]!);
    }
    return { workspaces: workspacePaths(workspaces), dependencies: [] };
  },
};

function selectedTarget(value: unknown, kind: "import" | "require", depth = 0): string | undefined {
  if (depth > 8) return;
  if (typeof value === "string") return value;
  if (!object(value)) return;
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "default" || condition === kind) return selectedTarget(target, kind, depth + 1);
  }
}
function mappingTarget(map: unknown, name: string, kind: "import" | "require"): string | undefined {
  if (!object(map) || !Object.keys(map).some((key) => key.startsWith(".") || key.startsWith("#"))) return name === "." ? selectedTarget(map, kind) : undefined;
  if (Object.hasOwn(map, name)) return selectedTarget(map[name], kind);
  const matches = Object.keys(map).filter((key) => {
    const [prefix, suffix] = key.split("*");
    return suffix !== undefined && key.split("*").length === 2 && name.startsWith(prefix!) && name.endsWith(suffix) && name.length >= prefix!.length + suffix.length;
  }).sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  const pattern = matches[0];
  if (!pattern) return;
  const star = pattern.indexOf("*"), wildcard = name.slice(star, name.length - (pattern.length - star - 1));
  return selectedTarget(map[pattern], kind)?.replaceAll("*", wildcard);
}

export function createPackageImportResolver(context: CodeImportContext, candidates: (base: string, value: string) => string[]): CodeImportResolver {
  const structure = context.structure;
  const owners = new Map<string, ProjectManifest | undefined>();
  const workspaceByDirectory = new Map<string, ProjectManifest | undefined>();
  const owner = (source: string) => {
    const directory = posix.dirname(source);
    if (!owners.has(directory)) owners.set(directory, structure && nearestProjectManifest(structure, source, "package.json"));
    return owners.get(directory);
  };
  const workspace = (source: string) => {
    const start = posix.dirname(source);
    if (workspaceByDirectory.has(start)) return workspaceByDirectory.get(start);
    let directory = start, result: ProjectManifest | undefined;
    while (structure) {
      const manifests = [structure.manifests.get(posix.join(directory, "pnpm-workspace.yaml")), structure.manifests.get(posix.join(directory, "package.json"))];
      result = manifests.find((manifest) => manifest && (manifest.warning || (manifest.value as PackageConfig)?.workspaces !== undefined));
      if (result || directory === ".") break;
      directory = posix.dirname(directory);
    }
    workspaceByDirectory.set(start, result); return result;
  };
  const packageNames = new Map<string, Map<string, ProjectManifest[]>>();
  return (source, specifier) => {
    const current = owner(source);
    if (current?.warning) return [];
    const config = current?.value as PackageConfig | undefined;
    const statements = context.fragmentsByPath.get(source)?.find((fragment) => fragment.kind === "module" && fragment.qualifiedName === source)?.importStatements;
    const kinds = [...new Set(statements?.filter((entry) => entry.specifier === specifier).map((entry) => entry.kind === "require" ? "require" as const : "import" as const) ?? ["import" as const])];
    const targets = new Set<string>();
    const resolve = (manifest: ProjectManifest, value: PackageConfig, name: string, internal: boolean) => {
      for (const kind of kinds) {
        const target = mappingTarget(internal ? value.imports : value.exports, name, kind)
          ?? (!internal && value.exports === undefined ? name === "." ? value.main ?? "./index.js" : name : undefined);
        if (!target || (value.exports !== undefined || internal) && !target.startsWith("./") || target.split("/").some((part) => part === ".." || part === "node_modules")) {
          uniqueImport(context, specifier, []); continue;
        }
        for (const path of uniqueImport(context, specifier, candidates(posix.dirname(manifest.path), target)
          .filter((path) => owner(path)?.path === manifest.path))) targets.add(path);
      }
    };
    if (specifier.startsWith("#")) {
      if (current && config) resolve(current, config, specifier, true);
    } else {
      const parts = specifier.split("/"), name = parts.splice(0, specifier.startsWith("@") ? 2 : 1).join("/"), subpath = parts.length ? `./${parts.join("/")}` : ".";
      let packages: ProjectManifest[] = [];
      if (current && config?.name === name) packages = [current];
      else {
        const boundary = workspace(source);
        if (boundary && !boundary.warning) {
          let names = packageNames.get(boundary.path);
          if (!names) {
            names = new Map();
            for (const path of boundary.references ?? []) {
              const manifest = structure?.manifests.get(path), pkg = manifest?.value as PackageConfig | undefined;
              if (!manifest || manifest.warning || !pkg?.name) continue;
              const entries = names.get(pkg.name) ?? []; entries.push(manifest); names.set(pkg.name, entries);
            }
            packageNames.set(boundary.path, names);
          }
          packages = names.get(name) ?? [];
        }
      }
      for (const manifest of packages) resolve(manifest, manifest.value as PackageConfig, subpath, false);
      if (packages.length > 1) {
        context.reportIssue?.({ status: "ambiguous", matchedName: specifier, reason: "multiple_matches", candidates: targets }); return [];
      }
    }
    // import and require in the same file can declare two different entry points.
    // Uniqueness applies per syntax mode, not to their legitimate union.
    return [...targets];
  };
}
