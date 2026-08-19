import {
  codeFragmentId,
  unique,
} from "./brace-language-engine.js";
import {
  PYTHON_ADAPTER_VERSION,
  type CodeFragmentKind,
  type CodeRoute,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

const PYTHON_EXTENSION_CLAIMS = [".py", ".pyi"] as const;
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "case",
  "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass",
  "raise", "return", "try", "while", "with", "yield",
]);

interface PythonStringSpan {
  start: number;
  quoteStart: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  quote: "'" | "\"";
  triple: boolean;
  raw: boolean;
  formatted: boolean;
  closed: boolean;
}

interface PythonCommentSpan {
  start: number;
  end: number;
  text: string;
}

export interface PythonMaskResult {
  masked: string;
  strings: PythonStringSpan[];
  comments: PythonCommentSpan[];
}

interface PhysicalLine {
  number: number;
  start: number;
  contentEnd: number;
  end: number;
  indentColumns: number;
  indentEnd: number;
}

interface PythonStatement {
  kind: "code" | "string";
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  indentColumns: number;
  rawNormalized: string;
  maskedNormalized: string;
  docText?: string;
}

interface PythonCandidate {
  symbol: string;
  qualifiedName: string;
  kind: CodeFragmentKind;
  header: PythonStatement;
  decorators: PythonStatement[];
  indentColumns: number;
  start: number;
  startLine: number;
  end: number;
  endLine: number;
  definition: string;
  isTest: boolean;
  isTestClass: boolean;
  docComment?: string;
  routes: CodeRoute[];
}

interface ImportInventory {
  imports: string[];
  references: string[];
}

function supportedPythonPath(path: string): boolean {
  const lower = path.toLowerCase();
  return PYTHON_EXTENSION_CLAIMS.some((claim) => lower.endsWith(claim));
}

function identifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/u.test(value);
}

function escapedAt(content: string, offset: number): boolean {
  let count = 0;
  for (let index = offset - 1; index >= 0 && content[index] === "\\"; index--) count++;
  return count % 2 === 1;
}

function stringTokenAt(content: string, offset: number): Omit<PythonStringSpan, "contentEnd" | "end" | "closed"> | undefined {
  if (offset < 0 || offset >= content.length || identifierCharacter(content[offset - 1])) return undefined;
  let quoteStart = offset;
  let prefix = "";
  if (content[offset] !== "'" && content[offset] !== "\"") {
    let cursor = offset;
    while (cursor < content.length && prefix.length < 4 && /[rRbBuUfF]/u.test(content[cursor]!)) {
      prefix += content[cursor]!;
      cursor++;
    }
    if (!prefix || (content[cursor] !== "'" && content[cursor] !== "\"") ||
        new Set(prefix.toLowerCase()).size !== prefix.length) return undefined;
    quoteStart = cursor;
  }
  const quote = content[quoteStart] as "'" | "\"";
  const triple = content.slice(quoteStart, quoteStart + 3) === quote.repeat(3);
  const delimiterLength = triple ? 3 : 1;
  return {
    start: offset,
    quoteStart,
    contentStart: quoteStart + delimiterLength,
    quote,
    triple,
    raw: prefix.toLowerCase().includes("r"),
    formatted: prefix.toLowerCase().includes("f"),
  };
}

