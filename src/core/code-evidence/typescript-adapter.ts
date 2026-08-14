import { createHash } from "node:crypto";
import {
  TYPESCRIPT_ADAPTER_VERSION,
  type CodeFragmentKind,
  type CodeRoute,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "from", "function", "get", "if", "implements", "import",
  "in", "instanceof", "interface", "let", "new", "null", "of", "private", "protected",
  "public", "readonly", "return", "set", "static", "super", "switch", "this", "throw",
  "true", "try", "type", "typeof", "undefined", "var", "void", "while", "with", "yield",
]);

interface CommentSpan {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
  doc: boolean;
}

interface Candidate {
  kind: CodeFragmentKind;
  symbol: string;
  qualifiedName: string;
  definition: string;
  start: number;
  end: number;
  extraCalls?: string[];
  extraRoutes?: CodeRoute[];
}

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, content.length); index++) {
    if (content.charCodeAt(index) === 10) line++;
  }
  return line;
}

function lineEnd(content: string, offset: number): number {
  const newline = content.indexOf("\n", offset);
  return newline < 0 ? content.length : newline;
}

function cleanComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .replace(/^\s*\/\//gm, "")
    .replace(/^\s*\* ?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function commentsIn(content: string): CommentSpan[] {
  const spans: CommentSpan[] = [];
  const pattern = /\/\*\*[\s\S]*?\*\/|\/\*(?!\*)[\s\S]*?\*\/|(?:^|\n)\s*\/\/[^\n]*/g;
  for (const match of content.matchAll(pattern)) {
    const raw = match[0];
    const leadingNewline = raw.startsWith("\n") ? 1 : 0;
    const start = (match.index ?? 0) + leadingNewline;
    const text = cleanComment(raw.slice(leadingNewline));
    if (!text) continue;
    const end = (match.index ?? 0) + raw.length;
    spans.push({
      start,
      end,
      startLine: lineNumberAt(content, start),
      endLine: lineNumberAt(content, Math.max(start, end - 1)),
      text,
      doc: raw.slice(leadingNewline).startsWith("/**"),
    });
  }
  return spans;
}

/** Masks strings and comments while preserving byte offsets and newlines. */
function maskNonCode(content: string): string {
  const chars = [...content];
  let mode: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  let escaped = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (mode === "code") {
      if (char === "/" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        index++;
        mode = "line-comment";
      } else if (char === "/" && next === "*") {
        chars[index] = chars[index + 1] = " ";
        index++;
        mode = "block-comment";
      } else if (char === "'") {
        chars[index] = " ";
        mode = "single";
      } else if (char === "\"") {
        chars[index] = " ";
        mode = "double";
      } else if (char === "`") {
        chars[index] = " ";
        mode = "template";
      }
      continue;
    }
    if (char === "\n") {
      if (mode === "line-comment") mode = "code";
      escaped = false;
      continue;
    }
    chars[index] = " ";
    if (mode === "block-comment" && char === "*" && next === "/") {
      chars[index + 1] = " ";
      index++;
      mode = "code";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && mode !== "line-comment" && mode !== "block-comment") {
      escaped = true;
      continue;
    }
    if (
      (mode === "single" && char === "'") ||
      (mode === "double" && char === "\"") ||
      (mode === "template" && char === "`")
    ) {
      mode = "code";
    }
  }
  return chars.join("");
}

function matchingBrace(masked: string, open: number): number {
  if (open < 0 || masked[open] !== "{") return open;
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === "{") depth++;
    if (masked[index] === "}") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return masked.length;
}

function definitionLine(content: string, start: number): string {
  return content.slice(start, lineEnd(content, start)).trim().replace(/\s+/g, " ");
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

function identifiersIn(masked: string): string[] {
  const values: string[] = [];
  for (const match of masked.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const value = match[0];
    if (!KEYWORDS.has(value)) values.push(value);
  }
  return unique(values);
}

function callsIn(masked: string): string[] {
  const values: string[] = [];
  for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)) {
    const value = match[1]!;
    const finalPart = value.split(".").at(-1)!;
    if (!KEYWORDS.has(finalPart) && !["function", "if", "for", "while", "switch", "catch"].includes(finalPart)) {
      values.push(value, finalPart);
    }
  }
  return unique(values);
}

function importsIn(content: string): { modules: string[]; symbols: string[] } {
  const modules: string[] = [];
  const symbols: string[] = [];
  for (const match of content.matchAll(/\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const moduleName = match[2] ?? match[3] ?? match[4];
    if (moduleName) modules.push(moduleName);
    const clause = match[1];
    if (clause) {
      for (const identifier of clause.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!KEYWORDS.has(identifier)) symbols.push(identifier);
      }
    }
  }
  return { modules: unique(modules), symbols: unique(symbols) };
}

