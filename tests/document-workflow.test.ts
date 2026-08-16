import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DOCUMENT_TEMPLATES } from "../src/config/templates.js";
import { sectionEvidencePlan } from "../src/config/editorial-plans.js";
import {
  documentContract,
  USER_REQUEST_LANGUAGE,
} from "../src/config/document-contracts.js";
import {
  WIKI_PAGE_DIRECTORIES,
  WIKI_PAGE_DIRECTORY_BY_TYPE,
} from "../src/config/workspace-layout.js";
import {
  createSectionContext,
  buildDocumentPlan,
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
    ["1. Purpose and Objectives", "2. Context and Motivation", "3. Functional Requirements"]
  );
});

test("document planning propagates an open-ended user output language", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-language-plan-"));
  for (const language of ["italiano", "français", "português"]) {
    const plan = await buildDocumentPlan(root, {
      documentType: "custom",
      objective: "Produce user-readable knowledge.",
      language,
    });
    assert.match(plan, new RegExp(`Output language:\\*\\* ${language}`));
    assert.equal(plan.includes(`Write all human-readable titles, headings, and prose in ${language}.`), true);
    assert.match(plan, /not an English-output requirement/);
  }

  const inferred = await buildDocumentPlan(root, {
    documentType: "custom",
    objective: "Produce user-readable knowledge.",
  });
  assert.equal(documentContract("custom").defaultLanguage, USER_REQUEST_LANGUAGE);
  assert.match(inferred, /Output language:\*\* the user's request language/);
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

  const explicitGermanDiagram = await createSectionContext({
    wikiRoot: root,
    sectionTitle: "Systemübersicht",
    documentType: "custom",
    diagramMode: "mermaid",
    pagePaths: ["concepts/Alpha.md"],
    maxPages: 1,
  });
  assert.equal(explicitGermanDiagram.diagramRelevant, true);
  assert.equal(explicitGermanDiagram.diagramEvidencePack !== undefined, true);

  const omittedGermanDiagram = await createSectionContext({
    wikiRoot: root,
    sectionTitle: "Systemübersicht",
    documentType: "custom",
    pagePaths: ["concepts/Alpha.md"],
    maxPages: 1,
  });
  assert.equal(omittedGermanDiagram.diagramMode, null);
  assert.equal(omittedGermanDiagram.diagramEvidencePack, undefined);
});

