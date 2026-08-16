import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildWikiGraph } from "../src/core/graph-index.js";
import {
  applyWikiMigration,
  detectWikiVersion,
  migrateSchemaText,
  planWikiMigration,
} from "../src/core/migration-service.js";
import { segmentMarkdown } from "../src/core/page-record.js";
import { clearRetrievalIndexes, searchRetrievalIndex, updateRetrievalPaths } from "../src/core/retrieval-index.js";
import { tokenizeSearchText } from "../src/core/text-analysis.js";

async function writePage(root: string, relPath: string, title: string, body: string, requestId?: string): Promise<void> {
  const absolute = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---", `title: "${title}"`, "type: implementation", "tags: [salesforce, api]",
    "created: 2026-07-11", "updated: 2026-07-11", "sources: []",
    ...(requestId ? [`request_id: "${requestId}"`] : []), "---", "", body,
  ].join("\n"), "utf-8");
}

test("technical tokenizer preserves compound identifiers and passage headings", () => {
  const tokens = tokenizeSearchText("REQ-123 aggiorna Asset__c via /services/data/v1");
  assert.equal(tokens.includes("req-123"), true);
  assert.equal(tokens.includes("asset__c"), true);
  assert.equal(tokens.includes("/services/data/v1"), true);
  const passages = segmentMarkdown("# API\n\nEndpoint alpha.\n\n## Errori\n\nCodice 409.");
  assert.deepEqual(passages.map((passage) => passage.heading), ["API", "Errori"]);
});

test("BM25 retrieval favors exact technical evidence and supports targeted updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-v3-search-"));
  await writePage(root, "implementations/Generic.md", "Generic", "REQ generica e Asset.");
  await writePage(root, "implementations/Exact.md", "REQ-123 Asset__c", "Implementa REQ-123 sul campo Asset__c.");
  clearRetrievalIndexes();
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "REQ-123 Asset__c", profile: "precision" });
  assert.equal(hits[0]?.path, "implementations/Exact.md");
  assert.equal(hits[0]?.heading.length > 0, true);

  await writePage(root, "implementations/Generic.md", "REQ-999", "REQ-999 Billing__c.");
  await updateRetrievalPaths(root, ["implementations/Generic.md"]);
  const updated = await searchRetrievalIndex({ wikiRoot: root, query: "REQ-999 Billing__c", profile: "precision" });
  assert.equal(updated[0]?.path, "implementations/Generic.md");
  await fs.access(path.join(root, ".knowledge-rail", "retrieval-index.json"));
});

test("same_request graph storage grows linearly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-v3-graph-"));
  for (let index = 0; index < 20; index++) {
    await writePage(root, `implementations/Page_${index}.md`, `Page ${index}`, "Shared request implementation.", "REQ-1");
  }
  clearRetrievalIndexes();
  const graph = await buildWikiGraph(root);
  assert.equal(graph.edges.filter((edge) => edge.kind === "same_request").length, 20);
});

test("migration supports v1/v2 detection, dry-run and idempotent v4 repair", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-v3-migrate-"));
  await fs.mkdir(root, { recursive: true });
  const originalSchema = "# Schema\n\nindex.md viene rigenerato automaticamente. Usa `wiki_list_pages` e `wiki_traceability_report`.";
  await fs.writeFile(path.join(root, "SCHEMA.md"), originalSchema, "utf-8");
  await fs.writeFile(path.join(root, "index.md"), "# Index", "utf-8");
  await writePage(root, "concepts/Alpha.md", "Alpha", "Contenuto Alpha.");
  assert.equal(await detectWikiVersion(root), 2);
  const dryRun = await planWikiMigration(root);
  assert.equal(dryRun.blockers.length, 0);
  assert.equal(await fs.stat(path.join(root, "SCHEMA.md")).then(() => true), true);

  const applied = await applyWikiMigration(root, { backup: true });
  assert.equal(applied.plan.detectedVersion, 2);
  assert.equal(await detectWikiVersion(root), 4);
  const migratedSchema = await fs.readFile(path.join(root, "SCHEMA.md"), "utf-8");
  assert.equal(migratedSchema, originalSchema, "migration must not rewrite canonical project conventions");
  assert.equal(migrateSchemaText(originalSchema).includes("`knowledge_context mode=list`"), true);
  assert.equal(migrateSchemaText(originalSchema).includes("`knowledge_context mode=graph view=traceability`"), true);
  const repair = await applyWikiMigration(root, { backup: true });
  assert.equal(repair.plan.detectedVersion, 4);
  await fs.access(path.join(root, ".knowledge-rail", "state.json"));
  await fs.access(path.join(root, ".knowledge-rail", "migrations", applied.runId, "journal.json"));
});

test("schema migration proposal covers every retired public operation without mutating source text", () => {
  const references = [
    ["wiki_write_page", "knowledge_page action=write"],
    ["wiki_read_resource", "knowledge_page action=read"],
    ["wiki_search", "knowledge_context mode=search"],
    ["wiki_graph_query", "knowledge_context mode=graph"],
    ["knowledge_prepare_source_ingestion", "knowledge_ingest"],
    ["knowledge_evidence_ir", "knowledge_ingest"],
    ["knowledge_code_evidence", "knowledge_code"],
    ["knowledge_plan_document", "knowledge_document_context action=plan"],
    ["knowledge_export_docx", "knowledge_document action=review (terminal; export removed)"],
    ["wiki_lint", "knowledge_admin action=lint"],
    ["knowledge_menu", "KnowledgeRail domain tools"],
  ] as const;
  const original = references.map(([legacy]) => `Use \`${legacy}\`.`).join("\n");
  const proposal = migrateSchemaText(original);
  assert.equal(original.includes("wiki_write_page"), true, "the caller-owned source string stays unchanged");
  for (const [legacy, replacement] of references) {
    assert.equal(proposal.includes(legacy), false, `${legacy} was not migrated`);
    assert.equal(proposal.includes(replacement), true, `${replacement} is missing`);
  }
});
