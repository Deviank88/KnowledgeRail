import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DOCUMENT_TEMPLATES } from "../src/config/templates.js";
import {
  WIKI_PAGE_DIRECTORIES,
  WIKI_PAGE_DIRECTORY_BY_TYPE,
} from "../src/config/workspace-layout.js";
import {
  createSectionContext,
  formatReviewResult,
  prepareKnowledgeUpdateDraft,
  parseTemplateSections,
  reviewDocumentStructure,
  WIKI_PAGE_TYPES,
} from "../src/core/document-workflow.js";
import {
  buildDevReportPlan,
  prepareRequestIngestionDrafts,
  validateDevReport,
} from "../src/core/report-workflow.js";
import { hasErrors, validateWikiPageContent } from "../src/core/wiki-validation.js";

async function writeWikiPage(root: string, relPath: string, params: {
  title: string;
  type: string;
  tags?: string[];
  body: string;
}): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    [
      "---",
      `title: "${params.title}"`,
      `type: ${params.type}`,
      `tags: [${(params.tags ?? []).join(", ")}]`,
      "created: 2026-05-21",
      "updated: 2026-05-21",
      'sources: ["docs/source.md"]',
      "---",
      "",
      params.body,
    ].join("\n"),
    "utf-8"
  );
}

test("parseTemplateSections extracts top-level document sections with optional limit", () => {
  const sections = parseTemplateSections(DOCUMENT_TEMPLATES.functional_spec, 3);

  assert.deepEqual(
    sections.map((section) => section.title),
    ["1. Scopo e Obiettivi", "2. Contesto e Motivazione", "3. Requisiti Funzionali"]
  );
});

test("workspace layout covers every canonical wiki page type without eager page directories", () => {
  assert.deepEqual(Object.keys(WIKI_PAGE_DIRECTORY_BY_TYPE), [...WIKI_PAGE_TYPES]);
  assert.deepEqual(
    [...new Set(Object.values(WIKI_PAGE_DIRECTORY_BY_TYPE))],
    [...WIKI_PAGE_DIRECTORIES]
  );
});

test("createSectionContext respects page and total character budgets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-context-"));
  await writeWikiPage(root, "concepts/Alpha.md", {
    title: "Alpha",
    type: "concept",
    tags: ["alpha"],
    body: "alpha ".repeat(20),
  });
  await writeWikiPage(root, "concepts/Beta.md", {
    title: "Beta",
    type: "concept",
    tags: ["beta"],
    body: "beta ".repeat(20),
  });

  const context = await createSectionContext({
    wikiRoot: root,
    sectionTitle: "Architettura Alpha",
    pagePaths: ["concepts/Alpha.md", "concepts/Beta.md"],
    maxPages: 2,
    maxCharsPerPage: 20,
    maxTotalChars: 35,
  });

  assert.equal(context.pages.length, 2);
  assert.equal(context.totalIncludedChars, 35);
  assert.equal(context.pages[0].includedChars, 20);
  assert.equal(context.pages[1].includedChars, 15);
  assert.equal(context.pages.every((page) => page.truncated), true);
});

test("reviewDocumentStructure reports placeholders, missing sections, and Mermaid issues", () => {
  const review = reviewDocumentStructure(
    [
      "# Documento Funzionale di Progetto: Test",
      "",
      "## 1. Scopo e Obiettivi",
      "[Descrivere lo scopo]",
      "",
      "```mermaid",
      "notARealDiagram",
      "```",
    ].join("\n"),
    DOCUMENT_TEMPLATES.functional_spec
  );

  assert.equal(review.placeholderCount > 0, true);
  assert.equal(review.missingSections.includes("2. Contesto e Motivazione"), true);
  assert.equal(review.findings.some((finding) => finding.code === "PLACEHOLDER_RESIDUO"), true);
  assert.equal(review.findings.some((finding) => finding.code === "MERMAID_SOSPETTO"), true);
});

test("reviewDocumentStructure reports client-facing and language issues with wiki update plan", () => {
  const review = reviewDocumentStructure(
    [
      "# Documento",
      "",
      "## Panoramica",
      "Questa sezione deriva dalla wiki e dal context pack dell'agent. Qual'è il flusso va verificato in src/app.ts.",
    ].join("\n"),
    undefined,
    { language: "italiano", clientFacing: true, includeWikiUpdatePlan: true }
  );

  assert.equal(review.clientFacingIssueCount > 0, true);
  assert.equal(review.languageIssueCount > 0, true);
  assert.equal(review.findings.some((finding) => finding.code === "NON_CLIENT_FACING"), true);
  assert.equal(review.findings.some((finding) => finding.code === "REVISIONE_LINGUA"), true);

  const formatted = formatReviewResult(review, "documento.md", { includeWikiUpdatePlan: true });
  assert.equal(formatted.includes("Piano aggiornamento wiki"), true);
  assert.equal(formatted.includes("prepare_knowledge_update"), true);
  assert.equal(formatted.includes("Matrice di copertura"), true);
});

