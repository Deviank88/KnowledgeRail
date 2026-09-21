import { wellFormedXml, firstElement, elementSpans, childText, decodeXml, type XmlSpan } from "./manifest-xml.js";
import { SALESFORCE_MANIFEST } from "./import-resolution/salesforce-config.js";
import { createSalesforceReferenceResolver } from "./import-resolution/salesforce.js";
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
  ".labels-meta.xml", ".resource-meta.xml", ".messagechannel-meta.xml",
  ".page", ".component", ".cmp", ".app",
] as const;

function supportedPath(path: string): boolean {
  return SFMETA_EXTENSION_CLAIMS.some((claim) => path.toLowerCase().endsWith(claim));
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
  readonly projectManifests = [SALESFORCE_MANIFEST];
  readonly createReferenceResolver = createSalesforceReferenceResolver;
  readonly parserVersion = SFMETA_ADAPTER_VERSION;
  readonly extensionClaims = SFMETA_EXTENSION_CLAIMS;

  supports(source: Pick<CodeSource, "path">): boolean {
    return supportedPath(source.path);
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    if (!this.supports(source)) return [];
    if (!wellFormedXml(source.content)) return [moduleFragment(source)];
    const lower = source.path.toLowerCase();
    if (/\.(?:page|component|cmp|app)$/u.test(lower)) {
      const module = moduleFragment(source);
      const visible = source.content.replace(/<!--[\s\S]*?-->/gu, " ");
      const root = /^\s*(?:<\?xml[^>]*>\s*)?<(?:apex:(?:page|component)|aura:(?:component|application))\b((?:"[^"]*"|'[^']*'|[^'">])*)>/u.exec(visible);
      if (root) {
        const declared = new Set<string>();
        for (const attribute of root[1]!.matchAll(/\b(controller|extensions)\s*=\s*(["'])(.*?)\2/gu)) {
          if (attribute[1] === "extensions" && /\.(?:cmp|app)$/u.test(lower)) continue;
          const names = attribute[3]!.split(",").map((name) => name.trim());
          if (names.every((name) => /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/u.test(name))) for (const name of names) declared.add(name);
        }
        if (declared.size) module.declaredReferences = [...declared];
      }
      return [module];
    }
    if (lower.endsWith(".labels-meta.xml")) {
      return [moduleFragment(source), ...elementSpans(source.content, "labels").flatMap((span) => {
        const name = childText(source.content, "fullName", span);
        return name && /^[A-Za-z_]\w*$/u.test(name) ? [fragment({ source, span, kind: "constant", symbol: name,
          qualifiedName: name, definition: `CustomLabel ${name}`, docComment: childText(source.content, "shortDescription", span) })] : [];
      })];
    }
    for (const [suffix, tag, kind] of [[".resource-meta.xml", "StaticResource", "constant"],
      [".messageChannel-meta.xml", "LightningMessageChannel", "class"]] as const) {
      if (!lower.endsWith(suffix.toLowerCase())) continue;
      const span = firstElement(source.content, tag), name = apiName(source.path, suffix);
      return span ? [moduleFragment(source), fragment({ source, span, kind, symbol: name, qualifiedName: name,
        definition: `${tag} ${name}`, docComment: childText(source.content, "description", span) })] : [moduleFragment(source)];
    }
    const entity = lower.endsWith(".object-meta.xml") ? customObject(source)
      : lower.endsWith(".field-meta.xml") ? customField(source)
      : lower.endsWith(".validationrule-meta.xml") ? validationRule(source)
      : lower.endsWith(".flow-meta.xml") ? flow(source)
      : lower.endsWith(".permissionset-meta.xml") ? permissionSet(source)
      : undefined;
    return entity ? [moduleFragment(source), entity] : [moduleFragment(source)];
  }
}
