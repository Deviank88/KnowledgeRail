import { createJavaScriptImportResolver } from "./import-resolution/javascript.js";
import { JAVASCRIPT_PROJECT_MANIFESTS } from "./import-resolution/javascript-config.js";
import { SALESFORCE_MANIFEST } from "./import-resolution/salesforce-config.js";
import { createHash } from "node:crypto";
import {
  TYPESCRIPT_ADAPTER_VERSION,
  type CodeFragmentKind,
  type CodeRoute,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

export const TYPESCRIPT_EXTENSION_CLAIMS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".js-meta.xml",
] as const;

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

function isLwcMetadata(path: string): boolean {
  return path.toLowerCase().endsWith(".js-meta.xml");
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

const REGEX_PREFIX_WORDS = new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await", "else", "do"]);

/** Masks strings, expression-position regexes and comments, preserving UTF-16 offsets. */
function maskNonCode(content: string): string {
  const chars = content.split("");
  let mode: "code" | "single" | "double" | "template" | "regex" | "line-comment" | "block-comment" = "code";
  let escaped = false;
  let regexClass = false;
  let previousToken = "";
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
      } else if (char === "/" && (!previousToken || REGEX_PREFIX_WORDS.has(previousToken) || /^[([{=,:;!&|?+*%~^<>-]$/u.test(previousToken))) {
        chars[index] = " ";
        mode = "regex";
        regexClass = false;
        previousToken = "literal";
      } else if (char === "'") {
        chars[index] = " ";
        mode = "single";
        previousToken = "literal";
      } else if (char === "\"") {
        chars[index] = " ";
        mode = "double";
        previousToken = "literal";
      } else if (char === "`") {
        chars[index] = " ";
        mode = "template";
        previousToken = "literal";
      } else if (/[A-Za-z_$]/u.test(char)) {
        const start = index;
        while (index + 1 < chars.length && /[\w$]/u.test(chars[index + 1]!)) index++;
        previousToken = previousToken === "." ? "literal" : content.slice(start, index + 1);
      } else if (!/\s/u.test(char)) {
        if ((char === "+" || char === "-") && next === char) { index++; previousToken = "literal"; }
        else previousToken = char;
      }
      continue;
    }
    if (char === "\n") {
      if (mode === "line-comment" || mode === "regex") mode = "code";
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
    if (mode === "regex") {
      if (char === "[") regexClass = true;
      else if (char === "]") regexClass = false;
      else if (char === "/" && !regexClass) {
        mode = "code";
        while (index + 1 < chars.length && /[dgimsuvy]/u.test(chars[index + 1]!)) chars[++index] = " ";
      }
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

function importsIn(content: string, masked: string): { modules: string[]; symbols: string[]; statements: NonNullable<KnowledgeFragment["importStatements"]>; unsupported: string[] } {
  const modules: string[] = [];
  const symbols: string[] = [];
  const statements: NonNullable<KnowledgeFragment["importStatements"]> = [], unsupported: string[] = [];
  const triviaEnd = (start: number): number => {
    let position = start;
    while (position < content.length) {
      if (/\s/u.test(content[position]!)) { position++; continue; }
      if (content.startsWith("/*", position)) { const end = content.indexOf("*/", position + 2); if (end < 0) return content.length; position = end + 2; continue; }
      if (content.startsWith("//", position)) { const end = content.indexOf("\n", position + 2); if (end < 0) return content.length; position = end + 1; continue; }
      break;
    }
    return position;
  };
  const literal = (start: number): { value: string; end: number } | undefined => {
    const open = triviaEnd(start), quote = content[open];
    if (quote !== '"' && quote !== "'") return;
    for (let end = open + 1; end < content.length; end++) {
      if (content[end] === "\n" || content[end] === "\r") return;
      if (content[end] === "\\") { end++; continue; }
      if (content[end] === quote) return { value: content.slice(open + 1, end), end: end + 1 };
    }
  };
  for (const anchor of masked.matchAll(/\b(?:import|require)\b/gu)) {
    let previous = anchor.index - 1;
    while (previous >= 0 && /\s/u.test(masked[previous]!)) previous--;
    if (masked[previous] === ".") continue;
    const start = triviaEnd(anchor.index + anchor[0].length);
    let module: ReturnType<typeof literal>, clause: string | undefined;
    if (anchor[0] === "require" || content[start] === "(") {
      if (content[start] !== "(") continue;
      module = literal(start + 1);
      if (!module || content[triviaEnd(module.end)] !== ")") {
        unsupported.push(`dynamic ${anchor[0]} at line ${lineNumberAt(content, anchor.index)}`);
        continue;
      }
    } else {
      module = literal(start);
      if (!module) {
        // Scan visible tokens once per declaration. Quoted export names and
        // comments may occur inside bindings; fake `from` text is masked.
        const tokens = /[{};()]|\b(?:from|import|require|export|function|const|let|var|class)\b/gu;
        tokens.lastIndex = start;
        let depth = 0, token: RegExpExecArray | null;
        while ((token = tokens.exec(masked))) {
          if (token[0] === "{") { if (++depth > 1) break; continue; }
          if (token[0] === "}") { if (--depth < 0) break; continue; }
          if (depth) continue;
          if (token[0] !== "from") break;
          module = literal(token.index + token[0].length);
          if (module) { clause = content.slice(start, token.index); break; }
        }
      }
    }
    if (module?.value) {
      modules.push(module.value);
      statements.push({ specifier: module.value, kind: anchor[0] === "require" ? "require" : "import" });
    }
    if (clause) {
      for (const identifier of clause.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!KEYWORDS.has(identifier)) symbols.push(identifier);
      }
    }
  }
  return { modules: unique(modules), symbols: unique(symbols), statements, unsupported };
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

function lwcExtrasIn(content: string): { references: string[]; calls: string[] } {
  const references: string[] = [];
  const calls: string[] = [];
  for (const match of content.matchAll(/@(api|track|wire)\b(?:\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?))?/g)) {
    references.push(match[1]!);
    if (match[2]) {
      references.push(match[2], match[2].split(".").at(-1)!);
      calls.push(match[2], match[2].split(".").at(-1)!);
    }
  }
  return { references: unique(references), calls: unique(calls) };
}

function isLwcComponentSource(path: string, content: string, masked: string): boolean {
  if (!path.toLowerCase().endsWith(".js")) return false;
  for (const match of content.matchAll(/\bimport\s+[\s\S]*?\s+from\s+["']lwc["']/g)) {
    const start = match.index ?? 0;
    if (masked.slice(start, start + "import".length) === "import") return true;
  }
  return false;
}

function lwcTargetsIn(content: string): string[] {
  const visible = content.replace(/<!--[\s\S]*?-->/gu, (comment) =>
    comment.replace(/[^\r\n]/gu, " ")
  );
  return unique([...visible.matchAll(/<target>\s*([^<]+?)\s*<\/target>/gi)].map((match) => match[1]!));
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

/** Parameter/type braces are not the function body. Input has strings/comments masked. */
function functionBodyOpen(masked: string, start: number): number {
  let genericDepth = 0;
  let parameters = -1;
  for (let index = start; index < masked.length; index++) {
    const char = masked[index];
    if (char === "<") genericDepth++;
    else if (char === ">" && genericDepth && masked[index - 1] !== "=") genericDepth--;
    else if (char === "(" && !genericDepth) { parameters = index; break; }
    else if (char === ";" && !genericDepth) break;
  }
  if (parameters < 0) return -1;
  let depth = 1;
  let cursor = parameters + 1;
  for (; cursor < masked.length && depth > 0; cursor++) {
    if (masked[cursor] === "(") depth++;
    else if (masked[cursor] === ")") depth--;
  }
  if (depth) return -1;
  let angles = 0;
  let parentheses = 0;
  let brackets = 0;
  let previous = ")";
  for (; cursor < masked.length; cursor++) {
    const char = masked[cursor]!;
    if (/\s/u.test(char)) continue;
    if (char === ";" && !angles && !parentheses && !brackets) return -1;
    if (char === "{") {
      const typeBrace = angles || parentheses || brackets || [":", "|", "&", "=", "=>"].includes(previous);
      if (!typeBrace) return cursor;
      cursor = matchingBrace(masked, cursor) - 1;
    } else if (char === "<") angles++;
    else if (char === ">" && angles && masked[cursor - 1] !== "=") angles--;
    else if (char === "(") parentheses++;
    else if (char === ")") parentheses--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    previous = char === ">" && masked[cursor - 1] === "=" ? "=>" : char;
  }
  return -1;
}

function addDefinitionCandidates(content: string, masked: string, candidates: Candidate[]): void {
  const declaration = /(?:^|\n)[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(class|function)[ \t]+([A-Za-z_$][\w$]*)\b/g;
  for (const match of masked.matchAll(declaration)) {
    const prefix = match[0].startsWith("\n") ? 1 : 0;
    const start = (match.index ?? 0) + prefix;
    const open = match[1] === "function"
      ? functionBodyOpen(masked, (match.index ?? 0) + match[0].length)
      : masked.indexOf("{", start);
    const sameLineEnd = lineEnd(masked, start);
    const end = open >= 0 && (match[1] === "function" || open <= sameLineEnd) ? matchingBrace(masked, open) : sameLineEnd;
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
  readonly createImportResolver = createJavaScriptImportResolver;
  readonly projectManifests = [...JAVASCRIPT_PROJECT_MANIFESTS, SALESFORCE_MANIFEST];
  readonly parserVersion = TYPESCRIPT_ADAPTER_VERSION;
  readonly extensionClaims = TYPESCRIPT_EXTENSION_CLAIMS;

  supports(source: Pick<CodeSource, "path">): boolean {
    return this.extensionClaims.some((claim) => source.path.toLowerCase().endsWith(claim));
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    if (!this.supports(source)) return [];
    const { content, path } = source;
    if (isLwcMetadata(path)) {
      const endLine = Math.max(1, content.split(/\r?\n/).length);
      return [{
        id: fragmentId(path, "module", path, 1),
        path,
        symbol: path,
        qualifiedName: path,
        kind: "module",
        definition: `LWC metadata ${path}`,
        range: { startLine: 1, endLine },
        imports: [],
        references: [],
        calls: [],
        routes: [],
        configKeys: lwcTargetsIn(content),
        databaseRefs: [],
        isTest: false,
      }];
    }
    const masked = maskNonCode(content);
    const comments = commentsIn(content);
    const imports = importsIn(content, masked);
    const isLwcComponent = isLwcComponentSource(path, content, masked);
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
      const lwc = isLwcComponent ? lwcExtrasIn(code) : { references: [], calls: [] };
      const calls = unique([...(candidate.extraCalls ?? []), ...callsIn(code), ...lwc.calls]);
      const references = unique([
        ...identifiersIn(code),
        ...imports.symbols,
        ...lwc.references,
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
        ...(candidate.kind === "module" ? {
          ...(imports.statements.length ? { importStatements: imports.statements } : {}),
          ...(imports.unsupported.length ? { unsupportedImports: imports.unsupported } : {}),
        } : {}),
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
