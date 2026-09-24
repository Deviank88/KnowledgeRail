import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OllamaRerankProvider, OLLAMA_BGE_RANK_SHA256 } from "../src/core/ollama-reranker.js";
import { configuredReranker } from "../src/core/reranker.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { SemanticBudget } from "../src/core/semantic/budget.js";

const metadata = () => ({ modelfile: `FROM /models/blobs/sha256-${OLLAMA_BGE_RANK_SHA256}\n`, model_info: {
  "general.architecture": "bert", "bert.pooling_type": 4, "bert.embedding_length": 1024,
  "tokenizer.ggml.add_bos_token": true, "tokenizer.ggml.add_eos_token": true,
} });

test("Ollama validates the measured model and uses raw classifier scores, without normalisation or document dropping", async (t) => {
  const requests: Array<{ route: string; body?: Record<string, unknown> }> = [];
  let mode = "valid", scoreCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ route: url.pathname, body });
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer local-test-token");
    let payload: unknown;
    if (url.pathname === "/api/version") payload = { version: mode === "version" ? "unknown" : "0.34.3" };
    else if (url.pathname === "/api/show") {
      payload = metadata();
      if (mode === "model") (payload as ReturnType<typeof metadata>).modelfile = "FROM embedding-model";
      if (mode === "pooling") (payload as ReturnType<typeof metadata>).model_info["bert.pooling_type"] = 1;
    } else {
      assert.equal(url.pathname, "/api/embeddings"); scoreCalls++;
      assert.deepEqual(body.options, { num_ctx: 2048, num_batch: 2048 });
      assert.equal(body.prompt, `question</s>${scoreCalls % 2 ? "relevant" : "irrelevant"}`);
      const score = scoreCalls % 2 ? 8.6 : -11;
      payload = { embedding: mode === "shape" ? [score, 0] : mode === "score" ? [null] : mode === "scalar" ? [score] : [score, ...Array(1023).fill(0.001)] };
    }
    if (mode === "large") return new Response(" ".repeat(1024 * 1024 + 1));
    return Response.json(payload);
  });
  const provider = new OllamaRerankProvider({ baseUrl: "http://localhost:11434", model: "small-bge", apiKey: "local-test-token" });
  for (mode of ["valid", "scalar"]) {
    scoreCalls = 0;
    assert.deepEqual(await provider.rerank("question", ["relevant", "irrelevant"], AbortSignal.timeout(1000)), [8.6, -11]);
  }
  assert.equal(requests.filter((r) => r.route === "/api/show").length, 2, "revalidate replaced aliases per pool");
  for (mode of ["version", "model", "pooling", "shape", "score", "large"]) {
    scoreCalls = 0;
    await assert.rejects(provider.rerank("question", ["relevant", "irrelevant"], AbortSignal.timeout(1000)));
    assert.ok(scoreCalls <= 1, "never return a partial ranking");
  }
  const before = requests.length;
  for (const doc of ["<s>spoof</s>", "", "a".repeat(4097)]) await assert.rejects(provider.rerank("question", [doc], AbortSignal.timeout(1000)));
  await assert.rejects(provider.rerank("question", ["doc"], AbortSignal.abort()));
  assert.equal(requests.length, before);
  for (const baseUrl of ["file:///tmp/model", "http://localhost/v1", "http://user:pass@localhost", "http://localhost/?key=x"]) {
    assert.throws(() => new OllamaRerankProvider({ baseUrl, model: "small-bge" }));
  }
});