test("reviewDocumentStructure reports placeholders, missing sections, and Mermaid issues", async () => {
  const review = await reviewDocumentStructure(
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
  assert.equal(review.missingSections.includes("2. Context and Motivation"), true);
  assert.equal(review.findings.some((finding) => finding.code === "UNRESOLVED_PLACEHOLDER"), true);
  assert.equal(review.findings.some((finding) => finding.code === "MERMAID_INVALID"), true);
});

test("reviewDocumentStructure reports client-facing and language issues with wiki update plan", async () => {
  const review = await reviewDocumentStructure(
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
  assert.equal(review.findings.some((finding) => finding.code === "LANGUAGE_REVIEW"), true);

  const formatted = formatReviewResult(review, "documento.md", { includeWikiUpdatePlan: true });
  assert.equal(formatted.includes("Wiki update plan"), true);
  assert.equal(formatted.includes("prepare_knowledge_update"), true);
  assert.equal(formatted.includes("Coverage matrix"), true);
});

test("reviewDocumentStructure accepts a complete custom document without blocking findings", async () => {
  const review = await reviewDocumentStructure(
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

test("valid Mermaid syntax remains delivery-ready while active directives block", async () => {
  const validBodies = [
    "flowchart LR\n  A <--> B",
    "flowchart LR\n  B[API Gateway<br/>HTTP]",
    "classDiagram\n  class Gateway {\n    <<interface>>\n  }",
    "stateDiagram-v2\n  state fork_state <<fork>>",
    "erDiagram\n  ORDER ||--o{ ITEM : contains",
    "sequenceDiagram\n  Alice-)John: hi",
  ];
  for (const body of validBodies) {
    const review = await reviewDocumentStructure(
      `# Diagram\n\n## Verified flow\n\nThis section contains a renderer-specific but valid Mermaid example.\n\n\`\`\`mermaid\n${body}\n\`\`\``
    );
    assert.equal(
      review.findings.some((finding) => finding.severity === "BLOCKER" && finding.code.includes("MERMAID")),
      false,
      body
    );
    assert.equal(review.readyForDelivery, true, body);
  }

  for (const body of [
    "flowchart LR\n  A --> B\n  click A \"https://example.com\"",
    "%%{init: {'theme': 'dark'}}%%\nflowchart LR\n  A --> B",
  ]) {
    const review = await reviewDocumentStructure(
      `# Unsafe diagram\n\n## Verified flow\n\nThis section has enough prose for structural review.\n\n\`\`\`mermaid\n${body}\n\`\`\``
    );
    assert.equal(review.findings.some((finding) => finding.code === "MERMAID_UNSAFE"), true);
    assert.equal(review.readyForDelivery, false);
  }
});

test("raw HTML detection ignores inline code and CommonMark autolinks", async () => {
  const portable = await reviewDocumentStructure(
    "# Portable\n\n## API\n\nThe return type is `Promise<void>` and the reference is <https://example.com>."
  );
  assert.equal(portable.findings.some((finding) => finding.code === "RAW_HTML"), false);

  const html = await reviewDocumentStructure(
    "# HTML\n\n## API\n\n<div>This real HTML container remains caller-owned content.</div>"
  );
  assert.equal(html.findings.some((finding) => finding.code === "RAW_HTML"), true);
});

test("asset review covers image forms, ignores examples, and preserves legacy JPG portability", async () => {
  const hostileSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const hostileResolver = async () => ({
    status: "resolved" as const,
    byteLength: hostileSvg.byteLength,
    bytes: hostileSvg,
  });
  for (const image of [
    "![Flow](../assets/hostile.svg)",
    "![Flow][diagram]\n\n[diagram]: ../assets/hostile.svg",
    '<img src="../assets/hostile.svg" alt="Flow">',
  ]) {
    const review = await reviewDocumentStructure(
      `# Asset\n\n## Diagram\n\nThis section contains enough verified explanatory prose.\n\n${image}`,
      undefined,
      { assetResolver: hostileResolver }
    );
    assert.equal(review.findings.some((finding) => finding.code === "SVG_ACTIVE_CONTENT"), true, image);
    assert.equal(review.findings.some((finding) => finding.code === "UNRESOLVED_PLACEHOLDER"), false, image);
    assert.equal(review.readyForDelivery, false, image);
  }

  const escape = await reviewDocumentStructure(
    "# Escape\n\n## Diagram\n\nThis section references a path that must remain confined.\n\n![Flow][diagram]\n\n[diagram]: ../assets/../outside.svg",
    undefined,
    { assetResolver: async () => ({ status: "escape" }) }
  );
  assert.equal(escape.findings.some((finding) => finding.code === "ASSET_PATH_ESCAPE"), true);

  const fenced = await reviewDocumentStructure(
    "# Example\n\n## Markdown\n\nThis section documents syntax without embedding the image.\n\n~~~markdown\n![x](https://example.com/s.png)\n~~~"
  );
  assert.equal(fenced.findings.some((finding) => finding.code.startsWith("ASSET_")), false);
  const frontmatter = await reviewDocumentStructure(
    "---\nexample: '![x](https://example.com/s.png)'\n---\n# Example\n\n## Metadata\n\nThis section explains that frontmatter is outside the reviewed body."
  );
  assert.equal(frontmatter.findings.some((finding) => finding.code.startsWith("ASSET_")), false);
  const outsideFence = await reviewDocumentStructure(
    "# Image\n\n## Markdown\n\nThis section embeds a remote image for illustration.\n\n![x](https://example.com/s.png)"
  );
  assert.equal(outsideFence.findings.some((finding) => finding.code === "ASSET_REMOTE"), true);

  const legacy = await reviewDocumentStructure(
    "# Legacy\n\n## Screenshots\n\nThis legacy deliverable includes an existing screenshot and status badge.\n\n![Screen](../assets/screen.jpg)\n![Build](https://img.shields.io/badge/build-passing.svg)",
    undefined,
    { assetResolver: async () => ({ status: "resolved", byteLength: 128 }) }
  );
  assert.equal(legacy.readyForDelivery, true);
  assert.deepEqual(
    legacy.findings.filter((finding) => finding.severity === "WARNING").map((finding) => finding.code).sort(),
    ["ASSET_REMOTE", "ASSET_TYPE_UNSUPPORTED"]
  );
  assert.equal(legacy.findings.some((finding) => finding.code === "NO_BLOCKERS"), true);
});

test("custom contract verdicts are profile-name independent", async () => {
  const markdown = "# Notes\n\n## Outcome\n\nShort.";
  const generic = await reviewDocumentStructure(markdown, undefined, { documentType: "custom" });
  const named = await reviewDocumentStructure(markdown, undefined, { documentType: "meeting_notes" });
  assert.deepEqual(named.findings, generic.findings);
  assert.equal(named.readyForDelivery, generic.readyForDelivery);
  assert.equal(documentContract("meeting_notes").kind, "custom");
  assert.deepEqual(sectionEvidencePlan("constructor", "Miscellaneous"), sectionEvidencePlan("custom", "Miscellaneous"));
});

test("diagram mode is enforced only when explicitly supplied", async () => {
  const markdown = "# Diagram\n\n## Flow\n\nThis verified flow is represented below.\n\n```mermaid\nflowchart LR\n  A --> B\n```";
  const omitted = await reviewDocumentStructure(markdown);
  assert.equal(omitted.effectiveDiagramMode, null);
  assert.equal(omitted.findings.some((finding) => finding.code === "DIAGRAM_MODE_MISMATCH"), false);

  const explicitNone = await reviewDocumentStructure(markdown, undefined, { diagramMode: "none" });
  assert.equal(explicitNone.effectiveDiagramMode, "none");
  assert.equal(explicitNone.findings.some((finding) => finding.code === "DIAGRAM_MODE_MISMATCH"), true);
});

test("reviewDocumentStructure flags non-portable HTML and private resource URIs", async () => {
  const review = await reviewDocumentStructure(
    [
      "# Documento",
      "",
      "## Panoramica",
      "<details><summary>Dettagli</summary>Testo verificato.</details>",
      "",
      "Fonte interna: [requisito](knowledge-rail://page/requirements/REQ_1.md).",
    ].join("\n")
  );

  assert.equal(review.findings.some((finding) => finding.code === "RAW_HTML"), true);
  assert.equal(review.findings.some((finding) => finding.code === "PRIVATE_RESOURCE_URI"), true);
  assert.equal(review.readyForDelivery, false);
});

test("document contracts apply audience defaults instead of treating every document as client-facing", async () => {
  const internal = await reviewDocumentStructure(
    "# Architecture\n\n## Evidence\n\nImplementation details are verified in src/server.ts and tests/server.test.ts.",
    undefined,
    { documentType: "architecture_doc" }
  );
  assert.equal(internal.findings.some((finding) => finding.code === "NON_CLIENT_FACING"), false);

  const client = await reviewDocumentStructure(
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
  assert.equal(plan.includes("## Automations"), true);

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
