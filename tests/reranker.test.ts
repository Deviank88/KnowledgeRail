import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { HttpRerankProvider, RerankSession, type RerankProvider } from "../src/core/reranker.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";

const descriptor = { id: "test-reranker", model: "deterministic", version: "1" };
test("absent, incomplete or invalid reranker configuration preserves offline knowledge retrieval without network calls", async (t) => {
  const keys = ["KNOWLEDGE_RAIL_RERANK_ENDPOINT", "KNOWLEDGE_RAIL_RERANK_MODEL", "KNOWLEDGE_RAIL_RERANK_VERSION", "KNOWLEDGE_RAIL_RERANK_API_KEY", "KNOWLEDGE_RAIL_RERANK_BUDGET_MS", "KNOWLEDGE_RAIL_RERANK_PROVIDER", "KNOWLEDGE_RAIL_RERANK_BASE_URL"];
  const saved = keys.map((key) => process.env[key]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-rerank-optional-"));
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("Unexpected network request"); });
  try {
    await fs.writeFile(path.join(root, "storage.md"), "---\ntitle: caching storage\ntype: concept\n---\nCaching storage preserves durable knowledge.");
    const request = { wikiRoot: root, query: "caching storage", semanticEnabled: false, progressiveWidening: false, persistDerivedIndexes: false };
    const base = await retrieveWikiHybrid({ ...request, rerankEnabled: false });
    assert.ok(base.hits.length > 0);
    const cases: Array<{ env: Record<string, string>; enabled?: boolean; reason?: string }> = [
      { env: {} },
      { env: { KNOWLEDGE_RAIL_RERANK_BASE_URL: "http://localhost:11434" }, reason: "invalid_configuration" },
      { env: { KNOWLEDGE_RAIL_RERANK_PROVIDER: "ollama" }, reason: "invalid_configuration" },
      { env: {}, enabled: true, reason: "unconfigured" },
      { env: { KNOWLEDGE_RAIL_RERANK_MODEL: "small-local-model" }, reason: "invalid_configuration" },
      { env: { KNOWLEDGE_RAIL_RERANK_ENDPOINT: "http://127.0.0.1:9999/rerank" }, reason: "invalid_configuration" },
      { env: { KNOWLEDGE_RAIL_RERANK_ENDPOINT: "file:///invalid", KNOWLEDGE_RAIL_RERANK_MODEL: "small-local-model" }, reason: "invalid_configuration" },
      { env: { KNOWLEDGE_RAIL_RERANK_ENDPOINT: "http://127.0.0.1:9999/rerank", KNOWLEDGE_RAIL_RERANK_MODEL: "small-local-model", KNOWLEDGE_RAIL_RERANK_BUDGET_MS: "invalid" }, reason: "invalid_configuration" },
      { env: { KNOWLEDGE_RAIL_RERANK_ENDPOINT: "http://127.0.0.1:9999/rerank", KNOWLEDGE_RAIL_RERANK_MODEL: "small-local-model" }, enabled: false },
    ];
    for (const scenario of cases) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, scenario.env);
      const result = await retrieveWikiHybrid({ ...request, rerankEnabled: scenario.enabled });
      assert.deepEqual(result.hits, base.hits);
      assert.deepEqual(result.coverage, base.coverage);
      assert.equal(result.rerank?.reason, scenario.reason);
      assert.equal(result.rerank?.calls ?? 0, 0);
      assert.equal(result.rerank?.applied ?? false, false);
    }
    assert.equal(networkCalls, 0);
  } finally {
    for (const [index, key] of keys.entries()) {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("identical widening pools reuse scores and changed pools share one cumulative deadline", async () => {
  let calls = 0;
  const provider: RerankProvider = { descriptor, async rerank(_query, documents) {
    calls++; if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return documents.map(() => 1);
  } };
  const session = new RerankSession(provider, 40);
  try {
    assert.deepEqual(await session.score("query", ["one"]), [1]);
    assert.deepEqual(await session.score("query", ["one"]), [1]); assert.equal(calls, 1);
    assert.equal(await session.score("query", ["one", "two"]), null);
    assert.equal(session.diagnostics.reason, "budget_exceeded"); assert.equal(session.diagnostics.applied, false);
    assert.equal(session.diagnostics.calls, 2);
  } finally { session.close(); }
});
test("reranking failure, timeout and invalid scores return the original hybrid order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-rerank-"));
  try {
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(root, `page${i}.md`), `---\ntitle: caching ${i}\ntype: concept\n---\nCaching storage provides ${i} durable results.`);
    const request = { wikiRoot: root, query: "caching storage", maxResults: 3, progressiveWidening: false, persistDerivedIndexes: false };
    const base = await retrieveWikiHybrid({ ...request, rerankEnabled: false });
    for (const provider of [
      { descriptor, async rerank() { throw new Error("secret provider failure"); } },
      { descriptor, async rerank() { return [NaN]; } },
      { descriptor, async rerank() { return new Promise<readonly number[]>(() => undefined); } },
    ]) {
      const started = performance.now();
      const result = await retrieveWikiHybrid({ ...request, reranker: provider, rerankBudgetMs: 30 });
      assert.deepEqual(result.hits.map((h) => h.path), base.hits.map((h) => h.path));
      assert.deepEqual(result.coverage, base.coverage);
      assert.ok(performance.now() - started < 500);
      assert.ok(result.rerank?.reason); assert.ok(!JSON.stringify(result).includes("secret provider failure"));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reranker sees the larger hybrid pool, stays within output budget and preserves identifiers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-rerank-pool-"));
  try {
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(root, `page${i}.md`), `---\ntitle: caching ${i}\ntype: concept\n---\nCaching storage ${i === 0 ? "KR-292" : ""} uses ${i === 4 ? "preferred" : "ordinary"} storage.`);
    const request = { wikiRoot: root, query: "caching storage", maxResults: 2, progressiveWidening: false, persistDerivedIndexes: false };
    let seen = 0;
    const reranker: RerankProvider = { descriptor, async rerank(_query, documents) { seen = documents.length; return documents.map((d) => d.includes("preferred") ? 1 : 0); } };
    const result = await retrieveWikiHybrid({ ...request, reranker });
    assert.ok(seen > 2); assert.equal(result.hits.length, 2); assert.equal(result.hits[0]!.path, "page4.md");
    const anchor = await retrieveWikiHybrid({ ...request, query: "KR-292 caching storage", reranker });
    assert.equal(anchor.hits[0]!.path, "page0.md");
    const filtered = await retrieveWikiHybrid({ ...request, pageTypes: ["decision"], reranker });
    assert.equal(filtered.hits.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("canonical edits during reranking discard obsolete candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-rerank-edit-"));
  try {
    const file = path.join(root, "page.md"); await fs.writeFile(file, "---\ntitle: caching\ntype: concept\n---\nCaching durable storage.");
    const reranker: RerankProvider = { descriptor, async rerank(_query, documents) { await fs.writeFile(file, "Deleted content replaced."); return documents.map(() => 1); } };
    const result = await retrieveWikiHybrid({ wikiRoot: root, query: "caching storage", reranker, progressiveWidening: false, persistDerivedIndexes: false });
    assert.equal(result.hits.length, 0); assert.equal(result.rerank?.reason, "stale_candidates");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("shared provider queue does not leak uncooperative cancelled requests", async () => {
  let calls = 0, release!: (value: readonly number[]) => void;
  const provider: RerankProvider = { descriptor, async rerank() { calls++; return new Promise((resolve) => { release = resolve; }); } };
  const a = new RerankSession(provider, 15), b = new RerankSession(provider, 15);
  assert.equal(await a.score("query", ["doc"]), null);
  assert.equal(await b.score("query", ["doc"]), null);
  assert.equal(calls, 1); release([1]); a.close(); b.close();
});

test("HTTP reranker validates indexed results and propagates cancellation", async () => {
  let mode = "valid";
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume request before replying. */ }
    if (mode === "slow") return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: mode === "valid" ? [{ index: 1, relevance_score: 3 }, { index: 0, relevance_score: -1 }] : [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 2 }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const provider = new HttpRerankProvider({ endpoint: `http://127.0.0.1:${address.port}/rerank`, model: "test" });
    assert.deepEqual(await provider.rerank("query", ["one", "two"], AbortSignal.timeout(1000)), [-1, 3]);
    mode = "invalid"; await assert.rejects(provider.rerank("query", ["one", "two"], AbortSignal.timeout(1000)));
    mode = "slow"; await assert.rejects(provider.rerank("query", ["one", "two"], AbortSignal.timeout(20)));
    mode = "valid"; assert.deepEqual(await provider.rerank("query", ["one", "two"], AbortSignal.timeout(1000)), [-1, 3]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