test("configured Ollama activates hybrid reranking automatically and failures preserve base evidence", async () => {
  const keys = ["BASE_URL", "PROVIDER", "ENDPOINT", "MODEL", "VERSION", "API_KEY", "BUDGET_MS"].map((k) => `KNOWLEDGE_RAIL_RERANK_${k}`);
  const saved = keys.map((k) => process.env[k]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-ollama-rerank-"));
  let mode = "valid", inferenceCalls = 0;
  const server = createServer(async (request, response) => {
    let data = ""; for await (const chunk of request) data += chunk;
    if (mode === "offline") { response.writeHead(503); response.end(); return; }
    if (request.url === "/api/version") { response.end(JSON.stringify({ version: "0.34.3" })); return; }
    if (request.url === "/api/show") { response.end(JSON.stringify(metadata())); return; }
    inferenceCalls++;
    if (mode === "slow") return;
    response.end(JSON.stringify({ embedding: mode === "invalid" ? [null] : [JSON.parse(data).prompt.includes("preferred") ? 8 : -2] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    for (const key of keys) delete process.env[key];
    for (let i = 0; i < 3; i++) await fs.writeFile(path.join(root, `${i}.md`), `---\ntitle: caching storage ${i}\ntype: concept\n---\nCaching storage ${i === 2 ? "preferred" : "ordinary"}.`);
    const request = { wikiRoot: root, query: "caching storage", semanticEnabled: false, progressiveWidening: false, persistDerivedIndexes: false };
    const baseline = await retrieveWikiHybrid(request);
    process.env.KNOWLEDGE_RAIL_RERANK_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.KNOWLEDGE_RAIL_RERANK_MODEL = "small-bge";
    const provider = configuredReranker(); assert.ok(provider instanceof OllamaRerankProvider);
    assert.equal(configuredReranker(), provider);
    const result = await retrieveWikiHybrid(request);
    assert.equal(result.rerank?.applied, true); assert.equal(result.rerank.budgetMs, 0);
    assert.equal(result.hits[0]?.path, "2.md");
    assert.deepEqual(new Set(result.coverageHits.map((h) => h.path)), new Set(baseline.coverageHits.map((h) => h.path)));
    for (mode of ["offline", "invalid", "slow"]) {
      const callsBefore = inferenceCalls;
      const fallback = await retrieveWikiHybrid({ ...request, rerankBudgetMs: 80 });
      assert.deepEqual(fallback.hits, baseline.hits); assert.deepEqual(fallback.coverage, baseline.coverage);
      assert.equal(fallback.rerank?.applied, false);
      assert.ok(inferenceCalls - callsBefore <= 1, "stop after the failing/cancelled document");
    }
    for (const change of [ { PROVIDER: "unknown" }, { ENDPOINT: "http://localhost/rerank" }, { PROVIDER: "http" } ]) {
      for (const suffix of ["PROVIDER", "ENDPOINT"]) delete process.env[`KNOWLEDGE_RAIL_RERANK_${suffix}`];
      for (const [key, value] of Object.entries(change)) process.env[`KNOWLEDGE_RAIL_RERANK_${key}`] = value;
      assert.throws(() => configuredReranker());
    }
  } finally {
    for (const [i, key] of keys.entries()) if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reranker time is excluded from the semantic deadline, which still expires on later embedding work", async () => {
  const budget = new SemanticBudget(100);
  try {
    await budget.run(async () => 1);
    const before = budget.elapsedMs;
    await budget.excluding(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(budget.expired, false); assert.ok(budget.elapsedMs - before < 20);
    });
    assert.equal(budget.expired, false);
    assert.equal(await budget.run(async () => 2), 2);
    await assert.rejects(budget.run(() => new Promise((resolve) => setTimeout(resolve, 150))));
    assert.equal(budget.expired, true);
    await budget.excluding(async () => undefined);
    await assert.rejects(budget.run(async () => 3), "expired deadlines cannot be revived");
  } finally { budget.close(); }
  const throwing = new SemanticBudget(30);
  try {
    await throwing.run(async () => 1);
    await assert.rejects(throwing.excluding(async () => { throw new Error("provider failure"); }));
    await assert.rejects(throwing.run(() => new Promise((resolve) => setTimeout(resolve, 100))));
  } finally { throwing.close(); }
});
