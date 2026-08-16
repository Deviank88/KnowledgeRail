import { DOCUMENT_PERSONAS, DOCUMENT_TEMPLATES } from "../config/templates.js";
import {
  documentContract,
  DOCUMENT_TYPES,
  USER_REQUEST_LANGUAGE,
  type DocumentContract,
  type DocumentType,
} from "../config/document-contracts.js";
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
  documentType?: DocumentType;
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
  documentType?: DocumentType;
  writerLanguage?: string;
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
  documentType?: DocumentType;
  readyForExport: boolean;
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
  documentType?: DocumentType;
  language?: string;
  clientFacing?: boolean;
  includeWikiUpdatePlan?: boolean;
}

export interface DocumentPlanOptions {
  documentType: DocumentType;
  projectName?: string;
  objective?: string;
  audience?: string;
  language?: string;
  maxSections?: number;
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
  { code: "RIFERIMENTO_WIKI", pattern: /\bwiki\b|wiki[_-][a-z_]+|wiki\//i, label: "references to the wiki or wiki tools" },
  { code: "RIFERIMENTO_CONTEXT_PACK", pattern: /context pack|pagina sorgente|pagine sorgenti|fonti frontmatter/i, label: "references to context packs or the evidence-gathering process" },
  { code: "RIFERIMENTO_AGENT", pattern: /\bagent\b|\bLLM\b|prompt|sub-agent|writer assegnato/i, label: "references to agents, LLMs, or prompts" },
  { code: "RIFERIMENTO_PERCORSI_INTERNI", pattern: /\b(src|tests|docs|wiki)[\\/][\w./-]+/i, label: "internal paths exposed to the client" },
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

function markdownHeadings(markdown: string): Array<{ level: number; title: string; index: number }> {
  const headings: Array<{ level: number; title: string; index: number }> = [];
  const headingRe = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(markdown)) !== null) {
    headings.push({
      level: match[1].length,
      title: match[2].trim(),
      index: match.index,
    });
  }
  return headings;
}

