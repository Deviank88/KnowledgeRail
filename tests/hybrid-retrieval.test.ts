import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

async function writePage(
  wikiRoot: string,
  relPath: string,
  params: { title: string; type: string; requestId?: string; body: string }
): Promise<void> {
  const file = path.join(wikiRoot, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    `title: \"${params.title}\"`,
    `type: ${params.type}`,
    "tags: [hybrid-test]",
    "created: 2026-08-13",
    "updated: 2026-08-13",
    ...(params.requestId ? [`request_id: \"${params.requestId}\"`] : []),
    "---",
    "",
    `# ${params.title}`,
    "",
    params.body,
  ].join("\n"), "utf8");
}

test("hybrid retrieval unions graph-only same-request evidence with lexical candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);

  try {
    await writePage(wikiRoot, "requirements/REQ_RETRY.md", {
      title: "Retry limit policy",
      type: "requirement",
      requestId: "REQ-9",
      body: "The retry limit is exactly three attempts before escalation.",
    });
    await writePage(wikiRoot, "implementations/Worker.md", {
      title: "Background worker implementation",
      type: "implementation",
      requestId: "REQ-9",
      body: "The worker uses an asynchronous scheduler and records execution telemetry.",
    });
    await writePage(wikiRoot, "analysis/Unrelated.md", {
      title: "Unrelated analysis",
      type: "analysis",
      body: "Warehouse capacity and invoicing are discussed here.",
    });

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "retry limit three attempts escalation",
      maxResults: 6,
      lexicalPoolSize: 10,
      seedCount: 4,
      graphMaxDepth: 1,
      graphMaxNodes: 12,
      graphMaxVisitedNodes: 24,
    });

    const lexicalPaths = new Set(result.lexicalHits.map((hit) => hit.path));
    assert.equal(lexicalPaths.has("requirements/REQ_RETRY.md"), true);
    assert.equal(lexicalPaths.has("implementations/Worker.md"), false);
    const lexicalSeed = result.hits.find((hit) => hit.path === "requirements/REQ_RETRY.md");
    assert.ok(lexicalSeed);
    assert.equal(lexicalSeed.channels.graphRank, undefined, "lexical seeds must not be double-counted as graph evidence");
    assert.equal(lexicalSeed.channels.lexicalConfidence, 1);

    const graphOnly = result.hits.find((hit) => hit.path === "implementations/Worker.md");
    assert.ok(graphOnly, "same-request graph evidence must enter the fused candidate set");
    assert.equal(graphOnly.channels.lexicalRank, undefined);
    assert.equal(typeof graphOnly.channels.graphRank, "number");
    assert.equal(result.graphResult.stats.visitedNodes < result.graphResult.graph.nodes.length, true);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hybrid retrieval preserves lexical ordering signal while adding graph signal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-rank-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);

  try {
    await writePage(wikiRoot, "requirements/Exact.md", {
      title: "OAuth token rotation requirement",
      type: "requirement",
      body: "OAuth token rotation must occur every ninety days.",
    });
    await writePage(wikiRoot, "analysis/Weak.md", {
      title: "Authentication notes",
      type: "analysis",
      body: "Generic authentication notes mention token handling once.",
    });

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "OAuth token rotation ninety days",
      maxResults: 5,
      graphMaxDepth: 1,
    });

    assert.equal(result.hits[0]?.path, "requirements/Exact.md");
    assert.equal(result.hits[0]?.channels.lexicalRank, 1);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("long task descriptions retain the domain subject over generic section vocabulary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-subject-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);

  try {
    await writePage(wikiRoot, "concepts/Lease.md", {
      title: "Lease lifecycle",
      type: "concept",
      body: "A Lease binds a tenant to a property unit and drives rent schedules.",
    });
    await writePage(wikiRoot, "requests/TableSort.md", {
      title: "Table sorting across components",
      type: "request",
      body: "Data model, automazioni, componenti, validazioni, test, rilasci, limiti e gap documentali.",
    });

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query:
        "Spiegare il funzionamento dei lease nel progetto SilverFir, includendo data model, automazioni e componenti, validazioni, test e rilasci, evidenziando limiti e gap documentali.",
      maxResults: 2,
      maxWideningLevel: 2,
      persistDerivedIndexes: false,
    });

    assert.equal(result.wideningLevel, 2);
    assert.equal(result.hits[0]?.path, "concepts/Lease.md");
    assert.equal(result.coverage.evidenceGaps.includes("passage_evidence"), false);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});