function scanStringEnd(
  content: string,
  token: Omit<PythonStringSpan, "contentEnd" | "end" | "closed">,
  nesting = 0
): Pick<PythonStringSpan, "contentEnd" | "end" | "closed"> {
  const delimiter = token.quote.repeat(token.triple ? 3 : 1);
  let index = token.contentStart;
  let braceDepth = 0;
  while (index < content.length) {
    if (token.formatted && braceDepth > 0) {
      const nested = nesting < 32 ? stringTokenAt(content, index) : undefined;
      if (nested) {
        index = scanStringEnd(content, nested, nesting + 1).end;
        continue;
      }
      if (content[index] === "#") {
        const newline = content.indexOf("\n", index + 1);
        index = newline < 0 ? content.length : newline;
        continue;
      }
      if (content[index] === "{") braceDepth++;
      else if (content[index] === "}") braceDepth--;
      index++;
      continue;
    }
    if (content.startsWith(delimiter, index) && !escapedAt(content, index)) {
      return { contentEnd: index, end: index + delimiter.length, closed: true };
    }
    if (token.formatted && content[index] === "{") {
      if (content[index + 1] === "{") {
        index += 2;
        continue;
      }
      braceDepth = 1;
      index++;
      continue;
    }
    if (token.formatted && content[index] === "}" && content[index + 1] === "}") {
      index += 2;
      continue;
    }
    if (!token.triple && (content[index] === "\n" || content[index] === "\r")) {
      if (!token.raw && escapedAt(content, index)) {
        index++;
        continue;
      }
      return { contentEnd: index, end: index, closed: false };
    }
    index++;
  }
  return { contentEnd: content.length, end: content.length, closed: false };
}

function maskRangePreservingWidth(chars: string[], content: string, start: number, end: number): void {
  for (let index = start; index < Math.min(end, content.length); index++) {
    const value = content[index]!;
    if (value === "\n" || value === "\r") continue;
    const point = content.codePointAt(index)!;
    if (point > 0xffff && index + 1 < end) {
      chars[index] = "\ud800";
      chars[index + 1] = "\udc00";
      index++;
    } else if (point <= 0x7f) {
      chars[index] = " ";
    } else if (point <= 0x7ff) {
      chars[index] = "\u00a0";
    } else {
      chars[index] = "\u3000";
    }
  }
}

export function maskPythonSourceDetailed(content: string): PythonMaskResult {
  const chars = content.split("");
  const strings: PythonStringSpan[] = [];
  const comments: PythonCommentSpan[] = [];
  let index = 0;
  while (index < content.length) {
    const token = stringTokenAt(content, index);
    if (token) {
      const scanned = scanStringEnd(content, token);
      const span: PythonStringSpan = { ...token, ...scanned };
      strings.push(span);
      maskRangePreservingWidth(chars, content, span.start, span.end);
      index = Math.max(index + 1, span.end);
      continue;
    }
    if (content[index] === "#") {
      const newline = content.indexOf("\n", index + 1);
      const end = newline < 0 ? content.length : newline;
      comments.push({ start: index, end, text: content.slice(index + 1, end).trim() });
      maskRangePreservingWidth(chars, content, index, end);
      index = end;
      continue;
    }
    index++;
  }
  return { masked: chars.join(""), strings, comments };
}

export function maskPythonSource(content: string): string {
  return maskPythonSourceDetailed(content).masked;
}

function indentation(raw: string, start: number, end: number): { columns: number; end: number } {
  let columns = 0;
  let index = start;
  while (index < end) {
    if (raw[index] === " ") columns++;
    else if (raw[index] === "\t") columns += 8 - (columns % 8);
    else if (raw[index] === "\f") columns = 0;
    else break;
    index++;
  }
  return { columns, end: index };
}

function physicalLines(content: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;
  let number = 1;
  if (content.length === 0) {
    return [{ number, start: 0, contentEnd: 0, end: 0, indentColumns: 0, indentEnd: 0 }];
  }
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const rawEnd = newline < 0 ? content.length : newline;
    const contentEnd = rawEnd > start && content[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const measured = indentation(content, start, contentEnd);
    lines.push({
      number,
      start,
      contentEnd,
      end: newline < 0 ? content.length : newline + 1,
      indentColumns: measured.columns,
      indentEnd: measured.end,
    });
    if (newline < 0) break;
    start = newline + 1;
    number++;
  }
  return lines;
}