function sectionBody(markdown: string, heading: { level: number; index: number }): string {
  const headingLineEnd = markdown.indexOf("\n", heading.index);
  const bodyStart = headingLineEnd === -1 ? markdown.length : headingLineEnd + 1;
  const nextHeadingRe = new RegExp(`^#{1,${heading.level}}\\s+`, "gm");
  nextHeadingRe.lastIndex = bodyStart;
  const next = nextHeadingRe.exec(markdown);
  return markdown.slice(bodyStart, next ? next.index : markdown.length).trim();
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

const DEFAULT_EDITOR_PERSONA =
  "You are a senior technical editor. Coordinate specialist writers, protect document completeness and consistency, and report gaps instead of inventing content.";

export async function buildDocumentPlan(
  wikiRoot: string,
  options: DocumentPlanOptions
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const contract = documentContract(options.documentType);
  const outputLanguage = options.language?.trim() || contract.defaultLanguage;
  const rawTemplate = DOCUMENT_TEMPLATES[options.documentType];
  const persona = DOCUMENT_PERSONAS[options.documentType] ?? DEFAULT_EDITOR_PERSONA;
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
    `- Use Mermaid only when a diagram clarifies flows, architecture, data, or sequences; never use ASCII art.`,
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
  return {
    documentType: options.documentType,
    writerLanguage: options.writerLanguage ?? (
      options.documentType ? documentContract(options.documentType).defaultLanguage : undefined
    ),
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
    "- Add Mermaid diagrams only when they clarify flows, architecture, or relationships.",
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

export function reviewDocumentStructure(
  markdown: string,
  template?: string,
  options: ReviewOptions = {}
): DocumentReviewResult {
  const findings: ReviewFinding[] = [];
  const contract: DocumentContract | undefined = options.documentType
    ? documentContract(options.documentType)
    : undefined;
  let contractCheckCount = 0;
  let contractChecksPassed = 0;
  const placeholders: string[] = [];
  const markdownWithoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const placeholderRe = /\[(?![ xX]\])([^\]\n]{3,})\](?!\()/g;
  let placeholderMatch: RegExpExecArray | null;
  while ((placeholderMatch = placeholderRe.exec(markdownWithoutCode)) !== null) {
    if (isTemplatePlaceholder(placeholderMatch[1])) {
      placeholders.push(placeholderMatch[0]);
    }
  }
  const mustachePlaceholders = markdownWithoutCode.match(/\{\{[^}]+\}\}/g) ?? [];
  placeholders.push(...mustachePlaceholders);

  if (placeholders.length > 0) {
    findings.push({
      severity: "BLOCKER",
      code: "PLACEHOLDER_RESIDUO",
      message: `${placeholders.length} unresolved placeholder(s) remain.`,
      evidence: [...new Set(placeholders)].slice(0, 8).join(", "),
    });
  }

  const fenceMatches = markdown.match(/^```/gm) ?? [];
  if (fenceMatches.length % 2 !== 0) {
    findings.push({
      severity: "BLOCKER",
      code: "FENCE_NON_CHIUSA",
      message: "The document contains an unclosed fenced code block.",
    });
  }

  const mermaidIssues: string[] = [];
  const mermaidBlockRe = /```mermaid\s*\r?\n([\s\S]*?)```/g;
  let mermaidMatch: RegExpExecArray | null;
  while ((mermaidMatch = mermaidBlockRe.exec(markdown)) !== null) {
    const firstLine = mermaidMatch[1].split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
    if (!/^(flowchart|graph|sequenceDiagram|erDiagram|classDiagram|stateDiagram|journey|gantt|pie|mindmap|timeline)\b/.test(firstLine)) {
      mermaidIssues.push(firstLine || "(empty block)");
    }
  }
  const asciiDiagramRe = /```(?!mermaid|json|bash|shell|ts|typescript|js|javascript|yaml|yml|http|text)\s*\r?\n[\s\S]*(?:──|-->|<--|\+[-+]{2,}|\|.*\|)[\s\S]*?```/g;
  const asciiDiagrams = markdown.match(asciiDiagramRe) ?? [];

  if (mermaidIssues.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "MERMAID_SOSPETTO",
      message: "Some Mermaid blocks do not start with a recognized diagram type.",
      evidence: mermaidIssues.slice(0, 5).join(", "),
    });
  }
  if (asciiDiagrams.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "DIAGRAMMA_ASCII",
      message: "Possible ASCII diagrams were found; convert them to Mermaid when they represent flows or architecture.",
    });
  }

  const language = (options.language ?? contract?.defaultLanguage ?? "English").toLowerCase();
  const languageIssues: string[] = [];
  if (language.includes("ital")) {
    for (const [index, rule] of ITALIAN_LANGUAGE_PATTERNS.entries()) {
      if (rule.pattern.test(markdownWithoutCode)) {
        languageIssues.push(ITALIAN_LANGUAGE_SUGGESTIONS[index] ?? rule.suggestion);
      }
      rule.pattern.lastIndex = 0;
    }
  }
  if (languageIssues.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "REVISIONE_LINGUA",
      message: `${languageIssues.length} possible language issue(s) were found for the requested language (${options.language ?? contract?.defaultLanguage ?? "English"}).`,
      evidence: uniqueStrings(languageIssues).slice(0, 8).join(" "),
    });
  }

  const clientFacingIssues: string[] = [];
  if (options.clientFacing ?? contract?.defaultClientFacing ?? true) {
    for (const rule of CLIENT_INTERNAL_PATTERNS) {
      if (rule.pattern.test(markdownWithoutCode)) {
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
  const headings = markdownHeadings(markdown);
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
        code: "SEZIONI_MANCANTI",
        message: `${missingSections.length} template section(s) are missing.`,
        evidence: missingSections.slice(0, 10).join(", "),
      });
    }
  }

  const weakSections: string[] = [];
  const coverage: DocumentReviewResult["coverage"] = [];
  const minimumSectionChars = contract?.minimumSectionChars ?? 12;
  for (const heading of h2Headings) {
    const body = sectionBody(markdown, heading);
    const plainBody = body.replace(/```[\s\S]*?```/g, "").trim();
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
      severity: contract && contract.type !== "custom" ? "BLOCKER" : "WARNING",
      code: "SEZIONI_DEBOLI",
      message: `Some sections do not meet the contract minimum of ${minimumSectionChars} useful characters.`,
      evidence: weakSections.slice(0, 10).join(", "),
    });
  }

  if (contract) {
    for (const rule of contract.contentRules) {
      contractCheckCount += 1;
      const matches = rule.patterns.reduce((count, pattern) => {
        const matched = markdown.match(new RegExp(pattern, "gi"));
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

  if (findings.length === 0) {
    findings.push({
      severity: "INFO",
      code: "NESSUN_BLOCCANTE",
      message: "No blocking structural problems were found.",
    });
  }

  const blockerCount = findings.filter((finding) => finding.severity === "BLOCKER").length;
  return {
    documentType: options.documentType,
    readyForExport: blockerCount === 0,
    blockerCount,
    contractCheckCount,
    contractChecksPassed,
    findings,
    missingSections,
    weakSections,
    placeholderCount: placeholders.length,
    mermaidIssueCount: mermaidIssues.length + asciiDiagrams.length + (fenceMatches.length % 2),
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
  if (finding.code.includes("SEZION")) return "analysis";
  if (finding.code.includes("MERMAID") || finding.code.includes("DIAGRAMMA")) return "concept";
  if (finding.code.includes("LINGUA") || finding.code.includes("CLIENT")) return "analysis";
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
    `> Ready for export: ${result.readyForExport ? "yes" : "no"}`,
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
  lines.push("- Convert ASCII diagrams to valid `mermaid` blocks when they represent processes or architecture.");
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
