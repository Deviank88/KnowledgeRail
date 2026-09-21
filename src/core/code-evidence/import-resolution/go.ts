import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver, ProjectManifestSpec } from "../types.js";
import { nearestProjectManifest } from "../project-structure.js";
import { addName, localPath } from "./paths.js";

interface GoConfig { modulePath?: string; dependencies: string[]; replacements: Array<{ name: string; directory: string }>; uses: string[]; notices: string[] }
function goDirectives(content: string, directive: string): string[] {
  const values: string[] = [];
  let group = false;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.replace(/\s*\/\/.*$/u, "").trim();
    if (!line) continue;
    if (group) { if (line === ")") group = false; else values.push(line); }
    else if (line.startsWith(directive + " ") || line.startsWith(directive + "\t")) {
      const value = line.slice(directive.length).trim();
      if (value === "(") group = true; else values.push(value);
    }
  }
  if (group) throw new Error("Unterminated Go directive block.");
  return values;
}
function goConfig(content: string): GoConfig {
  const dependencies: string[] = [], replacements: GoConfig["replacements"] = [], uses: string[] = [], notices = new Set<string>();
  const literal = (value: string): string | undefined => {
    try { return value.startsWith('"') ? JSON.parse(value) : /^[^\s"`]+$/u.test(value) ? value : undefined; } catch { return; }
  };
  for (const line of goDirectives(content, "require")) {
    const match = /^("[^"\\]+"|\S+)\s+v[^\s]+$/u.exec(line);
    const name = match && literal(match[1]!);
    if (name) dependencies.push(name); else notices.add("unsupported_go_require");
  }
  for (const line of goDirectives(content, "replace")) {
    const match = /^("[^"\\]+"|\S+)(?:\s+v\S+)?\s*=>\s*("[^"\\]+"|\S+)$/u.exec(line);
    const name = match && literal(match[1]!), directory = match && literal(match[2]!);
    if (name && directory && /^\.{1,2}(?:\/|$)/u.test(directory)) replacements.push({ name, directory });
    else notices.add("unsupported_go_replace");
  }
  for (const line of goDirectives(content, "use")) {
    const directory = literal(line);
    if (directory && !/[\0*?]/u.test(directory)) uses.push(directory); else notices.add("unsupported_go_workspace_use");
  }
  return { dependencies, replacements, uses, notices: [...notices] };
}
function goReferences(value: unknown, path: string): string[] {
  const config = value as GoConfig;
  return [...config.uses, ...config.replacements.map((entry) => entry.directory)].flatMap((directory) => {
    const target = localPath(posix.dirname(path), posix.join(directory, "go.mod"));
    return target ? [target] : [];
  });
}
export const GO_WORKSPACE_MANIFEST: ProjectManifestSpec = {
  fileName: "go.work", parse: goConfig, references: goReferences, referenceDepth: 4,
  notices: (value) => (value as GoConfig).notices,
};

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
    return { ...goConfig(content), modulePath };
  },
  references: goReferences, referenceDepth: 4,
  notices: (value) => (value as GoConfig).notices,
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
      const workspace = nearestProjectManifest(structure, source, "go.work");
      const configurations = [manifest, ...(workspace && !workspace.warning ? [workspace] : [])];
      const replacements = configurations.flatMap((entry) => (entry.value as GoConfig).replacements.map((replacement) => ({ ...replacement, owner: entry })));
      const matching = replacements.filter((entry) => specifier === entry.name || specifier.startsWith(entry.name + "/"))
        .sort((a, b) => b.name.length - a.name.length || Number(b.owner.fileName === "go.work") - Number(a.owner.fileName === "go.work"));
      const replacement = matching[0];
      if (replacement && new Set(matching.filter((entry) => entry.name === replacement.name && entry.owner === replacement.owner)
        .map((entry) => entry.directory)).size > 1) {
        context.reportIssue?.({ status: "ambiguous", matchedName: specifier, reason: "multiple_matches" }); return [];
      }
      let target = manifest;
      let modulePath = (manifest.value as GoConfig).modulePath!;
      if (replacement) {
        const file = localPath(posix.dirname(replacement.owner.path), posix.join(replacement.directory, "go.mod"));
        const resolved = file && structure.manifests.get(file);
        if (!resolved || resolved.warning) return [];
        target = resolved; modulePath = replacement.name;
      } else if (specifier !== modulePath && !specifier.startsWith(`${modulePath}/`)) {
        const members = workspace && !workspace.warning ? (workspace.value as GoConfig).uses.flatMap((directory) => {
          const path = localPath(posix.dirname(workspace.path), posix.join(directory, "go.mod"));
          if (!path) return [];
          const entry = structure.manifests.get(path), name = (entry?.value as GoConfig | undefined)?.modulePath;
          return entry && !entry.warning && name && (specifier === name || specifier.startsWith(name + "/")) ? [entry] : [];
        }) : [];
        if (members.length !== 1) {
          if (members.length > 1) context.reportIssue?.({ status: "ambiguous", matchedName: specifier, reason: "multiple_matches" });
          return [];
        }
        target = members[0]!; modulePath = (target.value as GoConfig).modulePath!;
      }
      const suffix = specifier === modulePath ? "" : specifier.slice(modulePath.length + 1);
      if (suffix && suffix.split("/").some((part) => !part || part === "." || part === ".." || part === "vendor")) return [];
      const directory = suffix ? localPath(posix.dirname(target.path), suffix) : posix.dirname(target.path);
      if (!directory || ownership.get(directory)?.path !== target.path) return [];
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
