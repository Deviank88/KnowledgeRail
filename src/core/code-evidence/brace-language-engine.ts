import { createHash } from "node:crypto";
import type {
  CodeFragmentKind,
  CodeRoute,
  CodeSource,
  KnowledgeFragment,
} from "./types.js";

export type BraceLanguage = "java" | "apex" | "csharp" | "go" | "rust" | "php" | "c" | "cpp";

export interface BraceCandidate {
  kind: CodeFragmentKind;
  symbol: string;
  qualifiedName: string;
  start: number;
  end: number;
  definition?: string;
  calls?: string[];
  references?: string[];
  routes?: CodeRoute[];
  configKeys?: string[];
  databaseRefs?: string[];
  isTest?: boolean;
}

export interface BraceExtractionContext {
  source: CodeSource;
  content: string;
  masked: string;
}

export interface BraceLanguageConfig {
  language: BraceLanguage;
  keywords: ReadonlySet<string>;
  caseInsensitiveKeywords?: boolean;
  lineCommentsAreDoc?: boolean;
  testPath(path: string): boolean;
  candidates(context: BraceExtractionContext): BraceCandidate[];
  imports(content: string): string[];
  configKeys?(content: string): string[];
  databaseRefs?(content: string): string[];
}

interface CommentSpan {
  start: number;
  end: number;
  text: string;
  doc: boolean;
}

interface MaskResult {
  masked: string;
  comments: CommentSpan[];
}

export function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

export function lineEnd(content: string, offset: number): number {
  const newline = content.indexOf("\n", offset);
  return newline < 0 ? content.length : newline;
}

export function lineStart(content: string, offset: number): number {
  const newline = content.lastIndexOf("\n", Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

export function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, content.length); index++) {
    if (content.charCodeAt(index) === 10) line++;
  }
  return line;
}

export function definitionLine(content: string, start: number): string {
  return content.slice(start, lineEnd(content, start)).trim().replace(/\s+/g, " ");
}

export function matchingBrace(masked: string, open: number): number {
  if (open < 0 || masked[open] !== "{") return Math.max(0, open);
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === "{") depth++;
    else if (masked[index] === "}" && --depth === 0) return index + 1;
  }
  return masked.length;
}

export function braceDepthAt(masked: string, open: number, offset: number): number {
  let depth = 0;
  for (let index = Math.max(0, open); index < Math.min(offset, masked.length); index++) {
    if (masked[index] === "{") depth++;
    else if (masked[index] === "}") depth--;
  }
  return depth;
}

export function annotationTextBefore(content: string, start: number): string {
  const lines = content.slice(0, lineStart(content, start)).split(/\r?\n/);
  const selected: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line) {
      if (selected.length === 0) continue;
      break;
    }
    if (line.startsWith("@") || line.startsWith("[") || line.startsWith("#[")) {
      selected.unshift(line);
      continue;
    }
    break;
  }
  return selected.join("\n");
}

function cleanComment(raw: string): string {
  return raw
    .replace(/^\s*\/\*+!?/u, "")
    .replace(/\*\/\s*$/u, "")
    .replace(/^\s*\/\/[\/@!]?[ ]?/gmu, "")
    .replace(/^\s*#[ ]?/gmu, "")
    .replace(/^\s*\* ?/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < Math.min(end, chars.length); index++) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
}

function escapedAt(content: string, offset: number): boolean {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && content[index] === "\\"; index--) backslashes++;
  return backslashes % 2 === 1;
}

function normalQuotedEnd(
  content: string,
  start: number,
  quote: string,
  stopSingleQuoteAtNewline = true
): number {
  for (let index = start + 1; index < content.length; index++) {
    if (content[index] === "\n" && quote === "'" && stopSingleQuoteAtNewline) return index;
    if (content[index] === quote && !escapedAt(content, index)) return index + 1;
  }
  return content.length;
}

