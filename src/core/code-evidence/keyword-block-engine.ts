import {
  codeFragmentId,
  definitionLine,
  lineEnd,
  lineNumberAt,
  lineStart,
  maskRangePreservingWidth,
  matchingBrace,
  unique,
} from "./brace-language-engine.js";
import type {
  CodeFragmentKind,
  CodeRoute,
  CodeSource,
  KnowledgeFragment,
} from "./types.js";

interface CommentSpan {
  start: number;
  end: number;
  text: string;
}

export interface RubyMaskResult {
  masked: string;
  comments: CommentSpan[];
}

interface PhysicalLine {
  start: number;
  end: number;
}

interface RubyCandidate {
  kind: CodeFragmentKind;
  symbol: string;
  qualifiedName: string;
  start: number;
  end?: number;
  definition?: string;
  references?: string[];
  calls?: string[];
  routes?: CodeRoute[];
  databaseRefs?: string[];
  isTest?: boolean;
}

interface BlockFrame {
  candidate?: RubyCandidate;
  singletonOwner?: string;
}

const RUBY_KEYWORDS = new Set([
  "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined", "do", "else",
  "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not", "or", "redo",
  "rescue", "retry", "return", "self", "super", "then", "true", "undef", "unless", "until", "when",
  "while", "yield",
]);

function escapedAt(content: string, offset: number): boolean {
  let count = 0;
  for (let index = offset - 1; index >= 0 && content[index] === "\\"; index--) count++;
  return count % 2 === 1;
}

function quotedEnd(content: string, start: number, quote: string, interpolation: boolean, nesting = 0): number {
  let index = start + 1;
  let braceDepth = 0;
  while (index < content.length) {
    if (braceDepth > 0) {
      if (nesting < 32 && (content[index] === "\"" || content[index] === "'" || content[index] === "`")) {
        const nestedQuote = content[index]!;
        index = quotedEnd(content, index, nestedQuote, nestedQuote !== "'", nesting + 1);
        continue;
      }
      if (content[index] === "{") braceDepth++;
      else if (content[index] === "}") braceDepth--;
      index++;
      continue;
    }
    if (content[index] === quote && !escapedAt(content, index)) return index + 1;
    if (interpolation && content[index] === "#" && content[index + 1] === "{") {
      braceDepth = 1;
      index += 2;
      continue;
    }
    if (content[index] === "\n" && quote !== "`") return index;
    index++;
  }
  return content.length;
}

function percentLiteralEnd(content: string, start: number): number | undefined {
  const match = /^%(?:[qQwWiIxrs])?([^A-Za-z0-9\s=])/u.exec(content.slice(start, start + 4));
  if (!match) return undefined;
  const open = match[1]!;
  const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
  let depth = 1;
  for (let index = start + match[0].length; index < content.length; index++) {
    if (escapedAt(content, index)) continue;
    if (open !== close && content[index] === open) depth++;
    else if (content[index] === close && --depth === 0) {
      let end = index + 1;
      if (/^%r/u.test(match[0])) while (/[a-z]/iu.test(content[end] ?? "")) end++;
      return end;
    }
  }
  return content.length;
}

