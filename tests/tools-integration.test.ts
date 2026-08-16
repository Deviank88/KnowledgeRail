import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { wikiPassageId } from "../src/context/passage-id.js";
import { wikiPassageUri } from "../src/context/resource-uri.js";
import { readWikiPageRecord } from "../src/core/page-record.js";
import { docsCategoryDir, setWikiRoot } from "../src/core/paths.js";
import { registerContextTools } from "../src/tools/context-tools.js";
import { registerDocumentTools } from "../src/tools/document-tools.js";
import { registerWikiPrompts } from "../src/tools/prompts.js";
import { registerSourceTools } from "../src/tools/source-tools.js";
import {
  registerWikiTools,
  setWikiMoveFailureAfterWritesForTests,
} from "../src/tools/wiki-tools.js";
import { registerEvidenceTools } from "../src/tools/evidence-tools.js";
import { registerCodeEvidenceTools } from "../src/tools/code-evidence-tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

type PromptHandler = (args: Record<string, unknown>) => Promise<{
  messages: Array<{ role: string; content: { type: string; text: string } }>;
}> | {
  messages: Array<{ role: string; content: { type: string; text: string } }>;
};

function createFakeServer(): {
  server: McpServer;
  tools: Map<string, ToolHandler>;
  prompts: Map<string, PromptHandler>;
} {
  const tools = new Map<string, ToolHandler>();
  const prompts = new Map<string, PromptHandler>();
  const fake = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
    registerPrompt: (name: string, _config: unknown, handler: PromptHandler) => {
      prompts.set(name, handler);
    },
  };
  return { server: fake as unknown as McpServer, tools, prompts };
}

async function setupWorkspace(): Promise<{
  root: string;
  tools: Map<string, ToolHandler>;
  prompts: Map<string, PromptHandler>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-tools-"));
  setWikiRoot(root);
  const { server, tools, prompts } = createFakeServer();
  registerWikiTools(server);
  registerContextTools(server);
  registerSourceTools(server);
  registerEvidenceTools(server);
  registerCodeEvidenceTools(server);
  registerDocumentTools(server);
  registerWikiPrompts(server);
  assert.equal(tools.size, 22);
  const init = await tools.get("knowledge_init")!({ force: false });
  assert.equal(init.isError, undefined);
  await fs.access(path.join(root, "docs", "evidence-ir"));
  return { root, tools, prompts };
}

const DEV_REPORT = [
  "# Development Report - REQ-1",
  "",
  "> **Cliente:** Client",
  "> **Progetto:** Alpha Project",
  "> **Request ID:** REQ-1",
  "> **Data:** 2026-05-30",
  "> **Stato:** Validato per ingestione wiki",
  "",
  "## Contesto richiesta",
  "Obiettivo: Implementare flusso Alpha.",
  "",
  "## Modifiche funzionali",
  "Il flusso Alpha consente agli utenti di completare la validazione.",
  "",
  "## Data model",
  "Nessuna modifica al data model.",
  "",
  "## Automazioni",
  "Nessuna modifica alle automazioni.",
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
  "Test eseguiti in ambiente test: caso Alpha completato con esito OK.",
  "",
  "## Changelog",
  "Aggiornato docs/changelogs/alpha.md.",
  "",
  "## Impatto documentale",
  "Aggiornare manuale utente e documento funzionale.",
  "",
  "## Gap/Ambiguità",
  "Nessun gap noto.",
].join("\n");

