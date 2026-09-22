import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { rerankWithUsage, recordUsageDisclosure, recordUsageMaterialization, recordUsageFallback, withUsageSession } from "../src/core/usage-ledger.js";
import { wikiPageUri } from "../src/context/resource-uri.js";

const stories = [
  { train: "billing credit policy", evaluation: "credit policy limits" },
  { train: "gestione limite credito", evaluation: "limite credito fatture" },
  { train: "booking cancellation policy", evaluation: "booking cancellation departure" },
  { train: "gestione annullamento prenotazioni", evaluation: "annullamento prenotazioni partenza" },
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-usage-eval-"));
const reports = [];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  for (const [i, story] of stories.entries()) {
    const wiki = path.join(root, String(i)); await fs.mkdir(wiki);
    const pool = [
      { path: "requirements/Exact.md", title: "Exact identifier", score: .6, channels: { lexicalRank: 1 } },
      { path: "requirements/Adjacent.md", title: "Adjacent evidence", score: .5 },
      { path: "requirements/Relevant.md", title: "Relevant evidence", score: .49 },
    ];
    const expected = new Set([pool[0]!.path, pool[2]!.path]);
    const quality = (hits: typeof pool) => hits.slice(0, 2).filter((hit) => expected.has(hit.path)).length / 2;
    const empty = structuredClone(pool); await rerankWithUsage(wiki, story.evaluation, empty);
    assert.equal(digest(empty), digest(pool));
    const observe = async (fallback: boolean) => withUsageSession("fixture", async () => {
      await recordUsageDisclosure(wiki, story.train, [wikiPageUri(pool[2]!.path), wikiPageUri("outside-pool.md")], false);
      await recordUsageMaterialization(wiki, wikiPageUri(pool[2]!.path));
      await recordUsageMaterialization(wiki, wikiPageUri("outside-pool.md"));
      if (fallback) await recordUsageFallback(wiki);
    });
    for (let n = 0; n < 8; n++) await observe(false);
    const enabled = structuredClone(pool), start = performance.now(); await rerankWithUsage(wiki, story.evaluation, enabled);
    const elapsedMs = performance.now() - start;
    assert.deepEqual(new Set(enabled.map((hit) => hit.path)), new Set(pool.map((hit) => hit.path)));
    assert.equal(enabled[0]!.path, pool[0]!.path);
    for (let n = 0; n < 5; n++) await observe(true);
    const penalized = structuredClone(pool); await rerankWithUsage(wiki, story.evaluation, penalized);
    assert.equal(digest(penalized), digest(pool));
    reports.push({ ...story, emptyLedgerIdentical: true, baselineRecallAt2: quality(pool), baselinePrecisionAt2: quality(pool),
      enabledRecallAt2: quality(enabled), enabledPrecisionAt2: quality(enabled), rewardTrapRestoresBaseline: true, samePool: true, elapsedMs });
  }
  console.log(JSON.stringify({ stories: reports, scope: "Production utility reranker over controlled fixed candidate pools, authored disjoint training/evaluation phrases and explicit simulated materializations. Not end-to-end retrieval or real user traffic." }));
} finally { await fs.rm(root, { recursive: true, force: true }); }