function rustCharEnd(content: string, start: number): number | null {
  const first = start + 1;
  if (content[first] === "\\") {
    if (content[first + 1] === "u" && content[first + 2] === "{") {
      const brace = content.indexOf("}", first + 3);
      return brace >= 0 && brace - start <= 12 && content[brace + 1] === "'" ? brace + 2 : null;
    }
    return content[first + 2] === "'" ? first + 3 : null;
  }
  const point = content.codePointAt(first);
  if (point === undefined || point === 10 || point === 13) return null;
  const width = point > 0xffff ? 2 : 1;
  return content[first + width] === "'" ? first + width + 1 : null;
}

function tripleQuotedEnd(content: string, start: number, escapedDelimiter = false): number {
  let close = content.indexOf("\"\"\"", start + 3);
  while (close >= 0 && escapedDelimiter && escapedAt(content, close)) {
    close = content.indexOf("\"\"\"", close + 3);
  }
  return close < 0 ? content.length : close + 3;
}

function csharpVerbatimEnd(content: string, quote: number): number {
  for (let index = quote + 1; index < content.length; index++) {
    if (content[index] !== "\"") continue;
    if (content[index + 1] === "\"") {
      index++;
      continue;
    }
    return index + 1;
  }
  return content.length;
}

function csharpInterpolatedEnd(content: string, start: number, verbatim: boolean, nesting = 0): number {
  const prefix = verbatim ? /^(?:\$@|@\$)"/u.exec(content.slice(start, start + 3)) : /^\$"/u.exec(
    content.slice(start, start + 2)
  );
  if (!prefix) return start + 1;
  let index = start + prefix[0].length;
  let braceDepth = 0;
  while (index < content.length) {
    if (braceDepth === 0) {
      if (content[index] === "{") {
        if (content[index + 1] === "{") {
          index += 2;
          continue;
        }
        braceDepth = 1;
        index++;
        continue;
      }
      if (content[index] === "}" && content[index + 1] === "}") {
        index += 2;
        continue;
      }
      if (content[index] === "\"") {
        if (verbatim && content[index + 1] === "\"") {
          index += 2;
          continue;
        }
        if (verbatim || !escapedAt(content, index)) return index + 1;
      }
      index++;
      continue;
    }
    if (content.startsWith("@\"", index)) {
      index = csharpVerbatimEnd(content, index + 1);
      continue;
    }
    if (nesting < 16 && (content.startsWith("$@\"", index) || content.startsWith("@$\"", index))) {
      index = csharpInterpolatedEnd(content, index, true, nesting + 1);
      continue;
    }
    if (nesting < 16 && content.startsWith("$\"", index)) {
      index = csharpInterpolatedEnd(content, index, false, nesting + 1);
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "/") {
      index = lineEnd(content, index);
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "*") {
      index = blockCommentEnd(content, index, false);
      continue;
    }
    if (content[index] === "\"" || content[index] === "'") {
      index = normalQuotedEnd(content, index, content[index]!);
      continue;
    }
    if (content[index] === "{") braceDepth++;
    else if (content[index] === "}" && --braceDepth === 0) {
      index++;
      continue;
    }
    index++;
  }
  return content.length;
}