function routesIn(content: string): Array<{ route: CodeRoute; start: number; end: number }> {
  const routes: Array<{ route: CodeRoute; start: number; end: number }> = [];
  const pattern = /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|options|head|use)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:[A-Za-z_$][\w$]*\s*,\s*)*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/gi;
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    routes.push({
      route: { method: match[1]!.toUpperCase(), path: match[2]!, handler: match[3]! },
      start,
      end: lineEnd(content, start),
    });
  }
  return routes;
}

function configKeysIn(content: string): string[] {
  const keys: string[] = [];
  for (const match of content.matchAll(/\bprocess\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\])/g)) {
    keys.push(match[1] ?? match[2] ?? "");
  }
  for (const match of content.matchAll(/\b(?:config|getConfig)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\(\s*["']([^"']+)["']\s*\))/g)) {
    keys.push(match[1] ?? match[2] ?? "");
  }
  return unique(keys);
}

function databaseRefsIn(content: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(/\b(?:table|from|into|join)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi)) {
    refs.push(match[1]!);
  }
  for (const match of content.matchAll(/\b(?:from|join|into|update)\s+([A-Za-z_][\w.-]*)/gi)) {
    refs.push(match[1]!);
  }
  return unique(refs);
}

function fragmentId(path: string, kind: CodeFragmentKind, qualifiedName: string, startLine: number): string {
  const digest = createHash("sha256")
    .update(`${path}\0${kind}\0${qualifiedName}\0${startLine}`)
    .digest("hex")
    .slice(0, 20);
  return `symbol-${digest}`;
}

function precedingDocComment(content: string, comments: readonly CommentSpan[], start: number): string | undefined {
  const candidate = [...comments].reverse().find((comment) => comment.doc && comment.end <= start);
  if (!candidate) return undefined;
  return content.slice(candidate.end, start).trim() === "" ? candidate.text : undefined;
}

function testPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

