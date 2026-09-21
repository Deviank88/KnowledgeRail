import * as fs from "node:fs/promises";
import { posix, relative, isAbsolute } from "node:path";
import { mapConcurrent } from "../../concurrent-map.js";
import { safeResolveWithin } from "../../paths.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { CodeImportContext, CodeImportDisposition, KnowledgeFragment } from "../types.js";
import { localPath } from "./paths.js";

const MANIFESTS: Record<string, string[]> = {
  "typescript-javascript": ["package.json"], python: ["pyproject.toml"], rust: ["Cargo.toml"],
  go: ["go.mod"], php: ["composer.json"], ruby: ["Gemfile", "*.gemspec"],
};
const SALESFORCE_PLATFORM = /^(?:lwc|@wire|lightning\/[^\s]+|@lwc\/[^\s]+|@salesforce\/(?:apex|(?:user|client|i18n|community|site|customPermission|userPermission|contentAssetUrl)\/[^\s]+))$/u;

/** Only declared dependency names are retained. Package installation and version
 * resolution are deliberately outside this index. No package-to-symbol guessing. */
export function dependencyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((name) => name.length <= 256 && /^[A-Za-z0-9_@][A-Za-z0-9_@./-]*$/u.test(name));
}

export function createImportClassifier(context: CodeImportContext): (source: string, specifier: string, language: string) => CodeImportDisposition | undefined {
  const cached = new Map<string, readonly string[]>();
  return (source, specifier, language) => {
    if (language === "typescript-javascript" && (SALESFORCE_PLATFORM.test(specifier) || specifier.startsWith("node:"))) return "platform";
    if (language === "rust" && /^(?:std|core|alloc)::/u.test(specifier)) return "platform";
    if (!context.structure || /^\.{1,2}\//u.test(specifier)) return;
    const directory = posix.dirname(source), key = `${language}\0${directory}`;
    let names = cached.get(key);
    if (!names) {
      names = (MANIFESTS[language] ?? []).flatMap((fileName) => {
        const manifest = nearestProjectManifest(context.structure!, source, fileName);
        const value = manifest?.value as { dependencies?: string[] } | undefined;
        return manifest?.warning ? [] : value?.dependencies ?? [];
      });
      cached.set(key, names);
    }
    const separator = language === "rust" ? "::" : language === "python" ? "." : "/";
    if (names.some((name) => specifier === name || specifier.startsWith(name + separator))) return "external_dependency";
  };
}

/** Probe explicit relative literals once per source generation, never per warm
 * query. Existence is confined to the repository; absent paths remain unknown.
 * New/deleted unindexed files become visible on an explicit code update/rebuild. */
export async function probeUnindexedImports(repositoryRoot: string, fragments: readonly KnowledgeFragment[], paths: ReadonlySet<string>): Promise<Set<string>> {
  const candidates = new Set<string>();
  for (const fragment of fragments) {
    if (fragment.kind !== "module" || fragment.qualifiedName !== fragment.path) continue;
    for (const specifier of fragment.imports) {
      if (!/^\.{1,2}\//u.test(specifier)) continue;
      const target = localPath(posix.dirname(fragment.path), specifier);
      if (target && posix.extname(target) && !paths.has(target) && candidates.size < 4096) candidates.add(target);
    }
  }
  if (!candidates.size) return new Set();
  const root = await fs.realpath(repositoryRoot);
  const found = await mapConcurrent([...candidates], 16, async (candidate) => {
    try {
      const file = await fs.realpath(safeResolveWithin(repositoryRoot, candidate));
      const within = relative(root, file);
      if (!within || within === ".." || within.startsWith("../") || within.startsWith("..\\") || isAbsolute(within)) return;
      if ((await fs.stat(file)).isFile()) return candidate;
    } catch { /* Missing or unreadable does not prove an unindexed local file. */ }
  });
  return new Set(found.filter((value): value is string => value !== undefined));
}