function rustRawString(content: string, start: number): { end: number } | null {
  const match = /^(?:br|r)(#{0,255})"/u.exec(content.slice(start, start + 260));
  if (!match) return null;
  const marker = `\"${match[1]!}`;
  const close = content.indexOf(marker, start + match[0].length);
  return { end: close < 0 ? content.length : close + marker.length };
}

function cppRawString(content: string, start: number): { end: number } | null {
  const match = /^R"([^ ()\\\t\r\n]{0,16})\(/u.exec(content.slice(start, start + 20));
  if (!match) return null;
  const marker = `)${match[1]!}\"`;
  const close = content.indexOf(marker, start + match[0].length);
  return { end: close < 0 ? content.length : close + marker.length };
}

function blockCommentEnd(content: string, start: number, nested: boolean): number {
  let depth = 1;
  for (let index = start + 2; index < content.length - 1; index++) {
    if (nested && content[index] === "/" && content[index + 1] === "*") {
      depth++;
      index++;
    } else if (content[index] === "*" && content[index + 1] === "/") {
      depth--;
      index++;
      if (depth === 0) return index + 1;
    }
  }
  return content.length;
}

function groupedLineCommentEnd(content: string, start: number): number {
  let end = lineEnd(content, start);
  while (end < content.length) {
    let cursor = end + 1;
    while (content[cursor] === " " || content[cursor] === "\t") cursor++;
    if (content[cursor] !== "/" || content[cursor + 1] !== "/") break;
    end = lineEnd(content, cursor);
  }
  return end;
}

function preprocessorDefinitionEnd(content: string, start: number): number {
  let end = lineEnd(content, start);
  while (end < content.length && /\\\s*$/u.test(content.slice(lineStart(content, end), end))) {
    end = lineEnd(content, end + 1);
  }
  return end;
}

function apexQueryEnd(content: string, start: number): number | null {
  if (!/^\[\s*(?:select|find)\b/iu.test(content.slice(start, start + 32))) return null;
  const close = content.indexOf("]", start + 1);
  return close < 0 ? content.length : close + 1;
}

function phpOpeningTag(content: string, start: number): { start: number; end: number } | null {
  const match = /<\?(?:php\b|=)/iu.exec(content.slice(start));
  return match?.index === undefined
    ? null
    : { start: start + match.index, end: start + match.index + match[0].length };
}

function phpHeredocEnd(content: string, start: number): number | null {
  const match = /^<<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*(?:\r?\n|$)/u
    .exec(content.slice(start));
  const delimiter = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!match || !delimiter) return null;
  let cursor = start + match[0].length;
  while (cursor < content.length) {
    const end = lineEnd(content, cursor);
    const line = content.slice(cursor, end).trim();
    if (line === delimiter || line === `${delimiter};`) return end;
    cursor = end < content.length ? end + 1 : content.length;
  }
  return content.length;
}

function maskDetailed(content: string, config: Pick<BraceLanguageConfig, "language" | "lineCommentsAreDoc">): MaskResult {
  const chars = content.split("");
  const comments: CommentSpan[] = [];
  let phpActive = config.language !== "php";
  for (let index = 0; index < content.length;) {
    if (config.language === "php" && !phpActive) {
      const opening = phpOpeningTag(content, index);
      if (!opening) {
        maskRange(chars, index, content.length);
        break;
      }
      maskRange(chars, index, opening.end);
      index = opening.end;
      phpActive = true;
      continue;
    }
    if (config.language === "php" && content.startsWith("?>", index)) {
      maskRange(chars, index, index + 2);
      index += 2;
      phpActive = false;
      continue;
    }
    const preprocessorLanguage = config.language === "c" || config.language === "cpp";
    if (preprocessorLanguage && content[index] === "#" &&
        content.slice(lineStart(content, index), index).trim() === "" &&
        /^#\s*define\b/u.test(content.slice(index, index + 32))) {
      const end = preprocessorDefinitionEnd(content, index);
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "/") {
      const end = groupedLineCommentEnd(content, index);
      const raw = content.slice(index, end);
      const marker = raw.trimStart().slice(0, 3);
      comments.push({
        start: index,
        end,
        text: cleanComment(raw),
        doc: Boolean(config.lineCommentsAreDoc) || marker === "///" || marker === "//!",
      });
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (config.language === "php" && content[index] === "#" && content[index + 1] !== "[") {
      const end = lineEnd(content, index);
      const raw = content.slice(index, end);
      comments.push({ start: index, end, text: cleanComment(raw), doc: false });
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "/" && content[index + 1] === "*") {
      const end = blockCommentEnd(content, index, config.language === "rust");
      const raw = content.slice(index, end);
      comments.push({
        start: index,
        end,
        text: cleanComment(raw),
        doc: /^\/\*\*/u.test(raw),
      });
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (config.language === "apex" && content[index] === "[") {
      const end = apexQueryEnd(content, index);
      if (end !== null) {
        maskRange(chars, index, end);
        index = end;
        continue;
      }
    }
    if (config.language === "rust") {
      const raw = rustRawString(content, index);
      if (raw) {
        maskRange(chars, index, raw.end);
        index = raw.end;
        continue;
      }
    }
    if (config.language === "php" && content.startsWith("<<<", index)) {
      const end = phpHeredocEnd(content, index);
      if (end !== null) {
        maskRange(chars, index, end);
        index = end;
        continue;
      }
    }
    if (config.language === "cpp" && content.startsWith("R\"", index)) {
      const raw = cppRawString(content, index);
      if (raw) {
        maskRange(chars, index, raw.end);
        index = raw.end;
        continue;
      }
    }
    if ((config.language === "java" || config.language === "csharp") && content.startsWith("\"\"\"", index)) {
      const end = tripleQuotedEnd(content, index, config.language === "java");
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (config.language === "csharp") {
      const interpolatedRaw = /^\$+"""/u.exec(content.slice(index, index + 12));
      if (interpolatedRaw) {
        const quote = index + interpolatedRaw[0].length - 3;
        const end = tripleQuotedEnd(content, quote);
        maskRange(chars, index, end);
        index = end;
        continue;
      }
      const verbatim = /^(?:\$@|@\$|@)"/u.exec(content.slice(index, index + 3));
      if (verbatim) {
        const quote = index + verbatim[0].length - 1;
        const end = verbatim[0] === "@\""
          ? csharpVerbatimEnd(content, quote)
          : csharpInterpolatedEnd(content, index, true);
        maskRange(chars, index, end);
        index = end;
        continue;
      }
      if (content.startsWith("$\"", index)) {
        const end = csharpInterpolatedEnd(content, index, false);
        maskRange(chars, index, end);
        index = end;
        continue;
      }
    }
    if (config.language === "go" && content[index] === "`") {
      const close = content.indexOf("`", index + 1);
      const end = close < 0 ? content.length : close + 1;
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "\"") {
      const end = normalQuotedEnd(content, index, "\"");
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "'") {
      const rustEnd = config.language === "rust" ? rustCharEnd(content, index) : undefined;
      if (config.language === "rust" && rustEnd === null) {
        index++;
        continue;
      }
      const end = rustEnd ?? normalQuotedEnd(content, index, "'", config.language !== "php");
      maskRange(chars, index, end);
      index = end;
      continue;
    }
    index++;
  }
  return { masked: chars.join(""), comments };
}

export function maskBraceLanguage(content: string, language: BraceLanguage): string {
  return maskDetailed(content, { language }).masked;
}

function fragmentId(path: string, kind: CodeFragmentKind, qualifiedName: string, startLine: number): string {
  const digest = createHash("sha256")
    .update(`${path}\0${kind}\0${qualifiedName}\0${startLine}`)
    .digest("hex")
    .slice(0, 20);
  return `symbol-${digest}`;
}

function keyword(config: BraceLanguageConfig, value: string): boolean {
  return config.keywords.has(config.caseInsensitiveKeywords ? value.toLowerCase() : value);
}

function identifiersIn(masked: string, config: BraceLanguageConfig): string[] {
  const values: string[] = [];
  const pattern = config.language === "php"
    ? /(?<![\w$])\$?[A-Za-z_][\w$]*/g
    : /\b[A-Za-z_][\w$]*\b/g;
  for (const match of masked.matchAll(pattern)) {
    const value = match[0]!;
    if (!keyword(config, value.replace(/^\$/u, ""))) values.push(value);
  }
  return unique(values);
}

function callsIn(masked: string, config: BraceLanguageConfig): string[] {
  const values: string[] = [];
  const pattern = config.language === "php"
    ? /(?<![\w$])(\$?[A-Za-z_][\w$]*(?:(?:::|->|\\)\$?[A-Za-z_][\w$]*)?)\s*\(/g
    : /\b([A-Za-z_][\w$]*(?:(?:::|\.)[A-Za-z_][\w$]*)?)\s*\(/g;
  for (const match of masked.matchAll(pattern)) {
    const value = match[1]!;
    const finalPart = value.split(/\.|::|->|\\/u).at(-1)!;
    const normalizedPart = finalPart.replace(/^\$/u, "");
    if (!keyword(config, normalizedPart) && !["if", "for", "while", "switch", "catch", "match"].includes(normalizedPart)) {
      values.push(value, finalPart);
    }
  }
  return unique(values);
}

function decorationsOnly(value: string): boolean {
  if (!value.trim()) return true;
  return value.split(/\r?\n/u).every((line) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith("@") || trimmed.startsWith("[") ||
      trimmed.startsWith("#[") || /^[),\]}'"]+$/u.test(trimmed);
  });
}

function precedingDocComment(
  content: string,
  comments: readonly CommentSpan[],
  start: number
): string | undefined {
  const candidate = [...comments].reverse().find((comment) => comment.doc && comment.end <= start && comment.text);
  if (!candidate) return undefined;
  return decorationsOnly(content.slice(candidate.end, start)) ? candidate.text : undefined;
}

function sortedFragments(fragments: readonly KnowledgeFragment[]): KnowledgeFragment[] {
  return [...fragments].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.range.startLine - right.range.startLine ||
    left.qualifiedName.localeCompare(right.qualifiedName)
  );
}

export function extractBraceLanguage(source: CodeSource, config: BraceLanguageConfig): KnowledgeFragment[] {
  const detailed = maskDetailed(source.content, config);
  const context: BraceExtractionContext = {
    source,
    content: source.content,
    masked: detailed.masked,
  };
  const candidates: BraceCandidate[] = [{
    kind: "module",
    symbol: source.path,
    qualifiedName: source.path,
    definition: `module ${source.path}`,
    start: 0,
    end: source.content.length,
  }, ...config.candidates(context)];
  for (const comment of detailed.comments) {
    if (comment.doc || comment.text.length < 12) continue;
    const startLine = lineNumberAt(source.content, comment.start);
    candidates.push({
      kind: "comment",
      symbol: `comment@${startLine}`,
      qualifiedName: `${source.path}:comment@${startLine}`,
      definition: comment.text.slice(0, 160),
      start: comment.start,
      end: comment.end,
    });
  }
  const imports = unique(config.imports(source.content));
  const fileConfigKeys = unique(config.configKeys?.(source.content) ?? []);
  const fileDatabaseRefs = unique(config.databaseRefs?.(source.content) ?? []);
  const fileIsTest = config.testPath(source.path);
  const deduplicated = new Map<string, BraceCandidate>();
  for (const candidate of candidates) {
    if (!candidate.symbol || candidate.end < candidate.start) continue;
    deduplicated.set(`${candidate.kind}\0${candidate.qualifiedName}\0${candidate.start}`, candidate);
  }
  const fragments: KnowledgeFragment[] = [];
  for (const candidate of deduplicated.values()) {
    const startLine = lineNumberAt(source.content, candidate.start);
    const endLine = Math.max(startLine, lineNumberAt(
      source.content,
      Math.max(candidate.start, candidate.end - 1)
    ));
    const raw = source.content.slice(candidate.start, candidate.end);
    const code = detailed.masked.slice(candidate.start, candidate.end);
    const calls = unique([...(candidate.calls ?? []), ...callsIn(code, config)]);
    const references = unique([
      ...(candidate.references ?? []),
      ...identifiersIn(code, config),
      ...calls.flatMap((call) => [call, call.split(/\.|::|->|\\/u).at(-1)!]),
    ]).filter((value) => config.caseInsensitiveKeywords
      ? value.toLowerCase() !== candidate.symbol.toLowerCase()
      : value !== candidate.symbol);
    fragments.push({
      id: fragmentId(source.path, candidate.kind, candidate.qualifiedName, startLine),
      path: source.path,
      symbol: candidate.symbol,
      qualifiedName: candidate.qualifiedName,
      kind: candidate.kind,
      definition: candidate.definition ?? definitionLine(source.content, candidate.start),
      range: { startLine, endLine },
      imports,
      references,
      calls,
      routes: candidate.routes ?? [],
      configKeys: unique([...(candidate.configKeys ?? []), ...fileConfigKeys.filter((key) => raw.includes(key))]),
      databaseRefs: unique([
        ...(candidate.databaseRefs ?? []),
        ...fileDatabaseRefs.filter((reference) => raw.toLowerCase().includes(reference.toLowerCase())),
      ]),
      isTest: fileIsTest || candidate.kind === "test" || candidate.isTest === true,
      ...(candidate.kind === "comment"
        ? { docComment: raw.trim() }
        : precedingDocComment(source.content, detailed.comments, candidate.start)
          ? { docComment: precedingDocComment(source.content, detailed.comments, candidate.start) }
          : {}),
    });
  }
  return sortedFragments(fragments);
}
