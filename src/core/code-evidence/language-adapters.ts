import {
  annotationTextBefore,
  braceDepthAt,
  definitionLine,
  extractBraceLanguage,
  lineEnd,
  maskBraceLanguage,
  matchingBrace,
  unique,
  type BraceCandidate,
  type BraceExtractionContext,
  type BraceLanguageConfig,
} from "./brace-language-engine.js";
import {
  APEX_ADAPTER_VERSION,
  C_ADAPTER_VERSION,
  CPP_ADAPTER_VERSION,
  CSHARP_ADAPTER_VERSION,
  GO_ADAPTER_VERSION,
  JAVA_ADAPTER_VERSION,
  KOTLIN_ADAPTER_VERSION,
  PHP_ADAPTER_VERSION,
  RUST_ADAPTER_VERSION,
  type CodeRoute,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

const CONTROL_WORDS = new Set([
  "catch", "do", "else", "for", "foreach", "if", "lock", "match", "return", "switch",
  "synchronized", "try", "using", "while", "with",
]);

const COMMON_KEYWORDS = [
  ...CONTROL_WORDS,
  "as", "break", "case", "const", "continue", "default", "false", "finally", "goto", "new",
  "null", "private", "protected", "public", "static", "this", "throw", "true", "void",
];

const JAVA_KEYWORDS = new Set([
  ...COMMON_KEYWORDS, "abstract", "assert", "boolean", "byte", "char", "class", "double", "enum",
  "exports", "extends", "final", "float", "implements", "import", "instanceof", "int", "interface",
  "long", "module", "native", "non-sealed", "opens", "package", "permits", "record", "requires",
  "sealed", "short", "strictfp", "super", "throws", "transient", "volatile", "yield",
]);

const KOTLIN_KEYWORDS = new Set([
  ...COMMON_KEYWORDS, "actual", "annotation", "by", "catch", "companion", "constructor", "crossinline",
  "data", "delegate", "do", "dynamic", "expect", "external", "field", "file", "finally", "fun",
  "get", "import", "infix", "init", "inline", "inner", "internal", "is", "it", "lateinit", "noinline",
  "object", "open", "operator", "out", "override", "package", "param", "property", "receiver", "reified",
  "sealed", "set", "setparam", "suspend", "tailrec", "typealias", "typeof", "val", "value", "var",
  "vararg", "when", "where",
]);

const APEX_KEYWORDS = new Set([
  ...[...JAVA_KEYWORDS].map((value) => value.toLowerCase()), "trigger", "on", "before", "after", "insert",
  "update", "delete", "undelete", "select", "find", "from", "limit", "offset", "where", "sharing",
  "without", "inherited", "virtual", "webservice", "global", "testmethod",
]);

const CSHARP_KEYWORDS = new Set([
  ...COMMON_KEYWORDS, "abstract", "add", "alias", "async", "await", "base", "bool", "byte", "char",
  "checked", "class", "decimal", "delegate", "double", "dynamic", "enum", "event", "explicit", "extern",
  "fixed", "float", "get", "global", "implicit", "in", "init", "int", "interface", "internal", "is",
  "long", "namespace", "object", "operator", "out", "override", "params", "partial", "readonly", "record",
  "ref", "remove", "required", "sbyte", "set", "short", "sizeof", "stackalloc", "string", "struct",
  "uint", "ulong", "unchecked", "unsafe", "ushort", "var", "virtual", "volatile", "where", "yield",
]);

const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func",
  "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct",
  "switch", "type", "var",
]);

const RUST_KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false",
  "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref",
  "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "union", "unsafe",
  "use", "where", "while",
]);

const PHP_KEYWORDS = new Set([
  ...COMMON_KEYWORDS, "and", "array", "callable", "class", "clone", "declare", "echo", "elseif",
  "empty", "enddeclare", "endfor", "endforeach", "endif", "endswitch", "endwhile", "enum", "eval",
  "exit", "extends", "final", "fn", "function", "global", "implements", "include", "include_once",
  "instanceof", "insteadof", "interface", "isset", "list", "match", "namespace", "never", "or",
  "parent", "print", "readonly", "require", "require_once", "self", "trait", "unset", "use", "xor",
  "yield", "yield_from",
]);

const C_KEYWORDS = new Set([
  ...COMMON_KEYWORDS, "auto", "char", "double", "enum", "extern", "float", "inline", "int", "long",
  "register", "restrict", "short", "signed", "sizeof", "struct", "typedef", "union", "unsigned", "volatile",
  "_Atomic", "_Bool", "_Complex", "_Generic", "_Imaginary", "_Noreturn", "_Static_assert", "_Thread_local",
]);

const CPP_KEYWORDS = new Set([
  ...C_KEYWORDS, "alignas", "alignof", "and", "and_eq", "asm", "bitand", "bitor", "bool", "class",
  "compl", "concept", "consteval", "constexpr", "constinit", "const_cast", "co_await", "co_return",
  "co_yield", "decltype", "delete", "dynamic_cast", "explicit", "export", "friend", "mutable", "namespace",
  "noexcept", "not", "not_eq", "nullptr", "operator", "or", "or_eq", "reinterpret_cast", "requires",
  "static_assert", "static_cast", "template", "thread_local", "typename", "virtual", "wchar_t", "xor", "xor_eq",
]);

function commonTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:Test|Tests|Spec)\.[^.]+$/i.test(path);
}

function extensionSupported(path: string, claims: readonly string[]): boolean {
  return claims.some((claim) => path.toLowerCase().endsWith(claim));
}

function matchStart(match: RegExpMatchArray): number {
  return match.index ?? 0;
}

function braceCandidate(params: {
  context: BraceExtractionContext;
  match: RegExpMatchArray;
  kind: BraceCandidate["kind"];
  symbol: string;
  qualifiedName: string;
  isTest?: boolean;
}): BraceCandidate {
  const start = matchStart(params.match);
  const open = params.context.masked.indexOf("{", start);
  return {
    kind: params.kind,
    symbol: params.symbol,
    qualifiedName: params.qualifiedName,
    start,
    end: open < 0 ? lineEnd(params.context.content, start) : matchingBrace(params.context.masked, open),
    definition: definitionLine(params.context.content, start),
    ...(params.isTest ? { isTest: true } : {}),
  };
}

