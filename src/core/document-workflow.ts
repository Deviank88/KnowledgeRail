import * as nodePath from "node:path";
import { marked, type Token, type Tokens } from "marked";
import { documentPersona, documentTemplate } from "../config/templates.js";
import {
  documentContract,
  DOCUMENT_TYPES,
  USER_REQUEST_LANGUAGE,
  type DocumentContract,
} from "../config/document-contracts.js";
import { getRuntimeWikiGraph } from "./graph-runtime.js";
import { WIKI_PAGE_DIRECTORY_BY_TYPE } from "../config/workspace-layout.js";
import {
  sectionEvidencePlan,
  type EditorialEvidenceKind,
  type SectionEvidencePlan,
} from "../config/editorial-plans.js";
import { compileTaskContext, type TaskContext } from "../context/task-context-compiler.js";
import { readValidatedWikiPageRecord, readWikiResource } from "../context/resource-reader.js";
import { readSourceCoverageLedger, sourceCoverageMetrics } from "./ingestion/coverage-ledger.js";
import type { WikiPageRecord } from "./page-record.js";
import { getWikiPageRecords } from "./retrieval-index.js";
import { tokenizeSearchText, type RetrievalProfile } from "./text-analysis.js";
import { WIKI_PAGE_TYPES, type WikiPageType } from "./wiki-validation.js";

export { DOCUMENT_TYPES, type DocumentType } from "../config/document-contracts.js";
export { WIKI_PAGE_TYPES, type WikiPageType } from "./wiki-validation.js";

export interface WikiPageInventoryEntry {
  relPath: string;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  body: string;
  charCount: number;
}

export interface TemplateSection {
  level: number;
  title: string;
  heading: string;
}

export interface SectionContextOptions {
  wikiRoot: string;
  sectionTitle: string;
  query?: string;
  documentType?: string;
  diagramMode?: DiagramMode;
  writerLanguage?: string;
  evidencePlan?: Partial<SectionEvidencePlan>;
  pagePaths?: string[];
  pageTypes?: readonly string[];
  maxPages?: number;
  maxCharsPerPage?: number;
  maxTotalChars?: number;
  maxOutputChars?: number;
  heuristicTokenBudget?: number;
  retrievalProfile?: RetrievalProfile;
  /** Retained for API compatibility. The accuracy-safe compiler always uses the graph. */
  useGraph?: boolean;
}

export interface SectionContextPage {
  relPath: string;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  evidenceUri?: string;
  heading?: string;
  score: number;
  includedChars: number;
  originalChars: number;
  truncated: boolean;
  body: string;
}

export interface SectionSourceCoverage {
  referencedSources: number;
  knownSources: number;
  fullyCoveredSources: number;
  unknownSources: string[];
  averageCoveragePercent: number | null;
}

export interface SectionCoverageMatrix {
  status: "COVERED" | "GAP";
  requiredEvidence: EditorialEvidenceKind[];
  foundEvidence: EditorialEvidenceKind[];
  missingEvidence: EditorialEvidenceKind[];
  sourceCoverage: SectionSourceCoverage;
  contradictions: string[];
  unprovenancedEvidenceCount: number;
}

export interface SectionContextResult {
  documentType?: string;
  writerLanguage?: string;
  diagramRelevant: boolean;
  diagramMode: DiagramMode | null;
  diagramEvidencePack?: DiagramEvidencePack;
  pages: SectionContextPage[];
  totalIncludedChars: number;
  totalOriginalChars: number;
  coverage: SectionCoverageMatrix;
  graphSummary?: string;
  compiler: {
    strategy: TaskContext["retrieval"]["strategy"];
    wideningLevel: TaskContext["retrieval"]["wideningLevel"];
    manifestHeuristicTokens: number;
    withinHeuristicBudget: boolean;
    fallbackUsed: boolean;
    fullGraphScanAttempted: false;
    fullSourceGrepAttempted: false;
  };
  omittedPaths?: string[];
}

export interface ReviewFinding {
  severity: "BLOCKER" | "WARNING" | "INFO";
  code: string;
  message: string;
  evidence?: string;
}

export interface DocumentReviewResult {
  documentType?: string;
  effectiveDiagramMode: DiagramMode | null;
  readyForDelivery: boolean;
  blockerCount: number;
  contractCheckCount: number;
  contractChecksPassed: number;
  findings: ReviewFinding[];
  missingSections: string[];
  weakSections: string[];
  placeholderCount: number;
  mermaidIssueCount: number;
  clientFacingIssueCount: number;
  languageIssueCount: number;
  coverage: Array<{ section: string; status: "ok" | "weak"; evidence: string[] }>;
}

export interface ReviewOptions {
  documentType?: string;
  diagramMode?: DiagramMode;
  language?: string;
  clientFacing?: boolean;
  includeWikiUpdatePlan?: boolean;
  assetResolver?: DocumentAssetResolver;
}

export interface DocumentPlanOptions {
  documentType: string;
  template?: string;
  projectName?: string;
  objective?: string;
  audience?: string;
  language?: string;
  maxSections?: number;
}

export const DIAGRAM_MODES = ["none", "mermaid", "external_asset"] as const;
export type DiagramMode = (typeof DIAGRAM_MODES)[number];

export interface DiagramEvidenceNode {
  id: string;
  label: string;
  type: string;
  path?: string;
  evidenceRefs: string[];
}

export interface DiagramEvidenceRelation {
  from: string;
  to: string;
  kind: string;
  evidenceRefs: string[];
}

export interface DiagramEvidencePack {
  nodes: DiagramEvidenceNode[];
  relations: DiagramEvidenceRelation[];
  gaps: string[];
}

export interface DocumentAssetRequest {
  relativePath: string;
  readLimit: number;
}

export type DocumentAssetResolution =
  | { status: "resolved"; byteLength: number; bytes?: Uint8Array }
  | { status: "missing"; detail?: string }
  | { status: "escape"; detail?: string }
  | { status: "invalid"; detail?: string };

export type DocumentAssetResolver = (
  request: DocumentAssetRequest
) => Promise<DocumentAssetResolution>;

export const DOCUMENT_ASSET_MAX_BYTES = 5 * 1024 * 1024;

const DIAGRAM_RELEVANT_SECTION =
  /architett|architect|component|system context|data|entit|schema|fluss|process|workflow|sequence|integraz|integrat|interface|api|deployment|infrastrutt|infrastruct|topolog|dipenden|dependenc/i;

export function isDiagramRelevantSection(sectionTitle: string): boolean {
  return DIAGRAM_RELEVANT_SECTION.test(sectionTitle);
}

export interface KnowledgeUpdateOptions {
  finding: string;
  targetPagePath?: string;
  pageType?: WikiPageType;
  title?: string;
  wikiContext?: string;
  codeContext?: string;
  sources?: string[];
  date?: string;
}