test("core wiki tools: write with warnings, edit, auto-index, delete, search, lint, graph", async () => {
  const { root, tools } = await setupWorkspace();
  await fs.writeFile(path.join(docsCategoryDir("client"), "source.md"), "alpha source", "utf-8");

  const page = [
    "---",
    'title: "Alpha Concept"',
    "type: concept",
    "tags: [alpha]",
    "created: 2026-05-07",
    "updated: 2026-05-07",
    'sources: ["docs/client/source.md"]',
    "---",
    "",
    "# Alpha",
    "alpha beta beta e vedi anche [[Pagina Mancante]]",
  ].join("\n");

  const write = await tools.get("wiki_write_page")!({ path: "concepts/Alpha.md", content: page });
  assert.equal(write.isError, undefined);
  assert.equal(write.content[0].text.includes("Index updated"), true);
  assert.equal(write.content[0].text.includes("[[Pagina Mancante]]"), true);

  // index.md rigenerato automaticamente dopo la scrittura
  const index = await fs.readFile(path.join(root, "wiki", "index.md"), "utf-8");
  assert.equal(index.includes("Alpha Concept"), true);

  // edit: old_string mancante
  const editMissing = await tools.get("wiki_edit_page")!({
    path: "concepts/Alpha.md",
    old_string: "non esiste",
    new_string: "x",
    replace_all: false,
  });
  assert.equal(editMissing.isError, true);

  // edit che rompe il frontmatter viene bloccato
  const editInvalid = await tools.get("wiki_edit_page")!({
    path: "concepts/Alpha.md",
    old_string: "type: concept",
    new_string: "type: not_a_type",
    replace_all: false,
  });
  assert.equal(editInvalid.isError, true);
  assert.equal(editInvalid.content[0].text.includes("TYPE_INVALID"), true);

  // edit valido
  const edit = await tools.get("wiki_edit_page")!({
    path: "concepts/Alpha.md",
    old_string: "beta beta",
    new_string: "beta gamma",
    replace_all: false,
  });
  assert.equal(edit.isError, undefined);
  assert.equal(edit.content[0].text.includes("1 replacement"), true);
  const edited = await fs.readFile(path.join(root, "wiki", "concepts", "Alpha.md"), "utf-8");
  assert.equal(edited.includes("beta gamma"), true);

  const boundedRead = await tools.get("wiki_read_page")!({
    path: "concepts/Alpha.md",
    max_chars: 32,
  });
  assert.equal(boundedRead.isError, undefined);
  assert.equal(boundedRead.content[0].text.includes("[Truncated:"), true);
  assert.equal([...boundedRead.content[0].text].length < edited.length + 100, true);

  const record = await readWikiPageRecord(path.join(root, "wiki"), "concepts/Alpha.md");
  assert.ok(record?.passages[0]);
  const passageRead = await tools.get("wiki_read_page")!({
    resource_uri: wikiPassageUri(record.path, wikiPassageId(record.passages[0])),
  });
  assert.equal(passageRead.content[0].text.includes("beta gamma"), true);
  assert.equal(passageRead.content[0].text.includes("[Truncated:"), false);

  const missingReadTarget = await tools.get("wiki_read_page")!({ max_chars: 32 });
  assert.equal(missingReadTarget.isError, true);
  assert.equal(missingReadTarget.content[0].text.includes("exactly one"), true);

  const search = await tools.get("wiki_search")!({ query: "gamma", max_results: 1 });
  assert.equal(search.content[0].text.includes("Alpha Concept"), true);

  const lint = await tools.get("wiki_lint")!({
    include_orphans: true,
    include_missing: true,
    include_broken_links: true,
  });
  assert.equal(lint.content[0].text.includes("INFO ORPHAN"), true);
  assert.equal(lint.content[0].text.includes("MISSING_WIKILINK"), true);

  const graphQuery = await tools.get("wiki_graph_query")!({
    query: "Alpha",
    max_nodes: 6,
    max_depth: 1,
  });
  assert.equal(graphQuery.content[0].text.includes("Graph query"), true);

  // delete + index auto-aggiornato
  const del = await tools.get("wiki_delete_page")!({ path: "concepts/Alpha.md" });
  assert.equal(del.isError, undefined);
  const indexAfterDelete = await fs.readFile(path.join(root, "wiki", "index.md"), "utf-8");
  assert.equal(indexAfterDelete.includes("Alpha Concept"), false);
});

