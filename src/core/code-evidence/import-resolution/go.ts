import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver, ProjectManifestSpec } from "../types.js";
import { nearestProjectManifest } from "../project-structure.js";
import { addName, localPath } from "./paths.js";

export const GO_MODULE_MANIFEST: ProjectManifestSpec = {
  fileName: "go.mod",
  parse(content) {
    const declarations = content.split(/\r?\n/u).filter((line) => /^\s*module\b/u.test(line));
    if (declarations.length !== 1) throw new Error("Expected one module directive.");
    const match = /^\s*module\s+("(?:[^"\\]|\\.)*"|[^\s"`]+)\s*(?:\/\/[^\r\n]*)?$/u.exec(declarations[0]!);
    if (!match) throw new Error("Unsupported module directive.");
    const modulePath: string = match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]!;
    if (modulePath.length > 4096 || !/^[A-Za-z0-9._~+-]+(?:\/[A-Za-z0-9._~+-]+)*$/u.test(modulePath) ||
        modulePath.split("/").some((part) => part === "." || part === "..")) throw new Error("Invalid module path.");
    return { modulePath };
  },
};

export function createGoImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths, structure } = context;
  const directories = new Map<string, Set<string>>();
  for (const path of paths) {
    if (!path.endsWith(".go") || path.endsWith("_test.go")) continue;
    addName(directories, posix.dirname(path), path);
  }
  if (structure && [...structure.manifests.values()].some((manifest) => manifest.fileName === "go.mod")) {
    const ownership = new Map([...directories.keys()].map((directory) =>
      [directory, nearestProjectManifest(structure, posix.join(directory, "package.go"), "go.mod")] as const
    ));
    return (source, specifier) => {
      const manifest = ownership.get(posix.dirname(source)) ?? nearestProjectManifest(structure, source, "go.mod");
      if (!manifest || manifest.warning) return [];
      const modulePath = (manifest.value as { modulePath: string }).modulePath;
      if (specifier !== modulePath && !specifier.startsWith(`${modulePath}/`)) return [];
      const suffix = specifier === modulePath ? "" : specifier.slice(modulePath.length + 1);
      if (suffix && suffix.split("/").some((part) => !part || part === "." || part === ".." || part === "vendor")) return [];
      const directory = suffix ? localPath(posix.dirname(manifest.path), suffix) : posix.dirname(manifest.path);
      if (!directory || ownership.get(directory)?.path !== manifest.path) return [];
      return [...(directories.get(directory) ?? [])];
    };
  }
  // Compatibility for snapshots without project declarations. The suffix rule
  // is deliberately not used in a repository containing a go.mod boundary.
  const suffixes = new Map<string, Set<string>>();
  for (const directory of directories.keys()) {
    const parts = directory.split("/");
    // Retain at least two directory components for nested packages; a lone
    // basename must not link external/orders to internal/orders.
    for (let start = 0; start <= Math.max(0, parts.length - 2); start++) {
      addName(suffixes, parts.slice(start).join("/"), directory);
    }
  }
  return (source, specifier) => {
    if (/^\.{1,2}\//u.test(specifier)) {
      const directory = localPath(posix.dirname(source), specifier);
      return directory ? [...(directories.get(directory) ?? [])] : [];
    }
    if (/[\\\s\0]/u.test(specifier) || !specifier.includes("/")) return [];
    const parts = specifier.split("/");
    for (let start = 0; start < parts.length; start++) {
      const matches = suffixes.get(parts.slice(start).join("/"));
      if (matches) {
        if (matches.size === 1) {
          const candidates = directories.get([...matches][0]!)!;
          context.reportIssue?.({ status: "unresolved", reason: "legacy_suffix_heuristic", matchedName: specifier, candidates });
          return [...candidates];
        }
        context.reportIssue?.({ status: "ambiguous", reason: "multiple_matches", matchedName: parts.slice(start).join("/"),
          candidates: [...matches].flatMap((directory) => [...directories.get(directory)!]) });
        return [];
      }
    }
    return [];
  };
}