function joinRoute(prefix: string, suffix: string): string {
  const left = prefix.trim();
  const right = suffix.trim();
  if (!left && !right) return "/";
  const joined = `${left.replace(/\/$/u, "")}/${right.replace(/^\//u, "")}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function annotationString(annotation: string, name: string): string | undefined {
  const match = new RegExp(`@?${name}\\s*\\((?:[^\"']*?)(?:value\\s*=\\s*|path\\s*=\\s*|urlMapping\\s*=\\s*)?[\"']([^\"']+)[\"']`, "iu")
    .exec(annotation);
  return match?.[1];
}

function attributeString(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\[${name}\\s*(?:\\(\\s*[\"']([^\"']*)[\"'][^)]*\\))?`, "iu").exec(attributes);
  return match?.[1] ?? (match ? "" : undefined);
}

function importsByPattern(content: string, pattern: RegExp, group = 1): string[] {
  return unique([...content.matchAll(pattern)].map((match) => match[group] ?? ""));
}

interface TypeOwner extends BraceCandidate {
  open: number;
}

function ownerForOffset(owners: readonly TypeOwner[], offset: number): TypeOwner | undefined {
  return [...owners]
    .filter((owner) => owner.start < offset && owner.end >= offset)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
}

function javaLikeTypes(
  context: BraceExtractionContext,
  namespace: string,
  caseInsensitive: boolean
): TypeOwner[] {
  const flags = caseInsensitive ? "gmi" : "gm";
  const pattern = new RegExp(
    "^[ \\t]*(?:(?:public|protected|private|global|static|abstract|virtual|final|sealed|non-sealed|strictfp|with\\s+sharing|without\\s+sharing|inherited\\s+sharing|partial)\\s+)*(class|interface|enum|record|struct)\\s+([A-Za-z_][\\w$]*)\\b[^;{]*\\{",
    flags
  );
  const owners: TypeOwner[] = [];
  for (const match of context.masked.matchAll(pattern)) {
    const symbol = match[2]!;
    const start = matchStart(match);
    const open = context.masked.indexOf("{", start);
    const parent = ownerForOffset(owners, start);
    const prefix = parent?.qualifiedName ?? namespace;
    owners.push({
      ...braceCandidate({
        context,
        match,
        kind: "class",
        symbol,
        qualifiedName: prefix ? `${prefix}.${symbol}` : symbol,
      }),
      open,
    });
  }
  return owners;
}

function javaLikeMethods(params: {
  context: BraceExtractionContext;
  owners: readonly TypeOwner[];
  separator: "#" | ".";
  caseInsensitive?: boolean;
  routeFor?: (annotations: string, owner: TypeOwner, symbol: string) => CodeRoute | undefined;
  isTest?: (annotations: string, symbol: string) => boolean;
}): BraceCandidate[] {
  const flags = params.caseInsensitive ? "gmi" : "gm";
  const pattern = new RegExp(
    "^[ \\t]*(?:(?:public|protected|private|global|internal|static|abstract|virtual|final|sealed|override|async|synchronized|native|transient|webservice|testmethod|extern|unsafe|new|partial)\\s+)*(?:<[^>{};]+>\\s+)?(?:[A-Za-z_][\\w$.[\\]<>?,]*(?:\\s*\\[\\])?\\s+)?([A-Za-z_][\\w$]*)\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[^\\n{]+)?\\s*\\{",
    flags
  );
  const candidates: BraceCandidate[] = [];
  for (const owner of params.owners) {
    const body = params.context.masked.slice(owner.open + 1, owner.end - 1);
    for (const match of body.matchAll(pattern)) {
      const relativeStart = matchStart(match);
      const start = owner.open + 1 + relativeStart;
      if (braceDepthAt(params.context.masked, owner.open, start) !== 1) continue;
      const symbol = match[1]!;
      if (CONTROL_WORDS.has(symbol.toLowerCase())) continue;
      const open = params.context.masked.indexOf("{", start);
      const annotations = annotationTextBefore(params.context.content, start);
      const qualifiedName = `${owner.qualifiedName}${params.separator}${symbol}`;
      const method: BraceCandidate = {
        kind: "method",
        symbol,
        qualifiedName,
        start,
        end: matchingBrace(params.context.masked, open),
        definition: definitionLine(params.context.content, start),
        isTest: params.isTest?.(annotations, symbol) ?? false,
      };
      candidates.push(method);
      const route = params.routeFor?.(annotations, owner, symbol);
      if (route) {
        const routeSymbol = `${route.method} ${route.path}`;
        candidates.push({
          ...method,
          kind: "route",
          symbol: routeSymbol,
          qualifiedName: `route:${routeSymbol}:${qualifiedName}`,
          routes: [{ ...route, handler: qualifiedName }],
          calls: [qualifiedName, symbol],
        });
      }
    }
  }
  return candidates;
}

function javaCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const packageName = /\bpackage\s+([A-Za-z_][\w.]*)\s*;/u.exec(context.masked)?.[1] ?? "";
  const owners = javaLikeTypes(context, packageName, false);
  const ownerPrefixes = new Map(owners.map((owner) => [
    owner.qualifiedName,
    annotationString(annotationTextBefore(context.content, owner.start), "RequestMapping") ?? "",
  ]));
  return [
    ...owners.map((owner) => ({
      ...owner,
      isTest: /(?:^|\.)[^.]*Test$/u.test(owner.qualifiedName) || /@(?:RunWith|ExtendWith)\b/u.test(
        annotationTextBefore(context.content, owner.start)
      ),
    })),
    ...javaLikeMethods({
      context,
      owners,
      separator: "#",
      isTest: (annotations) => /@(?:Test|ParameterizedTest|RepeatedTest)\b/u.test(annotations),
      routeFor: (annotations, owner) => {
        const mapping = /@(Get|Post|Put|Patch|Delete)Mapping\b/iu.exec(annotations);
        const generic = /@RequestMapping\b/iu.test(annotations);
        if (!mapping && !generic) return undefined;
        const method = mapping?.[1]?.toUpperCase() ??
          /RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/iu.exec(annotations)?.[1]?.toUpperCase() ?? "ANY";
        const suffix = mapping
          ? annotationString(annotations, `${mapping[1]}Mapping`) ?? ""
          : annotationString(annotations, "RequestMapping") ?? "";
        return { method, path: joinRoute(ownerPrefixes.get(owner.qualifiedName) ?? "", suffix) };
      },
    }),
  ];
}

const JAVA_CONFIG: BraceLanguageConfig = {
  language: "java",
  keywords: JAVA_KEYWORDS,
  testPath: (path) => commonTestPath(path) || /(?:^|\/)src\/test\//u.test(path),
  candidates: javaCandidates,
  imports: (content) => importsByPattern(content, /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gmu),
  configKeys: (content) => unique([...content.matchAll(/@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}["']\s*\)/gmu)]
    .map((match) => match[1]!)),
  databaseRefs: () => [],
};

function kotlinTypes(context: BraceExtractionContext, packageName: string): TypeOwner[] {
  const owners: TypeOwner[] = [];
  const pattern = /^[ \t]*(?:(?:public|protected|private|internal|abstract|final|open|data|sealed|value|inner|enum|annotation|expect|actual)[ \t]+)*(?:(companion)[ \t]+)?(class|interface|object)\b(?:[ \t]+([A-Za-z_]\w*))?/gmu;
  for (const match of context.masked.matchAll(pattern)) {
    const start = matchStart(match);
    const companion = match[1] !== undefined;
    const symbol = companion ? "Companion" : match[3];
    if (!symbol) continue;
    const open = kotlinTypeBody(context.masked, start + match[0].length);
    if (open === undefined) continue;
    const parent = ownerForOffset(owners, start);
    const prefix = parent?.qualifiedName ?? packageName;
    owners.push({
      ...braceCandidate({
        context,
        match,
        kind: "class",
        symbol,
        qualifiedName: prefix ? `${prefix}.${symbol}` : symbol,
      }),
      open,
    });
  }
  return owners;
}

function kotlinSpringRoute(annotations: string, prefix: string): CodeRoute | undefined {
  const mapping = /@(Get|Post|Put|Patch|Delete)Mapping\b/iu.exec(annotations);
  const generic = /@RequestMapping\b/iu.test(annotations);
  if (!mapping && !generic) return undefined;
  const method = mapping?.[1]?.toUpperCase() ??
    /RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/iu.exec(annotations)?.[1]?.toUpperCase() ?? "ANY";
  const suffix = mapping
    ? annotationString(annotations, `${mapping[1]}Mapping`) ?? ""
    : annotationString(annotations, "RequestMapping") ?? "";
  return { method, path: suffix ? joinRoute(prefix, suffix) : prefix || "/" };
}

function kotlinDslRanges(context: BraceExtractionContext): Array<{
  start: number;
  end: number;
  routePrefix?: string;
  routeScope: boolean;
}> {
  const ranges: Array<{ start: number; end: number; routePrefix?: string; routeScope: boolean }> = [];
  for (const match of context.masked.matchAll(/\brouting\s*(?:\([^)]*\))?\s*\{/gmu)) {
    const start = matchStart(match);
    const open = context.masked.indexOf("{", start);
    ranges.push({ start, end: matchingBrace(context.masked, open), routeScope: false });
  }
  for (const match of context.masked.matchAll(/\broute\s*\([^)]*\)\s*\{/gmu)) {
    const start = matchStart(match);
    const open = context.masked.indexOf("{", start);
    const original = context.content.slice(start, open);
    const routePrefix = /\broute\s*\(\s*"([^"$]+)"\s*\)/u.exec(original)?.[1];
    ranges.push({
      start,
      end: matchingBrace(context.masked, open),
      routeScope: true,
      ...(routePrefix ? { routePrefix } : {}),
    });
  }
  return ranges;
}

function kotlinDeclarationStarts(masked: string, index: number): boolean {
  return /^(?:@|(?:(?:public|protected|private|internal|abstract|final|open|data|sealed|value|inner|enum|annotation|companion|override|inline|noinline|crossinline|tailrec|operator|infix|external|suspend|expect|actual)\s+)*(?:fun|class|interface|object|val|var|typealias|package|import)\b)/u
    .test(masked.slice(index, Math.min(masked.length, index + 256)));
}

function kotlinTypeBody(masked: string, afterHeader: number): number | undefined {
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let squareDepth = 0;
  let supertypeSection = false;
  const limit = Math.min(masked.length, afterHeader + 64 * 1024);
  for (let index = afterHeader; index < limit; index++) {
    const value = masked[index]!;
    if (value === "\n" || value === "\r") {
      let next = index + 1;
      if (value === "\r" && masked[next] === "\n") next++;
      while (masked[next] === " " || masked[next] === "\t") next++;
      if (angleDepth === 0 && parenthesisDepth === 0 && squareDepth === 0 &&
          kotlinDeclarationStarts(masked, next)) return undefined;
      continue;
    }
    if (value === "<") angleDepth++;
    else if (value === ">" && angleDepth > 0) angleDepth--;
    else if (value === "(") parenthesisDepth++;
    else if (value === ")" && parenthesisDepth > 0) parenthesisDepth--;
    else if (value === "[") squareDepth++;
    else if (value === "]" && squareDepth > 0) squareDepth--;
    else if (value === "{" && supertypeSection) return index;
    else if (angleDepth === 0 && parenthesisDepth === 0 && squareDepth === 0) {
      if (value === "{") return index;
      if (value === ":") supertypeSection = true;
      if (value === ";" || value === "=" || value === "}") return undefined;
    }
  }
  return undefined;
}

function matchingParenthesis(masked: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === "(") depth++;
    else if (masked[index] === ")" && --depth === 0) return index;
    else if ((masked[index] === "\n" || masked[index] === "\r") && depth === 1) {
      let next = index + 1;
      if (masked[index] === "\r" && masked[next] === "\n") next++;
      while (masked[next] === " " || masked[next] === "\t") next++;
      if (kotlinDeclarationStarts(masked, next)) return undefined;
    }
  }
  return undefined;
}

function kotlinFunctionBody(masked: string, afterParameters: number): { index: number; token: "{" | "=" } | undefined {
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let squareDepth = 0;
  for (let index = afterParameters; index < masked.length; index++) {
    const value = masked[index]!;
    if (value === "\n" || value === "\r") {
      let next = index + 1;
      if (value === "\r" && masked[next] === "\n") next++;
      while (masked[next] === " " || masked[next] === "\t") next++;
      if (kotlinDeclarationStarts(masked, next)) return undefined;
      continue;
    }
    if (value === "<") angleDepth++;
    else if (value === ">" && angleDepth > 0) angleDepth--;
    else if (value === "(") parenthesisDepth++;
    else if (value === ")" && parenthesisDepth > 0) parenthesisDepth--;
    else if (value === "[") squareDepth++;
    else if (value === "]" && squareDepth > 0) squareDepth--;
    else if (angleDepth === 0 && parenthesisDepth === 0 && squareDepth === 0) {
      if (value === "{" || value === "=") return { index, token: value };
      if (value === ";" || value === "}") return undefined;
    }
  }
  return undefined;
}

function kotlinCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const packageName = /^\s*package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b/mu.exec(context.masked)?.[1] ?? "";
  const owners = kotlinTypes(context, packageName);
  const ownerPrefixes = new Map(owners.map((owner) => [
    owner.qualifiedName,
    annotationString(annotationTextBefore(context.content, owner.start), "RequestMapping") ?? "",
  ]));
  const candidates: BraceCandidate[] = owners.map((owner) => ({
    ...owner,
    isTest: /(?:Test|Tests|Spec)$/u.test(owner.symbol) ||
      /:\s*(?:StringSpec|FunSpec|DescribeSpec|BehaviorSpec|ShouldSpec)\s*\(/u.test(
        context.content.slice(owner.start, Math.min(owner.end, lineEnd(context.content, owner.start) + 300))
      ),
  }));
  const ownedStarts = new Set(owners.map((owner) => owner.start));
  const bodylessType = /^[ \t]*(?:(?:public|protected|private|internal|abstract|final|open|data|sealed|value|inner|enum|annotation|expect|actual)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)\b[^{}\r\n]*$/gmu;
  for (const match of context.masked.matchAll(bodylessType)) {
    const start = matchStart(match);
    if (ownedStarts.has(start)) continue;
    const symbol = match[1]!;
    const parent = ownerForOffset(owners, start);
    const prefix = parent?.qualifiedName ?? packageName;
    candidates.push({
      kind: "class",
      symbol,
      qualifiedName: prefix ? `${prefix}.${symbol}` : symbol,
      start,
      end: lineEnd(context.content, start),
      definition: definitionLine(context.content, start),
      isTest: /(?:Test|Tests|Spec)$/u.test(symbol),
    });
  }
  const functions: BraceCandidate[] = [];
  const pattern = /^[ \t]*(?:(?:public|protected|private|internal|abstract|final|open|override|inline|noinline|crossinline|tailrec|operator|infix|external|suspend|expect|actual)[ \t]+)*fun[ \t]+(?:<[^>{}\r\n]+>[ \t]*)?(?:([A-Za-z_][\w.<>,?]*)[ \t]*\.)?([A-Za-z_]\w*)[ \t]*\(/gmu;
  for (const match of context.masked.matchAll(pattern)) {
    const start = matchStart(match);
    const owner = ownerForOffset(owners, start);
    if (owner && braceDepthAt(context.masked, owner.open, start) !== 1) continue;
    const parametersOpen = start + match[0].lastIndexOf("(");
    const parametersClose = matchingParenthesis(context.masked, parametersOpen);
    if (parametersClose === undefined) continue;
    const body = kotlinFunctionBody(context.masked, parametersClose + 1);
    if (!body) continue;
    const receiver = match[1]?.replace(/\s+/gu, "");
    const symbol = match[2]!;
    const qualifiedName = receiver
      ? `${receiver}.${symbol}`
      : owner
        ? `${owner.qualifiedName}.${symbol}`
        : packageName
          ? `${packageName}.${symbol}`
          : symbol;
    const annotations = annotationTextBefore(context.content, start);
    const candidate: BraceCandidate = {
      kind: "function",
      symbol,
      qualifiedName,
      start,
      end: body.token === "{"
        ? matchingBrace(context.masked, body.index)
        : lineEnd(context.content, body.index),
      definition: definitionLine(context.content, start),
      references: receiver ? [receiver] : [],
      isTest: /@(?:Test|ParameterizedTest|RepeatedTest)\b/u.test(annotations),
    };
    candidate.kind = candidate.isTest ? "test" : owner && !receiver ? "method" : "function";
    candidates.push(candidate);
    functions.push(candidate);
    const route = kotlinSpringRoute(annotations, owner ? ownerPrefixes.get(owner.qualifiedName) ?? "" : "");
    if (route) {
      const routeSymbol = `${route.method} ${route.path}`;
      candidates.push({
        ...candidate,
        kind: "route",
        symbol: routeSymbol,
        qualifiedName: `route:${routeSymbol}:${qualifiedName}`,
        routes: [{ ...route, handler: qualifiedName }],
        calls: [qualifiedName, symbol],
      });
    }
  }
  const propertyPattern = /^[ \t]*(?:(?:public|protected|private|internal|override|open|final|lateinit|const)\s+)*(?:val|var)\s+([A-Za-z_]\w*)[^\r\n]*(?:\r?\n[ \t]+)?(?:get|set)\s*\([^)]*\)\s*(=|\{)/gmu;
  for (const match of context.masked.matchAll(propertyPattern)) {
    const start = matchStart(match);
    const owner = ownerForOffset(owners, start);
    if (!owner || braceDepthAt(context.masked, owner.open, start) !== 1) continue;
    const symbol = match[1]!;
    const open = match[2] === "{" ? context.masked.indexOf("{", start) : -1;
    candidates.push({
      kind: "method",
      symbol,
      qualifiedName: `${owner.qualifiedName}.${symbol}`,
      start,
      end: open >= 0
        ? matchingBrace(context.masked, open)
        : lineEnd(context.content, start + match[0].length),
      definition: definitionLine(context.content, start),
    });
  }
  const dslRanges = kotlinDslRanges(context);
  for (const match of context.content.matchAll(/\b(get|post|put|patch|delete|options|head)\s*\(\s*"([^"$]+)"\s*\)\s*\{/giu)) {
    const start = matchStart(match);
    if (context.masked.slice(start, start + match[1]!.length).toLowerCase() !== match[1]!.toLowerCase()) continue;
    const owner = functions.find((candidate) => start > candidate.start && start < candidate.end);
    const enclosingDsl = dslRanges.filter((range) => start > range.start && start < range.end)
      .sort((left, right) => left.start - right.start);
    if (enclosingDsl.length === 0 && !owner?.references?.some((value) => /(?:^|\.)Route$/u.test(value))) continue;
    const routeScopes = enclosingDsl.filter((range) => range.routeScope);
    if (routeScopes.some((range) => !range.routePrefix)) continue;
    const method = match[1]!.toUpperCase();
    const routePrefix = routeScopes.reduce((value, range) => joinRoute(value, range.routePrefix!), "");
    const routePath = joinRoute(routePrefix, match[2]!);
    const open = context.masked.indexOf("{", start);
    const handler = owner?.qualifiedName;
    candidates.push({
      kind: "route",
      symbol: `${method} ${routePath}`,
      qualifiedName: `route:${method} ${routePath}${handler ? `:${handler}` : ""}`,
      start,
      end: matchingBrace(context.masked, open),
      routes: [{ method, path: routePath, ...(handler ? { handler } : {}) }],
      calls: handler ? [handler, owner!.symbol] : [],
    });
  }
  return candidates;
}

const KOTLIN_CONFIG: BraceLanguageConfig = {
  language: "kotlin",
  keywords: KOTLIN_KEYWORDS,
  testPath: (path) => commonTestPath(path) || /(?:^|\/)src\/test\//u.test(path),
  candidates: kotlinCandidates,
  imports: (content) => importsByPattern(content, /^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_*]\w*)*(?:\s+as\s+[A-Za-z_]\w*)?)/gmu),
  configKeys: (content) => unique([
    ...[...content.matchAll(/@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}["']\s*\)/gmu)].map((match) => match[1]!),
    ...[...content.matchAll(/\bSystem\.getenv\s*\(\s*["']([^"']+)["']/gmu)].map((match) => match[1]!),
  ]),
  databaseRefs: () => [],
};

function apexDatabaseRefs(content: string): string[] {
  const refs: string[] = [];
  for (const query of content.matchAll(/\[\s*(?:SELECT|FIND)\b[\s\S]*?\]/giu)) {
    for (const match of query[0].matchAll(/\bFROM\s+([A-Za-z_][\w.]*)/giu)) refs.push(match[1]!);
  }
  for (const query of content.matchAll(/\bDatabase\.query\s*\(\s*["']([^"']+)["']/giu)) {
    for (const match of query[1]!.matchAll(/\bFROM\s+([A-Za-z_][\w.]*)/giu)) refs.push(match[1]!);
  }
  return unique(refs);
}

function apexCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const candidates: BraceCandidate[] = [];
  const owners = javaLikeTypes(context, "", true);
  const restPrefixes = new Map(owners.map((owner) => [
    owner.qualifiedName,
    annotationString(annotationTextBefore(context.content, owner.start), "RestResource") ?? "",
  ]));
  candidates.push(...owners.map((owner) => ({
    ...owner,
    isTest: /@isTest\b/iu.test(annotationTextBefore(context.content, owner.start)),
  })));
  candidates.push(...javaLikeMethods({
    context,
    owners,
    separator: ".",
    caseInsensitive: true,
    isTest: (annotations) => /@isTest\b|\btestMethod\b/iu.test(annotations),
    routeFor: (annotations, owner) => {
      const method = /@(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\b/iu.exec(annotations)?.[1]
        ?.replace(/^Http/iu, "").toUpperCase();
      return method ? { method, path: restPrefixes.get(owner.qualifiedName) || "/" } : undefined;
    },
  }));
  const triggerPattern = /^[ \t]*trigger\s+([A-Za-z_][\w$]*)\s+on\s+([A-Za-z_][\w$]*)\s*\(([^)]*)\)\s*\{/gimu;
  for (const match of context.masked.matchAll(triggerPattern)) {
    const symbol = match[1]!;
    const objectName = match[2]!;
    const events = match[3]!.split(",").map((event) => event.trim()).filter(Boolean);
    const start = matchStart(match);
    const open = context.masked.indexOf("{", start);
    const routes = events.map((event): CodeRoute => ({
      method: `TRIGGER ${event.toUpperCase()}`,
      path: objectName,
      handler: symbol,
    }));
    candidates.push({
      kind: "route",
      symbol: `trigger ${symbol} on ${objectName}`,
      qualifiedName: `trigger:${symbol}:${objectName}`,
      start,
      end: matchingBrace(context.masked, open),
      definition: definitionLine(context.content, start),
      routes,
      databaseRefs: [objectName, ...apexDatabaseRefs(context.content.slice(start, matchingBrace(context.masked, open)))],
    });
  }
  return candidates;
}

const APEX_CONFIG: BraceLanguageConfig = {
  language: "apex",
  keywords: APEX_KEYWORDS,
  caseInsensitiveKeywords: true,
  testPath: (path) => commonTestPath(path),
  candidates: apexCandidates,
  imports: () => [],
  configKeys: () => [],
  databaseRefs: apexDatabaseRefs,
};

function csharpCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const namespace = /\bnamespace\s+([A-Za-z_][\w.]*)\s*(?:;|\{)/u.exec(context.masked)?.[1] ?? "";
  const owners = javaLikeTypes(context, namespace, false);
  const controllerPrefixes = new Map(owners.map((owner) => [
    owner.qualifiedName,
    attributeString(annotationTextBefore(context.content, owner.start), "Route") ?? "",
  ]));
  const candidates: BraceCandidate[] = [
    ...owners.map((owner) => ({
      ...owner,
      isTest: /(?:Tests?|Spec)$/u.test(owner.symbol),
    })),
    ...javaLikeMethods({
      context,
      owners,
      separator: ".",
      isTest: (attributes) => /\[(?:Fact|Theory|Test|TestMethod)\b/u.test(attributes),
      routeFor: (attributes, owner) => {
        const match = /\[Http(Get|Post|Put|Patch|Delete)\b/iu.exec(attributes);
        if (!match) return undefined;
        const suffix = attributeString(attributes, `Http${match[1]}`) ?? "";
        return { method: match[1]!.toUpperCase(), path: joinRoute(controllerPrefixes.get(owner.qualifiedName) ?? "", suffix) };
      },
    }),
  ];
  const propertyPattern = /^[ \t]*(?:(?:public|protected|private|internal|static|virtual|override|required|init|new)\s+)+[A-Za-z_][\w.<>,?\[\]]*\s+([A-Za-z_][\w]*)\s*\{[^{}]*(?:get|set|init)\s*;/gmu;
  for (const match of context.masked.matchAll(propertyPattern)) {
    const start = matchStart(match);
    const owner = ownerForOffset(owners, start);
    if (!owner || braceDepthAt(context.masked, owner.open, start) !== 1) continue;
    const open = context.masked.indexOf("{", start);
    const symbol = match[1]!;
    candidates.push({
      kind: "method",
      symbol,
      qualifiedName: `${owner.qualifiedName}.${symbol}`,
      start,
      end: matchingBrace(context.masked, open),
      definition: definitionLine(context.content, start),
    });
  }
  const minimalApi = /\bapp\s*\.\s*Map(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_][\w.]*)/giu;
  for (const match of context.content.matchAll(minimalApi)) {
    const start = matchStart(match);
    const route = { method: match[1]!.toUpperCase(), path: match[2]!, handler: match[3]! };
    candidates.push({
      kind: "route",
      symbol: `${route.method} ${route.path}`,
      qualifiedName: `route:${route.method} ${route.path}`,
      start,
      end: lineEnd(context.content, start),
      routes: [route],
      calls: [route.handler, route.handler.split(".").at(-1)!],
    });
  }
  return candidates;
}

const CSHARP_CONFIG: BraceLanguageConfig = {
  language: "csharp",
  keywords: CSHARP_KEYWORDS,
  testPath: commonTestPath,
  candidates: csharpCandidates,
  imports: (content) => importsByPattern(content, /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([\w.]+)\s*;/gmu),
  configKeys: (content) => unique([...content.matchAll(/\b(?:Configuration|config)\s*\[\s*["']([^"']+)["']\s*\]/gmu)]
    .map((match) => match[1]!)),
  databaseRefs: (content) => importsByPattern(content, /\b(?:FromSqlRaw|ExecuteSqlRaw)\s*\(\s*["'][^"']*?\b(?:FROM|UPDATE|INTO)\s+([A-Za-z_][\w.]*)/giu),
};

function goImports(content: string): string[] {
  const values: string[] = [];
  for (const block of content.matchAll(/\bimport\s*\(([^)]*)\)|\bimport\s+(?:[A-Za-z_.]\w*\s+)?["']([^"']+)["']/gsu)) {
    if (block[2]) values.push(block[2]);
    for (const match of (block[1] ?? "").matchAll(/(?:[A-Za-z_.]\w*\s+)?["']([^"']+)["']/gu)) values.push(match[1]!);
  }
  return unique(values);
}

function goCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const packageName = /\bpackage\s+([A-Za-z_]\w*)/u.exec(context.masked)?.[1] ?? "";
  const candidates: BraceCandidate[] = [];
  for (const match of context.masked.matchAll(/^[ \t]*type\s+([A-Za-z_]\w*)\s+(struct|interface)\s*\{/gmu)) {
    const symbol = match[1]!;
    candidates.push(braceCandidate({
      context,
      match,
      kind: "class",
      symbol,
      qualifiedName: packageName ? `${packageName}.${symbol}` : symbol,
    }));
  }
  const functionPattern = /^[ \t]*func\s*(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)\s*\([^)]*\)[^{\n]*\{/gmu;
  for (const match of context.masked.matchAll(functionPattern)) {
    const receiver = match[1];
    const symbol = match[2]!;
    const start = matchStart(match);
    const open = context.masked.indexOf("{", start);
    const isTest = /^(?:Test|Benchmark|Example)[A-Z_]/u.test(symbol);
    candidates.push({
      kind: isTest ? "test" : receiver ? "method" : "function",
      symbol,
      qualifiedName: receiver ? `${receiver}.${symbol}` : packageName ? `${packageName}.${symbol}` : symbol,
      start,
      end: matchingBrace(context.masked, open),
      definition: definitionLine(context.content, start),
      isTest,
    });
  }
  const routePattern = /\b(?:http\.)?HandleFunc\s*\(\s*["`]([^"`]+)["`]\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)|\b(?:router|r|e|chi|mux|gin)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|Handle)\s*\(\s*["`]([^"`]+)["`]\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/giu;
  for (const match of context.content.matchAll(routePattern)) {
    const start = matchStart(match);
    const method = match[3]?.toUpperCase() ?? "ANY";
    const routePath = match[1] ?? match[4]!;
    const handler = match[2] ?? match[5]!;
    candidates.push({
      kind: "route",
      symbol: `${method} ${routePath}`,
      qualifiedName: `route:${method} ${routePath}`,
      start,
      end: lineEnd(context.content, start),
      routes: [{ method, path: routePath, handler }],
      calls: [handler],
    });
  }
  return candidates;
}

const GO_CONFIG: BraceLanguageConfig = {
  language: "go",
  keywords: GO_KEYWORDS,
  lineCommentsAreDoc: true,
  testPath: (path) => path.endsWith("_test.go"),
  candidates: goCandidates,
  imports: goImports,
  databaseRefs: (content) => unique([...content.matchAll(/\bdb\s*:\s*["`]([^,"` ]+)/gu)].map((match) => match[1]!)),
};

function rustImports(content: string): string[] {
  return unique([...content.matchAll(/^\s*(?:pub\s+)?use\s+([^;]+);/gmu)].map((match) => match[1]!.replace(/\s+/gu, "")));
}

function rustCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const candidates: BraceCandidate[] = [];
  const implRanges: Array<{ start: number; end: number }> = [];
  const macroRanges: Array<{ start: number; end: number }> = [];
  for (const match of context.masked.matchAll(/^[ \t]*macro_rules!\s*([A-Za-z_]\w*)\s*\{/gmu)) {
    const candidate = braceCandidate({
      context,
      match,
      kind: "function",
      symbol: match[1]!,
      qualifiedName: match[1]!,
    });
    macroRanges.push({ start: candidate.start, end: candidate.end });
    candidates.push(candidate);
  }
  const insideMacro = (offset: number) => macroRanges.some((range) =>
    offset > range.start && offset < range.end
  );
  for (const match of context.masked.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)\b[^;{]*\{/gmu)) {
    if (insideMacro(matchStart(match))) continue;
    const symbol = match[2]!;
    candidates.push(braceCandidate({ context, match, kind: "class", symbol, qualifiedName: symbol }));
  }
  for (const match of context.masked.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/gmu)) {
    if (insideMacro(matchStart(match))) continue;
    const symbol = match[1]!;
    const isTest = /#\[cfg\s*\(\s*test\s*\)\]/u.test(annotationTextBefore(context.content, matchStart(match)));
    candidates.push(braceCandidate({
      context,
      match,
      kind: isTest ? "test" : "module",
      symbol,
      qualifiedName: isTest ? `test:${symbol}` : symbol,
      isTest,
    }));
  }
  for (const match of context.masked.matchAll(/^[ \t]*impl(?:\s*<[^>{}]*>)?(?:\s+[A-Za-z_]\w*\s+for)?\s+([A-Za-z_]\w*(?:::\w+)*)[^{}]*\{/gmu)) {
    const typeName = match[1]!;
    const start = matchStart(match);
    if (insideMacro(start)) continue;
    const open = context.masked.indexOf("{", start);
    const end = matchingBrace(context.masked, open);
    implRanges.push({ start, end });
    const body = context.masked.slice(open + 1, end - 1);
    for (const fn of body.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>{}]*>)?\s*\([^)]*\)[^{;]*\{/gmu)) {
      const methodStart = open + 1 + matchStart(fn);
      if (braceDepthAt(context.masked, open, methodStart) !== 1) continue;
      const symbol = fn[1]!;
      const methodOpen = context.masked.indexOf("{", methodStart);
      const annotations = annotationTextBefore(context.content, methodStart);
      const isTest = /#\[test\]/u.test(annotations);
      candidates.push({
        kind: isTest ? "test" : "method",
        symbol,
        qualifiedName: `${typeName}::${symbol}`,
        start: methodStart,
        end: matchingBrace(context.masked, methodOpen),
        definition: definitionLine(context.content, methodStart),
        isTest,
      });
    }
  }
  for (const match of context.masked.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>{}]*>)?\s*\([^)]*\)[^{;]*\{/gmu)) {
    const start = matchStart(match);
    if (insideMacro(start) || implRanges.some((range) => start > range.start && start < range.end)) continue;
    const symbol = match[1]!;
    const annotations = annotationTextBefore(context.content, start);
    const isTest = /#\[test\]/u.test(annotations);
    candidates.push(braceCandidate({
      context,
      match,
      kind: isTest ? "test" : "function",
      symbol,
      qualifiedName: symbol,
      isTest,
    }));
  }
  return candidates;
}

const RUST_CONFIG: BraceLanguageConfig = {
  language: "rust",
  keywords: RUST_KEYWORDS,
  testPath: (path) => commonTestPath(path) || path.includes("/tests/"),
  candidates: rustCandidates,
  imports: rustImports,
};

function phpNamespace(masked: string): string {
  return /\bnamespace\s+([A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)\s*(?:;|\{)/iu.exec(masked)?.[1] ?? "";
}

function phpTypeOwners(context: BraceExtractionContext, namespace: string): TypeOwner[] {
  const owners: TypeOwner[] = [];
  const pattern = /^[ \t]*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)\b[^;{]*\{/gimu;
  for (const match of context.masked.matchAll(pattern)) {
    const symbol = match[2]!;
    const start = matchStart(match);
    const open = context.masked.indexOf("{", start);
    const parent = ownerForOffset(owners, start);
    const prefix = parent?.qualifiedName ?? namespace;
    owners.push({
      ...braceCandidate({
        context,
        match,
        kind: "class",
        symbol,
        qualifiedName: prefix ? `${prefix}\\${symbol}` : symbol,
      }),
      open,
    });
  }
  return owners;
}

function phpRouteAttribute(attributes: string, prefix = ""): CodeRoute | undefined {
  const route = /#\[\s*(?:(?:[A-Za-z_]\w*)\\)*Route\s*\(\s*(?:path\s*:\s*)?["']([^"']+)["']([\s\S]*?)\)\s*\]/iu
    .exec(attributes);
  if (route) {
    const method = /methods?\s*:\s*\[?\s*["'](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["']/iu
      .exec(route[2] ?? "")?.[1]?.toUpperCase() ?? "ANY";
    return { method, path: joinRoute(prefix, route[1]!) };
  }
  const shorthand = /#\[\s*(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/iu.exec(attributes);
  return shorthand
    ? { method: shorthand[1]!.toUpperCase(), path: joinRoute(prefix, shorthand[2]!) }
    : undefined;
}

function phpTestMarker(context: BraceExtractionContext, start: number, symbol: string): boolean {
  if (/^test[A-Z_]/iu.test(symbol)) return true;
  const annotations = annotationTextBefore(context.content, start);
  if (/#\[\s*(?:(?:[A-Za-z_]\w*)\\)*Test\b/iu.test(annotations)) return true;
  return /@test\b/iu.test(context.content.slice(Math.max(0, start - 600), start));
}

function phpCandidates(context: BraceExtractionContext): BraceCandidate[] {
  const namespace = phpNamespace(context.masked);
  const owners = phpTypeOwners(context, namespace);
  const ownerRoutePrefixes = new Map(owners.map((owner) => [
    owner.qualifiedName,
    phpRouteAttribute(annotationTextBefore(context.content, owner.start))?.path ?? "",
  ]));
  const candidates: BraceCandidate[] = owners.map((owner) => ({
    ...owner,
    isTest: /Test$/iu.test(owner.symbol),
  }));
  const methodPattern = /^[ \t]*(?:(?:public|protected|private|static|abstract|final|readonly)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?::\s*[^;{\r\n]+)?\s*\{/gimu;
  for (const owner of owners) {
    const body = context.masked.slice(owner.open + 1, owner.end - 1);
    for (const match of body.matchAll(methodPattern)) {
      const start = owner.open + 1 + matchStart(match);
      if (braceDepthAt(context.masked, owner.open, start) !== 1) continue;
      const symbol = match[1]!;
      const open = context.masked.indexOf("{", start);
      const qualifiedName = `${owner.qualifiedName}::${symbol}`;
      const method: BraceCandidate = {
        kind: "method",
        symbol,
        qualifiedName,
        start,
        end: matchingBrace(context.masked, open),
        definition: definitionLine(context.content, start),
        isTest: phpTestMarker(context, start, symbol),
      };
      candidates.push(method);
      const route = phpRouteAttribute(
        annotationTextBefore(context.content, start),
        ownerRoutePrefixes.get(owner.qualifiedName) ?? ""
      );
      if (route) {
        const routeSymbol = `${route.method} ${route.path}`;
        candidates.push({
          ...method,
          kind: "route",
          symbol: routeSymbol,
          qualifiedName: `route:${routeSymbol}:${qualifiedName}`,
          routes: [{ ...route, handler: qualifiedName }],
          calls: [qualifiedName, symbol],
        });
      }
    }
  }
  for (const match of context.masked.matchAll(methodPattern)) {
    const start = matchStart(match);
    if (ownerForOffset(owners, start)) continue;
    const symbol = match[1]!;
    const qualifiedName = namespace ? `${namespace}\\${symbol}` : symbol;
    candidates.push(braceCandidate({
      context,
      match,
      kind: "function",
      symbol,
      qualifiedName,
      isTest: phpTestMarker(context, start, symbol),
    }));
  }
  const laravelRoute = /\bRoute\s*::\s*(get|post|put|patch|delete|options|any)\s*\(\s*["']([^"']+)["']/giu;
  for (const match of context.content.matchAll(laravelRoute)) {
    const start = matchStart(match);
    if (context.masked.slice(start, start + 5).toLowerCase() !== "route") continue;
    const method = match[1]!.toUpperCase();
    const routePath = match[2]!;
    candidates.push({
      kind: "route",
      symbol: `${method} ${routePath}`,
      qualifiedName: `route:${method} ${routePath}`,
      start,
      end: lineEnd(context.content, start),
      routes: [{ method, path: routePath }],
      calls: [`Route::${match[1]!}`],
    });
  }
  return candidates;
}

function phpImports(content: string): string[] {
  const masked = maskBraceLanguage(content, "php");
  const context: BraceExtractionContext = {
    source: { repositoryRoot: "", path: "fixture.php", content },
    content,
    masked,
  };
  const owners = phpTypeOwners(context, phpNamespace(masked));
  const values: string[] = [];
  for (const match of content.matchAll(/^[ \t]*use\s+(?:(function|const)\s+)?([^;]+);/gimu)) {
    const start = matchStart(match);
    if (ownerForOffset(owners, start) || !/^\s*use\b/iu.test(masked.slice(start))) continue;
    const target = match[2]!.trim();
    if (target.startsWith("(")) continue;
    values.push(`${match[1] ? `${match[1]!.toLowerCase()} ` : ""}${target}`);
  }
  return unique(values);
}

function phpVisibleValues(content: string, pattern: RegExp, group: number): string[] {
  const masked = maskBraceLanguage(content, "php");
  return unique([...content.matchAll(pattern)]
    .filter((match) => masked[matchStart(match)] !== " ")
    .map((match) => match[group] ?? ""));
}

function phpConfigKeys(content: string): string[] {
  return unique([
    ...phpVisibleValues(content, /\$_ENV\s*\[\s*["']([^"']+)["']\s*\]/giu, 1),
    ...phpVisibleValues(content, /\b(?:getenv|env|config)\s*\(\s*["']([^"']+)["']/giu, 1),
  ]);
}

function phpDatabaseRefs(content: string): string[] {
  return unique([
    ...phpVisibleValues(content, /\bprotected\s+\$table\s*=\s*["']([^"']+)["']/giu, 1),
    ...phpVisibleValues(content, /\b(?:DB\s*::\s*)?table\s*\(\s*["']([^"']+)["']/giu, 1),
  ]);
}

const PHP_CONFIG: BraceLanguageConfig = {
  language: "php",
  keywords: PHP_KEYWORDS,
  caseInsensitiveKeywords: true,
  testPath: (path) => commonTestPath(path) || /Test\.php$/iu.test(path),
  candidates: phpCandidates,
  imports: phpImports,
  configKeys: phpConfigKeys,
  databaseRefs: phpDatabaseRefs,
};

function includes(content: string): string[] {
  return unique([...content.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gmu)].map((match) => match[1]!));
}

function cFamilyCandidates(context: BraceExtractionContext, cpp: boolean): BraceCandidate[] {
  const candidates: BraceCandidate[] = [];
  const owners: TypeOwner[] = [];
  if (cpp) {
    for (const match of context.masked.matchAll(/^[ \t]*namespace\s+([A-Za-z_]\w*)\s*\{/gmu)) {
      const symbol = match[1]!;
      const start = matchStart(match);
      const open = context.masked.indexOf("{", start);
      candidates.push({ ...braceCandidate({ context, match, kind: "module", symbol, qualifiedName: symbol }), definition: `namespace ${symbol}` });
      owners.push({ ...braceCandidate({ context, match, kind: "module", symbol, qualifiedName: symbol }), open });
    }
    for (const match of context.masked.matchAll(/^[ \t]*(?:template\s*<[^>{}]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)\b[^;{]*\{/gmu)) {
      const symbol = match[1]!;
      const start = matchStart(match);
      const namespaceOwner = ownerForOffset(owners, start);
      const qualifiedName = namespaceOwner ? `${namespaceOwner.qualifiedName}::${symbol}` : symbol;
      const open = context.masked.indexOf("{", start);
      const owner: TypeOwner = { ...braceCandidate({ context, match, kind: "class", symbol, qualifiedName }), open };
      owners.push(owner);
      candidates.push(owner);
    }
  }
  const functionPatterns = [
    /^(?![ \t]*(?:public|protected|private)\s*:)[ \t]*(?:template\s*<[^>{}]*>\s*)?(?:(?:static|inline|constexpr|consteval|virtual|extern|friend|explicit|signed|unsigned|long|short)\s+)*(?:[A-Za-z_][\w:<>,*&\[\]]*\s+)+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:->\s*[^\n{]+)?\{/gmu,
    /^[ \t]*(?:(?:static|inline|constexpr|consteval|virtual|extern|friend|signed|unsigned|long|short|const|volatile|struct|class)\s+)*(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\s*<[^>{};]+>)?[ \t]*)?[*&]+[ \t]*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:->\s*[^\n{]+)?\{/gmu,
  ];
  const seenFunctionStarts = new Set<number>();
  for (const match of functionPatterns.flatMap((pattern) => [...context.masked.matchAll(pattern)])) {
    const start = matchStart(match);
    if (seenFunctionStarts.has(start)) continue;
    seenFunctionStarts.add(start);
    const rawName = match[1]!;
    if (CONTROL_WORDS.has(rawName.toLowerCase()) || /\boperator\b/u.test(match[0])) continue;
    const classOwner = ownerForOffset(owners.filter((owner) => owner.kind === "class"), start);
    if (classOwner && braceDepthAt(context.masked, classOwner.open, start) !== 1) continue;
    const open = context.masked.indexOf("{", start);
    const parts = rawName.split("::");
    const symbol = parts.at(-1)!;
    const namespaceOwner = ownerForOffset(owners.filter((owner) => owner.kind === "module"), start);
    const qualifiedName = rawName.includes("::")
      ? namespaceOwner && !rawName.startsWith(`${namespaceOwner.qualifiedName}::`)
        ? `${namespaceOwner.qualifiedName}::${rawName}`
        : rawName
      : classOwner
        ? `${classOwner.qualifiedName}::${symbol}`
        : namespaceOwner
          ? `${namespaceOwner.qualifiedName}::${symbol}`
          : symbol;
    candidates.push({
      kind: rawName.includes("::") || classOwner ? "method" : "function",
      symbol,
      qualifiedName,
      start,
      end: matchingBrace(context.masked, open),
      definition: definitionLine(context.content, start),
    });
  }
  if (cpp) {
    const constructorPattern = /^[ \t]*(?:(?:explicit|constexpr|consteval|inline)\s+)?([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\([^;{}]*\)\s*(?::[^{}]+)?\{/gmu;
    for (const match of context.masked.matchAll(constructorPattern)) {
      const start = matchStart(match);
      if (seenFunctionStarts.has(start)) continue;
      const rawName = match[1]!;
      const parts = rawName.split("::");
      const symbol = parts.at(-1)!;
      const declaredOwner = parts.length > 1 ? parts.at(-2) : undefined;
      const classOwner = ownerForOffset(owners.filter((owner) => owner.kind === "class"), start);
      if ((!declaredOwner || declaredOwner !== symbol) && classOwner?.symbol !== symbol) continue;
      if (classOwner && braceDepthAt(context.masked, classOwner.open, start) !== 1) continue;
      const namespaceOwner = ownerForOffset(owners.filter((owner) => owner.kind === "module"), start);
      const qualifiedName = rawName.includes("::")
        ? namespaceOwner && !rawName.startsWith(`${namespaceOwner.qualifiedName}::`)
          ? `${namespaceOwner.qualifiedName}::${rawName}`
          : rawName
        : `${classOwner!.qualifiedName}::${symbol}`;
      const open = context.masked.indexOf("{", start);
      candidates.push({
        kind: "method",
        symbol,
        qualifiedName,
        start,
        end: matchingBrace(context.masked, open),
        definition: definitionLine(context.content, start),
      });
    }
  }
  return candidates;
}

const C_CONFIG: BraceLanguageConfig = {
  language: "c",
  keywords: C_KEYWORDS,
  testPath: commonTestPath,
  candidates: (context) => cFamilyCandidates(context, false),
  imports: includes,
};

const CPP_CONFIG: BraceLanguageConfig = {
  language: "cpp",
  keywords: CPP_KEYWORDS,
  testPath: commonTestPath,
  candidates: (context) => cFamilyCandidates(context, true),
  imports: includes,
};

abstract class BraceKnowledgeAdapter implements KnowledgeAdapter {
  abstract readonly parserVersion: string;
  abstract readonly extensionClaims: readonly string[];
  abstract readonly config: BraceLanguageConfig;

  supports(source: Pick<CodeSource, "path">): boolean {
    return extensionSupported(source.path, this.extensionClaims);
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    return this.supports(source) ? extractBraceLanguage(source, this.config) : [];
  }
}

export class JavaKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = JAVA_ADAPTER_VERSION;
  readonly extensionClaims = [".java"] as const;
  readonly config = JAVA_CONFIG;
}

export class KotlinKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = KOTLIN_ADAPTER_VERSION;
  readonly extensionClaims = [".kt", ".kts"] as const;
  readonly config = KOTLIN_CONFIG;
}

export class ApexKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = APEX_ADAPTER_VERSION;
  readonly extensionClaims = [".cls", ".trigger"] as const;
  readonly config = APEX_CONFIG;
}

export class CSharpKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = CSHARP_ADAPTER_VERSION;
  readonly extensionClaims = [".cs"] as const;
  readonly config = CSHARP_CONFIG;
}

export class GoKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = GO_ADAPTER_VERSION;
  readonly extensionClaims = [".go"] as const;
  readonly config = GO_CONFIG;
}

export class RustKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = RUST_ADAPTER_VERSION;
  readonly extensionClaims = [".rs"] as const;
  readonly config = RUST_CONFIG;
}

export class PhpKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = PHP_ADAPTER_VERSION;
  readonly extensionClaims = [".php"] as const;
  readonly config = PHP_CONFIG;

  override supports(source: Pick<CodeSource, "path">): boolean {
    const path = source.path.toLowerCase();
    return path.endsWith(".php") && !path.endsWith(".blade.php");
  }
}

export class CKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = C_ADAPTER_VERSION;
  readonly extensionClaims = [".c"] as const;
  readonly config = C_CONFIG;
}

export class CppKnowledgeAdapter extends BraceKnowledgeAdapter {
  readonly parserVersion = CPP_ADAPTER_VERSION;
  readonly extensionClaims = [".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh"] as const;
  readonly config = CPP_CONFIG;
}
