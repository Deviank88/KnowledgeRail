import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pageUtilities, recordUsageDisclosure, recordUsageMaterialization, recordUsageFallback, rerankWithUsage,
  usageStatus, withUsageSession } from "../src/core/usage-ledger.js";
import { wikiPageUri } from "../src/context/resource-uri.js";
import { isMutatingDomainCall } from "../src/http/request-workspace.js";

test("only actual reads in the same session contribute utility; repeated reads do not inflate it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-usage-"));
  try {
    const uri = wikiPageUri("requirements/Billing.md");
    await withUsageSession("a", () => recordUsageDisclosure(root, "Explain billing limits", [uri], false));
    assert.equal((await pageUtilities(root, "billing limits")).size, 0);
    await withUsageSession("b", () => recordUsageMaterialization(root, uri));
    assert.equal((await pageUtilities(root, "billing limits")).size, 0);
    await withUsageSession("a", () => recordUsageMaterialization(root, uri));
    const first = (await pageUtilities(root, "billing limits")).get(uri)!;
    assert.ok(first > 0 && first <= 0.25);
    await withUsageSession("a", () => recordUsageMaterialization(root, uri));
    const status = await usageStatus(root);
    assert.equal(status.materialized, 1);
    const later = (await pageUtilities(root, "billing limits", Date.now() + 90 * 86_400_000)).get(uri)!;
    assert.ok(Math.abs(later / first - 0.5) < 0.001);
    await withUsageSession("a", () => recordUsageFallback(root));
    assert.equal((await pageUtilities(root, "billing limits")).get(uri), 0);
    const bytes = await fs.readFile(path.join(root, ".knowledge-rail/usage-ledger.jsonl"), "utf8");
    assert.equal(bytes.includes("Explain billing limits"), false);
    assert.equal(bytes.includes('"session"'), false);
    assert.equal((await usageStatus(root, true)).events, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("usage reranks only the existing pool, protects exact lexical leaders and caps boosts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-usage-rank-"));
  try {
    const hits = [
      { path: "a.md", title: "Exact leader", score: 0.6, channels: { lexicalRank: 1 } },
      { path: "b.md", title: "Other", score: 0.5 },
      { path: "c.md", title: "Useful", score: 0.49 },
    ];
    const empty = structuredClone(hits);
    await rerankWithUsage(root, "billing limits", empty);
    assert.deepEqual(empty, hits);
    for (let i = 0; i < 8; i++) await withUsageSession("a", async () => {
      await recordUsageDisclosure(root, "billing limits", [wikiPageUri("c.md"), wikiPageUri("unretrieved.md")], false);
      await recordUsageMaterialization(root, wikiPageUri("c.md"));
      await recordUsageMaterialization(root, wikiPageUri("unretrieved.md"));
    });
    await rerankWithUsage(root, "billing limits", hits);
    assert.deepEqual(hits.map((h) => h.path), ["a.md", "c.md", "b.md"]);
    const boost = (hits[1] as typeof hits[number] & { usageBoost: number }).usageBoost;
    assert.equal(boost, 0.15);
    assert.equal(hits.length, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("workspaces isolate observations and suspicious request text is never persisted as terms", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-usage-isolation-"));
  try {
    const a = path.join(root, "a"), b = path.join(root, "b");
    await fs.mkdir(a); await fs.mkdir(b);
    await withUsageSession("shared", async () => {
      await recordUsageDisclosure(a, "api_key=sk-test-secret billing", [wikiPageUri("a.md")], true);
      await recordUsageMaterialization(b, wikiPageUri("a.md"));
    });
    assert.equal((await usageStatus(b)).events, 0);
    const raw = await fs.readFile(path.join(a, ".knowledge-rail/usage-ledger.jsonl"), "utf8");
    assert.equal(raw.includes("sk-test-secret"), false);
    assert.deepEqual(JSON.parse(raw.trim()).terms, []);
    assert.equal(isMutatingDomainCall("knowledge_admin", { action: "usage", options: { action: "reset" } }), true);
    assert.equal(isMutatingDomainCall("knowledge_admin", { action: "usage", options: { action: "status" } }), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit failure removes utility and disabled ranking preserves the original pool", async () => {
  const { recordUsageOutcome } = await import("../src/core/usage-ledger.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-usage-outcome-"));
  const previous = process.env["KNOWLEDGE_RAIL_USAGE_RANKING"];
  try {
    await withUsageSession("outcome", async () => {
      await recordUsageDisclosure(root, "credit policy", [wikiPageUri("c.md")], false);
      await recordUsageMaterialization(root, wikiPageUri("c.md"));
      assert.equal(await recordUsageOutcome(root, "failed"), true);
      assert.equal(await recordUsageOutcome(root, "succeeded"), false);
    });
    assert.equal((await pageUtilities(root, "credit policy")).get(wikiPageUri("c.md")), 0);
    for (let i = 0; i < 8; i++) await withUsageSession("training", async () => {
      await recordUsageDisclosure(root, "credit policy", [wikiPageUri("c.md")], false);
      await recordUsageMaterialization(root, wikiPageUri("c.md"));
    });
    const hits = [{ path: "b.md", title: "Other", score: .5 }, { path: "c.md", title: "Credit", score: .49 }];
    const before = structuredClone(hits); process.env["KNOWLEDGE_RAIL_USAGE_RANKING"] = "0";
    await rerankWithUsage(root, "credit policy", hits); assert.deepEqual(hits, before);
  } finally {
    if (previous === undefined) delete process.env["KNOWLEDGE_RAIL_USAGE_RANKING"]; else process.env["KNOWLEDGE_RAIL_USAGE_RANKING"] = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