test("filesystem tools reject glob and symlink workspace escapes", {
  skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false,
}, async () => {
  const { root, tools } = await setupWorkspace();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-outside-"));
  const validPage = [
    "---",
    "title: Outside",
    "type: concept",
    "tags: [escape]",
    "created: 2026-08-16",
    "updated: 2026-08-16",
    "sources: []",
    "---",
    "",
    "# Outside",
  ].join("\n");
  await fs.writeFile(path.join(outside, "Existing.md"), validPage);

  const traversal = await tools.get("knowledge_files")!({
    action: "list",
    category: "client",
    pattern: "../../**/*",
  });
  assert.equal(traversal.isError, true);
  assert.match(traversal.content[0].text, /Parent-directory/);

  const absolute = await tools.get("knowledge_files")!({
    action: "list",
    category: "client",
    pattern: "/etc/hosts",
  });
  assert.equal(absolute.isError, true);
  assert.match(absolute.content[0].text, /Absolute/);

  const linkedWiki = path.join(root, "wiki", "linked");
  await fs.symlink(outside, linkedWiki, "dir");
  await assert.rejects(
    () => tools.get("wiki_write_page")!({ path: "linked/New.md", content: validPage }),
    /outside/
  );
  await assert.rejects(
    () => tools.get("wiki_edit_page")!({
      path: "linked/Existing.md",
      old_string: "Outside",
      new_string: "Escaped",
      replace_all: false,
    }),
    /outside/
  );
  await assert.rejects(
    () => tools.get("wiki_move_page")!({
      old_path: "linked/Existing.md",
      new_path: "Moved.md",
      dry_run: false,
    }),
    /outside/
  );
  await assert.rejects(
    () => tools.get("wiki_delete_page")!({ path: "linked/Existing.md" }),
    /outside/
  );

  const outsideSecret = path.join(outside, "secret.txt");
  await fs.writeFile(outsideSecret, "outside-secret");
  await fs.symlink(outsideSecret, path.join(root, "docs", "client", "linked.txt"), "file");
  const linkedRead = await tools.get("knowledge_files")!({
    action: "read",
    category: "client",
    path: "linked.txt",
  });
  assert.equal(linkedRead.isError, true);
  assert.equal(JSON.stringify(linkedRead).includes("outside-secret"), false);

  await fs.rm(path.join(root, "docs", "deliverables"), { recursive: true, force: true });
  await fs.symlink(outside, path.join(root, "docs", "deliverables"), "dir");
  await assert.rejects(
    () => tools.get("knowledge_write_document")!({
      filename: "escaped.md",
      title: "Escaped",
      document_type: "custom",
      content: "# Escaped",
      overwrite: true,
    }),
    /outside/
  );
  await assert.rejects(() => fs.access(path.join(outside, "escaped.md")));
  await fs.rm(outside, { recursive: true, force: true });
});

test("wikilinks resolve canonical frontmatter titles before legacy filenames", async () => {
  const { tools } = await setupWorkspace();
  const frontmatter = (title: string) => [
    "---",
    `title: "${title}"`,
    "type: concept",
    "tags: [links]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "sources: []",
    "---",
  ].join("\n");

  await tools.get("wiki_write_page")!({
    path: "concepts/internal-a.md",
    content: `${frontmatter("Canonical Alpha Title")}\n\n# Alpha\nBootstrap page.`,
  });
  const betaWrite = await tools.get("wiki_write_page")!({
    path: "concepts/internal-b.md",
    content: `${frontmatter("Canonical Beta Title")}\n\n# Beta\nSee [[Canonical Alpha Title]].`,
  });
  assert.equal(betaWrite.content[0].text.includes("does not match"), false);
  const alphaEdit = await tools.get("wiki_edit_page")!({
    path: "concepts/internal-a.md",
    old_string: "Bootstrap page.",
    new_string: "See [[Canonical Beta Title]].",
    replace_all: false,
  });
  assert.equal(alphaEdit.content[0].text.includes("does not match"), false);

  const lint = await tools.get("wiki_lint")!({
    include_orphans: true,
    include_missing: true,
    include_broken_links: true,
  });
  assert.equal(lint.content[0].text, "Wiki lint passed. No problems found.");
});

