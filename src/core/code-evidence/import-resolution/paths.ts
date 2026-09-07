import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";

export function localPath(base: string, value: string): string | undefined {
  if (/[\\?#\0]/u.test(value) || /^[A-Za-z]:/u.test(value) || posix.isAbsolute(value)) return;
  const path = posix.normalize(posix.join(base, value));
  return path === ".." || path.startsWith("../") ? undefined : path;
}

/** Singular names require one file; declared groups bypass this helper. */
export function uniqueImport(context: CodeImportContext, matchedName: string, candidates: ReadonlySet<string> | readonly string[]): string[] {
  if (Array.isArray(candidates) && candidates.length === 1) return [candidates[0]!];
  const matches = Array.isArray(candidates) ? new Set(candidates) : candidates as ReadonlySet<string>;
  if (matches.size === 1) return [...matches];
  context.reportIssue?.({ status: matches.size ? "ambiguous" : "unresolved", matchedName,
    candidates: matches, reason: matches.size ? "multiple_matches" : "not_indexed_or_unsupported" });
  return [];
}

export function addName(index: Map<string, Set<string>>, name: string, path: string): void {
  const entries = index.get(name);
  if (entries) entries.add(path);
  else index.set(name, new Set([path]));
}

/** Best-effort fallback for adapters without a resolver; stem collisions are
 * choices, not declared multi-file groups. Custom resolver arrays stay trusted. */
export function createLegacyImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths } = context;
  const names = new Map<string, Set<string>>();
  for (const path of paths) addName(names, posix.basename(path).replace(/\.[^.]+$/, "").toLowerCase(), path);
  return (_source, specifier) => uniqueImport(context, specifier, names.get(specifier.toLowerCase().split("/").at(-1)!) ?? []);
}