function regexAllowed(content: string, offset: number): boolean {
  const prefix = content.slice(lineStart(content, offset), offset).trimEnd();
  if (!prefix || /[=([{,:;!?&|+*%^~<>-]$/u.test(prefix)) return true;
  const word = /([A-Za-z_]\w*[!?=]?)$/u.exec(prefix)?.[1]?.toLowerCase();
  return word !== undefined && [
    "and", "begin", "case", "do", "if", "in", "not", "or", "rescue", "return", "then", "unless",
    "until", "when", "while", "yield",
  ].includes(word);
}

function regexEnd(content: string, start: number): number {
  let characterClass = false;
  for (let index = start + 1; index < content.length; index++) {
    if (content[index] === "\n" || content[index] === "\r") return index;
    if (escapedAt(content, index)) continue;
    if (content[index] === "[") characterClass = true;
    else if (content[index] === "]") characterClass = false;
    else if (content[index] === "/" && !characterClass) {
      let end = index + 1;
      while (/[a-z]/iu.test(content[end] ?? "")) end++;
      return end;
    }
  }
  return content.length;
}

function physicalLines(content: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline + 1;
    lines.push({ start, end });
    start = end;
  }
  if (content.length === 0) lines.push({ start: 0, end: 0 });
  return lines;
}

function rubyCodePosition(line: string, sought: number): boolean {
  for (let index = 0; index < sought;) {
    if (line[index] === "#") return false;
    if (line[index] === "\"" || line[index] === "'" || line[index] === "`") {
      const quote = line[index]!;
      const end = quotedEnd(line, index, quote, quote !== "'");
      if (end > sought) return false;
      index = end;
      continue;
    }
    if (line[index] === "%") {
      const end = percentLiteralEnd(line, index);
      if (end !== undefined) {
        if (end > sought) return false;
        index = end;
        continue;
      }
    }
    if (line[index] === "/" && regexAllowed(line, index)) {
      const end = regexEnd(line, index);
      if (end > sought) return false;
      index = end;
      continue;
    }
    index++;
  }
  return true;
}

function heredocRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = physicalLines(content);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const raw = content.slice(line.start, line.end);
    const markers = [...raw.matchAll(/<<[-~]?(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/gu)]
      .filter((marker) => {
        if (!rubyCodePosition(raw, marker.index ?? 0)) return false;
        if (/^<<[-~]/u.test(marker[0])) return true;
        const prefix = raw.slice(0, marker.index ?? 0).trimEnd();
        return !prefix || /[=([{,:;]$/u.test(prefix);
      });
    if (markers.length === 0 || raw.trimStart().startsWith("#")) continue;
    let bodyLine = lineIndex + 1;
    for (const marker of markers) {
      const delimiter = marker[1] ?? marker[2] ?? marker[3]!;
      const indentedTerminator = /^<<[-~]/u.test(marker[0]);
      ranges.push({
        start: line.start + (marker.index ?? 0),
        end: line.start + (marker.index ?? 0) + marker[0].length,
      });
      const bodyStart = lines[bodyLine]?.start;
      if (bodyStart === undefined) continue;
      let terminator = bodyLine;
      while (terminator < lines.length) {
        const physical = content.slice(lines[terminator]!.start, lines[terminator]!.end)
          .replace(/\r?\n$/u, "");
        const candidate = indentedTerminator ? physical.trim() : physical;
        if (candidate === delimiter) break;
        terminator++;
      }
      const bodyEnd = terminator < lines.length ? lines[terminator]!.end : content.length;
      ranges.push({ start: bodyStart, end: bodyEnd });
      bodyLine = Math.min(lines.length, terminator + 1);
    }
    lineIndex = Math.max(lineIndex, bodyLine - 1);
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function maskRubySourceDetailed(content: string): RubyMaskResult {
  const chars = content.split("");
  const comments: CommentSpan[] = [];
  const ranges = heredocRanges(content);
  let rangeIndex = 0;
  for (let index = 0; index < content.length;) {
    const range = ranges[rangeIndex];
    if (range && index === range.start) {
      maskRangePreservingWidth(chars, range.start, range.end);
      index = range.end;
      rangeIndex++;
      continue;
    }
    if (range && index > range.start) {
      rangeIndex++;
      continue;
    }
    if (content[index] === "=" && content.slice(lineStart(content, index), index).trim() === "" &&
        content.startsWith("=begin", index)) {
      const close = /^(?:=end)\b/gmu;
      close.lastIndex = lineEnd(content, index) + 1;
      const found = close.exec(content);
      const end = found ? lineEnd(content, found.index) : content.length;
      maskRangePreservingWidth(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "#") {
      const end = lineEnd(content, index);
      comments.push({ start: index, end, text: content.slice(index + 1, end).trim() });
      maskRangePreservingWidth(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "\"" || content[index] === "'" || content[index] === "`") {
      const quote = content[index]!;
      const end = quotedEnd(content, index, quote, quote !== "'");
      maskRangePreservingWidth(chars, index, end);
      index = end;
      continue;
    }
    if (content[index] === "%") {
      const end = percentLiteralEnd(content, index);
      if (end !== undefined) {
        maskRangePreservingWidth(chars, index, end);
        index = end;
        continue;
      }
    }
    if (content[index] === "/" && regexAllowed(content, index)) {
      const end = regexEnd(content, index);
      maskRangePreservingWidth(chars, index, end);
      index = end;
      continue;
    }
    index++;
  }
  return { masked: chars.join(""), comments };
}

export function maskRubySource(content: string): string {
  return maskRubySourceDetailed(content).masked;
}

function precedingDoc(content: string, start: number): string | undefined {
  const before = content.slice(0, lineStart(content, start)).split(/\r?\n/u);
  if (before.at(-1) === "") before.pop();
  const values: string[] = [];
  for (let index = before.length - 1; index >= 0; index--) {
    const line = before[index]!.trim();
    if (!line.startsWith("#")) break;
    values.unshift(line.replace(/^#+\s?/u, ""));
  }
  const text = values.join(" ").replace(/\s+/gu, " ").trim();
  return text || undefined;
}

function ownerName(stack: readonly BlockFrame[]): string | undefined {
  return [...stack].reverse().find((frame) =>
    frame.candidate?.kind === "class" || frame.candidate?.kind === "module"
  )?.candidate?.qualifiedName;
}

function testPath(path: string): boolean {
  return /(?:^|\/)(?:spec|test)(?:\/|$)|(?:_spec|_test)\.rb$/iu.test(path);
}

function railsRoutes(resource: string): CodeRoute[] {
  const base = `/${resource}`;
  return [
    { method: "GET", path: base, handler: `${resource}#index` },
    { method: "GET", path: `${base}/new`, handler: `${resource}#new` },
    { method: "POST", path: base, handler: `${resource}#create` },
    { method: "GET", path: `${base}/:id`, handler: `${resource}#show` },
    { method: "GET", path: `${base}/:id/edit`, handler: `${resource}#edit` },
    { method: "PATCH", path: `${base}/:id`, handler: `${resource}#update` },
    { method: "DELETE", path: `${base}/:id`, handler: `${resource}#destroy` },
  ];
}

function routeCandidate(original: string, absoluteStart: number, path: string): RubyCandidate | undefined {
  const verb = /^\s*(get|post|put|patch|delete|options|head)\s+["']([^"']+)["'](?:\s*(?:,|=>)\s*(?:to:\s*)?["']([^"']+)["'])?/iu.exec(original);
  if (!verb) return undefined;
  const method = verb[1]!.toUpperCase();
  const routePath = verb[2]!;
  const handler = verb[3];
  return {
    kind: "route",
    symbol: `${method} ${routePath}`,
    qualifiedName: `route:${method} ${routePath}${handler ? `:${handler}` : ""}`,
    start: absoluteStart,
    definition: original.trim().replace(/\s+/gu, " "),
    routes: [{ method, path: routePath, ...(handler ? { handler } : {}) }],
    calls: handler ? [handler] : [],
    isTest: testPath(path),
  };
}

function rspecName(original: string): string | undefined {
  const match = /^\s*(?:RSpec\.)?describe\s+(?:["']([^"']+)["']|([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*))/u.exec(original);
  return match?.[1] ?? match?.[2];
}

function completeCandidate(candidate: RubyCandidate, end: number): void {
  candidate.end = Math.max(candidate.start, end);
}

function candidatesIn(source: CodeSource, masked: string): RubyCandidate[] {
  const candidates: RubyCandidate[] = [];
  const stack: BlockFrame[] = [];
  for (const line of physicalLines(source.content)) {
    const maskedLine = masked.slice(line.start, line.end);
    let statementOffset = 0;
    for (const maskedStatement of maskedLine.split(";")) {
      const statementStart = line.start + statementOffset;
      const original = source.content.slice(statementStart, statementStart + maskedStatement.length);
      const trimmed = maskedStatement.trim();
      statementOffset += maskedStatement.length + 1;
      if (!trimmed) continue;
      if (/^end\b/u.test(trimmed)) {
        const frame = stack.pop();
        if (frame?.candidate) completeCandidate(frame.candidate, lineEnd(source.content, statementStart));
        continue;
      }
      if (/^class\s+<</u.test(trimmed)) {
        stack.push({ singletonOwner: ownerName(stack) ?? "self" });
        continue;
      }
      const classMatch = /^(class|module)\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\b/u.exec(trimmed);
      if (classMatch && !/^class\s+<</u.test(trimmed)) {
        const parent = ownerName(stack);
        const symbol = classMatch[2]!.split("::").at(-1)!;
        const qualifiedName = classMatch[2]!.includes("::") || !parent ? classMatch[2]! : `${parent}::${classMatch[2]!}`;
        const minitest = classMatch[1] === "class" && /<\s*Minitest::Test\b/u.test(original);
        const candidate: RubyCandidate = {
          kind: classMatch[1] === "module" ? "module" : "class",
          symbol,
          qualifiedName,
          start: statementStart + maskedStatement.indexOf(classMatch[0]),
          definition: original.trim().replace(/\s+/gu, " "),
          isTest: minitest || testPath(source.path) || /(?:Test|Spec)$/u.test(symbol),
        };
        candidates.push(candidate);
        stack.push({ candidate });
        continue;
      }
      const defMatch = /^def\s+(?:(self)\.)?([A-Za-z_]\w*[!?=]?)/u.exec(trimmed);
      if (defMatch) {
        const parent = ownerName(stack);
        const singletonOwner = [...stack].reverse().find((frame) => frame.singletonOwner)?.singletonOwner;
        const singleton = defMatch[1] !== undefined || singletonOwner !== undefined;
        const symbol = defMatch[2]!;
        const endless = /^def\b[^\r\n]*?\s=\s*(?!=|>)/u.test(trimmed);
        const candidate: RubyCandidate = {
          kind: /^test_/u.test(symbol) ? "test" : parent ? "method" : "function",
          symbol,
          qualifiedName: parent
            ? `${singletonOwner ?? parent}${singleton ? "." : "#"}${symbol}`
            : singleton
              ? `${singletonOwner ?? "self"}.${symbol}`
              : symbol,
          start: statementStart + maskedStatement.indexOf(defMatch[0]),
          definition: original.trim().replace(/\s+/gu, " "),
          isTest: /^test_/u.test(symbol) || testPath(source.path),
        };
        candidates.push(candidate);
        if (endless) completeCandidate(candidate, lineEnd(source.content, statementStart));
        else stack.push({ candidate });
        continue;
      }
      const describe = rspecName(original);
      if (describe) {
        const parent = ownerName(stack);
        const candidate: RubyCandidate = {
          kind: "test",
          symbol: describe,
          qualifiedName: `test:${parent ? `${parent}::` : ""}${describe}`,
          start: statementStart,
          definition: original.trim().replace(/\s+/gu, " "),
          isTest: true,
        };
        candidates.push(candidate);
        if (/\bdo\b/u.test(trimmed)) stack.push({ candidate });
        else {
          const open = masked.indexOf("{", statementStart);
          completeCandidate(candidate, open >= 0 ? matchingBrace(masked, open) : lineEnd(source.content, statementStart));
        }
        continue;
      }
      const resources = /^resources\s+:([A-Za-z_]\w*)/u.exec(trimmed);
      if (/routes\.rb$/iu.test(source.path) && resources) {
        const name = resources[1]!;
        const routes = railsRoutes(name);
        const candidate: RubyCandidate = {
          kind: "route",
          symbol: `resources ${name}`,
          qualifiedName: `route:resources ${name}`,
          start: statementStart,
          definition: original.trim().replace(/\s+/gu, " "),
          routes,
          calls: routes.map((route) => route.handler!),
        };
        candidates.push(candidate);
        if (/\bdo\b/u.test(trimmed)) stack.push({ candidate });
        else completeCandidate(candidate, lineEnd(source.content, statementStart));
        continue;
      }
      const route = routeCandidate(original, statementStart, source.path);
      if (route) {
        candidates.push(route);
        if (/\bdo\b/u.test(trimmed)) stack.push({ candidate: route });
        else completeCandidate(route, lineEnd(source.content, statementStart));
        continue;
      }
      if (/^(?:context|it)\b/u.test(trimmed) && /\bdo\b/u.test(trimmed)) {
        stack.push({});
        continue;
      }
      if (/(?:^|[=(]\s*)(?:if|unless|while|until|case|begin|for)\b/u.test(trimmed)) {
        stack.push({});
        continue;
      }
      if (/\bdo\b/u.test(trimmed)) stack.push({});
    }
  }
  return candidates.filter((candidate) => candidate.end !== undefined);
}

function visibleMatch(masked: string, match: RegExpMatchArray, token: RegExp): boolean {
  const relative = match[0].search(token);
  const start = (match.index ?? 0) + Math.max(0, relative);
  return relative >= 0 && token.test(masked.slice(start, start + match[0].length - relative));
}

function importsIn(content: string, masked: string): string[] {
  return unique([...content.matchAll(/^\s*(?:require|require_relative)\s*\(?\s*["']([^"']+)["']/gmu)]
    .filter((match) => visibleMatch(masked, match, /\brequire(?:_relative)?\b/u))
    .map((match) => match[1]!));
}

function configKeysIn(content: string, masked: string): string[] {
  return unique([...content.matchAll(/\bENV\s*\[\s*["']([^"']+)["']\s*\]/gu)]
    .filter((match) => visibleMatch(masked, match, /\bENV\b/u))
    .map((match) => match[1]!));
}

function databaseRefsIn(content: string, masked: string): string[] {
  return unique([
    ...[...content.matchAll(/\bself\.table_name\s*=\s*["']([^"']+)["']/gu)]
      .filter((match) => visibleMatch(masked, match, /\bself\.table_name\b/u))
      .map((match) => match[1]!),
    ...[...content.matchAll(/\bcreate_table\s*\(?\s*:([A-Za-z_]\w*)/gu)]
      .filter((match) => visibleMatch(masked, match, /\bcreate_table\b/u))
      .map((match) => match[1]!),
  ]);
}

function identifiersIn(masked: string): string[] {
  return unique([...masked.matchAll(/\b[A-Za-z_]\w*[!?=]?\b/gu)]
    .map((match) => match[0]!)
    .filter((value) => !RUBY_KEYWORDS.has(value)));
}

function callsIn(masked: string): string[] {
  const values: string[] = [];
  for (const match of masked.matchAll(/\b([A-Za-z_]\w*[!?]?(?:\.[A-Za-z_]\w*[!?]?)*)\s*\(/gu)) {
    const value = match[1]!;
    values.push(value, value.split(".").at(-1)!);
  }
  return unique(values);
}

function attrReferences(content: string, masked: string): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(/\battr_(?:accessor|reader|writer)\s+([^\r\n]+)/gu)) {
    if (!visibleMatch(masked, match, /\battr_(?:accessor|reader|writer)\b/u)) continue;
    for (const name of match[1]!.matchAll(/:([A-Za-z_]\w*)|["']([A-Za-z_]\w*)["']/gu)) {
      values.push(name[1] ?? name[2]!);
    }
  }
  return unique(values);
}

export function extractRubyKeywordBlocks(source: CodeSource): KnowledgeFragment[] {
  const detailed = maskRubySourceDetailed(source.content);
  const fileImports = importsIn(source.content, detailed.masked);
  const fileConfigKeys = configKeysIn(source.content, detailed.masked);
  const fileDatabaseRefs = databaseRefsIn(source.content, detailed.masked);
  const moduleCandidate: RubyCandidate = {
    kind: "module",
    symbol: source.path,
    qualifiedName: source.path,
    start: 0,
    end: source.content.length,
    definition: `module ${source.path}`,
    isTest: testPath(source.path),
  };
  const candidates = [moduleCandidate, ...candidatesIn(source, detailed.masked)];
  return candidates.map((candidate): KnowledgeFragment => {
    const end = candidate.end ?? candidate.start;
    const startLine = lineNumberAt(source.content, candidate.start);
    const endLine = Math.max(startLine, lineNumberAt(source.content, Math.max(candidate.start, end - 1)));
    const raw = source.content.slice(candidate.start, end);
    const masked = detailed.masked.slice(candidate.start, end);
    const calls = unique([...(candidate.calls ?? []), ...callsIn(masked)]);
    const references = unique([
      ...(candidate.references ?? []),
      ...identifiersIn(masked),
      ...attrReferences(raw, masked),
      ...calls,
    ]).filter((value) => value !== candidate.symbol);
    return {
      id: codeFragmentId(source.path, candidate.kind, candidate.qualifiedName, startLine),
      path: source.path,
      symbol: candidate.symbol,
      qualifiedName: candidate.qualifiedName,
      kind: candidate.kind,
      definition: candidate.definition ?? definitionLine(source.content, candidate.start),
      range: { startLine, endLine },
      imports: fileImports,
      references,
      calls,
      routes: candidate.routes ?? [],
      configKeys: fileConfigKeys.filter((key) => raw.includes(key)),
      databaseRefs: unique([
        ...(candidate.databaseRefs ?? []),
        ...fileDatabaseRefs.filter((value) => raw.includes(value)),
      ]),
      isTest: candidate.kind === "test" || candidate.isTest === true || testPath(source.path),
      ...(candidate.kind === "module" ? {} : precedingDoc(source.content, candidate.start)
        ? { docComment: precedingDoc(source.content, candidate.start) }
        : {}),
    };
  }).sort((left, right) =>
    left.range.startLine - right.range.startLine || left.qualifiedName.localeCompare(right.qualifiedName)
  );
}