function addDefinitionCandidates(content: string, masked: string, candidates: Candidate[]): void {
  const declaration = /(?:^|\n)[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(class|function)[ \t]+([A-Za-z_$][\w$]*)\b[^;\n{]*(?:\{|;)/g;
  for (const match of masked.matchAll(declaration)) {
    const prefix = match[0].startsWith("\n") ? 1 : 0;
    const start = (match.index ?? 0) + prefix;
    const open = masked.indexOf("{", start);
    const sameLineEnd = lineEnd(masked, start);
    const end = open >= 0 && open <= sameLineEnd ? matchingBrace(masked, open) : sameLineEnd;
    candidates.push({
      kind: match[1] === "class" ? "class" : "function",
      symbol: match[2]!,
      qualifiedName: match[2]!,
      definition: definitionLine(content, start),
      start,
      end,
    });
  }

  const arrow = /(?:^|\n)[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[^=\n]*=[ \t]*(?:async[ \t]*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*=>/g;
  for (const match of masked.matchAll(arrow)) {
    const prefix = match[0].startsWith("\n") ? 1 : 0;
    const start = (match.index ?? 0) + prefix;
    const afterArrow = start + match[0].lastIndexOf("=>") + 2;
    const open = masked.indexOf("{", afterArrow);
    const sameLineEnd = lineEnd(masked, start);
    const end = open >= 0 && open <= sameLineEnd ? matchingBrace(masked, open) : sameLineEnd;
    candidates.push({
      kind: "function",
      symbol: match[1]!,
      qualifiedName: match[1]!,
      definition: definitionLine(content, start),
      start,
      end,
    });
  }
}

function addMethodCandidates(content: string, masked: string, candidates: Candidate[]): void {
  const classes = candidates.filter((candidate) => candidate.kind === "class");
  for (const owner of classes) {
    const body = masked.slice(owner.start, owner.end);
    const method = /(?:^|\n)[ \t]*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)[ \t]+)*(constructor|[A-Za-z_$][\w$]*)[ \t]*(?:<[^\n>{}]+>)?[ \t]*\([^;{}]*\)[ \t]*(?::[ \t]*[^\n{]+)?[ \t]*\{/g;
    for (const match of body.matchAll(method)) {
      const prefix = match[0].startsWith("\n") ? 1 : 0;
      const start = owner.start + (match.index ?? 0) + prefix;
      if (start === owner.start) continue;
      const open = masked.indexOf("{", start);
      const symbol = match[1]!;
      candidates.push({
        kind: "method",
        symbol,
        qualifiedName: `${owner.symbol}.${symbol}`,
        definition: definitionLine(content, start),
        start,
        end: matchingBrace(masked, open),
      });
    }
  }
}

function addTestCandidates(content: string, masked: string, path: string, candidates: Candidate[]): void {
  const pattern = /\b(?:test|it)\s*\(\s*(["'`])([^"'`]+)\1\s*,/g;
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const open = masked.indexOf("{", start + match[0].length);
    const end = open >= 0 ? matchingBrace(masked, open) : lineEnd(content, start);
    candidates.push({
      kind: "test",
      symbol: match[2]!,
      qualifiedName: `test:${match[2]!}`,
      definition: definitionLine(content, start),
      start,
      end,
    });
  }
  if (testPath(path) && !candidates.some((candidate) => candidate.kind === "test")) {
    candidates.push({
      kind: "test",
      symbol: path.split("/").at(-1)!,
      qualifiedName: `test:${path}`,
      definition: `test module ${path}`,
      start: 0,
      end: content.length,
    });
  }
}

export class TypeScriptKnowledgeAdapter implements KnowledgeAdapter {
  readonly parserVersion = TYPESCRIPT_ADAPTER_VERSION;

  supports(source: Pick<CodeSource, "path">): boolean {
    return CODE_EXTENSIONS.has(extension(source.path));
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    if (!this.supports(source)) return [];
    const { content, path } = source;
    const masked = maskNonCode(content);
    const comments = commentsIn(content);
    const imports = importsIn(content);
    const candidates: Candidate[] = [{
      kind: "module",
      symbol: path,
      qualifiedName: path,
      definition: `module ${path}`,
      start: 0,
      end: content.length,
    }];
    addDefinitionCandidates(content, masked, candidates);
    addMethodCandidates(content, masked, candidates);
    addTestCandidates(content, masked, path, candidates);

    for (const item of routesIn(content)) {
      const symbol = `${item.route.method} ${item.route.path}`;
      candidates.push({
        kind: "route",
        symbol,
        qualifiedName: `route:${symbol}`,
        definition: definitionLine(content, item.start),
        start: item.start,
        end: item.end,
        extraCalls: item.route.handler ? [item.route.handler, item.route.handler.split(".").at(-1)!] : [],
        extraRoutes: [item.route],
      });
    }

    for (const comment of comments) {
      if (comment.text.length < 12 || comment.doc) continue;
      candidates.push({
        kind: "comment",
        symbol: `comment@${comment.startLine}`,
        qualifiedName: `${path}:comment@${comment.startLine}`,
        definition: comment.text.slice(0, 160),
        start: comment.start,
        end: comment.end,
      });
    }

    const isTestFile = testPath(path);
    const deduplicated = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const key = `${candidate.kind}\0${candidate.qualifiedName}\0${candidate.start}`;
      deduplicated.set(key, candidate);
    }

    const fragments: KnowledgeFragment[] = [];
    for (const candidate of deduplicated.values()) {
      const startLine = lineNumberAt(content, candidate.start);
      const endLine = Math.max(startLine, lineNumberAt(content, Math.max(candidate.start, candidate.end - 1)));
      const raw = content.slice(candidate.start, candidate.end);
      const code = masked.slice(candidate.start, candidate.end);
      const fragmentRoutes = candidate.extraRoutes ?? routesIn(raw).map((item) => item.route);
      const calls = unique([...(candidate.extraCalls ?? []), ...callsIn(code)]);
      const references = unique([
        ...identifiersIn(code),
        ...imports.symbols,
        ...calls.flatMap((call) => [call, call.split(".").at(-1)!]),
      ]).filter((identifier) => identifier !== candidate.symbol);
      const docComment = candidate.kind === "comment"
        ? raw.trim()
        : precedingDocComment(content, comments, candidate.start);
      fragments.push({
        id: fragmentId(path, candidate.kind, candidate.qualifiedName, startLine),
        path,
        symbol: candidate.symbol,
        qualifiedName: candidate.qualifiedName,
        kind: candidate.kind,
        definition: candidate.definition,
        range: { startLine, endLine },
        imports: imports.modules,
        references,
        calls,
        routes: fragmentRoutes,
        configKeys: configKeysIn(raw),
        databaseRefs: databaseRefsIn(raw),
        isTest: isTestFile || candidate.kind === "test",
        docComment,
      });
    }
    return fragments.sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.range.startLine - right.range.startLine ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    );
  }
}
