import * as nodePath from "node:path";
import {
  codeFragmentId,
  lineNumberAt,
  unique,
} from "./brace-language-engine.js";
import {
  SFMETA_ADAPTER_VERSION,
  type CodeFragmentKind,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

export const SFMETA_EXTENSION_CLAIMS = [
  ".object-meta.xml",
  ".field-meta.xml",
  ".validationrule-meta.xml",
  ".flow-meta.xml",
  ".permissionset-meta.xml",
] as const;

interface XmlSpan {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

function supportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SFMETA_EXTENSION_CLAIMS.some((claim) => lower.endsWith(claim));
}

function wellFormedXml(content: string): boolean {
  const stack: string[] = [];
  let rootElements = 0;
  for (let offset = 0; offset < content.length;) {
    const start = content.indexOf("<", offset);
    if (start < 0) return !content.slice(offset).trim() && rootElements === 1 && stack.length === 0;
    if (stack.length === 0 && content.slice(offset, start).trim()) return false;
    if (content.startsWith("<!--", start)) {
      const end = content.indexOf("-->", start + 4);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", start)) {
      if (stack.length === 0) return false;
      const end = content.indexOf("]]>", start + 9);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    if (content.startsWith("<?", start)) {
      const end = content.indexOf("?>", start + 2);
      if (end < 0) return false;
      offset = end + 2;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < content.length; end++) {
      const value = content[end]!;
      if (quote) {
        if (value === quote) quote = "";
      } else if (value === "\"" || value === "'") {
        quote = value;
      } else if (value === ">") {
        break;
      }
    }
    if (end >= content.length || quote) return false;
    const token = content.slice(start + 1, end).trim();
    if (token.startsWith("!")) return false;
    const closing = token.startsWith("/");
    const selfClosing = !closing && token.endsWith("/");
    const name = /^\/?([A-Za-z_][\w:.-]*)(?:\s|\/|$)/u.exec(token)?.[1];
    if (!name) return false;
    if (closing) {
      if (token.slice(1 + name.length).trim() || stack.pop() !== name) return false;
    } else {
      if (stack.length === 0 && ++rootElements > 1) return false;
      if (!selfClosing) stack.push(name);
    }
    offset = end + 1;
  }
  return rootElements === 1 && stack.length === 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function elementSpans(content: string, tag: string): XmlSpan[] {
  const values: XmlSpan[] = [];
  const lower = content.toLowerCase();
  const open = new RegExp(`<${tag}\\b[^>]*>`, "giu");
  const closeToken = `</${tag.toLowerCase()}>`;
  for (const match of content.matchAll(open)) {
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const close = lower.indexOf(closeToken, bodyStart);
    if (close < 0) continue;
    values.push({ start, bodyStart, bodyEnd: close, end: close + closeToken.length });
  }
  return values;
}

function firstElement(content: string, tag: string): XmlSpan | undefined {
  return elementSpans(content, tag)[0];
}

function childText(content: string, tag: string, within?: XmlSpan): string | undefined {
  const start = within?.bodyStart ?? 0;
  const end = within?.bodyEnd ?? content.length;
  const slice = content.slice(start, end);
  const span = firstElement(slice, tag);
  return span ? decodeXml(slice.slice(span.bodyStart, span.bodyEnd)) || undefined : undefined;
}

function apiName(path: string, suffix: string): string {
  const name = nodePath.posix.basename(path.replace(/\\/gu, "/"));
  return name.slice(0, -suffix.length);
}

function objectFromSfdxPath(path: string): string | undefined {
  return /(?:^|\/)objects\/([^/]+)\/(?:fields|validationRules)\//iu.exec(path.replace(/\\/gu, "/"))?.[1];
}

function formulaReferences(formula: string | undefined): string[] {
  if (!formula) return [];
  const ignored = new Set([
    "and", "blankvalue", "case", "false", "if", "isblank", "isnew", "isnull", "not", "null",
    "or", "priorvalue", "record", "text", "today", "true", "user",
  ]);
  const chars = formula.split("");
  for (let index = 0; index < formula.length;) {
    if (formula[index] !== "\"" && formula[index] !== "'") {
      index++;
      continue;
    }
    const quote = formula[index]!;
    const start = index++;
    while (index < formula.length) {
      if (formula[index] === quote && formula[index - 1] !== "\\") {
        index++;
        break;
      }
      index++;
    }
    for (let offset = start; offset < index; offset++) chars[offset] = " ";
  }
  const searchable = chars.join("");
  const values: string[] = [];
  for (const match of searchable.matchAll(/\b(?:[A-Za-z_][\w]*\.)?[A-Za-z_][\w]*\b/gu)) {
    const value = match[0]!;
    const lower = value.toLowerCase();
    const after = searchable.slice((match.index ?? 0) + value.length).trimStart();
    if (!ignored.has(lower) && !after.startsWith("(")) values.push(value);
  }
  return unique(values);
}

function fragment(params: {
  source: CodeSource;
  span: XmlSpan;
  kind: CodeFragmentKind;
  symbol: string;
  qualifiedName: string;
  definition: string;
  references?: string[];
  calls?: string[];
  databaseRefs?: string[];
  docComment?: string;
}): KnowledgeFragment {
  const startLine = lineNumberAt(params.source.content, params.span.start);
  const endLine = Math.max(startLine, lineNumberAt(params.source.content, Math.max(
    params.span.start,
    params.span.end - 1
  )));
  return {
    id: codeFragmentId(params.source.path, params.kind, params.qualifiedName, startLine),
    path: params.source.path,
    symbol: params.symbol,
    qualifiedName: params.qualifiedName,
    kind: params.kind,
    definition: params.definition,
    range: { startLine, endLine },
    imports: [],
    references: unique(params.references ?? []),
    calls: unique(params.calls ?? []),
    routes: [],
    configKeys: [],
    databaseRefs: unique(params.databaseRefs ?? []),
    isTest: false,
    ...(params.docComment ? { docComment: params.docComment } : {}),
  };
}

function moduleFragment(source: CodeSource): KnowledgeFragment {
  const span = { start: 0, end: source.content.length, bodyStart: 0, bodyEnd: source.content.length };
  return fragment({
    source,
    span,
    kind: "module",
    symbol: source.path,
    qualifiedName: source.path,
    definition: `module ${source.path}`,
  });
}

function customObject(source: CodeSource): KnowledgeFragment | undefined {
  const span = firstElement(source.content, "CustomObject");
  if (!span) return undefined;
  const name = apiName(source.path, ".object-meta.xml");
  const label = childText(source.content, "label", span);
  const description = childText(source.content, "description", span);
  const docComment = [label, description].filter(Boolean).join(" — ");
  return fragment({
    source,
    span,
    kind: "class",
    symbol: name,
    qualifiedName: name,
    definition: `CustomObject ${name}`,
    databaseRefs: [name],
    ...(docComment ? { docComment } : {}),
  });
}

function customField(source: CodeSource): KnowledgeFragment | undefined {
  const span = firstElement(source.content, "CustomField");
  if (!span) return undefined;
  const field = apiName(source.path, ".field-meta.xml");
  const object = objectFromSfdxPath(source.path);
  const qualifiedName = object ? `${object}.${field}` : field;
  const type = childText(source.content, "type", span);
  const formula = childText(source.content, "formula", span);
  const label = childText(source.content, "label", span);
  return fragment({
    source,
    span,
    kind: "method",
    symbol: field,
    qualifiedName,
    definition: `CustomField ${qualifiedName}${type ? ` type=${type}` : ""}`,
    references: formulaReferences(formula),
    databaseRefs: object ? [object, qualifiedName] : [field],
    ...(label ? { docComment: label } : {}),
  });
}

function validationRule(source: CodeSource): KnowledgeFragment | undefined {
  const span = firstElement(source.content, "ValidationRule");
  if (!span) return undefined;
  const rule = apiName(source.path, ".validationRule-meta.xml");
  const object = objectFromSfdxPath(source.path);
  const qualifiedName = object ? `${object}.${rule}` : rule;
  const formula = childText(source.content, "errorConditionFormula", span);
  const description = childText(source.content, "description", span);
  return fragment({
    source,
    span,
    kind: "method",
    symbol: rule,
    qualifiedName,
    definition: `ValidationRule ${qualifiedName}`,
    references: formulaReferences(formula),
    databaseRefs: object ? [object] : [],
    ...(description ? { docComment: description } : {}),
  });
}

function flow(source: CodeSource): KnowledgeFragment | undefined {
  const span = firstElement(source.content, "Flow");
  if (!span) return undefined;
  const name = apiName(source.path, ".flow-meta.xml");
  const status = childText(source.content, "status", span);
  const calls: string[] = [];
  for (const tag of [
    "actionCalls", "apexPluginCalls", "recordCreates", "recordDeletes", "recordLookups", "recordUpdates", "subflows",
  ]) {
    for (const action of elementSpans(source.content.slice(span.bodyStart, span.bodyEnd), tag)) {
      const actionName = childText(source.content.slice(span.bodyStart, span.bodyEnd), "name", action);
      if (actionName) calls.push(actionName);
    }
  }
  const objects = elementSpans(source.content.slice(span.bodyStart, span.bodyEnd), "object")
    .map((item) => decodeXml(source.content.slice(span.bodyStart + item.bodyStart, span.bodyStart + item.bodyEnd)));
  return fragment({
    source,
    span,
    kind: "module",
    symbol: name,
    qualifiedName: name,
    definition: `Flow ${name}${status ? ` status=${status}` : ""}`,
    calls,
    databaseRefs: objects,
    docComment: childText(source.content, "description", span),
  });
}

function permissionSet(source: CodeSource): KnowledgeFragment | undefined {
  const span = firstElement(source.content, "PermissionSet");
  if (!span) return undefined;
  const name = apiName(source.path, ".permissionset-meta.xml");
  const objects = elementSpans(source.content.slice(span.bodyStart, span.bodyEnd), "object")
    .map((item) => decodeXml(source.content.slice(span.bodyStart + item.bodyStart, span.bodyStart + item.bodyEnd)));
  const fields = elementSpans(source.content.slice(span.bodyStart, span.bodyEnd), "field")
    .map((item) => decodeXml(source.content.slice(span.bodyStart + item.bodyStart, span.bodyStart + item.bodyEnd)));
  return fragment({
    source,
    span,
    kind: "class",
    symbol: name,
    qualifiedName: name,
    definition: `PermissionSet ${name}`,
    references: [...objects, ...fields],
    databaseRefs: [...objects, ...fields],
    docComment: childText(source.content, "description", span),
  });
}

export class SalesforceMetadataKnowledgeAdapter implements KnowledgeAdapter {
  readonly parserVersion = SFMETA_ADAPTER_VERSION;
  readonly extensionClaims = SFMETA_EXTENSION_CLAIMS;

  supports(source: Pick<CodeSource, "path">): boolean {
    return supportedPath(source.path);
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    if (!this.supports(source)) return [];
    if (!wellFormedXml(source.content)) return [moduleFragment(source)];
    const lower = source.path.toLowerCase();
    const entity = lower.endsWith(".object-meta.xml") ? customObject(source)
      : lower.endsWith(".field-meta.xml") ? customField(source)
      : lower.endsWith(".validationrule-meta.xml") ? validationRule(source)
      : lower.endsWith(".flow-meta.xml") ? flow(source)
      : lower.endsWith(".permissionset-meta.xml") ? permissionSet(source)
      : undefined;
    return entity ? [moduleFragment(source), entity] : [moduleFragment(source)];
  }
}