test("wiki_move_page updates wikilinks and relative markdown links", async () => {
  const { root, tools } = await setupWorkspace();
  await fs.writeFile(path.join(docsCategoryDir("client"), "source.md"), "alpha source", "utf-8");

  const frontmatter = (title: string) => [
    "---",
    `title: "${title}"`,
    "type: concept",
    "tags: [alpha]",
    "created: 2026-05-07",
    "updated: 2026-05-07",
    'sources: ["docs/client/source.md"]',
    "---",
  ].join("\n");

  await tools.get("wiki_write_page")!({
    path: "concepts/Alpha.md",
    content: `${frontmatter("Alpha")}\n\n# Alpha\ncontenuto`,
  });
  await tools.get("wiki_write_page")!({
    path: "concepts/Beta.md",
    content: `${frontmatter("Beta")}\n\n# Beta\nVedi [[Alpha]] e [dettagli](Alpha.md).`,
  });

  const move = await tools.get("wiki_move_page")!({
    old_path: "concepts/Alpha.md",
    new_path: "entities/Alpha_Entity.md",
    dry_run: false,
  });
  assert.equal(move.isError, undefined);
  assert.equal(move.content[0].text.includes("Moved"), true);

  const beta = await fs.readFile(path.join(root, "wiki", "concepts", "Beta.md"), "utf-8");
  assert.equal(beta.includes("[[Alpha Entity]]"), true);
  assert.equal(beta.includes("(../entities/Alpha_Entity.md)"), true);
});

test("wiki_move_page rolls back every touched page after a partial failure", async () => {
  const { root, tools } = await setupWorkspace();
  const page = (title: string, body: string) => [
    "---",
    `title: "${title}"`,
    "type: concept",
    "tags: [journal]",
    "created: 2026-08-16",
    "updated: 2026-08-16",
    "sources: []",
    "---",
    "",
    `# ${title}`,
    body,
  ].join("\n");
  await tools.get("wiki_write_page")!({ path: "concepts/Alpha.md", content: page("Alpha", "Body") });
  await tools.get("wiki_write_page")!({
    path: "concepts/Beta.md",
    content: page("Beta", "See [[Alpha]] and [details](Alpha.md)."),
  });
  const alphaBefore = await fs.readFile(path.join(root, "wiki", "concepts", "Alpha.md"), "utf8");
  const betaBefore = await fs.readFile(path.join(root, "wiki", "concepts", "Beta.md"), "utf8");
  const indexBefore = await fs.readFile(path.join(root, "wiki", "index.md"), "utf8");

  setWikiMoveFailureAfterWritesForTests(2);
  try {
    await assert.rejects(() => tools.get("wiki_move_page")!({
      old_path: "concepts/Alpha.md",
      new_path: "entities/Alpha_Entity.md",
      dry_run: false,
    }), /Injected wiki move failure/);
  } finally {
    setWikiMoveFailureAfterWritesForTests(null);
  }

  assert.equal(
    await fs.readFile(path.join(root, "wiki", "concepts", "Alpha.md"), "utf8"),
    alphaBefore
  );
  assert.equal(
    await fs.readFile(path.join(root, "wiki", "concepts", "Beta.md"), "utf8"),
    betaBefore
  );
  assert.equal(await fs.readFile(path.join(root, "wiki", "index.md"), "utf8"), indexBefore);
  await assert.rejects(() => fs.access(path.join(root, "wiki", "entities", "Alpha_Entity.md")));
});