test("reviewDocumentStructure accepts a complete custom document without blocking findings", () => {
  const review = reviewDocumentStructure(
    [
      "# Documento",
      "",
      "## Panoramica",
      "Questa sezione contiene testo sufficiente per descrivere lo scopo del documento in modo concreto, senza placeholder e senza lacune strutturali rilevabili dal controllo automatico.",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[Input] --> B[Output]",
      "```",
    ].join("\n")
  );

  assert.equal(review.placeholderCount, 0);
  assert.equal(review.mermaidIssueCount, 0);
  assert.equal(review.findings.some((finding) => finding.severity === "BLOCKER"), false);
});

test("document contracts apply audience defaults instead of treating every document as client-facing", () => {
  const internal = reviewDocumentStructure(
    "# Architecture\n\n## Evidence\n\nImplementation details are verified in src/server.ts and tests/server.test.ts.",
    undefined,
    { documentType: "architecture_doc" }
  );
  assert.equal(internal.findings.some((finding) => finding.code === "NON_CLIENT_FACING"), false);

  const client = reviewDocumentStructure(
    "# Functional specification\n\n## Evidence\n\nImplementation details are verified in src/server.ts and tests/server.test.ts.",
    undefined,
    { documentType: "functional_spec" }
  );
  assert.equal(client.findings.some((finding) => finding.code === "NON_CLIENT_FACING"), true);
});

test("prepareKnowledgeUpdateDraft produces a valid wiki page draft", async () => {
  const draft = prepareKnowledgeUpdateDraft({
    finding: "La sezione Requisiti Funzionali è incompleta e va verificata nel codice.",
    pageType: "analysis",
    title: "Verifica Requisiti Funzionali",
    wikiContext: "La wiki cita il requisito Alpha.",
    codeContext: "src/alpha-service.ts conferma il flusso Alpha.",
    sources: ["src/alpha-service.ts"],
    date: "2026-05-21",
  });

  assert.equal(draft.path, "analysis/Verifica_Requisiti_Funzionali.md");
  assert.equal(draft.content.includes("type: analysis"), true);
  assert.equal(draft.content.includes("src/alpha-service.ts"), true);

  const validation = await validateWikiPageContent(draft.content, { checkSourceExists: false });
  assert.equal(hasErrors(validation.issues), false);
});

test("development report contract blocks incomplete reports and prepares request drafts for valid reports", () => {
  const plan = buildDevReportPlan({
    client: "Cliente",
    project: "Progetto",
    requestId: "REQ-42",
    objective: "Aggiornare automazione.",
  });
  assert.equal(plan.includes("knowledge_ingest action=report"), true);
  assert.equal(plan.includes("## Automazioni"), true);

  const incomplete = validateDevReport([
    "# Report",
    "",
    "## Contesto richiesta",
    "Richiesta breve.",
  ].join("\n"));
  assert.equal(incomplete.valid, false);
  assert.equal(incomplete.findings.some((finding) => finding.code === "SECTION_MISSING"), true);

  const validReport = [
    "# Development Report - REQ-42",
    "",
    "> **Cliente:** Cliente",
    "> **Progetto:** Progetto",
    "> **Request ID:** REQ-42",
    "> **Data:** 2026-05-30",
    "> **Stato:** Validato per ingestione wiki",
    "",
    "## Contesto richiesta",
    "Obiettivo: Aggiornare automazione.",
    "",
    "## Modifiche funzionali",
    "La richiesta aggiorna il comportamento visibile del processo operativo.",
    "",
    "## Data model",
    "Nessuna modifica al data model.",
    "",
    "## Automazioni",
    "Trigger aggiornato alla chiusura del record con condizione su stato validato.",
    "",
    "## Integrazioni/API",
    "Nessuna modifica a integrazioni o API.",
    "",
    "## UI/UX",
    "Nessuna modifica UI/UX.",
    "",
    "## Permessi/Sicurezza",
    "Nessuna modifica a permessi o sicurezza.",
    "",
    "## Test",
    "Test eseguiti in ambiente test con esito OK e regressione principale verificata.",
    "",
    "## Changelog",
    "Aggiornato changelog della release.",
    "",
    "## Impatto documentale",
    "Aggiornare documento funzionale.",
    "",
    "## Gap/Ambiguità",
    "Nessun gap noto.",
  ].join("\n");

  const prepared = prepareRequestIngestionDrafts(validReport, "docs/reports/REQ-42.md");
  assert.equal(prepared.valid, true);
  assert.equal(prepared.drafts.some((draft) => draft.path.includes("requests/REQ_42")), true);
  assert.equal(prepared.drafts.some((draft) => draft.content.includes("type: automation")), true);
});