function lineForOffset(lines: readonly PhysicalLine[], offset: number): PhysicalLine {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle]!;
    if (offset < line.start) high = middle - 1;
    else if (offset >= line.end && middle < lines.length - 1) low = middle + 1;
    else return line;
  }
  return lines[Math.max(0, Math.min(lines.length - 1, low))]!;
}

function normalizeStatement(value: string): string {
  return value.replace(/\\\r?\n/gu, " ").replace(/\s+/gu, " ").trim();
}

function updateBracketDepth(value: string, initial: number): number {
  let depth = initial;
  for (const character of value) {
    if (character === "(" || character === "[" || character === "{") depth++;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function codeStatements(
  content: string,
  masked: string,
  lines: readonly PhysicalLine[],
  strings: readonly PythonStringSpan[]
): PythonStatement[] {
  const statements: PythonStatement[] = [];
  let active: { start: number; startLine: number; indentColumns: number } | undefined;
  let depth = 0;
  let stringIndex = 0;
  for (const line of lines) {
    const visible = masked.slice(line.start, line.contentEnd);
    if (!active && !visible.trim()) continue;
    if (!active) {
      active = { start: line.start, startLine: line.number, indentColumns: line.indentColumns };
      depth = 0;
    }
    depth = updateBracketDepth(visible, depth);
    const explicitContinuation = /\\\s*$/u.test(visible);
    if (depth > 0 || explicitContinuation) continue;
    let end = line.contentEnd;
    while (strings[stringIndex] && strings[stringIndex]!.end <= line.start) stringIndex++;
    for (let candidateIndex = stringIndex;
      candidateIndex < strings.length && strings[candidateIndex]!.start < line.end;
      candidateIndex++) {
      const span = strings[candidateIndex]!;
      if (span.start >= active.start && span.end > end) end = span.end;
    }
    const endLine = lineForOffset(lines, Math.max(active.start, end - 1)).number;
    statements.push({
      kind: "code",
      start: active.start,
      end,
      startLine: active.startLine,
      endLine,
      indentColumns: active.indentColumns,
      rawNormalized: normalizeStatement(content.slice(active.start, end)),
      maskedNormalized: normalizeStatement(masked.slice(active.start, end)),
    });
    active = undefined;
  }
  if (active) {
    statements.push({
      kind: "code",
      start: active.start,
      end: content.length,
      startLine: active.startLine,
      endLine: lines.at(-1)!.number,
      indentColumns: active.indentColumns,
      rawNormalized: normalizeStatement(content.slice(active.start)),
      maskedNormalized: normalizeStatement(masked.slice(active.start)),
    });
  }
  return statements;
}

function normalizedDocText(content: string, spans: readonly PythonStringSpan[]): string | undefined {
  if (spans.some((span) => !span.closed)) return undefined;
  const value = spans.map((span) => content.slice(span.contentStart, span.contentEnd)).join("");
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines.join("\n").replace(/\s+/gu, " ").trim() || undefined;
}

function standaloneStringStatements(
  content: string,
  lines: readonly PhysicalLine[],
  strings: readonly PythonStringSpan[]
): PythonStatement[] {
  const statements: PythonStatement[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < strings.length; index++) {
    if (consumed.has(index)) continue;
    const first = strings[index]!;
    const firstLine = lineForOffset(lines, first.start);
    if (content.slice(firstLine.start, first.start).trim()) continue;
    const group = [first];
    consumed.add(index);
    let cursor = first.end;
    let nextIndex = index + 1;
    while (nextIndex < strings.length) {
      const next = strings[nextIndex]!;
      if (lineForOffset(lines, cursor).number !== lineForOffset(lines, next.start).number ||
          content.slice(cursor, next.start).trim()) break;
      group.push(next);
      consumed.add(nextIndex);
      cursor = next.end;
      nextIndex++;
    }
    const endLine = lineForOffset(lines, Math.max(first.start, cursor - 1));
    const trailing = content.slice(cursor, endLine.contentEnd).trim();
    if (trailing && !trailing.startsWith("#")) continue;
    statements.push({
      kind: "string",
      start: first.start,
      end: cursor,
      startLine: firstLine.number,
      endLine: endLine.number,
      indentColumns: firstLine.indentColumns,
      rawNormalized: normalizeStatement(content.slice(first.start, cursor)),
      maskedNormalized: "",
      docText: normalizedDocText(content, group),
    });
  }
  return statements;
}

function pythonStatements(content: string, details: PythonMaskResult, lines: readonly PhysicalLine[]): PythonStatement[] {
  return [
    ...codeStatements(content, details.masked, lines, details.strings),
    ...standaloneStringStatements(content, lines, details.strings),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
}

function suiteHeader(value: string): RegExpMatchArray | undefined {
  const match = /^(?:(async)\s+)?(def|class)\s+([A-Za-z_]\w*)\b/u.exec(value) ?? undefined;
  if (!match || !value.includes(":")) return undefined;
  return match;
}

function decoratorStatement(statement: PythonStatement): boolean {
  return statement.kind === "code" && statement.maskedNormalized.startsWith("@");
}

function commentFallback(
  content: string,
  lines: readonly PhysicalLine[],
  startLine: number
): string | undefined {
  const comments: string[] = [];
  for (let number = startLine - 1; number >= 1; number--) {
    const line = lines[number - 1]!;
    const trimmed = content.slice(line.start, line.contentEnd).trim();
    if (!trimmed) break;
    if (!trimmed.startsWith("#")) break;
    comments.unshift(trimmed.replace(/^#+\s?/u, ""));
  }
  return comments.join(" ").replace(/\s+/gu, " ").trim() || undefined;
}

function pythonTestPath(path: string): boolean {
  return /(?:^|\/)tests?(?:\/|$)|(?:^|\/)test_[^/]*\.py$|_test\.py$/iu.test(path);
}

function decoratedAsTest(decorators: readonly PythonStatement[]): boolean {
  return decorators.some((item) => /^@pytest\.(?:mark\.|fixture\b)/u.test(item.rawNormalized));
}

function normalizedRoutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function decoratorRoutes(decorators: readonly PythonStatement[], handler: string): CodeRoute[] {
  const routes: CodeRoute[] = [];
  for (const decorator of decorators) {
    const value = decorator.rawNormalized;
    const direct = /^@[A-Za-z_]\w*\.(get|post|put|patch|delete|options|head)\s*\(\s*(["'])([^"'\r\n]*)\2/iu.exec(value);
    if (direct) {
      routes.push({ method: direct[1]!.toUpperCase(), path: normalizedRoutePath(direct[3]!), handler });
      continue;
    }
    const flask = /^@[A-Za-z_]\w*\.route\s*\(\s*(["'])([^"'\r\n]*)\1([\s\S]*)\)$/iu.exec(value);
    if (!flask) continue;
    const methods = [...flask[3]!.matchAll(/["']([A-Za-z]+)["']/gu)].map((match) => match[1]!.toUpperCase());
    for (const method of methods.length > 0 ? methods : ["GET"]) {
      routes.push({ method, path: normalizedRoutePath(flask[2]!), handler });
    }
  }
  return routes;
}

function suiteColonOffset(masked: string, header: PythonStatement): number | undefined {
  let depth = 0;
  for (let offset = header.start; offset < header.end; offset++) {
    const character = masked[offset];
    if (character === "(" || character === "[" || character === "{") depth++;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    else if (character === ":" && depth === 0) return offset;
  }
  return undefined;
}

function inlineDocstring(
  content: string,
  masked: string,
  strings: readonly PythonStringSpan[],
  header: PythonStatement
): string | undefined {
  const colon = suiteColonOffset(masked, header);
  if (colon === undefined) return undefined;
  const first = strings.find((span) => span.start > colon && span.end <= header.end);
  if (!first || content.slice(colon + 1, first.start).trim()) return undefined;
  const adjacent = [first];
  let cursor = first.end;
  for (const span of strings) {
    if (span.start <= first.start || span.end > header.end) continue;
    if (content.slice(cursor, span.start).trim()) break;
    adjacent.push(span);
    cursor = span.end;
  }
  return normalizedDocText(content, adjacent);
}

function candidateDocstring(
  statements: readonly PythonStatement[],
  header: PythonStatement,
  indentColumns: number
): string | undefined {
  for (const statement of statements) {
    if (statement.start <= header.end) continue;
    if (statement.indentColumns <= indentColumns) return undefined;
    return statement.kind === "string" ? statement.docText : undefined;
  }
  return undefined;
}

function buildCandidates(
  source: CodeSource,
  details: PythonMaskResult,
  statements: readonly PythonStatement[],
  lines: readonly PhysicalLine[],
  isStub: boolean
): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const stack: PythonCandidate[] = [];
  const fileIsTest = !isStub && pythonTestPath(source.path);
  const nextAtSameOrLowerIndent = new Array<number>(statements.length).fill(statements.length);
  const indentationStack: number[] = [];
  for (let index = statements.length - 1; index >= 0; index--) {
    while (indentationStack.length > 0 &&
      statements[indentationStack.at(-1)!]!.indentColumns > statements[index]!.indentColumns) {
      indentationStack.pop();
    }
    nextAtSameOrLowerIndent[index] = indentationStack.at(-1) ?? statements.length;
    indentationStack.push(index);
  }
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]!;
    if (statement.kind !== "code") continue;
    const headerMatch = suiteHeader(statement.maskedNormalized);
    if (!headerMatch) continue;
    const headerType = headerMatch[2]!;
    const symbol = headerMatch[3]!;
    while (stack.length > 0 && stack.at(-1)!.indentColumns >= statement.indentColumns) stack.pop();
    const parent = stack.at(-1);
    const decorators: PythonStatement[] = [];
    for (let previous = index - 1; previous >= 0; previous--) {
      const item = statements[previous]!;
      if (!decoratorStatement(item) || item.indentColumns !== statement.indentColumns) break;
      decorators.unshift(item);
    }
    const qualifiedName = parent ? `${parent.qualifiedName}.${symbol}` : symbol;
    const isClass = headerType === "class";
    const isTestClass = !isStub && isClass && (
      /\b(?:unittest\.)?TestCase\b/u.test(statement.rawNormalized) || /^Test[A-Z_]/u.test(symbol)
    );
    const inheritedTest = stack.some((item) => item.isTestClass);
    const testMarker = decoratedAsTest(decorators);
    const isTest = !isStub && (fileIsTest || inheritedTest || isTestClass || /^test(?:_|$)/u.test(symbol) || testMarker);
    const kind: CodeFragmentKind = isClass
      ? "class"
      : parent?.kind === "class"
        ? "method"
        : isTest
          ? "test"
          : "function";
    const lastBodyStatement = statements[Math.max(index, nextAtSameOrLowerIndent[index]! - 1)]!;
    const endLine = Math.max(statement.endLine, lastBodyStatement.endLine);
    const endLineRecord = lines[Math.max(0, Math.min(lines.length - 1, endLine - 1))]!;
    const docComment = inlineDocstring(source.content, details.masked, details.strings, statement) ??
      candidateDocstring(statements, statement, statement.indentColumns) ??
      commentFallback(source.content, lines, (decorators[0] ?? statement).startLine);
    const routes = isStub || isClass ? [] : decoratorRoutes(decorators, qualifiedName);
    const candidate: PythonCandidate = {
      symbol,
      qualifiedName,
      kind,
      header: statement,
      decorators,
      indentColumns: statement.indentColumns,
      start: (decorators[0] ?? statement).start,
      startLine: (decorators[0] ?? statement).startLine,
      end: endLineRecord.contentEnd,
      endLine,
      definition: statement.rawNormalized,
      isTest,
      isTestClass,
      ...(docComment ? { docComment } : {}),
      routes,
    };
    candidates.push(candidate);
    stack.push(candidate);
  }
  return candidates;
}

function pythonImports(statements: readonly PythonStatement[], content: string): ImportInventory {
  const imports: string[] = [];
  const references: string[] = [];
  for (const statement of statements) {
    if (statement.kind !== "code") continue;
    const value = statement.maskedNormalized;
    const direct = /^import\s+(.+)$/u.exec(value);
    if (direct) {
      for (const item of direct[1]!.split(",")) {
        const match = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(item.trim());
        if (!match) continue;
        imports.push(match[1]!);
        references.push(match[2] ?? match[1]!.split(".")[0]!);
      }
      continue;
    }
    const from = /^from\s+(\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.+)\s+import\s+(.+)$/u.exec(value);
    if (!from) continue;
    imports.push(from[1]!);
    const imported = from[2]!.replace(/^\(|\)$/gu, "");
    for (const item of imported.split(",")) {
      const match = /^([A-Za-z_]\w*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(item.trim());
      if (match && match[1] !== "*") references.push(match[2] ?? match[1]!);
    }
  }
  const allAssignment = /\b__all__\s*=\s*[[(]([\s\S]*?)[\])]/gu.exec(content);
  if (allAssignment) {
    for (const match of allAssignment[1]!.matchAll(/["']([A-Za-z_]\w*)["']/gu)) references.push(match[1]!);
  }
  return { imports: unique(imports), references: unique(references) };
}

function callsIn(masked: string): string[] {
  const values: string[] = [];
  for (const match of masked.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/gu)) {
    const value = match[1]!;
    const before = masked.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
    const finalPart = value.split(".").at(-1)!;
    if (/\b(?:class|def)\s*$/u.test(before) || PYTHON_KEYWORDS.has(finalPart)) continue;
    values.push(value, finalPart);
  }
  return unique(values);
}

function identifiersIn(masked: string): string[] {
  return unique([...masked.matchAll(/\b[A-Za-z_]\w*\b/gu)]
    .map((match) => match[0])
    .filter((value) => !PYTHON_KEYWORDS.has(value)));
}

function pythonConfigKeys(content: string, masked = maskPythonSource(content)): string[] {
  const values: string[] = [];
  const stringValuePatterns = [
    /\bos\.environ\s*\[\s*["']([^"']+)["']\s*\]/gu,
    /\bos\.environ\.get\s*\(\s*["']([^"']+)["']/gu,
    /\bos\.getenv\s*\(\s*["']([^"']+)["']/gu,
  ];
  for (const pattern of stringValuePatterns) {
    for (const match of content.matchAll(pattern)) {
      if (masked.slice(match.index, match.index! + 2) === "os") values.push(match[1]!);
    }
  }
  for (const match of masked.matchAll(/\bsettings\.([A-Z][A-Z0-9_]*)\b/gu)) values.push(match[1]!);
  return unique(values);
}

function pythonDatabaseRefs(
  content: string,
  strings: readonly PythonStringSpan[],
  masked = maskPythonSource(content)
): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(/\b(?:__tablename__|db_table)\s*=\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/gu)) {
    if (masked[match.index!] !== " ") values.push(match[1]!);
  }
  for (const match of content.matchAll(/\bTable\s*\(\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/gu)) {
    if (masked[match.index!] !== " ") values.push(match[1]!);
  }
  for (const span of strings) {
    const lineStart = content.lastIndexOf("\n", Math.max(0, span.start - 1)) + 1;
    if (!content.slice(lineStart, span.start).trim()) continue;
    const text = content.slice(span.contentStart, span.contentEnd);
    if (!(
      /\bSELECT\b[\s\S]*\bFROM\b/iu.test(text) ||
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/iu.test(text)
    )) continue;
    for (const match of text.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/giu)) {
      values.push(match[1]!);
    }
  }
  return unique(values);
}

function matchingParenthesis(masked: string, open: number, fallback: number): number {
  if (open < 0) return fallback;
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === "(") depth++;
    else if (masked[index] === ")" && --depth === 0) return index + 1;
  }
  return fallback;
}

function routeFragments(
  source: CodeSource,
  masked: string,
  lines: readonly PhysicalLine[],
  statements: readonly PythonStatement[],
  candidates: readonly PythonCandidate[],
  imports: readonly string[],
  isStub: boolean
): KnowledgeFragment[] {
  if (isStub) return [];
  const fragments: KnowledgeFragment[] = [];
  for (const candidate of candidates) {
    for (const route of candidate.routes) {
      const symbol = `${route.method} ${route.path}`;
      const qualifiedName = `route:${symbol}:${candidate.qualifiedName}`;
      fragments.push({
        id: codeFragmentId(source.path, "route", qualifiedName, candidate.startLine),
        path: source.path,
        symbol,
        qualifiedName,
        kind: "route",
        definition: candidate.definition,
        range: { startLine: candidate.startLine, endLine: candidate.endLine },
        imports: [...imports],
        references: [candidate.symbol, candidate.qualifiedName],
        calls: [],
        routes: [route],
        configKeys: pythonConfigKeys(
          source.content.slice(candidate.start, candidate.end),
          masked.slice(candidate.start, candidate.end)
        ),
        databaseRefs: [],
        isTest: candidate.isTest,
        ...(candidate.docComment ? { docComment: candidate.docComment } : {}),
      });
    }
  }
  if (!/(?:^|\/)urls\.py$/iu.test(source.path)) return fragments;
  for (const statement of statements) {
    if (statement.kind !== "code") continue;
    const raw = source.content.slice(statement.start, statement.end);
    for (const route of raw.matchAll(
      /\b(?:re_path|path)\s*\(\s*[rRuUbBfF]{0,3}(["'])([^"'\r\n]*)\1\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/gu
    )) {
      const path = normalizedRoutePath(route[2]!);
      const handler = route[3]!;
      const codeRoute: CodeRoute = { method: "ANY", path, handler };
      const symbol = `ANY ${path}`;
      const qualifiedName = `route:${symbol}:${handler}`;
      const start = statement.start + (route.index ?? 0);
      const open = source.content.indexOf("(", start);
      const end = matchingParenthesis(masked, open, statement.end);
      const startLine = lineForOffset(lines, start).number;
      const endLine = lineForOffset(lines, Math.max(start, end - 1)).number;
      fragments.push({
        id: codeFragmentId(source.path, "route", qualifiedName, startLine),
        path: source.path,
        symbol,
        qualifiedName,
        kind: "route",
        definition: normalizeStatement(source.content.slice(start, end)),
        range: { startLine, endLine },
        imports: [...imports],
        references: [handler],
        calls: [handler],
        routes: [codeRoute],
        configKeys: [],
        databaseRefs: [],
        isTest: false,
      });
    }
  }
  return fragments;
}

function commentFragments(
  source: CodeSource,
  comments: readonly PythonCommentSpan[],
  lines: readonly PhysicalLine[],
  imports: readonly string[],
  isTest: boolean
): KnowledgeFragment[] {
  return comments.filter((comment) => comment.text.length >= 12).map((comment) => {
    const startLine = lineForOffset(lines, comment.start).number;
    const qualifiedName = `${source.path}:comment@${startLine}`;
    return {
      id: codeFragmentId(source.path, "comment", qualifiedName, startLine),
      path: source.path,
      symbol: `comment@${startLine}`,
      qualifiedName,
      kind: "comment",
      definition: comment.text.slice(0, 160),
      range: { startLine, endLine: lineForOffset(lines, Math.max(comment.start, comment.end - 1)).number },
      imports: [...imports],
      references: [],
      calls: [],
      routes: [],
      configKeys: [],
      databaseRefs: [],
      isTest,
      docComment: comment.text,
    } satisfies KnowledgeFragment;
  });
}

export class PythonKnowledgeAdapter implements KnowledgeAdapter {
  readonly parserVersion = PYTHON_ADAPTER_VERSION;
  readonly extensionClaims = PYTHON_EXTENSION_CLAIMS;

  supports(source: Pick<CodeSource, "path">): boolean {
    return supportedPythonPath(source.path);
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    if (!this.supports(source)) return [];
    const details = maskPythonSourceDetailed(source.content);
    const lines = physicalLines(source.content);
    const statements = pythonStatements(source.content, details, lines);
    const isStub = source.path.toLowerCase().endsWith(".pyi");
    const candidates = buildCandidates(source, details, statements, lines, isStub);
    const inventory = pythonImports(statements, source.content);
    const moduleDoc = statements[0]?.kind === "string" && statements[0].indentColumns === 0
      ? statements[0].docText
      : undefined;
    const moduleEndLine = lineForOffset(lines, Math.max(0, source.content.length - 1)).number;
    const moduleConfig = pythonConfigKeys(source.content, details.masked);
    const moduleDatabase = pythonDatabaseRefs(source.content, details.strings, details.masked);
    const moduleCalls = callsIn(details.masked);
    const fragments: KnowledgeFragment[] = [{
      id: codeFragmentId(source.path, "module", source.path, 1),
      path: source.path,
      symbol: source.path,
      qualifiedName: source.path,
      kind: "module",
      definition: `module ${source.path}`,
      range: { startLine: 1, endLine: moduleEndLine },
      imports: inventory.imports,
      references: unique([...inventory.references, ...identifiersIn(details.masked), ...moduleCalls]),
      calls: moduleCalls,
      routes: candidates.flatMap((candidate) => candidate.routes),
      configKeys: moduleConfig,
      databaseRefs: moduleDatabase,
      isTest: !isStub && pythonTestPath(source.path),
      ...(moduleDoc ? { docComment: moduleDoc } : {}),
    }];
    for (const candidate of candidates) {
      const raw = source.content.slice(candidate.start, candidate.end);
      const masked = details.masked.slice(candidate.start, candidate.end);
      const calls = callsIn(masked);
      const references = unique([
        ...inventory.references,
        ...identifiersIn(masked),
        ...calls,
      ]).filter((value) => value !== candidate.symbol && value !== candidate.qualifiedName);
      const localStrings = details.strings.filter((span) => span.start >= candidate.start && span.end <= candidate.end);
      fragments.push({
        id: codeFragmentId(source.path, candidate.kind, candidate.qualifiedName, candidate.startLine),
        path: source.path,
        symbol: candidate.symbol,
        qualifiedName: candidate.qualifiedName,
        kind: candidate.kind,
        definition: candidate.definition,
        range: { startLine: candidate.startLine, endLine: candidate.endLine },
        imports: inventory.imports,
        references,
        calls,
        routes: candidate.routes,
        configKeys: pythonConfigKeys(raw, masked),
        databaseRefs: pythonDatabaseRefs(raw, localStrings.map((span) => ({
          ...span,
          start: span.start - candidate.start,
          quoteStart: span.quoteStart - candidate.start,
          contentStart: span.contentStart - candidate.start,
          contentEnd: span.contentEnd - candidate.start,
          end: span.end - candidate.start,
        })), masked),
        isTest: candidate.isTest,
        ...(candidate.docComment ? { docComment: candidate.docComment } : {}),
      });
    }
    fragments.push(...routeFragments(source, details.masked, lines, statements, candidates, inventory.imports, isStub));
    fragments.push(...commentFragments(
      source,
      details.comments,
      lines,
      inventory.imports,
      !isStub && pythonTestPath(source.path)
    ));
    const deduplicated = new Map<string, KnowledgeFragment>();
    for (const fragment of fragments) deduplicated.set(fragment.id, fragment);
    return [...deduplicated.values()].sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.range.startLine - right.range.startLine ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    );
  }
}