test("source ingestion: normalize, prepare drafts, dev report ingestion, traceability", async () => {
  const { tools } = await setupWorkspace();
  await fs.writeFile(path.join(docsCategoryDir("client"), "source.md"), "alpha source", "utf-8");

  const truncated = await tools.get("knowledge_files")!({
    action: "read",
    category: "client",
    path: "source.md",
    max_chars: 5,
  });
  assert.equal(truncated.content[0].text.includes("[Truncated"), true);

  const normalized = await tools.get("knowledge_normalize_source")!({
    category: "client",
    path: "source.md",
    overwrite: false,
  });
  assert.equal(normalized.isError, undefined);
  assert.equal(normalized.content[0].text.includes("docs/normalized/client_source.md"), true);

  const listed = await tools.get("knowledge_files")!({ action: "list", category: "client", pattern: "**/*" });
  assert.equal(listed.content[0].text.includes("source.md"), true);
  assert.equal(listed.content[0].text.includes("normalized"), true);

  const sourceDraft = await tools.get("knowledge_prepare_source_ingestion")!({
    source_kind: "client_source",
    title: "Fonte Alpha",
    normalized_filename: "client_source.md",
    max_chars: 12000,
  });
  assert.equal(sourceDraft.isError, undefined);
  assert.equal(sourceDraft.content[0].text.includes("Evidence IR extraction unit"), true);
  assert.equal(sourceDraft.content[0].text.includes("record, link, validation and synthesis are orchestrated internally"), true);
  assert.equal(sourceDraft.content[0].text.includes("Unresolved queue:"), true);
  assert.equal(sourceDraft.content[0].text.includes("```source"), true);

  const sourceCoverageResult = await tools.get("knowledge_prepare_source_ingestion")!({
    action: "coverage",
    normalized_filename: "client_source.md",
  });
  assert.equal(sourceCoverageResult.isError, undefined);
  assert.equal(sourceCoverageResult.content[0].text.includes("state: open"), true);
  assert.equal(sourceCoverageResult.content[0].text.includes("unresolvedSegmentCount:"), true);

  const prematureFinalize = await tools.get("knowledge_prepare_source_ingestion")!({
    action: "finalize",
    normalized_filename: "client_source.md",
  });
  assert.equal(prematureFinalize.isError, true);
  assert.equal(prematureFinalize.content[0].text.includes("Cannot finalize source coverage"), true);

  const segmentId = sourceDraft.content[0].text.match(/Segment: `([^`]+)`/)?.[1];
  assert.ok(segmentId);
  const representedBypass = await tools.get("knowledge_prepare_source_ingestion")!({
    action: "record",
    normalized_filename: "client_source.md",
    segment_id: segmentId,
    status: "integrated",
    evidence_refs: [segmentId],
    page_refs: ["index.md"],
  });
  assert.equal(representedBypass.isError, true);
  assert.equal(representedBypass.content[0].text.includes("derived only by knowledge_ingest action=apply_claims"), true);

  const evidenceRecord = await tools.get("knowledge_evidence_ir")!({
    action: "record",
    normalized_filename: "client_source.md",
    segment_id: segmentId,
    claims: [{
      text: "Alpha source is canonical client context.",
      kind: "fact",
      origin: "extracted",
      confidence: 0.99,
      target: {
        entity_key: "alpha-source",
        page_path: "client-sources/AlphaSource.md",
        page_title: "Alpha source",
        page_type: "client_source",
      },
    }],
  });
  assert.equal(evidenceRecord.isError, undefined);
  assert.equal(evidenceRecord.content[0].text.includes("Evidence recorded before synthesis"), true);
  const recoveredClaimId = evidenceRecord.content[0].text.match(/(claim-[a-f0-9]{32})/)?.[1];
  assert.ok(recoveredClaimId);
  const recoveryRecord = await tools.get("knowledge_evidence_ir")!({
    action: "recovery_record",
    total_evidence_used: 2,
    recovery_events: [{
      evidence_ref: recoveredClaimId,
      source_uri: "docs/normalized/client_source.md",
      discovered_by: "source_fallback",
      expected_wiki_pages: ["client-sources/AlphaSource.md"],
      reason: "The source fallback exposed canonical evidence missing from the wiki.",
    }],
  });
  assert.equal(recoveryRecord.isError, undefined);
  assert.equal(recoveryRecord.content[0].text.includes("KnowledgeRecoveryPending: 1"), true);
  const recoveryEventId = recoveryRecord.content[0].text.match(/(recovery-[a-f0-9]{32})/)?.[1];
  assert.ok(recoveryEventId);

  const evidenceLink = await tools.get("knowledge_evidence_ir")!({ action: "link" });
  assert.equal(evidenceLink.isError, undefined);
  assert.equal(evidenceLink.content[0].text.includes("candidate_new_page"), true);
  const evidencePlan = await tools.get("knowledge_evidence_ir")!({ action: "plan_synthesis" });
  assert.equal(evidencePlan.isError, undefined);
  assert.equal(evidencePlan.content[0].text.includes("No pages written"), true);
  assert.equal(evidencePlan.content[0].text.includes("client-sources/AlphaSource.md"), true);
  const evidenceSynthesis = await tools.get("knowledge_evidence_ir")!({ action: "synthesize" });
  assert.equal(evidenceSynthesis.isError, undefined);
  assert.equal(evidenceSynthesis.content[0].text.includes("Coverage updated: 1 segments; pending: 0"), true);
  const recoveryResolution = await tools.get("knowledge_evidence_ir")!({
    action: "recovery_resolve",
    recovery_event_id: recoveryEventId,
    recovery_resolution: "new_page",
    recovery_page_refs: ["client-sources/AlphaSource.md"],
    recovery_reason: "Evidence IR synthesis completed through the validated mutation pipeline.",
  });
  assert.equal(recoveryResolution.isError, undefined);
  assert.equal(recoveryResolution.content[0].text.includes("KnowledgeRecoveryPending: 0"), true);
  const recoveryStatus = await tools.get("knowledge_evidence_ir")!({
    action: "recovery_status",
    include_resolved: true,
  });
  assert.equal(recoveryStatus.isError, undefined);
  assert.equal(recoveryStatus.content[0].text.includes("LateRecoveryRate: 0.5000"), true);
  assert.equal(recoveryStatus.content[0].text.includes("resolvedEventCount: 1"), true);

  const evidenceStatus = await tools.get("knowledge_evidence_ir")!({ action: "status" });
  assert.equal(evidenceStatus.isError, undefined);
  assert.equal(evidenceStatus.content[0].text.includes("claimsWithProvenancePercent: 100.00"), true);
  const coveredAfterSynthesis = await tools.get("knowledge_prepare_source_ingestion")!({
    action: "coverage",
    normalized_filename: "client_source.md",
  });
  assert.equal(coveredAfterSynthesis.content[0].text.includes("segmentsProcessed: 1/"), true);
  assert.equal(coveredAfterSynthesis.content[0].text.includes(`- gaps: ${segmentId}`), false);

  await fs.writeFile(path.join(docsCategoryDir("reports"), "REQ-1.md"), DEV_REPORT, "utf-8");
  const requestDrafts = await tools.get("knowledge_prepare_request_ingestion")!({
    report_filename: "REQ-1.md",
  });
  assert.equal(requestDrafts.isError, undefined);
  assert.equal(requestDrafts.content[0].text.includes("Request-ingestion drafts"), true);
  assert.equal(requestDrafts.content[0].text.includes("requests/REQ_1_request.md"), true);

  // report incompleto → bloccato
  await fs.writeFile(
    path.join(docsCategoryDir("reports"), "REQ-2.md"),
    "# Development Report - REQ-2\n\n## Contesto richiesta\nSolo contesto.",
    "utf-8"
  );
  const blocked = await tools.get("knowledge_prepare_request_ingestion")!({
    report_filename: "REQ-2.md",
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.content[0].text.includes("BLOCKED"), true);

  const trace = await tools.get("wiki_graph_query")!({ query: "REQ-1", view: "traceability" });
  assert.equal(typeof trace.content[0].text, "string");
});

test("document tools: open profiles, section context, Markdown write, terminal review, and knowledge update", async () => {
  const { tools, prompts } = await setupWorkspace();
  await fs.writeFile(path.join(docsCategoryDir("client"), "source.md"), "alpha source", "utf-8");

  const page = [
    "---",
    'title: "Alpha Concept"',
    "type: concept",
    "tags: [alpha]",
    "created: 2026-05-07",
    "updated: 2026-05-07",
    'sources: ["docs/client/source.md"]',
    "---",
    "",
    "# Alpha",
    "alpha beta beta",
  ].join("\n");
  await tools.get("wiki_write_page")!({ path: "concepts/Alpha.md", content: page });

  const documentPlan = await tools.get("knowledge_plan_document")!({
    document_type: "safety_case",
    project_name: "Alpha",
    required_sections: ["Claim", "Evidence"],
  });
  assert.equal(documentPlan.content[0].text.includes("Document editorial plan"), true);
  assert.equal(documentPlan.structuredContent?.documentType, "safety_case");
  assert.equal((documentPlan.structuredContent?.documentProfile as { builtInPreset?: boolean }).builtInPreset, false);
  assert.deepEqual(documentPlan.structuredContent?.requiredSections, ["Claim", "Evidence"]);

  const diagramPlan = await tools.get("knowledge_plan_document")!({
    document_type: "architecture_doc",
    project_name: "Alpha",
  });
  const diagramChoice = diagramPlan.structuredContent?.diagramChoice as {
    default?: string;
    selected?: string | null;
    opportunities?: string[];
    optionDetails?: Array<{ mode?: string; requiresFilesystemAccess?: boolean }>;
  };
  assert.equal(diagramChoice.default, "none");
  assert.equal(diagramChoice.selected, null);
  assert.equal((diagramChoice.opportunities?.length ?? 0) > 0, true);
  assert.equal(
    diagramChoice.optionDetails?.find((option) => option.mode === "external_asset")?.requiresFilesystemAccess,
    true
  );

  const sectionContext = await tools.get("knowledge_section_context")!({
    section_title: "Requisiti Funzionali",
    document_type: "custom",
    query: "alpha beta",
    max_pages: 1,
    max_chars_per_page: 100,
    max_total_chars: 100,
  });
  assert.equal(sectionContext.content[0].text.includes("Section context pack"), true);
  assert.equal(sectionContext.content[0].text.includes("Alpha Concept"), true);

  const diagramContext = await tools.get("knowledge_section_context")!({
    section_title: "System Architecture",
    document_type: "architecture_doc",
    diagram_mode: "mermaid",
    query: "alpha",
    max_pages: 1,
  });
  assert.equal(diagramContext.structuredContent?.diagramRelevant, true);
  assert.equal(diagramContext.structuredContent?.diagramMode, "mermaid");
  assert.equal(
    Array.isArray((diagramContext.structuredContent?.diagramEvidencePack as { nodes?: unknown[] }).nodes),
    true
  );

  const docWrite = await tools.get("knowledge_write_document")!({
    filename: "brief.md",
    title: "Brief",
    document_type: "custom",
    content: "# Brief\n\n## Summary\n\nThis concise custom document records a completed and independently verifiable outcome.",
    overwrite: false,
  });
  assert.equal(docWrite.isError, undefined);

  const docReview = await tools.get("knowledge_review_document")!({
    filename: "brief.md",
    document_type: "custom",
  });
  assert.equal(docReview.content[0].text.includes("Document review"), true);
  assert.equal(docReview.content[0].text.includes("NESSUN_BLOCCANTE"), true);
  assert.equal(docReview.structuredContent?.readyForDelivery, true);
  assert.match(String(docReview.structuredContent?.contentSha256), /^[a-f0-9]{64}$/);
  const firstHash = String(docReview.structuredContent?.contentSha256);
  await tools.get("knowledge_write_document")!({
    filename: "brief.md",
    title: "Brief",
    document_type: "custom",
    content: "# Brief\n\n## Summary\n\nThis concise custom document records a completed and independently verifiable outcome with a changed byte.",
    overwrite: true,
  });
  const changedReview = await tools.get("knowledge_review_document")!({
    filename: "brief.md",
    document_type: "custom",
  });
  assert.notEqual(changedReview.structuredContent?.contentSha256, firstHash);

  const invalidWrite = await tools.get("knowledge_write_document")!({
    filename: "invalid.md",
    title: "Invalid",
    document_type: "custom",
    content: "# Invalid",
    overwrite: false,
  });
  assert.equal(invalidWrite.isError, undefined, "drafts with blockers remain storable");
  assert.equal(invalidWrite.structuredContent?.readyForDelivery, false);

  const assetsDir = docsCategoryDir("assets");
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(
    path.join(assetsDir, "hostile.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8"
  );
  const hostileWrite = await tools.get("knowledge_write_document")!({
    filename: "hostile.md",
    title: "Hostile",
    document_type: "custom",
    diagram_mode: "external_asset",
    content: "# Hostile\n\n## Diagram\n\nA caller-owned diagram is referenced here.\n\n![Flow](../assets/hostile.svg)",
    overwrite: true,
  });
  assert.equal(hostileWrite.structuredContent?.readyForDelivery, false);
  assert.equal(
    (hostileWrite.structuredContent?.findings as Array<{ code?: string }>).some(
      (finding) => finding.code === "SVG_ACTIVE_CONTENT"
    ),
    true
  );
  const missingAssetWrite = await tools.get("knowledge_write_document")!({
    filename: "missing-asset.md",
    title: "Missing asset",
    document_type: "custom",
    diagram_mode: "external_asset",
    content: "# Missing asset\n\n## Diagram\n\nThe expected local diagram is not present.\n\n![Flow](../assets/missing.png)",
    overwrite: true,
  });
  assert.equal(
    (missingAssetWrite.structuredContent?.findings as Array<{ code?: string }>).some(
      (finding) => finding.code === "ASSET_MISSING"
    ),
    true
  );
  const escapingAssetWrite = await tools.get("knowledge_write_document")!({
    filename: "escaping-asset.md",
    title: "Escaping asset",
    document_type: "custom",
    diagram_mode: "external_asset",
    content: "# Escaping asset\n\n## Diagram\n\nThe path must remain confined.\n\n![Flow](../../outside.svg)",
    overwrite: true,
  });
  assert.equal(
    (escapingAssetWrite.structuredContent?.findings as Array<{ code?: string }>).some(
      (finding) => finding.code === "ASSET_PATH_INVALID"
    ),
    true
  );

  const draft = await prompts.get("prepare_knowledge_update")!({
    finding: "La sezione requisiti Alpha è incompleta.",
    page_type: "analysis",
    title: "Requisiti Alpha",
    knowledge_context: sectionContext.content[0].text,
    sources: "src/alpha-service.ts",
  });
  assert.equal(draft.messages[0].content.text.includes("analysis/Requisiti_Alpha.md"), true);
  assert.equal(draft.messages[0].content.text.includes("knowledge_page action=write"), true);

  assert.equal(tools.has("knowledge_export_docx"), false);
});

test("MCP prompts return editorial and dev-report plans", async () => {
  const { prompts } = await setupWorkspace();

  const planDoc = await prompts.get("plan_document")!({
    document_type: "functional_spec",
    project_name: "Alpha Project",
  });
  assert.equal(planDoc.messages[0].content.text.includes("Document editorial plan"), true);
  assert.equal(planDoc.messages[0].content.text.includes('knowledge_document_context action="section"'), true);

  const planReport = await prompts.get("plan_dev_report")!({
    client: "Client",
    project: "Alpha Project",
    request_id: "REQ-1",
    objective: "Implementare flusso Alpha",
  });
  assert.equal(planReport.messages[0].content.text.includes("Development Report - REQ-1"), true);
  assert.equal(planReport.messages[0].content.text.includes("Data model"), true);
});
