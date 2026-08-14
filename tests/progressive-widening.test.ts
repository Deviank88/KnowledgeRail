import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { readWikiPageRecord } from "../src/core/page-record.js";
import { clearRetrievalIndexes, type RetrievalHit } from "../src/core/retrieval-index.js";

async function writePage(
  wikiRoot: string,
  relPath: string,
  params: {
    title: string;
    type: string;
    body: string;
    requestId?: string;
    tags?: string[];
    sources?: string[];
  }
): Promise<void> {
  const file = path.join(wikiRoot, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    `title: ${JSON.stringify(params.title)}`,
    `type: ${params.type}`,
    `tags: [${(params.tags ?? []).map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `sources: [${(params.sources ?? []).map((source) => JSON.stringify(source)).join(", ")}]`,
    ...(params.requestId ? [`request_id: ${JSON.stringify(params.requestId)}`] : []),
    "created: 2026-08-13",
    "updated: 2026-08-13",
    "---",
    "",
    params.body,
  ].join("\n"), "utf8");
}

async function withWiki(
  prefix: string,
  run: (wikiRoot: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);
  try {
    await run(wikiRoot);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("easy exact retrieval remains at W0", async () => {
  await withWiki("knowledge-rail-widen-easy-", async (wikiRoot) => {
    await writePage(wikiRoot, "requirements/Exact.md", {
      title: "REQ-808 exact quota",
      type: "requirement",
      body: "# Quota\n\nREQ-808 permits exactly 75 signed operations per minute.",
      sources: ["specs/req-808.md"],
    });

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "REQ-808 75 signed operations per minute",
      maxResults: 6,
      initialBudget: {
        maxSeedCandidates: 1,
        maxVisitedNodes: 6,
        maxDepth: 0,
        maxEvidence: 2,
        tokenBudget: 500,
      },
      maximumBudget: {
        maxSeedCandidates: 6,
        maxVisitedNodes: 30,
        maxDepth: 3,
        maxEvidence: 6,
        tokenBudget: 1_500,
      },
    });

    assert.equal(result.wideningLevel, 0);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.coverage.sufficient, true);
    assert.equal(result.hits[0]?.path, "requirements/Exact.md");
  });
});

test("a truncated two-hop frontier widens deterministically and recovers required evidence", async () => {
  await withWiki("knowledge-rail-widen-hop-", async (wikiRoot) => {
    await writePage(wikiRoot, "concepts/Seed.md", {
      title: "Quartz entry point",
      type: "concept",
      body: "# Entry\n\nQuartz recovery begins here. See [[Bridge.md]].",
    });
    await writePage(wikiRoot, "concepts/Bridge.md", {
      title: "Relay bridge",
      type: "concept",
      body: "# Relay\n\nThe relay delegates to [[Target.md]].",
    });
    await writePage(wikiRoot, "concepts/Target.md", {
      title: "Epoch publication decision",
      type: "decision",
      body: "# Decision\n\nPublication waits until the epoch lease is validated.",
    });
    for (let index = 0; index < 80; index++) {
      await writePage(wikiRoot, `noise/Noise_${index}.md`, {
        title: `Unrelated note ${index}`,
        type: "analysis",
        body: `# Note\n\nUnrelated warehouse telemetry ${index}.`,
      });
    }

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "Quartz recovery entry point",
      maxResults: 8,
      lexicalPoolSize: 8,
      initialBudget: {
        maxSeedCandidates: 1,
        maxVisitedNodes: 8,
        maxDepth: 0,
        maxEvidence: 3,
        tokenBudget: 600,
      },
      maximumBudget: {
        maxSeedCandidates: 8,
        maxVisitedNodes: 32,
        maxDepth: 3,
        maxEvidence: 8,
        tokenBudget: 1_600,
      },
      coverageRequirements: { requiredPageTypes: ["decision"] },
    });

    assert.equal(result.wideningLevel >= 1, true);
    assert.equal(result.hits.some((hit) => hit.path === "concepts/Target.md"), true);
    assert.equal(result.coverage.sufficient, true);
    assert.equal(result.attempts[0]?.coverage.truncatedFrontierCount, 1);
    for (const attempt of result.attempts) {
      assert.equal(attempt.visitedNodes <= attempt.budget.maxVisitedNodes, true);
      assert.equal(attempt.visitedNodes < result.graphResult.graph.nodes.length, true);
    }
  });
});

test("W3 invokes an explicit fallback only after W0-W2 remain insufficient", async () => {
  await withWiki("knowledge-rail-widen-fallback-", async (wikiRoot) => {
    await writePage(wikiRoot, "requirements/Seed.md", {
      title: "Zephyr lookup requirement",
      type: "requirement",
      body: "# Requirement\n\nZephyr lookup must remain deterministic.",
    });
    await writePage(wikiRoot, "decisions/Fallback.md", {
      title: "Canonical routing choice",
      type: "decision",
      body: "# Decision\n\nThe canonical key is selected before dispatch.",
    });
    let fallbackCalls = 0;

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "Zephyr deterministic lookup",
      maxResults: 6,
      initialBudget: {
        maxSeedCandidates: 1,
        maxVisitedNodes: 4,
        maxDepth: 0,
        maxEvidence: 2,
        tokenBudget: 500,
      },
      maximumBudget: {
        maxSeedCandidates: 4,
        maxVisitedNodes: 16,
        maxDepth: 2,
        maxEvidence: 6,
        tokenBudget: 1_200,
      },
      coverageRequirements: { requiredPageTypes: ["decision"] },
      fallbackProvider: async (): Promise<RetrievalHit[]> => {
        fallbackCalls++;
        const record = await readWikiPageRecord(wikiRoot, "decisions/Fallback.md");
        assert.ok(record);
        const passage = record.passages[0];
        return [{
          path: record.path,
          title: record.title,
          type: record.type,
          tags: record.tags,
          sources: record.sources,
          requestId: record.requestId,
          score: 100,
          heading: passage?.heading ?? "",
          excerpt: passage?.text ?? "",
          record,
        }];
      },
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(result.wideningLevel, 3);
    assert.equal(result.attempts.slice(0, 3).every((attempt) => !attempt.fallbackUsed), true);
    assert.equal(result.attempts[3]?.fallbackUsed, true);
    assert.equal(result.hits.some((hit) => hit.path === "decisions/Fallback.md"), true);
    assert.equal(result.coverage.sufficient, true);
  });
});

test("retrieval stops at W2 when no source/code fallback is configured", async () => {
  await withWiki("knowledge-rail-widen-no-fallback-", async (wikiRoot) => {
    await writePage(wikiRoot, "requirements/Seed.md", {
      title: "Zephyr lookup requirement",
      type: "requirement",
      body: "# Requirement\n\nZephyr lookup must remain deterministic.",
    });

    const result = await retrieveWikiHybrid({
      wikiRoot,
      query: "Zephyr deterministic lookup",
      maxResults: 4,
      initialBudget: {
        maxSeedCandidates: 1,
        maxVisitedNodes: 4,
        maxDepth: 0,
        maxEvidence: 2,
        tokenBudget: 500,
      },
      maximumBudget: {
        maxSeedCandidates: 4,
        maxVisitedNodes: 16,
        maxDepth: 2,
        maxEvidence: 4,
        tokenBudget: 1_200,
      },
      coverageRequirements: { requiredPageTypes: ["decision"] },
    });

    assert.equal(result.wideningLevel, 2);
    assert.equal(result.attempts.length, 3);
    assert.equal(result.coverage.sufficient, false);
    assert.equal(result.attempts.every((attempt) => !attempt.fallbackUsed), true);
  });
});
