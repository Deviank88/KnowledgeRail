import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { localPath, uniqueImport } from "./paths.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { GemspecConfig } from "./ruby-config.js";

export function createRubyImportResolver(context: CodeImportContext): CodeImportResolver {
  const owners = new Map<string, ReturnType<typeof nearestProjectManifest>>();
  const owner = (source: string) => {
    if (!owners.has(source)) owners.set(source, context.structure && nearestProjectManifest(context.structure, source, "*.gemspec"));
    return owners.get(source);
  };
  return (source, specifier) => {
    // Extraction retains the operation; require uses a runtime load path that is
    // not inferred from a filename, lib/ convention or another language's stem.
    const statements = context.fragmentsByPath.get(source)?.find((fragment) => fragment.kind === "module" && fragment.qualifiedName === source)?.importStatements;
    const kinds = statements?.filter((entry) => entry.specifier === specifier).map((entry) => entry.kind) ?? [];
    const results = new Set<string>();
    const resolve = (base: string) => {
      const target = localPath(base, specifier);
      if (!target || (posix.extname(target) && !target.endsWith(".rb"))) return [];
      const path = target.endsWith(".rb") ? target : `${target}.rb`;
      return context.paths.has(path) ? [path] : [];
    };
    if (kinds.includes("require_relative")) for (const path of uniqueImport(context, specifier, resolve(posix.dirname(source)))) results.add(path);
    if (kinds.includes("require")) {
      const manifest = owner(source);
      const matches = new Set<string>();
      if (manifest && !manifest.warning) {
        for (const directory of (manifest.value as GemspecConfig).requirePaths) {
          const base = localPath(posix.dirname(manifest.path), directory);
          if (base) for (const path of resolve(base)) if (owner(path)?.path === manifest.path) matches.add(path);
          // Load paths are ordered. An indexed first match shadows later roots.
          if (matches.size) break;
        }
      }
      for (const path of uniqueImport(context, kinds.includes("require_relative") ? `require:${specifier}` : specifier, matches)) results.add(path);
    }
    return [...results];
  };
}
