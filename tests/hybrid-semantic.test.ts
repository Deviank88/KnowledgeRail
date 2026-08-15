import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import type { SemanticHit, SemanticIndex } from "../src/core/semantic/types.js";

async function writePage(wikiRoot: string, relPath: string, title: string, body: string): Promise<void> {
  const file = path.join(wikiRoot, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    `title: "${title}"`,
    "type: requirement",
    "tags: [semantic-hybrid-test]",
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n"), "utf8");
}

function injectedIndex(hits: readonly SemanticHit[]): SemanticIndex {
  return {
    descriptor: {
      provider: { id: "test", model: "semantic-golden", version: "1", dimensions: 8 },
      engine: {
        id: "test-ann", version: "1", dimensions: 8, tables: 1,
        bitsPerTable: 1, probes: 1, minimumScore: 0,
      },
      passageCount: hits.length,
      pageCount: new Set(hits.map((hit) => hit.pagePath)).size,
    },
    async upsertPassages() {},
    async removePage() {},
    async search() { return [...hits]; },
  };
}

const provider = { id: "test", model: "semantic-golden", version: "1", dimensions: 8 };

test("semantic-only passages enter the RRF seed union without bypassing lexical retrieval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-semantic-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);
  try {
    await writePage(
      wikiRoot,
      "requirements/Overload.md",
      "Adaptive admission policy",
      "The gateway applies predictive load shedding before saturation."
    );
    await writePage(
      wikiRoot,
      "requirements/Exact.md",
      "REQ-7421",
      "The immutable audit identifier is REQ-7421."
    );
    await writePage(
      wikiRoot,
      "requirements/WeakIdentifierMention.md",
      "Generic identifier notes",
      "REQ-7421 appears in a generic cross-reference without normative evidence."
    );
    const semanticHit: SemanticHit = {
      pagePath: "requirements/Overload.md",
      passageId: "p-0123456789abcdef",
      heading: "Adaptive admission policy",
      text: "The gateway applies predictive load shedding before saturation.",
      score: 0.97,
      provider,
    };

    const baseline = await retrieveWikiHybrid({
      wikiRoot,
      query: "keep platform responsive during demand spikes",
      maxResults: 4,
      progressiveWidening: false,
    });
    assert.equal(baseline.hits.some((hit) => hit.path === semanticHit.pagePath), false);

    const enhanced = await retrieveWikiHybrid({
      wikiRoot,
      query: "keep platform responsive during demand spikes",
      maxResults: 4,
      progressiveWidening: false,
      semanticIndex: injectedIndex([semanticHit]),
    });
    assert.equal(enhanced.hits[0]?.path, semanticHit.pagePath);
    assert.equal(enhanced.hits[0]?.channels.lexicalRank, undefined);
    assert.equal(enhanced.hits[0]?.channels.semanticRank, 1);
    assert.equal(enhanced.graphResult.stats.seedCount, 1, "semantic candidates must seed graph traversal");
    assert.equal(enhanced.semantic.available, true);
    assert.equal(enhanced.lexicalHits.length, 0, "the exact/BM25 channel remains independently observable");

    const exact = await retrieveWikiHybrid({
      wikiRoot,
      query: "REQ-7421",
      maxResults: 4,
      progressiveWidening: false,
      semanticIndex: injectedIndex([{
        ...semanticHit,
        pagePath: "requirements/WeakIdentifierMention.md",
        text: "REQ-7421 appears in a generic cross-reference without normative evidence.",
      }]),
    });
    assert.equal(exact.hits[0]?.path, "requirements/Exact.md", "semantic RRF must not demote an exact identifier");
    assert.equal(exact.hits[0]?.channels.lexicalRank, 1);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("semantic backend failures degrade safely to lexical retrieval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-semantic-fallback-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);
  try {
    await writePage(wikiRoot, "requirements/Exact.md", "REQ-9000", "Exact identifier REQ-9000.");
    const failing = injectedIndex([]);
    failing.search = async () => { throw new Error("provider offline\nsecret-looking detail"); };
    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "REQ-9000",
      progressiveWidening: false,
      semanticIndex: failing,
    });
    assert.equal(result.hits[0]?.path, "requirements/Exact.md");
    assert.equal(result.semantic.available, false);
    assert.equal(result.semantic.error?.includes("\n"), false);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});