const CLIENT_INTERNAL_PATTERNS: Array<{ code: string; pattern: RegExp; label: string }> = [
  { code: "WIKI_REFERENCE", pattern: /\bwiki\b|wiki[_-][a-z_]+|wiki\//i, label: "references to the wiki or wiki tools" },
  { code: "CONTEXT_PACK_REFERENCE", pattern: /context pack|pagina sorgente|pagine sorgenti|fonti frontmatter/i, label: "references to context packs or the evidence-gathering process" },
  { code: "AGENT_REFERENCE", pattern: /\bagent\b|\bLLM\b|prompt|sub-agent|writer assegnato/i, label: "references to agents, LLMs, or prompts" },
  { code: "INTERNAL_PATH_REFERENCE", pattern: /\b(src|tests|docs|wiki)[\\/][\w./-]+/i, label: "internal paths exposed to the client" },
];
const ITALIAN_LANGUAGE_PATTERNS: Array<{ pattern: RegExp; suggestion: string }> = [
  { pattern: /(^|[\s(["])qual['’]è(?=$|[\s),.;:!?])/gi, suggestion: "Usare `qual è` senza apostrofo." },
  { pattern: /(^|[\s(["])un pò(?=$|[\s),.;:!?])/gi, suggestion: "Usare `un po'`." },
  { pattern: /(^|[\s(["])perchè(?=$|[\s),.;:!?])/gi, suggestion: "Usare `perché`." },
  { pattern: /(^|[\s(["])poichè(?=$|[\s),.;:!?])/gi, suggestion: "Usare `poiché`." },
  { pattern: /(^|[\s(["])affinchè(?=$|[\s),.;:!?])/gi, suggestion: "Usare `affinché`." },
  { pattern: /(^|[\s(["])nonchè(?=$|[\s),.;:!?])/gi, suggestion: "Usare `nonché`." },
  { pattern: /(^|[\s(["])sè stesso(?=$|[\s),.;:!?])/gi, suggestion: "Usare `se stesso`." },
  { pattern: /(^|[\s(["])dà luogo(?=$|[\s),.;:!?])/gi, suggestion: "Valutare `da luogo` solo se `da` è preposizione; mantenere `dà` solo come verbo dare." },
];
const ITALIAN_LANGUAGE_SUGGESTIONS = [
  "Use Italian `qual è` without an apostrophe.",
  "Use Italian `un po'`.",
  "Use Italian `perché`.",
  "Use Italian `poiché`.",
  "Use Italian `affinché`.",
  "Use Italian `nonché`.",
  "Use Italian `se stesso`.",
  "Use Italian `da luogo` only when `da` is a preposition; retain `dà` only as the verb.",
] as const;

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`*_#[\](){}:.,;!?'"|/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function titleToSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "Knowledge_Update";
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isTemplatePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return /[A-Za-zÀ-ÿ]/.test(trimmed);
}

export async function collectWikiInventory(
  wikiRoot: string,
  pageTypes?: readonly string[]
): Promise<WikiPageInventoryEntry[]> {
  const typeFilter = pageTypes ? new Set(pageTypes) : null;
  return (await getWikiPageRecords(wikiRoot))
    .filter((record) => !typeFilter || typeFilter.has(record.type))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((record) => ({
      relPath: record.path,
      title: record.title,
      type: record.type,
      tags: record.tags,
      sources: record.sources,
      body: record.body,
      charCount: record.body.length,
    }));
}

export function parseTemplateSections(template: string, maxSections?: number): TemplateSection[] {
  const sections: TemplateSection[] = [];
  const sectionRe = /^(##)\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(template)) !== null) {
    sections.push({
      level: match[1].length,
      title: match[2].trim(),
      heading: match[0],
    });
    if (maxSections && sections.length >= maxSections) break;
  }
  return sections;
}

export async function buildDocumentPlan(
  wikiRoot: string,
  options: DocumentPlanOptions
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const contract = documentContract(options.documentType);
  const outputLanguage = options.language?.trim() || contract.defaultLanguage;
  const rawTemplate = options.template ?? documentTemplate(options.documentType);
  const persona = documentPersona(options.documentType);
  const template = rawTemplate
    ? rawTemplate
        .replace(/\{\{PROJECT_NAME\}\}/g, options.projectName ?? "{{PROJECT_NAME}}")
        .replace(/\{\{DATE\}\}/g, today)
    : "";
  const sections = template ? parseTemplateSections(template, options.maxSections) : [];
  const inventory = await collectWikiInventory(wikiRoot);
  const counts = new Map<string, number>();
  for (const page of inventory) {
    counts.set(page.type || "unknown", (counts.get(page.type || "unknown") ?? 0) + 1);
  }

  const sectionLines =
    sections.length > 0
      ? sections
          .map((section, idx) => {
            const query = section.title.replace(/^\d+[\s.]+/, "");
            const evidencePlan = sectionEvidencePlan(options.documentType, section.title);
            return [
              `### ${idx + 1}. ${section.title}`,
              `- **Assigned writer:** specialist for section "${section.title}".`,
              `- **Required evidence:** ${evidencePlan.require.join(", ") || "none"}.`,
              `- **Preferred evidence:** ${evidencePlan.prefer.join(", ") || "none"}.`,
              `- **Context pack:** call \`knowledge_document_context action="section"\` with \`document_type="${options.documentType}"\`, \`section_title="${section.title}"\`, \`query="${query}"\`, \`retrieval_profile="coverage"\`.`,
              "- **Expected output:** assembly-ready Markdown with no placeholders, concrete evidence, and explicit gaps.",
            ].join("\n");
          })
          .join("\n\n")
      : "- Custom document: define sections first, then request a targeted context pack for each section.";

  const templateBlock = template
    ? ["## Reference template", "", "```markdown", template, "```"].join("\n")
    : "## Reference template\n\nNo predefined template for `custom`.";

  return [
    `# Document editorial plan`,
    ``,
    `> **Type:** ${options.documentType}`,
    `> **Project:** ${options.projectName ?? "{{PROJECT_NAME}}"}`,
    `> **Objective:** ${options.objective ?? "Produce a complete, consistent document that can be validated against the wiki."}`,
    `> **Audience:** ${options.audience ?? "Project stakeholders and the operations team."}`,
    `> **Contract:** ${contract.label} — ${contract.purpose}`,
    `> **Output language:** ${outputLanguage}`,
    `> **Default destination:** ${contract.defaultClientFacing ? "client-facing" : "internal/technical"}`,
    `> **Available wiki pages:** ${inventory.length}`,
    `> **Inventory by type:** ${[...counts.entries()].map(([type, count]) => `${type}: ${count}`).join(", ") || "n/a"}`,
    ``,
    `## Editor role`,
    ``,
    persona,
    ``,
    `The editor does not write everything in one pass: assign sections to writers, request targeted context packs, assemble the document, and then run review.`,
    ``,
    `## Context-pack strategy`,
    `- The template is an evidence plan: each section declares required and preferred evidence.`,
    `- The context pack must contain a required/found/missing/source-coverage/contradictions matrix.`,
    `- If the matrix state is \`GAP\`, report the gap without filling it with unsupported inference.`,
    `- For long contexts use \`knowledge_document_context action="section"\` with targeted queries and an explicit budget.`,
    `- Each writer receives only the pages relevant to their section, with an explicit character budget.`,
    `- When evidence is missing, write a traceable gap instead of inventing content.`,
    `- Expand relevant budget-excluded pages with \`knowledge_page action="read"\` and verify requirements/decisions across sections.`,
    `- For code evidence use \`knowledge_code\` first; a raw scan is an explicit fallback and must be recorded.`,
    `- Diagrams are optional and no representation is enforced when the choice is omitted. Use Mermaid or a relative external asset only when the user selected that representation; never use ASCII art.`,
    `- Write all human-readable titles, headings, and prose in ${outputLanguage}. The English reference template and editor instructions are structural guidance, not an English-output requirement.`,
    ``,
    `## Sections to assign to writers`,
    ``,
    sectionLines,
    ``,
    `## Editorial checklist`,
    `- Every planned section is present and consistent with the others.`,
    `- No placeholder such as \`[Describe...]\` or \`{{PROJECT_NAME}}\` remains in the final document.`,
    `- Tables, requirements, acceptance criteria, and risks are concrete and verifiable.`,
    `- Uncertain information is marked as a gap or assumption, not presented as fact.`,
    `- Before delivery, call \`knowledge_document action="review"\` on the saved file.`,
    `- If review finds gaps or inaccuracies, use \`prepare_knowledge_update\` and update the wiki before regenerating the document.`,
    ``,
    templateBlock,
  ].join("\n");
}

function selectPassageContext(
  record: WikiPageRecord,
  queryTerms: readonly string[],
  limit: number
): string {
  if (record.body.length <= limit) return record.body;
  const ranked = record.passages.map((passage, index) => {
    const tokens = new Set(tokenizeSearchText(`${passage.heading} ${passage.text}`));
    const matched = queryTerms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
    return { passage, index, score: matched / Math.max(queryTerms.length, 1) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen: Array<{ index: number; text: string }> = [];
  let used = 0;
  for (const item of ranked) {
    if (item.score <= 0 && chosen.length > 0) continue;
    const block = `### ${item.passage.heading}\n\n${item.passage.text}`;
    if (used + block.length > limit) {
      if (chosen.length === 0) chosen.push({ index: item.index, text: block.slice(0, limit) });
      continue;
    }
    chosen.push({ index: item.index, text: block });
    used += block.length + 2;
  }
  return chosen.sort((a, b) => a.index - b.index).map((item) => item.text).join("\n\n").slice(0, limit);
}

const EDITORIAL_KIND_FIELDS: Readonly<Partial<Record<
  EditorialEvidenceKind,
  readonly (keyof Pick<TaskContext,
    "requirements" | "decisions" | "invariants" | "constraints" | "dependencies" |
    "affectedComponents" | "implementationEvidence" | "tests" | "risks" |
    "currentState" | "contradictions"
  >)[]
>>> = {
  requirement: ["requirements"],
  implementation: ["implementationEvidence", "affectedComponents"],
  decision: ["decisions"],
  constraint: ["constraints"],
  invariant: ["invariants"],
  test: ["tests"],
  risk: ["risks"],
  current_state: ["currentState"],
  dependency: ["dependencies"],
  contradiction: ["contradictions"],
};

const EDITORIAL_REQUIRED_PAGE_TYPES: Readonly<Partial<Record<
  EditorialEvidenceKind,
  readonly string[]
>>> = {
  requirement: ["requirement"],
  implementation: ["implementation"],
  decision: ["decision"],
  test: ["test_result"],
  risk: ["risk"],
};

function taskFieldsForKinds(kinds: readonly EditorialEvidenceKind[]): Array<
  keyof Pick<TaskContext,
    "requirements" | "decisions" | "invariants" | "constraints" | "dependencies" |
    "affectedComponents" | "implementationEvidence" | "tests" | "risks" |
    "currentState" | "contradictions"
  >
> {
  return [...new Set(kinds.flatMap((kind) => EDITORIAL_KIND_FIELDS[kind] ?? []))];
}

function requiredPageTypesForKinds(kinds: readonly EditorialEvidenceKind[]): string[] {
  return [...new Set(kinds.flatMap((kind) => EDITORIAL_REQUIRED_PAGE_TYPES[kind] ?? []))];
}

function taskUrisForKind(task: TaskContext, kind: EditorialEvidenceKind): Set<string> {
  if (kind === "source") {
    return new Set(task.evidence.filter((evidence) => evidence.sourceRefs.length > 0).map((evidence) => evidence.uri));
  }
  const fields = EDITORIAL_KIND_FIELDS[kind] ?? [];
  return new Set(fields.flatMap((field) => task[field].map((evidence) => evidence.uri)));
}

function pageHasEditorialKind(
  page: SectionContextPage,
  kind: EditorialEvidenceKind,
  task: TaskContext
): boolean {
  if (kind === "source") return page.sources.length > 0;
  if (page.evidenceUri && taskUrisForKind(task, kind).has(page.evidenceUri)) return true;
  if (kind === "requirement") return page.type === "requirement";
  if (kind === "implementation") {
    return ["implementation", "api", "integration", "automation", "data_model"].includes(page.type);
  }
  if (kind === "decision") return page.type === "decision";
  if (kind === "test") return page.type === "test_result";
  if (kind === "risk") return page.type === "risk";
  if (kind === "current_state") {
    return ["entity", "concept", "summary", "overview", "analysis", "client_source", "meeting_note"].includes(page.type);
  }
  if (kind === "dependency") return ["api", "integration", "automation", "data_model"].includes(page.type);
  if (kind === "constraint") return /\b(constraint|vincol|limit|non deve|must not)\w*/i.test(page.body);
  if (kind === "invariant") return /\b(invariant|invariante|deve sempre|must always|must never)\w*/i.test(page.body);
  if (kind === "contradiction") return /\b(contrad|conflitt|conflict)\w*/i.test(page.body);
  return false;
}

async function sectionSourceCoverage(
  wikiRoot: string,
  pages: readonly SectionContextPage[]
): Promise<SectionSourceCoverage> {
  const sourceRefs = [...new Set(pages.flatMap((page) => page.sources))].sort();
  const known: Array<{ state: "open" | "fully_covered"; percent: number }> = [];
  const unknownSources: string[] = [];
  for (const sourceRef of sourceRefs) {
    const ledger = await readSourceCoverageLedger(wikiRoot, sourceRef);
    if (!ledger) {
      unknownSources.push(sourceRef);
      continue;
    }
    known.push({ state: ledger.state, percent: sourceCoverageMetrics(ledger).sourceCoveragePercent });
  }
  return {
    referencedSources: sourceRefs.length,
    knownSources: known.length,
    fullyCoveredSources: known.filter((source) => source.state === "fully_covered").length,
    unknownSources,
    averageCoveragePercent: sourceRefs.length === 0
      ? null
      : known.reduce((sum, source) => sum + source.percent, 0) / sourceRefs.length,
  };
}

function compilerGraphSummary(task: TaskContext, includedPaths: readonly string[]): string {
  const finalAttempt = task.retrieval.attempts.at(-1);
  return [
    "## Graph-based summary",
    "",
    `- Strategy: ${task.retrieval.strategy}, widening W${task.retrieval.wideningLevel}.`,
    `- Materialized evidence: ${includedPaths.length}; visited nodes: ${finalAttempt?.visitedNodes ?? 0}; ` +
      `visited edges: ${finalAttempt?.visitedEdges ?? 0}.`,
    `- Full graph scan: no; fallback: ${task.retrieval.fallbackUsed ? "yes" : "no"}.`,
  ].join("\n");
}

async function buildDiagramEvidencePack(
  wikiRoot: string,
  pages: readonly SectionContextPage[]
): Promise<DiagramEvidencePack> {
  if (pages.length === 0) {
    return {
      nodes: [],
      relations: [],
      gaps: ["No evidence pages were selected, so no diagram facts can be supported."],
    };
  }

  const runtime = await getRuntimeWikiGraph(wikiRoot, false, { persist: false });
  const pageByNodeId = new Map<string, SectionContextPage>();
  for (const page of pages) {
    const nodeId = runtime.pageNodeByPath.get(page.relPath);
    if (nodeId) pageByNodeId.set(nodeId, page);
  }

  const selected = new Set(pageByNodeId.keys());
  const allowedKinds = new Set([
    "page",
    "request",
    "requirement",
    "implementation",
    "test_result",
    "release",
    "api",
    "data_model",
  ]);
  const candidateEdges = runtime.graph.edges
    .filter((edge) => selected.has(edge.from) || selected.has(edge.to))
    .filter((edge) => {
      const from = runtime.nodesById.get(edge.from);
      const to = runtime.nodesById.get(edge.to);
      return Boolean(from && to && allowedKinds.has(from.kind) && allowedKinds.has(to.kind));
    })
    .slice(0, 40);
  const nodeIds = new Set<string>(selected);
  for (const edge of candidateEdges) {
    if (nodeIds.size < 20) nodeIds.add(edge.from);
    if (nodeIds.size < 20) nodeIds.add(edge.to);
  }

  const nodes = [...nodeIds]
    .map((id): DiagramEvidenceNode | null => {
      const node = runtime.nodesById.get(id);
      if (!node) return null;
      const page = pageByNodeId.get(id);
      const evidenceRefs = uniqueStrings([
        ...(page?.evidenceUri ? [page.evidenceUri] : []),
        ...(page?.sources ?? []),
        ...(node.path ? [node.path] : []),
      ]);
      return {
        id,
        label: node.label,
        type: node.kind,
        ...(node.path ? { path: node.path } : {}),
        evidenceRefs,
      };
    })
    .filter((node): node is DiagramEvidenceNode => node !== null);

  const relations = candidateEdges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge): DiagramEvidenceRelation => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      evidenceRefs: uniqueStrings([
        ...(pageByNodeId.get(edge.from)?.evidenceUri ? [pageByNodeId.get(edge.from)!.evidenceUri!] : []),
        ...(pageByNodeId.get(edge.to)?.evidenceUri ? [pageByNodeId.get(edge.to)!.evidenceUri!] : []),
        ...(pageByNodeId.get(edge.from)?.sources ?? []),
        ...(pageByNodeId.get(edge.to)?.sources ?? []),
      ]),
    }));
  const gaps: string[] = [];
  if (selected.size < pages.length) {
    gaps.push("Some selected evidence pages are not represented in the current graph index.");
  }
  if (relations.length === 0) {
    gaps.push("The current graph index contains no supported relations among the selected evidence.");
  }
  gaps.push("Message flows and cardinalities are omitted unless explicitly represented by indexed evidence.");
  return { nodes, relations, gaps };
}

export async function createSectionContext(
  options: SectionContextOptions
): Promise<SectionContextResult> {
  const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 8));
  const maxCharsPerPage = Math.max(1, options.maxCharsPerPage ?? 6000);
  const maxTotalChars = Math.max(0, Math.min(
    options.maxTotalChars ?? 30_000,
    options.maxOutputChars ? Math.max(0, options.maxOutputChars - 2_000) : Number.POSITIVE_INFINITY
  ));
  const queryText = [options.sectionTitle, options.query].filter(Boolean).join(" ");
  const queryTerms = tokenizeSearchText(queryText);
  const plan = sectionEvidencePlan(options.documentType, options.sectionTitle, options.evidencePlan);
  const priorityKinds = [...plan.require, ...plan.prefer];
  const task = await compileTaskContext({
    wikiRoot: options.wikiRoot,
    intent: "document",
    objective: `Prepare section \"${options.sectionTitle}\" using verifiable evidence.`,
    query: queryText,
    changedPaths: options.pagePaths,
    pageTypes: options.pageTypes,
    retrievalProfile: options.retrievalProfile ?? "coverage",
    maxEvidence: maxPages,
    heuristicTokenBudget: options.heuristicTokenBudget ?? 4_000,
    coverageRequirements: {
      minimumSourceDiversity: plan.require.includes("source") ? 1 : 0,
    },
    evidencePolicy: {
      replaceDefaults: true,
      requiredCategories: taskFieldsForKinds(plan.require),
      priorityCategories: taskFieldsForKinds(priorityKinds),
      requiredPageTypes: requiredPageTypesForKinds(plan.require),
    },
  });

  const explicitPaths = [...new Set((options.pagePaths ?? []).map((value) => value.replace(/\\/g, "/")))];
  const evidenceByPath = new Map(task.evidence.map((evidence) => [evidence.path, evidence] as const));
  const candidatePaths = [...new Set([...explicitPaths, ...task.evidence.map((evidence) => evidence.path)])];
  const pages: SectionContextPage[] = [];
  let remainingTotal = maxTotalChars;
  let totalIncludedChars = 0;
  let totalOriginalChars = 0;

  for (const relPath of candidatePaths) {
    if (pages.length >= maxPages || remainingTotal <= 0) break;
    const record = await readValidatedWikiPageRecord(options.wikiRoot, relPath);
    if (!record || (options.pageTypes && !options.pageTypes.includes(record.type))) continue;
    const evidence = evidenceByPath.get(relPath);
    const limit = Math.min(maxCharsPerPage, remainingTotal);
    const body = evidence
      ? (await readWikiResource({
          wikiRoot: options.wikiRoot,
          resourceUri: evidence.uri,
          maxCharacters: limit,
        })).text
      : selectPassageContext(record, queryTerms, limit);
    const truncated = body.length < record.body.length;
    pages.push({
      relPath,
      title: record.title,
      type: record.type,
      tags: record.tags,
      sources: record.sources,
      evidenceUri: evidence?.uri,
      heading: evidence?.heading,
      score: evidence?.score ?? 1_000_000,
      includedChars: body.length,
      originalChars: record.body.length,
      truncated,
      body,
    });
    remainingTotal -= body.length;
    totalIncludedChars += body.length;
    totalOriginalChars += record.body.length;
  }

  const consideredKinds = [...new Set([...plan.require, ...plan.prefer])];
  const foundEvidence = consideredKinds.filter((kind) =>
    pages.some((page) => pageHasEditorialKind(page, kind, task))
  );
  const missingEvidence = plan.require.filter((kind) => !foundEvidence.includes(kind));
  const contradictions = [...new Set([
    ...task.contradictions.map((evidence) => evidence.path),
    ...task.unknowns.filter((gap) => gap.kind === "contradiction").map((gap) => gap.description),
  ])];
  const coverage: SectionCoverageMatrix = {
    status: missingEvidence.length > 0 ? "GAP" : "COVERED",
    requiredEvidence: plan.require,
    foundEvidence,
    missingEvidence,
    sourceCoverage: await sectionSourceCoverage(options.wikiRoot, pages),
    contradictions,
    unprovenancedEvidenceCount: pages.filter((page) => page.sources.length === 0).length,
  };
  const includedPaths = new Set(pages.map((page) => page.relPath));
  const omittedPaths = candidatePaths.filter((candidate) => !includedPaths.has(candidate)).slice(0, 8);
  const diagramMode = options.diagramMode ?? null;
  const diagramRelevant = diagramMode === "mermaid" || diagramMode === "external_asset";
  return {
    documentType: options.documentType,
    writerLanguage: options.writerLanguage ?? (
      options.documentType ? documentContract(options.documentType).defaultLanguage : undefined
    ),
    diagramRelevant,
    diagramMode,
    ...(diagramRelevant
      ? { diagramEvidencePack: await buildDiagramEvidencePack(options.wikiRoot, pages) }
      : {}),
    pages,
    totalIncludedChars,
    totalOriginalChars,
    coverage,
    graphSummary: compilerGraphSummary(task, pages.map((page) => page.relPath)),
    compiler: {
      strategy: task.retrieval.strategy,
      wideningLevel: task.retrieval.wideningLevel,
      manifestHeuristicTokens: task.size.heuristicTokens,
      withinHeuristicBudget: task.budget.withinHeuristicBudget,
      fallbackUsed: task.retrieval.fallbackUsed,
      fullGraphScanAttempted: false,
      fullSourceGrepAttempted: false,
    },
    omittedPaths,
  };
}

export function formatSectionContext(
  result: SectionContextResult,
  sectionTitle: string,
  maxOutputChars?: number
): string {
  const lines: string[] = [
    `# Section context pack: ${sectionTitle}`,
    "",
    `> Included pages: ${result.pages.length}`,
    `> Included characters: ${result.totalIncludedChars}`,
    `> Original characters: ${result.totalOriginalChars}`,
    `> Context Compiler: ${result.compiler.strategy} W${result.compiler.wideningLevel}`,
    `> Manifest budget: ~${result.compiler.manifestHeuristicTokens} tokens (${result.compiler.withinHeuristicBudget ? "within budget" : "exceeded"})`,
    "",
    "## Evidence coverage matrix",
    "",
    "| State | Required evidence | Found evidence | Missing evidence | Source coverage | Contradictions |",
    "|---|---|---|---|---|---|",
    `| ${result.coverage.status} | ${result.coverage.requiredEvidence.join(", ") || "none"} | ` +
      `${result.coverage.foundEvidence.join(", ") || "none"} | ` +
      `${result.coverage.missingEvidence.join(", ") || "none"} | ` +
      `${result.coverage.sourceCoverage.averageCoveragePercent === null
        ? "no referenced sources"
        : `${result.coverage.sourceCoverage.averageCoveragePercent.toFixed(2)}% ` +
          `(${result.coverage.sourceCoverage.knownSources}/${result.coverage.sourceCoverage.referencedSources} known; ` +
          `${result.coverage.sourceCoverage.unknownSources.length} unknown)`} | ` +
      `${result.coverage.contradictions.join("; ") || "none detected"} |`,
    "",
    `> Evidence without source provenance: ${result.coverage.unprovenancedEvidenceCount}`,
    "",
    ...(result.coverage.status === "GAP"
      ? [
          "**GAP — required evidence is missing. Do not complete the section with unsupported inference.**",
          "",
        ]
      : []),
    "## Writer instructions",
    "- Use only the evidence in this context pack and report gaps instead of inventing content.",
    "- Every factual claim must preserve the provenance shown by the evidence URI or sources.",
    `- Write in the requested language (${result.writerLanguage ?? USER_REQUEST_LANGUAGE}) using a professional, concrete, polished register; the surrounding English instructions are internal guidance only.`,
    ...(result.diagramMode === "mermaid"
      ? ["- Diagram choice: Mermaid. If a diagram adds material clarity, write a complete fenced Mermaid block grounded only in the diagram evidence pack."]
      : result.diagramMode === "external_asset"
        ? ["- Diagram choice: external asset. If a diagram adds material clarity, reference a caller-owned relative SVG/PNG asset; KnowledgeRail does not generate it."]
        : result.diagramMode === "none"
          ? ["- Diagram choice: none. Do not add a diagram unless the user changes the selection."]
          : ["- Diagram choice: not selected. No representation is enforced; ask only when a diagram would materially help, then propagate diagram_mode explicitly."]),
    "- Do not use ASCII art or placeholders.",
    "",
  ];

  if (result.graphSummary) {
    lines.push(result.graphSummary.trimEnd());
    lines.push("");
  }

  if (result.pages.length === 0) {
    lines.push("No relevant pages were found for this section.");
    return lines.join("\n");
  }

  for (const page of result.pages) {
    lines.push(`## ${page.title}`);
    lines.push(`_Path: \`${page.relPath}\`_`);
    lines.push(`_Type: ${page.type || "n/a"} | Score: ${page.score}_`);
    if (page.heading) lines.push(`_Passage: ${page.heading}_`);
    if (page.evidenceUri) lines.push(`_Evidence URI: ${page.evidenceUri}_`);
    lines.push(`_Tags: ${page.tags.length > 0 ? page.tags.join(", ") : "n/a"}_`);
    lines.push(`_Sources: ${page.sources.length > 0 ? page.sources.join(", ") : "n/a"}_`);
    lines.push(`_Characters: ${page.includedChars}/${page.originalChars}${page.truncated ? " (truncated)" : ""}_`);
    lines.push("");
    lines.push(page.body);
    if (page.truncated) {
      lines.push("");
      lines.push(`_[Truncated: ${page.originalChars - page.includedChars} additional characters]_`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  if (result.omittedPaths && result.omittedPaths.length > 0) {
    lines.push("## Relevant pages omitted by the budget", "");
    for (const path of result.omittedPaths) lines.push(`- ${path}`);
    lines.push("", "Use `knowledge_page action=read` or a new context pack with `page_paths` to expand them.", "");
  }

  // The prose evidence remains first so an optional diagram aid cannot consume
  // the caller's output budget before the primary section evidence.
  if (result.diagramEvidencePack) {
    lines.push("## Diagram evidence pack", "");
    lines.push(`> Selected mode: ${result.diagramMode}; diagram required: no`);
    lines.push("", "### Nodes", "");
    if (result.diagramEvidencePack.nodes.length === 0) lines.push("- none");
    for (const node of result.diagramEvidencePack.nodes) {
      lines.push(`- ${node.id} — ${node.label} (${node.type}); evidence: ${node.evidenceRefs.join(", ") || "GAP"}`);
    }
    lines.push("", "### Relations", "");
    if (result.diagramEvidencePack.relations.length === 0) lines.push("- none");
    for (const relation of result.diagramEvidencePack.relations) {
      lines.push(`- ${relation.from} --${relation.kind}--> ${relation.to}; evidence: ${relation.evidenceRefs.join(", ") || "GAP"}`);
    }
    lines.push("", "### Diagram GAPs", "");
    for (const gap of result.diagramEvidencePack.gaps) lines.push(`- ${gap}`);
    lines.push("");
  }

  const output = lines.join("\n");
  if (!maxOutputChars || Buffer.byteLength(output, "utf8") <= maxOutputChars) return output;
  const marker = "\n\n_[Output truncated to the overall budget; expand the listed pages with knowledge_page action=read.]_";
  const contentByteBudget = Math.max(0, maxOutputChars - Buffer.byteLength(marker, "utf8"));
  let usedBytes = 0;
  let bounded = "";
  for (const character of output) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + bytes > contentByteBudget) break;
    bounded += character;
    usedBytes += bytes;
  }
  return `${bounded}${marker}`;
}

interface DeliverableHeading {
  level: number;
  title: string;
  blockIndex: number;
}

interface DeliverableCodeBlock {
  raw: string;
  language: string;
  text: string;
  fenced: boolean;
  closed: boolean;
}

interface TokenizedDeliverable {
  body: string;
  frontmatter?: string;
  tokens: Token[];
  headings: DeliverableHeading[];
  codeBlocks: DeliverableCodeBlock[];
  images: string[];
  links: string[];
  rawHtml: string[];
  proseFragments: string[];
}

function splitLeadingFrontmatter(markdown: string): { body: string; frontmatter?: string } {
  const firstLineEnd = markdown.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? markdown : markdown.slice(0, firstLineEnd)).replace(/^\uFEFF/, "").replace(/\r$/, "");
  if (!/^[ \t]*---[ \t]*$/.test(firstLine)) return { body: markdown };

  let lineStart = firstLineEnd === -1 ? markdown.length : firstLineEnd + 1;
  while (lineStart < markdown.length) {
    const lineEnd = markdown.indexOf("\n", lineStart);
    const nextEnd = lineEnd === -1 ? markdown.length : lineEnd;
    const line = markdown.slice(lineStart, nextEnd).replace(/\r$/, "");
    if (/^[ \t]*(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const bodyStart = lineEnd === -1 ? markdown.length : lineEnd + 1;
      return {
        frontmatter: markdown.slice(firstLineEnd === -1 ? markdown.length : firstLineEnd + 1, lineStart),
        body: markdown.slice(bodyStart),
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return { body: markdown };
}

function tokenChildren(token: Token): Token[] {
  if (token.type === "table") {
    const table = token as Tokens.Table;
    return [...table.header.flatMap((cell) => cell.tokens), ...table.rows.flatMap((row) => row.flatMap((cell) => cell.tokens))];
  }
  if (token.type === "list") return (token as Tokens.List).items;
  const children = (token as { tokens?: Token[] }).tokens;
  return children ?? [];
}

function tokenPlainText(tokens: readonly Token[]): string {
  const fragments: string[] = [];
  const visit = (token: Token): void => {
    if (token.type === "code" || token.type === "codespan" || token.type === "def") return;
    if (token.type === "html") {
      fragments.push((token as Tokens.HTML).text);
      return;
    }
    const children = tokenChildren(token);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    if ("text" in token && typeof token.text === "string") fragments.push(token.text);
  };
  tokens.forEach(visit);
  return fragments.join("\n");
}

function fencedCodeClosed(raw: string): boolean {
  const opening = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/);
  if (!opening) return true;
  const marker = opening[1][0];
  const minimum = opening[1].length;
  const lines = raw.slice(opening[0].length).split(/\r?\n/);
  return lines.some((line) => {
    const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
    return Boolean(close && close[1][0] === marker && close[1].length >= minimum);
  });
}

function htmlAttributeValues(html: string, element: string, attribute: string): string[] {
  const values: string[] = [];
  const elementRe = new RegExp(`<${element}\\b[^>]*>`, "gi");
  const attributeRe = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\u0060]+))`, "i");
  let elementMatch: RegExpExecArray | null;
  while ((elementMatch = elementRe.exec(html)) !== null) {
    const attributeMatch = attributeRe.exec(elementMatch[0]);
    const value = attributeMatch?.[1] ?? attributeMatch?.[2] ?? attributeMatch?.[3];
    if (value) values.push(value);
  }
  return values;
}

function htmlUriAttributeValues(html: string): string[] {
  const values: string[] = [];
  const attributeRe = /\b(?:href|src|xlink:href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = attributeRe.exec(html)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) values.push(value);
  }
  return values;
}

function tokenizeDeliverable(markdown: string): TokenizedDeliverable {
  const { body, frontmatter } = splitLeadingFrontmatter(markdown);
  const tokens = marked.lexer(body, { gfm: true, pedantic: false }) as Token[];
  const headings: DeliverableHeading[] = [];
  const codeBlocks: DeliverableCodeBlock[] = [];
  const images: string[] = [];
  const links: string[] = [];
  const rawHtml: string[] = [];
  const proseFragments: string[] = [];

  tokens.forEach((token, blockIndex) => {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      headings.push({ level: heading.depth, title: tokenPlainText(heading.tokens).trim() || heading.text.trim(), blockIndex });
    }
  });

  const visit = (token: Token): void => {
    if (token.type === "code") {
      const code = token as Tokens.Code;
      const fenced = code.codeBlockStyle !== "indented" && /^[ \t]{0,3}(?:`{3,}|~{3,})/.test(code.raw);
      codeBlocks.push({
        raw: code.raw,
        language: (code.lang ?? "").trim().split(/\s+/, 1)[0].toLowerCase(),
        text: code.text,
        fenced,
        closed: !fenced || fencedCodeClosed(code.raw),
      });
      return;
    }
    if (token.type === "codespan" || token.type === "def") return;
    if (token.type === "image") {
      const image = token as Tokens.Image;
      images.push(image.href);
    } else if (token.type === "link") {
      links.push((token as Tokens.Link).href);
    } else if (token.type === "html") {
      const html = (token as Tokens.HTML).text;
      rawHtml.push(html);
      images.push(...htmlAttributeValues(html, "img", "src"));
      proseFragments.push(html);
      return;
    }

    const children = tokenChildren(token);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    if ("text" in token && typeof token.text === "string") proseFragments.push(token.text);
  };
  tokens.forEach(visit);

  return {
    body,
    frontmatter,
    tokens,
    headings,
    codeBlocks,
    images: [...new Set(images)],
    links: [...new Set(links)],
    rawHtml,
    proseFragments,
  };
}

export function markdownImageTargets(markdown: string): string[] {
  return tokenizeDeliverable(markdown).images;
}

function assetFinding(
  severity: ReviewFinding["severity"],
  code: string,
  message: string,
  evidence: string
): ReviewFinding {
  return { severity, code, message, evidence };
}

function decodeHtmlUriCharacters(value: string): string {
  const codePoint = (raw: string, radix: number, original: string): string => {
    const parsed = Number.parseInt(raw, radix);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
      ? String.fromCodePoint(parsed)
      : original;
  };
  return value
    .replace(/&#(\d+);?/g, (match, code: string) => codePoint(code, 10, match))
    .replace(/&#x([\da-f]+);?/gi, (match, code: string) => codePoint(code, 16, match))
    .replace(/&(colon|tab|newline);/gi, (_match, name: string) => name.toLowerCase() === "colon" ? ":" : name.toLowerCase() === "tab" ? "\t" : "\n");
}

function normalizedUri(value: string): string {
  return decodeHtmlUriCharacters(value).trim().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
}

const UNSAFE_URI_SCHEMES = new Set(["javascript", "vbscript", "data", "file", "knowledge-rail"]);

function uriScheme(value: string): string | undefined {
  return normalizedUri(value).match(/^([a-z][a-z0-9+.-]*):/)?.[1];
}

function svgFindings(svg: string, rawTarget: string): ReviewFinding[] {
  if (!/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg)) return [];
  const decodedSvg = decodeHtmlUriCharacters(svg);
  const activeMarkup = /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<(?:iframe|object|embed)\b|\son[a-z]+\s*=|@import|url\s*\(/i.test(decodedSvg);
  const activeReference = htmlUriAttributeValues(decodedSvg).some((value) => {
    const scheme = uriScheme(value);
    return normalizedUri(value).startsWith("//") || scheme === "http" || scheme === "https" || Boolean(scheme && UNSAFE_URI_SCHEMES.has(scheme));
  });
  return activeMarkup || activeReference
    ? [assetFinding("BLOCKER", "SVG_ACTIVE_CONTENT", "The referenced SVG contains active or externally loaded content.", rawTarget)]
    : [];
}

async function validateDocumentAsset(
  rawTarget: string,
  resolver?: DocumentAssetResolver
): Promise<ReviewFinding[]> {
  const scheme = uriScheme(rawTarget);
  if (scheme === "http" || scheme === "https") {
    return [assetFinding("WARNING", "ASSET_REMOTE", "Remote images reduce offline portability and are not content-validated.", rawTarget)];
  }
  if (scheme && UNSAFE_URI_SCHEMES.has(scheme)) {
    return [assetFinding("BLOCKER", "ASSET_UNSAFE_URI", "Image references must not use active, embedded, filesystem, or private resource URIs.", rawTarget)];
  }
  if (scheme || rawTarget.startsWith("#")) {
    return [assetFinding("WARNING", "ASSET_NON_PORTABLE", "The image reference is not a portable workspace-relative asset.", rawTarget)];
  }
  if (rawTarget.includes("\\")) {
    return [assetFinding("BLOCKER", "ASSET_PATH_INVALID", "Image paths must use portable forward slashes.", rawTarget)];
  }

  let target: string;
  try {
    target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
  } catch {
    return [assetFinding("BLOCKER", "ASSET_PATH_INVALID", "The image path contains invalid URL encoding.", rawTarget)];
  }
  if (!target.startsWith("../assets/")) {
    return [assetFinding("BLOCKER", "ASSET_PATH_INVALID", "Deliverable images must remain below docs/assets.", rawTarget)];
  }

  const relativePath = target.slice("../assets/".length);
  const extension = nodePath.extname(relativePath).toLowerCase();
  const validatedFormat = extension === ".svg" || extension === ".png";
  const sniffExtensionless = extension === "";
  const findings: ReviewFinding[] = [];
  if (!validatedFormat) {
    findings.push(assetFinding(
      "WARNING",
      "ASSET_TYPE_UNSUPPORTED",
      sniffExtensionless
        ? "The extensionless local image is content-sniffed for SVG safety but has no portable declared format."
        : "Only SVG and PNG assets receive content validation; this local image is checked for existence and size only.",
      rawTarget
    ));
  }
  if (!resolver) {
    findings.push(assetFinding(
      validatedFormat || sniffExtensionless ? "BLOCKER" : "WARNING",
      "ASSET_UNVERIFIED",
      "The local image could not be resolved for review.",
      rawTarget
    ));
    return findings;
  }

  let resolution: DocumentAssetResolution;
  try {
    resolution = await resolver({
      relativePath,
      readLimit: extension === ".png" ? 8 : extension === ".svg" || sniffExtensionless ? DOCUMENT_ASSET_MAX_BYTES : 0,
    });
  } catch (error: unknown) {
    resolution = { status: "invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  if (resolution.status !== "resolved") {
    const isMissing = resolution.status === "missing";
    findings.push(assetFinding(
      isMissing && !validatedFormat && !sniffExtensionless ? "WARNING" : "BLOCKER",
      isMissing ? "ASSET_MISSING" : resolution.status === "escape" ? "ASSET_PATH_ESCAPE" : "ASSET_PATH_INVALID",
      isMissing
        ? "A referenced local image does not exist."
        : resolution.status === "escape"
          ? "The image path resolves outside docs/assets."
          : "The image path could not be resolved safely.",
      resolution.detail ?? rawTarget
    ));
    return findings;
  }

  if (resolution.byteLength > DOCUMENT_ASSET_MAX_BYTES) {
    findings.push(assetFinding(
      validatedFormat || sniffExtensionless ? "BLOCKER" : "WARNING",
      "ASSET_TOO_LARGE",
      "A referenced image exceeds the 5 MB review limit.",
      rawTarget
    ));
    return findings;
  }
  if (extension === ".png") {
    const signature = Buffer.from(resolution.bytes ?? []).subarray(0, 8).toString("hex");
    if (signature !== "89504e470d0a1a0a") {
      findings.push(assetFinding("BLOCKER", "ASSET_SIGNATURE_INVALID", "The referenced PNG has an invalid signature.", rawTarget));
    }
    return findings;
  }

  if (extension === ".svg") {
    const svg = Buffer.from(resolution.bytes ?? []).toString("utf8");
    if (!/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg)) {
      findings.push(assetFinding("BLOCKER", "ASSET_SIGNATURE_INVALID", "The referenced SVG does not start with an SVG element.", rawTarget));
    } else {
      findings.push(...svgFindings(svg, rawTarget));
    }
    return findings;
  }

  if (sniffExtensionless) {
    findings.push(...svgFindings(Buffer.from(resolution.bytes ?? []).toString("utf8"), rawTarget));
  }
  return findings;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function validateDocumentAssets(
  targets: readonly string[],
  resolver?: DocumentAssetResolver
): Promise<ReviewFinding[]> {
  if (targets.length === 0) return [];
  const batches = await mapWithConcurrency([...new Set(targets)], 4, (target) => validateDocumentAsset(target, resolver));
  return batches.flat();
}

export async function reviewDocumentStructure(
  markdown: string,
  template?: string,
  options: ReviewOptions = {}
): Promise<DocumentReviewResult> {
  const findings: ReviewFinding[] = [];
  const contract: DocumentContract | undefined = options.documentType
    ? documentContract(options.documentType)
    : undefined;
  let contractCheckCount = 0;
  let contractChecksPassed = 0;
  const tokenized = tokenizeDeliverable(markdown);
  const reviewText = tokenized.proseFragments.join("\n");
  const placeholders: string[] = [];
  const placeholderRe = /\[(?![ xX]\])([^\]\n]{3,})\](?!\()/g;
  for (const fragment of tokenized.proseFragments) {
    let placeholderMatch: RegExpExecArray | null;
    while ((placeholderMatch = placeholderRe.exec(fragment)) !== null) {
      if (isTemplatePlaceholder(placeholderMatch[1])) placeholders.push(placeholderMatch[0]);
    }
    placeholderRe.lastIndex = 0;
    placeholders.push(...(fragment.match(/\{\{[^}]+\}\}/g) ?? []));
  }
  for (const destination of [...tokenized.links, ...tokenized.images]) {
    placeholders.push(...(destination.match(/\{\{[^}]+\}\}/g) ?? []));
  }

  if (tokenized.rawHtml.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "RAW_HTML",
      message: "Raw HTML is preserved as source but is outside the portable Markdown profile.",
    });
  }
  const activeHtml = tokenized.rawHtml.filter((html) => {
    const decodedHtml = decodeHtmlUriCharacters(html);
    const activeMarkup = /<\/?(?:script|iframe|object|embed)\b|\son[a-z]+\s*=/i.test(decodedHtml);
    const activeReference = htmlUriAttributeValues(decodedHtml).some((value) => {
      const scheme = uriScheme(value);
      return Boolean(scheme && UNSAFE_URI_SCHEMES.has(scheme));
    });
    return activeMarkup || activeReference;
  });
  if (activeHtml.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "RAW_HTML_UNSAFE",
      message: "Raw HTML contains active elements, event handlers, or executable URI content.",
      evidence: activeHtml.slice(0, 3).join(", "),
    });
  }

  const privateResourceUris = [reviewText, ...tokenized.links, ...tokenized.images]
    .filter((value) => /knowledge-rail:\/\//i.test(normalizedUri(value)));
  if (privateResourceUris.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "PRIVATE_RESOURCE_URI",
      message: "Deliverables must not contain private knowledge-rail resource URIs.",
    });
  }

  const unsafeLinks = tokenized.links.filter((destination) => {
    const scheme = uriScheme(destination);
    return Boolean(scheme && UNSAFE_URI_SCHEMES.has(scheme));
  });
  if (unsafeLinks.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "LINK_UNSAFE_URI",
      message: "Links must not use active, embedded, filesystem, or private resource URIs.",
      evidence: unsafeLinks.slice(0, 5).join(", "),
    });
  }

  if (placeholders.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "UNRESOLVED_PLACEHOLDER",
      message: `${placeholders.length} unresolved placeholder(s) remain.`,
      evidence: [...new Set(placeholders)].slice(0, 8).join(", "),
    });
  }

  const unclosedFences = tokenized.codeBlocks.filter((block) => block.fenced && !block.closed);
  if (unclosedFences.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "UNCLOSED_CODE_FENCE",
      message: "The document contains an unclosed fenced code block.",
    });
  }

  const mermaidWarnings: string[] = [];
  const mermaidSecurityIssues: string[] = [];
  const mermaidBlocks = tokenized.codeBlocks.filter((block) => block.fenced && block.language === "mermaid");
  for (const block of mermaidBlocks) {
    const body = block.text.trim();
    const securityBody = decodeHtmlUriCharacters(body);
    const firstLine = body.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
    if (!/^(flowchart|graph|sequenceDiagram|erDiagram|classDiagram|stateDiagram(?:-v2)?|journey|gantt|pie|mindmap|timeline)\b/.test(firstLine)) {
      mermaidWarnings.push(firstLine || "(empty block)");
    }
    if (body.length > 50_000) mermaidWarnings.push("block exceeds 50,000 characters");
    if (/%%\s*\{|(?:^|[;\r\n])\s*(?:click|href|call|link)\b|https?:|javascript:|vbscript:|data:/i.test(securityBody)) {
      mermaidSecurityIssues.push("block contains an active directive or URI");
    }
    if (/<\/?(?:script|iframe|object|embed)\b|\son[a-z]+\s*=/i.test(securityBody)) {
      mermaidSecurityIssues.push("block contains active HTML syntax");
    }
    if (/<[^>]+>|data:/i.test(body)) {
      mermaidWarnings.push("block contains HTML-like or data URI syntax that requires renderer-specific verification");
    }
  }
  const knownNonDiagramLanguages = new Set(["mermaid", "json", "bash", "shell", "sh", "ts", "typescript", "js", "javascript", "yaml", "yml", "http", "text"]);
  const asciiDiagrams = tokenized.codeBlocks.filter((block) =>
    block.fenced
    && !knownNonDiagramLanguages.has(block.language)
    && /(?:──|-->|<--|\+[-+]{2,}|\|.*\|)/m.test(block.text)
  );

  if (mermaidSecurityIssues.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "MERMAID_UNSAFE",
      message: "One or more Mermaid blocks contain active directives or unsafe URI content.",
      evidence: mermaidSecurityIssues.slice(0, 5).join(", "),
    });
  }
  if (mermaidWarnings.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "MERMAID_INVALID",
      message: "One or more Mermaid blocks require renderer-specific syntax or size verification.",
      evidence: mermaidWarnings.slice(0, 5).join(", "),
    });
  }
  const imageLinkCount = tokenized.images.length;
  if (options.diagramMode === "none" && mermaidBlocks.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "DIAGRAM_MODE_MISMATCH",
      message: "The document contains Mermaid source although diagram_mode is none.",
    });
  }
  if (options.diagramMode === "external_asset" && mermaidBlocks.length > 0 && imageLinkCount === 0) {
    findings.push({
      severity: "WARNING",
      code: "DIAGRAM_MODE_MISMATCH",
      message: "diagram_mode is external_asset, but the document contains Mermaid source instead.",
    });
  }
  if (asciiDiagrams.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "ASCII_DIAGRAM",
      message: "Possible ASCII diagrams were found; convert them to Mermaid when they represent flows or architecture.",
    });
  }

  const language = (options.language ?? contract?.defaultLanguage ?? "English").toLowerCase();
  const languageIssues: string[] = [];
  if (language.includes("ital")) {
    for (const [index, rule] of ITALIAN_LANGUAGE_PATTERNS.entries()) {
      if (rule.pattern.test(reviewText)) {
        languageIssues.push(ITALIAN_LANGUAGE_SUGGESTIONS[index] ?? rule.suggestion);
      }
      rule.pattern.lastIndex = 0;
    }
  }
  if (languageIssues.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "LANGUAGE_REVIEW",
      message: `${languageIssues.length} possible language issue(s) were found for the requested language (${options.language ?? contract?.defaultLanguage ?? "English"}).`,
      evidence: uniqueStrings(languageIssues).slice(0, 8).join(" "),
    });
  }

  const clientFacingIssues: string[] = [];
  if (options.clientFacing ?? contract?.defaultClientFacing ?? true) {
    for (const rule of CLIENT_INTERNAL_PATTERNS) {
      if (rule.pattern.test(reviewText)) {
        clientFacingIssues.push(rule.label);
      }
      rule.pattern.lastIndex = 0;
    }
  }
  if (clientFacingIssues.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "NON_CLIENT_FACING",
      message: "The document contains internal-process references that are unsuitable for a client-facing deliverable.",
      evidence: uniqueStrings(clientFacingIssues).join(", "),
    });
  }

  const missingSections: string[] = [];
  const headings = tokenized.headings;
  const h1Headings = headings.filter((heading) => heading.level === 1);
  const h2Headings = headings.filter((heading) => heading.level === 2);
  contractCheckCount += 2;
  if (h1Headings.length === 1) {
    contractChecksPassed += 1;
  } else {
    findings.push({
      severity: "BLOCKER",
      code: "DOCUMENT_TITLE_CONTRACT",
      message: h1Headings.length === 0
        ? "The document must have an H1 title."
        : "The document must have exactly one H1 title.",
    });
  }
  if (h2Headings.length > 0) {
    contractChecksPassed += 1;
  } else {
    findings.push({
      severity: "BLOCKER",
      code: "DOCUMENT_SECTION_CONTRACT",
      message: "The document must contain at least one H2 section.",
    });
  }
  const normalizedH2 = h2Headings.map((heading) => normalizeText(heading.title));
  if (template) {
    for (const expected of parseTemplateSections(template)) {
      contractCheckCount += 1;
      const expectedNorm = normalizeText(expected.title).replace(/^\d+\s+/, "");
      const found = normalizedH2.some((actual) => {
        const actualNoNumber = actual.replace(/^\d+\s+/, "");
        return actualNoNumber === expectedNorm || actualNoNumber.includes(expectedNorm) || expectedNorm.includes(actualNoNumber);
      });
      if (found) {
        contractChecksPassed += 1;
      } else {
        missingSections.push(expected.title);
      }
    }
    if (missingSections.length > 0) {
      findings.push({
        severity: "BLOCKER",
        code: "MISSING_SECTIONS",
        message: `${missingSections.length} template section(s) are missing.`,
        evidence: missingSections.slice(0, 10).join(", "),
      });
    }
  }

  const weakSections: string[] = [];
  const coverage: DocumentReviewResult["coverage"] = [];
  const minimumSectionChars = contract?.minimumSectionChars ?? 12;
  for (const heading of h2Headings) {
    const nextHeading = headings.find((candidate) =>
      candidate.blockIndex > heading.blockIndex && candidate.level <= heading.level
    );
    const sectionTokens = tokenized.tokens.slice(heading.blockIndex + 1, nextHeading?.blockIndex ?? tokenized.tokens.length);
    const body = sectionTokens.map((token) => token.raw).join("").trim();
    const plainBody = tokenPlainText(sectionTokens).trim();
    if (plainBody.length < minimumSectionChars) {
      weakSections.push(heading.title);
    }
    const evidence = uniqueStrings([
      ...(body.match(/(?:wiki|docs)\/[\w./-]+/g) ?? []),
      ...(body.match(/\[\[[^\]]+\]\]/g) ?? []),
    ]).slice(0, 6);
    coverage.push({ section: heading.title, status: plainBody.length >= minimumSectionChars ? "ok" : "weak", evidence });
  }
  if (weakSections.length > 0) {
    findings.push({
      severity: contract?.kind === "preset" ? "BLOCKER" : "WARNING",
      code: "WEAK_SECTIONS",
      message: `Some sections do not meet the contract minimum of ${minimumSectionChars} useful characters.`,
      evidence: weakSections.slice(0, 10).join(", "),
    });
  }

  if (contract) {
    for (const rule of contract.contentRules) {
      contractCheckCount += 1;
      const matches = rule.patterns.reduce((count, pattern) => {
        const matched = tokenized.body.match(new RegExp(pattern, "gi"));
        return count + (matched?.length ?? 0);
      }, 0);
      if (matches >= (rule.minimumMatches ?? 1)) {
        contractChecksPassed += 1;
      } else {
        findings.push({
          severity: "BLOCKER",
          code: rule.code,
          message: rule.description,
        });
      }
    }
  }

  findings.push(...await validateDocumentAssets(tokenized.images, options.assetResolver));

  const blockerCount = findings.filter((finding) => finding.severity === "BLOCKER").length;
  if (blockerCount === 0) {
    findings.push({
      severity: "INFO",
      code: "NO_BLOCKERS",
      message: "No blocking structural problems were found.",
    });
  }

  return {
    documentType: options.documentType,
    effectiveDiagramMode: options.diagramMode ?? null,
    readyForDelivery: blockerCount === 0,
    blockerCount,
    contractCheckCount,
    contractChecksPassed,
    findings,
    missingSections,
    weakSections,
    placeholderCount: placeholders.length,
    mermaidIssueCount: mermaidWarnings.length + mermaidSecurityIssues.length + asciiDiagrams.length + unclosedFences.length,
    clientFacingIssueCount: clientFacingIssues.length,
    languageIssueCount: languageIssues.length,
    coverage,
  };
}

function actionQueryForFinding(finding: ReviewFinding): string {
  const evidence = finding.evidence ? ` ${finding.evidence}` : "";
  return `${finding.code} ${finding.message}${evidence}`
    .replace(/[`*_#[\](){}:.,;!?'"|/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestedPageTypeForFinding(finding: ReviewFinding): WikiPageType {
  if (finding.code.includes("SECTION")) return "analysis";
  if (finding.code.includes("MERMAID") || finding.code.includes("DIAGRAM")) return "concept";
  if (finding.code.includes("LANGUAGE") || finding.code.includes("CLIENT")) return "analysis";
  return "overview";
}

export function formatWikiUpdatePlan(result: DocumentReviewResult): string {
  const actionable = result.findings.filter((finding) => finding.severity !== "INFO");
  const lines: string[] = [
    "## Wiki update plan",
    "",
  ];

  if (actionable.length === 0) {
    lines.push("No required wiki updates were detected. If human review raises doubts, still use `knowledge_context mode=search` and targeted code reading before changing the final document.");
    return lines.join("\n");
  }

  lines.push("Resolve wiki gaps before updating the client-facing document:");
  lines.push("");
  actionable.forEach((finding, index) => {
    const query = actionQueryForFinding(finding);
    const pageType = suggestedPageTypeForFinding(finding);
    lines.push(`### Action ${index + 1} — ${finding.code}`);
    lines.push(`- **Wiki search:** call \`knowledge_context mode="search"\` with query \`${query}\`.`);
    lines.push("- **Read:** call `knowledge_page action=read` for the relevant pages found.");
    lines.push("- **Code verification:** if the wiki is insufficient, use `knowledge_code` first; a raw scan is an explicit fallback and must be recorded.");
    lines.push(`- **Prepare update:** use \`prepare_knowledge_update\` with \`page_type="${pageType}"\`, the finding, and wiki/code context.`);
    lines.push("- **Apply:** use `knowledge_page action=write` (index.md updates automatically), then `action=append_log`.");
    lines.push("- **Regenerate:** call `knowledge_document_context action=section` again and update the document section.");
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

export function formatReviewResult(
  result: DocumentReviewResult,
  filename: string,
  options: ReviewOptions = {}
): string {
  const lines: string[] = [
    `# Document review: ${filename}`,
    "",
    `> Type: ${result.documentType ?? "unspecified"}`,
    `> Ready for delivery: ${result.readyForDelivery ? "yes" : "no"}`,
    `> Blocker: ${result.blockerCount}`,
    `> Contract checks: ${result.contractChecksPassed}/${result.contractCheckCount}`,
    `> Finding: ${result.findings.length}`,
    `> Remaining placeholders: ${result.placeholderCount}`,
    `> Mermaid/diagram issues: ${result.mermaidIssueCount}`,
    `> Language issues: ${result.languageIssueCount}`,
    `> Client-facing issues: ${result.clientFacingIssueCount}`,
    "",
    "## Finding",
    "",
  ];

  for (const finding of result.findings) {
    lines.push(`- **${finding.severity} ${finding.code}:** ${finding.message}`);
    if (finding.evidence) lines.push(`  Evidence: ${finding.evidence}`);
  }

  lines.push("", "## Coverage matrix", "", "| Section | State | Cited evidence |", "|---|---|---|");
  if (result.coverage.length === 0) lines.push("| _No H2 sections_ | weak | — |");
  const tableCell = (value: string): string => value.replace(/\|/g, "&#124;");
  for (const row of result.coverage) {
    lines.push(`| ${tableCell(row.section)} | ${row.status} | ${tableCell(row.evidence.join(", ")) || "to verify"} |`);
  }

  lines.push("");
  lines.push("## Automatable review checklist");
  lines.push("- Resolve every BLOCKER finding before delivery.");
  lines.push("- Replace every placeholder with real content or remove the section when it does not apply.");
  lines.push("- Expand weak sections using `knowledge_document_context action=section` with targeted queries.");
  lines.push("- Remove ASCII diagrams. Use Mermaid or a relative external asset only if that representation was selected.");
  lines.push("- If a finding identifies gaps or inaccuracies, update the wiki before regenerating the document.");
  lines.push("- Save the revised version with `knowledge_document action=write` only after applying patches.");
  if (options.includeWikiUpdatePlan ?? true) {
    lines.push("");
    lines.push(formatWikiUpdatePlan(result));
  }
  lines.push("");
  lines.push("## Suggested patch prompt");
  lines.push("Use the findings above as the backlog. First update the wiki for verifiable gaps using knowledge_context mode=search, knowledge_page action=read, prepare_knowledge_update, and knowledge_page action=write. Only then produce the revised document.");

  return lines.join("\n");
}

export function prepareKnowledgeUpdateDraft(options: KnowledgeUpdateOptions): {
  path: string;
  content: string;
} {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const title = options.title?.trim() || `Knowledge update - ${options.finding.slice(0, 60).trim()}`;
  const pageType = options.pageType ?? "analysis";
  const pathPrefix: Record<WikiPageType, string> = WIKI_PAGE_DIRECTORY_BY_TYPE;
  const pagePath = options.targetPagePath?.trim()
    ? normalizeRelPath(options.targetPagePath)
    : `${pathPrefix[pageType]}/${titleToSlug(title)}.md`;
  const sources = uniqueStrings(options.sources ?? []);
  const tags = uniqueStrings(["document-review", pageType, "knowledge-gap"]);
  const content = [
    "---",
    `title: "${escapeYamlString(title)}"`,
    `type: ${pageType}`,
    `tags: [${tags.join(", ")}]`,
    `created: ${today}`,
    `updated: ${today}`,
    `sources: [${sources.map((source) => `"${escapeYamlString(source)}"`).join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Reason for the update",
    options.finding.trim(),
    "",
    "## Verified summary",
    "Complete the final summary after comparing wiki context and code. Do not leave this section empty before applying with `knowledge_page action=write`.",
    "",
    "## Wiki evidence",
    options.wikiContext?.trim() || "Complete with `knowledge_context mode=search` and `knowledge_page action=read`.",
    "",
    "## Code evidence",
    options.codeContext?.trim() || "Complete by reading project code directly if the wiki is insufficient.",
    "",
    "## Impact on client documents",
    "Regenerate the affected section context packs and update the final document without internal-process references.",
  ].join("\n");

  return { path: pagePath, content };
}
