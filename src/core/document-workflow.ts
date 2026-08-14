import { DOCUMENT_PERSONAS, DOCUMENT_TEMPLATES } from "../config/templates.js";
import {
  documentContract,
  DOCUMENT_TYPES,
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

export { DOCUMENT_TYPES, type DocumentType } from "../config/document-contracts.js";

export const WIKI_PAGE_TYPES = [
  "entity",
  "concept",
  "summary",
  "comparison",
  "overview",
  "analysis",
  "meeting_note",
  "client_source",
  "candidate_request",
  "request",
  "requirement",
  "implementation",
  "test_result",
  "decision",
  "release",
  "risk",
  "data_model",
  "automation",
  "integration",
  "api",
] as const;

export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

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
  { code: "RIFERIMENTO_WIKI", pattern: /\bwiki\b|wiki[_-][a-z_]+|wiki\//i, label: "riferimenti alla wiki o a tool wiki" },
  { code: "RIFERIMENTO_CONTEXT_PACK", pattern: /context pack|pagina sorgente|pagine sorgenti|fonti frontmatter/i, label: "riferimenti a context pack o processo di raccolta fonti" },
  { code: "RIFERIMENTO_AGENT", pattern: /\bagent\b|\bLLM\b|prompt|sub-agent|writer assegnato/i, label: "riferimenti ad agent, LLM o prompt" },
  { code: "RIFERIMENTO_PERCORSI_INTERNI", pattern: /\b(src|tests|docs|wiki)[\\/][\w./-]+/i, label: "percorsi interni esposti al cliente" },
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
  "Sei un redattore tecnico senior. Coordina writer specialistici, proteggi completezza e coerenza del documento, e segnala lacune invece di inventare contenuti.";

export async function buildDocumentPlan(
  wikiRoot: string,
  options: DocumentPlanOptions
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const contract = documentContract(options.documentType);
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
              `- **Writer assegnato:** specialista della sezione "${section.title}".`,
              `- **Evidence obbligatoria:** ${evidencePlan.require.join(", ") || "nessuna"}.`,
              `- **Evidence preferita:** ${evidencePlan.prefer.join(", ") || "nessuna"}.`,
              `- **Context pack:** chiamare \`knowledge_document_context action="section"\` con \`document_type="${options.documentType}"\`, \`section_title="${section.title}"\`, \`query="${query}"\`, \`retrieval_profile="coverage"\`.`,
              "- **Output atteso:** markdown pronto per assemblaggio, senza placeholder, con evidenze concrete e lacune esplicite.",
            ].join("\n");
          })
          .join("\n\n")
      : "- Documento custom: il redattore deve definire prima le sezioni, poi richiedere context pack mirati per ciascuna.";

  const templateBlock = template
    ? ["## Template di riferimento", "", "```markdown", template, "```"].join("\n")
    : "## Template di riferimento\n\nNessun template predefinito per `custom`.";

  return [
    `# Piano editoriale documento`,
    ``,
    `> **Tipo:** ${options.documentType}`,
    `> **Progetto:** ${options.projectName ?? "{{PROJECT_NAME}}"}`,
    `> **Obiettivo:** ${options.objective ?? "Produrre un documento completo, coerente e validabile dalla wiki."}`,
    `> **Audience:** ${options.audience ?? "Stakeholder di progetto e team operativo."}`,
    `> **Contratto:** ${contract.label} — ${contract.purpose}`,
    `> **Lingua predefinita:** ${contract.defaultLanguage}`,
    `> **Destinazione predefinita:** ${contract.defaultClientFacing ? "client-facing" : "interna/tecnica"}`,
    `> **Pagine wiki disponibili:** ${inventory.length}`,
    `> **Inventario per tipo:** ${[...counts.entries()].map(([type, count]) => `${type}: ${count}`).join(", ") || "n/d"}`,
    ``,
    `## Ruolo del redattore`,
    ``,
    persona,
    ``,
    `Il redattore non scrive tutto in una singola passata: assegna le sezioni ai writer, richiede context pack mirati, assembla il documento e poi attiva la review.`,
    ``,
    `## Strategia context pack`,
    `- Il template è un evidence plan: ogni sezione dichiara evidence obbligatoria e preferita.`,
    `- Il context pack deve contenere la matrice required/found/missing/source coverage/contradictions.`,
    `- Se lo stato della matrice è \`GAP\`, riportare il gap senza completarlo con inferenze non supportate.`,
    `- Per contesti lunghi usare \`knowledge_document_context action="section"\` con query mirate e budget esplicito.`,
    `- Ogni writer deve ricevere solo le pagine rilevanti per la propria sezione, con budget esplicito di caratteri.`,
    `- Se mancano evidenze, il writer deve scrivere una lacuna tracciabile invece di inventare.`,
    `- Espandere con \`knowledge_page action="read"\` le pagine pertinenti segnalate come escluse dal budget e verificare requisiti/decisioni tra sezioni.`,
    `- Per evidence di codice usare prima \`knowledge_code\`; una scansione raw è solo fallback esplicito e deve essere registrata.`,
    `- Usare Mermaid solo quando il diagramma chiarisce flussi, architetture, dati o sequenze; mai ASCII art.`,
    ``,
    `## Sezioni da assegnare ai writer`,
    ``,
    sectionLines,
    ``,
    `## Checklist redazionale`,
    `- Tutte le sezioni previste sono presenti e coerenti fra loro.`,
    `- Nessun placeholder come \`[Descrivere...]\` o \`{{PROJECT_NAME}}\` rimane nel documento finale.`,
    `- Tabelle, requisiti, criteri di accettazione e rischi sono concreti e verificabili.`,
    `- Le informazioni dubbie sono marcate come lacune o assunzioni, non presentate come fatti.`,
    `- Prima della consegna chiamare \`knowledge_document action="review"\` sul file salvato.`,
    `- Se la review trova lacune o inesattezze, usare il prompt \`prepare_knowledge_update\` e aggiornare la wiki prima di rigenerare il documento.`,
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
    "## Sintesi graph-based",
    "",
    `- Strategia: ${task.retrieval.strategy}, widening W${task.retrieval.wideningLevel}.`,
    `- Evidenze materializzate: ${includedPaths.length}; nodi visitati: ${finalAttempt?.visitedNodes ?? 0}; ` +
      `archi visitati: ${finalAttempt?.visitedEdges ?? 0}.`,
    `- Full graph scan: no; fallback: ${task.retrieval.fallbackUsed ? "sì" : "no"}.`,
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
    objective: `Preparare la sezione \"${options.sectionTitle}\" usando evidenze verificabili.`,
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
    `# Context pack sezione: ${sectionTitle}`,
    "",
    `> Pagine incluse: ${result.pages.length}`,
    `> Caratteri inclusi: ${result.totalIncludedChars}`,
    `> Caratteri originali: ${result.totalOriginalChars}`,
    `> Context Compiler: ${result.compiler.strategy} W${result.compiler.wideningLevel}`,
    `> Budget manifest: ~${result.compiler.manifestHeuristicTokens} token (${result.compiler.withinHeuristicBudget ? "rispettato" : "superato"})`,
    "",
    "## Matrice di copertura evidence",
    "",
    "| Stato | Evidence obbligatoria | Evidence trovata | Evidence mancante | Source coverage | Contraddizioni |",
    "|---|---|---|---|---|---|",
    `| ${result.coverage.status} | ${result.coverage.requiredEvidence.join(", ") || "nessuna"} | ` +
      `${result.coverage.foundEvidence.join(", ") || "nessuna"} | ` +
      `${result.coverage.missingEvidence.join(", ") || "nessuna"} | ` +
      `${result.coverage.sourceCoverage.averageCoveragePercent === null
        ? "nessuna fonte referenziata"
        : `${result.coverage.sourceCoverage.averageCoveragePercent.toFixed(2)}% ` +
          `(${result.coverage.sourceCoverage.knownSources}/${result.coverage.sourceCoverage.referencedSources} note; ` +
          `${result.coverage.sourceCoverage.unknownSources.length} unknown)`} | ` +
      `${result.coverage.contradictions.join("; ") || "nessuna rilevata"} |`,
    "",
    `> Evidence senza source provenance: ${result.coverage.unprovenancedEvidenceCount}`,
    "",
    ...(result.coverage.status === "GAP"
      ? [
          "**GAP — mancano evidenze obbligatorie. Non completare la sezione con inferenze non supportate.**",
          "",
        ]
      : []),
    "## Istruzioni writer",
    "- Usa solo le evidenze presenti in questo context pack e segnala le lacune invece di inventare.",
    "- Ogni claim fattuale deve mantenere la provenance indicata dall'evidence URI o dalle fonti.",
    `- Scrivi nella lingua richiesta (${result.writerLanguage ?? "lingua del documento"}) con registro professionale, concreto e pulito.`,
    "- Inserisci diagrammi Mermaid solo quando aiutano a chiarire flussi, architetture o relazioni.",
    "- Non usare ASCII art o placeholder.",
    "",
  ];

  if (result.graphSummary) {
    lines.push(result.graphSummary.trimEnd());
    lines.push("");
  }

  if (result.pages.length === 0) {
    lines.push("Nessuna pagina rilevante trovata per questa sezione.");
    return lines.join("\n");
  }

  for (const page of result.pages) {
    lines.push(`## ${page.title}`);
    lines.push(`_Percorso: \`${page.relPath}\`_`);
    lines.push(`_Tipo: ${page.type || "n/d"} | Score: ${page.score}_`);
    if (page.heading) lines.push(`_Passaggio: ${page.heading}_`);
    if (page.evidenceUri) lines.push(`_Evidence URI: ${page.evidenceUri}_`);
    lines.push(`_Tags: ${page.tags.length > 0 ? page.tags.join(", ") : "n/d"}_`);
    lines.push(`_Fonti: ${page.sources.length > 0 ? page.sources.join(", ") : "n/d"}_`);
    lines.push(`_Caratteri: ${page.includedChars}/${page.originalChars}${page.truncated ? " (troncato)" : ""}_`);
    lines.push("");
    lines.push(page.body);
    if (page.truncated) {
      lines.push("");
      lines.push(`_[Troncato: ${page.originalChars - page.includedChars} caratteri aggiuntivi]_`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  if (result.omittedPaths && result.omittedPaths.length > 0) {
    lines.push("## Pagine pertinenti non incluse nel budget", "");
    for (const path of result.omittedPaths) lines.push(`- ${path}`);
    lines.push("", "Usare `knowledge_page action=read` o un nuovo context pack con `page_paths` per espanderle.", "");
  }

  const output = lines.join("\n");
  if (!maxOutputChars || Buffer.byteLength(output, "utf8") <= maxOutputChars) return output;
  const marker = "\n\n_[Output troncato al budget complessivo; espandere le pagine indicate con knowledge_page action=read.]_";
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
      message: `Sono presenti ${placeholders.length} placeholder non risolti.`,
      evidence: [...new Set(placeholders)].slice(0, 8).join(", "),
    });
  }

  const fenceMatches = markdown.match(/^```/gm) ?? [];
  if (fenceMatches.length % 2 !== 0) {
    findings.push({
      severity: "BLOCKER",
      code: "FENCE_NON_CHIUSA",
      message: "Il documento contiene un blocco fenced code non chiuso.",
    });
  }

  const mermaidIssues: string[] = [];
  const mermaidBlockRe = /```mermaid\s*\r?\n([\s\S]*?)```/g;
  let mermaidMatch: RegExpExecArray | null;
  while ((mermaidMatch = mermaidBlockRe.exec(markdown)) !== null) {
    const firstLine = mermaidMatch[1].split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
    if (!/^(flowchart|graph|sequenceDiagram|erDiagram|classDiagram|stateDiagram|journey|gantt|pie|mindmap|timeline)\b/.test(firstLine)) {
      mermaidIssues.push(firstLine || "(blocco vuoto)");
    }
  }
  const asciiDiagramRe = /```(?!mermaid|json|bash|shell|ts|typescript|js|javascript|yaml|yml|http|text)\s*\r?\n[\s\S]*(?:──|-->|<--|\+[-+]{2,}|\|.*\|)[\s\S]*?```/g;
  const asciiDiagrams = markdown.match(asciiDiagramRe) ?? [];

  if (mermaidIssues.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "MERMAID_SOSPETTO",
      message: "Alcuni blocchi Mermaid non iniziano con un tipo di diagramma riconosciuto.",
      evidence: mermaidIssues.slice(0, 5).join(", "),
    });
  }
  if (asciiDiagrams.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "DIAGRAMMA_ASCII",
      message: "Sono presenti possibili diagrammi ASCII: convertirli in Mermaid se rappresentano flussi o architetture.",
    });
  }

  const language = (options.language ?? contract?.defaultLanguage ?? "italiano").toLowerCase();
  const languageIssues: string[] = [];
  if (language.includes("ital")) {
    for (const rule of ITALIAN_LANGUAGE_PATTERNS) {
      if (rule.pattern.test(markdownWithoutCode)) {
        languageIssues.push(rule.suggestion);
      }
      rule.pattern.lastIndex = 0;
    }
  }
  if (languageIssues.length > 0) {
    findings.push({
      severity: "WARNING",
      code: "REVISIONE_LINGUA",
      message: `Rilevati ${languageIssues.length} possibili problemi linguistici nella lingua richiesta (${options.language ?? contract?.defaultLanguage ?? "italiano"}).`,
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
      message: "Il documento contiene riferimenti al processo interno non adatti a un cliente finale.",
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
        ? "Il documento deve avere un titolo H1."
        : "Il documento deve avere un solo titolo H1.",
    });
  }
  if (h2Headings.length > 0) {
    contractChecksPassed += 1;
  } else {
    findings.push({
      severity: "BLOCKER",
      code: "DOCUMENT_SECTION_CONTRACT",
      message: "Il documento deve contenere almeno una sezione H2.",
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
        message: `Mancano ${missingSections.length} sezioni previste dal template.`,
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
      message: `Alcune sezioni non raggiungono il minimo contrattuale di ${minimumSectionChars} caratteri utili.`,
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
      message: "Non sono stati rilevati problemi strutturali bloccanti.",
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
    "## Piano aggiornamento wiki",
    "",
  ];

  if (actionable.length === 0) {
    lines.push("Nessun aggiornamento wiki obbligatorio rilevato. Se emergono dubbi durante la revisione umana, usare comunque `knowledge_context mode=search` e la lettura mirata del codice prima di modificare il documento finale.");
    return lines.join("\n");
  }

  lines.push("Prima di aggiornare il documento cliente-facing, risolvere le lacune nella wiki:");
  lines.push("");
  actionable.forEach((finding, index) => {
    const query = actionQueryForFinding(finding);
    const pageType = suggestedPageTypeForFinding(finding);
    lines.push(`### Azione ${index + 1} — ${finding.code}`);
    lines.push(`- **Ricerca wiki:** chiamare \`knowledge_context mode="search"\` con query \`${query}\`.`);
    lines.push("- **Lettura:** chiamare `knowledge_page action=read` sulle pagine rilevanti trovate.");
    lines.push("- **Verifica codice:** se la wiki non basta, usare prima `knowledge_code`; una scansione raw è solo fallback esplicito e va registrata.");
    lines.push(`- **Preparazione aggiornamento:** usare il prompt \`prepare_knowledge_update\` con \`page_type="${pageType}"\`, finding e contesto wiki/codice.`);
    lines.push("- **Applicazione:** usare `knowledge_page action=write` (index.md si aggiorna da solo), poi `action=append_log`.");
    lines.push("- **Rigenerazione:** richiamare `knowledge_document_context action=section` e aggiornare la sezione del documento.");
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
    `# Review documento: ${filename}`,
    "",
    `> Tipo: ${result.documentType ?? "non specificato"}`,
    `> Pronto per export: ${result.readyForExport ? "sì" : "no"}`,
    `> Blocker: ${result.blockerCount}`,
    `> Check contratto: ${result.contractChecksPassed}/${result.contractCheckCount}`,
    `> Finding: ${result.findings.length}`,
    `> Placeholder residui: ${result.placeholderCount}`,
    `> Problemi Mermaid/diagrammi: ${result.mermaidIssueCount}`,
    `> Problemi lingua: ${result.languageIssueCount}`,
    `> Problemi client-facing: ${result.clientFacingIssueCount}`,
    "",
    "## Finding",
    "",
  ];

  for (const finding of result.findings) {
    lines.push(`- **${finding.severity} ${finding.code}:** ${finding.message}`);
    if (finding.evidence) lines.push(`  Evidenza: ${finding.evidence}`);
  }

  lines.push("", "## Matrice di copertura", "", "| Sezione | Stato | Evidenze citate |", "|---|---|---|");
  if (result.coverage.length === 0) lines.push("| _Nessuna sezione H2_ | weak | — |");
  for (const row of result.coverage) {
    lines.push(`| ${row.section.replace(/\|/g, "\\|")} | ${row.status} | ${row.evidence.join(", ").replace(/\|/g, "\\|") || "da verificare"} |`);
  }

  lines.push("");
  lines.push("## Checklist revisione automatizzabile");
  lines.push("- Risolvere tutti i finding BLOCKER prima della consegna.");
  lines.push("- Sostituire ogni placeholder con contenuto reale o rimuovere la sezione se non applicabile.");
  lines.push("- Integrare le sezioni deboli usando `knowledge_document_context action=section` con query mirate.");
  lines.push("- Convertire diagrammi ASCII in blocchi `mermaid` validi quando rappresentano processi o architetture.");
  lines.push("- Se il finding indica lacune o inesattezze, aggiornare prima la wiki e solo dopo rigenerare il documento.");
  lines.push("- Salvare la versione revisionata solo con `knowledge_document action=write` dopo aver applicato le patch.");
  if (options.includeWikiUpdatePlan ?? true) {
    lines.push("");
    lines.push(formatWikiUpdatePlan(result));
  }
  lines.push("");
  lines.push("## Prompt patch consigliato");
  lines.push("Usa i finding sopra come backlog. Prima aggiorna la wiki per lacune verificabili usando knowledge_context mode=search, knowledge_page action=read, il prompt prepare_knowledge_update e knowledge_page action=write. Solo dopo produci la versione revisionata del documento.");

  return lines.join("\n");
}

export function prepareKnowledgeUpdateDraft(options: KnowledgeUpdateOptions): {
  path: string;
  content: string;
} {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const title = options.title?.trim() || `Aggiornamento conoscenza - ${options.finding.slice(0, 60).trim()}`;
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
    "## Motivo dell'aggiornamento",
    options.finding.trim(),
    "",
    "## Sintesi verificata",
    "Integrare qui la sintesi finale dopo aver confrontato contesto wiki e codice. Non lasciare questa sezione vuota prima di applicare con `knowledge_page action=write`.",
    "",
    "## Evidenze dalla wiki",
    options.wikiContext?.trim() || "Da completare con `knowledge_context mode=search` e `knowledge_page action=read`.",
    "",
    "## Evidenze dal codice",
    options.codeContext?.trim() || "Da completare leggendo direttamente il codice di progetto se la wiki non è sufficiente.",
    "",
    "## Impatto sui documenti cliente",
    "Rigenerare i context pack delle sezioni interessate e aggiornare il documento finale senza riferimenti al processo interno.",
  ].join("\n");

  return { path: pagePath, content };
}
