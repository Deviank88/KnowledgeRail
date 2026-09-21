import { maskBraceLanguage } from "../brace-language-engine.js";
import type { CodeSource, KnowledgeFragment } from "../types.js";

/** File-level literal declarations. Inline-module attributes and macro bodies
 * remain outside this contract; neither cfg nor macros are evaluated. */
export function attachRustDeclarations(source: CodeSource, fragments: KnowledgeFragment[]): KnowledgeFragment[] {
  const module = fragments.find((fragment) => fragment.kind === "module" && fragment.qualifiedName === source.path);
  if (!module) return fragments;
  const masked = maskBraceLanguage(source.content, "rust");
  const declarations: NonNullable<KnowledgeFragment["moduleDeclarations"]> = [];
  const reexports: NonNullable<KnowledgeFragment["reexports"]> = [];
  let depth = 0, scanned = 0;
  for (const match of masked.matchAll(/\b(?:(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;|pub\s+use\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)+)(?:\s+as\s+([A-Za-z_]\w*))?\s*;)/gu)) {
    for (; scanned < match.index; scanned++) { if (masked[scanned] === "{") depth++; else if (masked[scanned] === "}") depth--; }
    if (depth !== 0) continue;
    if (match[1]) {
      const prefix = masked.slice(Math.max(0, match.index - 4096), match.index);
      const attributeSpan = /((?:\s*#\[[^\]]*\])*)\s*$/u.exec(prefix)?.[0] ?? "";
      const attributeStart = match.index - attributeSpan.length;
      const paths = [...attributeSpan.matchAll(/#\[\s*path\b[^\]]*\]/gu)].flatMap((attribute) => {
        const raw = source.content.slice(attributeStart + attribute.index, attributeStart + attribute.index + attribute[0].length);
        const path = /^#\[\s*path\s*=\s*"([^"\\]+)"\s*\]$/u.exec(raw); return path ? [path] : [];
      });
      const pathMatch = paths[0];
      if ((/\bpath\b/u.test(attributeSpan) && paths.length !== 1) || /#\[\s*cfg_attr\b/u.test(attributeSpan)) {
        declarations.push({ name: match[1], unsupported: true });
        (module.unsupportedImports ??= []).push(`unsupported path attribute for mod ${match[1]}`); continue;
      }
      declarations.push({ name: match[1], ...(pathMatch ? { path: pathMatch[1] } : {}),
        ...(/#\[\s*cfg\s*\(/u.test(attributeSpan) ? { conditional: true } : {}) });
      module.imports = [...new Set([...module.imports, `self::${match[1]}`])];
    } else if (match[2]) reexports.push({ name: match[3] ?? match[2].split("::").at(-1)!, target: match[2] });
  }
  if (declarations.length) module.moduleDeclarations = declarations;
  if (reexports.length) module.reexports = reexports;
  return fragments;
}
