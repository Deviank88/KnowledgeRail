import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { addName, localPath, uniqueImport } from "./paths.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { CargoConfig } from "./rust-config.js";

function moduleBase(path: string): string {
  return /\/(?:lib|main|mod)\.rs$/u.test(`/${path}`) ? posix.dirname(path) : path.slice(0, -3);
}

// Expansion is bounded even for adversarial nested use trees. The adapter has
// already removed whitespace; aliases do not change the containing file module.
function usePaths(raw: string): string[] {
  if (raw.length > 65_536) return [];
  const result: string[] = [];
  const pending = [{ value: raw, prefix: "", depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { value, prefix, depth } = pending.pop()!;
    if (++visited > 1024 || depth > 32) return [];
    let nesting = 0;
    let start = 0;
    const pieces: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (value[index] === "{") nesting++;
      else if (value[index] === "}") nesting--;
      else if (value[index] === "," && nesting === 0) {
        pieces.push(value.slice(start, index));
        start = index + 1;
      }
      if (nesting < 0) return [];
    }
    if (nesting !== 0) return [];
    pieces.push(value.slice(start));
    for (const piece of pieces.filter(Boolean)) {
      const open = piece.indexOf("{");
      if (open >= 0) {
        if (!piece.endsWith("}") || (open > 0 && !piece.slice(0, open).endsWith("::"))) return [];
        pending.push({ value: piece.slice(open + 1, -1), prefix: prefix + piece.slice(0, open), depth: depth + 1 });
      } else result.push(prefix + piece);
    }
  }
  return result;
}

export function createRustImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths, fragmentsByPath } = context;
  const owner = (source: string) => context.structure && nearestProjectManifest(context.structure, source, "Cargo.toml");
  const declaredRoots = new Set<string>();
  for (const manifest of context.structure?.manifests.values() ?? []) if (manifest.fileName === "Cargo.toml" && !manifest.warning) {
    for (const root of (manifest.value as CargoConfig).roots) declaredRoots.add(posix.join(posix.dirname(manifest.path), root));
  }
  const baseOf = (path: string) => declaredRoots.has(path) ? posix.dirname(path) : moduleBase(path);
  const modules = new Map<string, Set<string>>();
  const conditional = new Set<string>();
  const reexports = new Map<string, Array<{ source: string; target: string }>>();
  for (const path of paths) {
    if (!path.endsWith(".rs")) continue;
    addName(modules, baseOf(path), path);
    const inline = (fragmentsByPath.get(path) ?? []).filter((fragment) =>
      fragment.kind === "module" && fragment.qualifiedName !== path
    ).sort((left, right) => left.range.startLine - right.range.startLine || right.range.endLine - left.range.endLine);
    const parents: typeof inline = [];
    for (const fragment of inline) {
      while (parents.length && parents.at(-1)!.range.endLine < fragment.range.endLine) parents.pop();
      addName(modules, posix.join(baseOf(path), ...parents.map((parent) => parent.symbol), fragment.symbol), path);
      parents.push(fragment);
    }
  }
  const declaredModules = new Map<string, Set<string>>();
  for (const [path, fragments] of fragmentsByPath) {
    if (!path.endsWith(".rs")) continue;
    const file = fragments.find((fragment) => fragment.kind === "module" && fragment.qualifiedName === path);
    for (const declaration of file?.moduleDeclarations ?? []) {
      const key = posix.join(baseOf(path), declaration.name);
      const candidates = declaration.unsupported ? [] : declaration.path ? [localPath(posix.dirname(path), declaration.path)]
        : [posix.join(baseOf(path), declaration.name + ".rs"), posix.join(baseOf(path), declaration.name, "mod.rs")];
      if (!declaredModules.has(key)) declaredModules.set(key, new Set());
      for (const candidate of candidates) if (candidate && paths.has(candidate) && owner(candidate)?.path === owner(path)?.path) declaredModules.get(key)!.add(candidate);
      if (declaration.conditional) conditional.add(key);
    }
    for (const entry of file?.reexports ?? []) {
      const key = posix.join(baseOf(path), entry.name), entries = reexports.get(key) ?? [];
      entries.push({ source: path, target: entry.target }); reexports.set(key, entries);
    }
  }
  // A #[path] declaration replaces the conventional same-name file, including
  // when its declared target is absent. It must never fall through to a guess.
  for (const [key, candidates] of declaredModules) modules.set(key, candidates);
  const crateRoot = (source: string): string | undefined => {
    const manifest = owner(source);
    if (manifest) {
      if (manifest.warning) return;
      const roots = [...declaredRoots].filter((root) => owner(root)?.path === manifest.path && paths.has(root) &&
        (source === root || source.startsWith(`${posix.dirname(root)}/`)));
      const directories = [...new Set(roots.map((root) => posix.dirname(root)))].sort((a, b) => b.length - a.length);
      return directories[0];
    }
    let directory = posix.dirname(source);
    while (directory !== ".") {
      if (paths.has(`${directory}/lib.rs`) || paths.has(`${directory}/main.rs`)) return directory;
      directory = posix.dirname(directory);
    }
    return ".";
  };
  const resolve = (source: string, specifier: string, followReexport = true): string[] => {
    const root = crateRoot(source);
    if (root === undefined) return [];
    const result = new Set<string>();
    for (const value of usePaths(specifier)) {
      const parts = value.split("::");
      let base = baseOf(source);
      if (parts[0] === "crate") { base = root; parts.shift(); }
      else if (parts[0] === "self") parts.shift();
      else if (parts[0] === "super") {
        while (parts[0] === "super") {
          if (base === root || base === ".") return [];
          base = posix.dirname(base);
          parts.shift();
        }
      } else { uniqueImport(context, value, []); continue; } // External crates/bare paths are not inferred.
      if (!parts.every((part) => /^[A-Za-z_]\w*$|^\*$/u.test(part))) { uniqueImport(context, value, []); continue; }
      if (parts.at(-1) === "*" || parts.at(-1) === "self") parts.pop();
      const exported = followReexport ? reexports.get(posix.join(base, ...parts)) : undefined;
      if (exported) {
        const candidates = new Set<string>();
        for (const entry of exported) {
          const target = /^(?:crate|self|super)::/u.test(entry.target) ? entry.target : `crate::${entry.target}`;
          const symbol = entry.target.split("::").at(-1)!;
          for (const path of resolve(entry.source, target, false)) if ((fragmentsByPath.get(path) ?? []).some((fragment) =>
            fragment.kind !== "module" && fragment.kind !== "comment" && fragment.symbol === symbol)) candidates.add(path);
        }
        for (const path of uniqueImport(context, value, candidates)) result.add(path);
        continue;
      }
      let matched = false;
      for (let count = parts.length; count >= (parts.length ? 1 : 0); count--) {
        const candidates = modules.get(posix.join(base, ...parts.slice(0, count)));
        if (!candidates) continue;
        matched = true;
        if (conditional.has(posix.join(base, ...parts.slice(0, count)))) context.reportIssue?.({ status: "unresolved", reason: "cfg_conditional", matchedName: value, candidates });
        for (const path of uniqueImport(context, value, [...candidates].filter((path) => owner(path)?.path === owner(source)?.path))) result.add(path);
        break;
      }
      if (!matched) uniqueImport(context, value, []);
    }
    return [...result];
  };
  return resolve;
}
