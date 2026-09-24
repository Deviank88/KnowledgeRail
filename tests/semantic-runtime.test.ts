import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PersistentSemanticIndex, semanticIndexFile, configuredSemanticIndex, clearSemanticIndexes } from "../src/core/semantic/index.js";
import { HnswAnnEngine } from "../src/core/semantic/hnsw-engine.js";
import { SemanticStorage } from "../src/core/semantic/storage.js";
import { readWikiPageRecord } from "../src/core/page-record.js";
import { EmbeddingRequestQueue } from "../src/core/semantic/build-queue.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import type { EmbeddingProvider, SemanticIndex } from "../src/core/semantic/types.js";
import { OpenAiCompatibleEmbeddingProvider } from "../src/core/semantic/provider.js";
import { createServer } from "node:http";

const descriptor = { id: "semantic-runtime-test", model: "correlated-hash", version: "1", dimensions: 8 };
function vector(text: string): number[] {
  const bytes = createHash("sha256").update(text).digest();
  return Array.from({ length: 8 }, (_, i) => i ? (bytes[i]! / 255 - 0.5) * 0.3 : 1);
}
function provider() {
  const counts = { documents: 0, queries: 0, coverage: 0 };
  const instance: EmbeddingProvider = { descriptor,
    async embedDocuments(texts) { counts.documents += texts.length; return texts.map(vector); },
    async embedQuery(text) { counts.queries++; return vector(text); },
    async embedQueries(texts) { counts.coverage += texts.length; return texts.map(vector); },
  };
  return { instance, counts };
}
async function fixture(count = 6) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr292-test-"));
  const records = [];
  for (let i = 0; i < count; i++) {
    const filename = `page-${i}.md`;
    await fs.writeFile(path.join(root, filename), `---\ntitle: Page ${i}\ntype: ${i % 2 ? "concept" : "requirement"}\n---\n# Page ${i}\n\nDurable semantic evidence ${i}.\n\n## Details ${i}\n\nOriginal source fingerprint ${i}.`);
    records.push((await readWikiPageRecord(root, filename))!);
  }
  return { root, records };
}

test("the retired rescoring environment variable cannot invalidate a configured index", async (t) => {
  const keys = Object.keys(process.env).filter((key) => key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_") || key === "KNOWLEDGE_RAIL_SEMANTIC_RESCORE");
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const { root } = await fixture(0);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Empty corpus must not call a provider"); });
  try {
    process.env.KNOWLEDGE_RAIL_EMBEDDING_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.KNOWLEDGE_RAIL_EMBEDDING_MODEL = "test";
    process.env.KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS = "8";
    const index = await configuredSemanticIndex(root);
    assert.ok(index);
    process.env.KNOWLEDGE_RAIL_SEMANTIC_RESCORE = "true";
    assert.equal(await configuredSemanticIndex(root), index);
    assert.equal("rescoring" in index.descriptor, false);
  } finally {
    clearSemanticIndexes();
    for (const key of Object.keys(process.env)) if (key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_") || key === "KNOWLEDGE_RAIL_SEMANTIC_RESCORE") delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retired sidecars do not affect retrieval; compatible vectors and HNSW survive cleanup without embedding", async () => {
  for (const engine of ["lsh", "hnsw"] as const) for (const sidecar of ["missing", "corrupt", "symlink"] as const) {
    const { root, records } = await fixture(2), p = provider();
    const create = () => new PersistentSemanticIndex(root, p.instance,
      engine === "hnsw" ? new HnswAnnEngine({ dimensions: 8 }) : undefined);
    const original = create();
    const sidecarPath = path.join(root, ".knowledge-rail/semantic-originals.bin");
    const target = path.join(root, "unrelated.bin");
    try {
      await original.synchronize(records);
      const expected = (await original.searchWithDiagnostics("evidence", 32)).hits;
      assert.ok(expected.length > 0);
      original.dispose();
      const metadata = JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8"));
      // Retired metadata is additive: vector bytes, hash and graph are unchanged.
      for (const row of metadata.passages) row.original = { generation: "old", offset: 64, hash: "old" };
      await fs.writeFile(semanticIndexFile(root), JSON.stringify(metadata));
      if (sidecar === "corrupt") await fs.writeFile(sidecarPath, "unusable original vectors");
      if (sidecar === "symlink") { await fs.writeFile(target, "keep this file"); await fs.symlink(target, sidecarPath); }
      const before = p.counts.documents, restored = create();
      try {
        const result = await restored.searchWithDiagnostics("evidence", 32);
        assert.deepEqual(result.hits, expected);
        if (engine === "hnsw") assert.equal(result.diagnostics.graphRestored, true);
        if (sidecar !== "missing") assert.ok(await fs.lstat(sidecarPath), "read-only retrieval does not mutate storage");
        await restored.startBackground(records);
        assert.equal(p.counts.documents, before);
        assert.deepEqual((await restored.searchWithDiagnostics("evidence", 32)).hits, expected);
        const cleaned = JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8"));
        assert.ok(cleaned.passages.every((row: object) => !("original" in row)));
        await assert.rejects(fs.lstat(sidecarPath), { code: "ENOENT" });
        if (sidecar === "symlink") assert.equal(await fs.readFile(target, "utf8"), "keep this file");
      } finally { restored.dispose(); }
    } finally { original.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("failed checkpoint leaves retired storage recoverable and retry reuses document embeddings", async (t) => {
  const { root, records } = await fixture(2), p = provider();
  const index = new PersistentSemanticIndex(root, p.instance);
  const sidecarPath = path.join(root, ".knowledge-rail/semantic-originals.bin");
  try {
    await index.synchronize(records);
    const expected = (await index.searchWithDiagnostics("evidence", 32)).hits;
    await fs.writeFile(sidecarPath, "retired data");
    const mock = t.mock.method(SemanticStorage.prototype, "compact", async () => { throw new Error("checkpoint interrupted"); });
    await assert.rejects(index.checkpoint(), /checkpoint interrupted/);
    mock.mock.restore();
    assert.equal(await fs.readFile(sidecarPath, "utf8"), "retired data");
    index.dispose();
    const before = p.counts.documents, next = new PersistentSemanticIndex(root, p.instance);
    try {
      await next.synchronize(records);
      await next.checkpoint();
      assert.equal(p.counts.documents, before);
      assert.deepEqual((await next.searchWithDiagnostics("evidence", 32)).hits, expected);
      await assert.rejects(fs.lstat(sidecarPath), { code: "ENOENT" });
    } finally { next.dispose(); }
  } finally { index.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("canonical edit during query embedding discards stale passages", async () => {
  const { root, records } = await fixture(1), p = provider();
  const index = new PersistentSemanticIndex(root, p.instance);
  try {
    await index.synchronize(records);
    p.instance.embedQuery = async () => {
      await fs.writeFile(path.join(root, records[0]!.path), records[0]!.raw.replace("Durable semantic", "Changed source"));
      return vector("evidence");
    };
    const result = await index.searchWithDiagnostics("evidence", 32);
    assert.equal(result.hits.length, 0);
    assert.ok(result.diagnostics.stalePassages! > 0);
  } finally { index.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("foreground deadline covers search and coverage and returns the exact base ranking", async () => {
  const { root } = await fixture(3);
  const baseline = await retrieveWikiHybrid({ wikiRoot: root, query: "Durable semantic", maxResults: 8 });
  for (const phase of ["priority", "query", "coverage"] as const) {
    let cancelled = false;
    const block = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    });
    const index: SemanticIndex = { descriptor: { provider: descriptor, engine: { id: "test", version: "1", dimensions: 8 }, passageCount: 1, pageCount: 1 },
      async upsertPassages() {}, async removePage() {},
      async prioritize() { if (phase === "priority") await new Promise(() => {}); },
      async search(_query, _k, options) { if (phase === "query") return block(options?.signal); return []; },
      async assessCoverage(_queries, _paths, signal) { return block(signal); },
    };
    const started = performance.now();
    const result = await retrieveWikiHybrid({ wikiRoot: root, query: "Durable semantic", maxResults: 8, semanticIndex: index, semanticBudgetMs: 30 });
    assert.ok(performance.now() - started < 500);
    assert.equal(result.semantic.budgetExceeded, true);
    assert.deepEqual(result.hits.map((h) => h.path), baseline.hits.map((h) => h.path));
    assert.equal(result.coverage.coverageMode, "lexical");
    if (phase !== "priority") assert.equal(cancelled, true);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("queue cancellation bounds pending and uncooperative work; circuit recovers", async () => {
  const queue = new EmbeddingRequestQueue(20, 2);
  let release!: () => void, calls = 0;
  const abort = new AbortController();
  const running = queue.run(() => { calls++; return new Promise<void>((r) => { release = r; }); }, true, abort.signal);
  await new Promise<void>((r) => setImmediate(r)); abort.abort(); await assert.rejects(running);
  const waiting = new AbortController();
  const pending = [queue.run(async () => { calls++; }, true, waiting.signal), queue.run(async () => { calls++; }, true, waiting.signal)];
  await assert.rejects(queue.run(async () => {}), /queue_full/);
  waiting.abort(); await Promise.all(pending.map((p) => assert.rejects(p))); release();
  await new Promise<void>((r) => setImmediate(r)); assert.equal(calls, 1);
  const circuit = new EmbeddingRequestQueue(20);
  for (let i = 0; i < 3; i++) await assert.rejects(circuit.run(async () => { throw new Error("offline"); }));
  await assert.rejects(circuit.run(async () => 1), /circuit_open/);
  await new Promise((r) => setTimeout(r, 25)); assert.equal(await circuit.run(async () => 7), 7);
});

test("HTTP embedding cancellation reaches a stalled local provider and allows recovery", async () => {
  let stalled = true, requests = 0, closed = 0;
  const server = createServer((request, response) => {
    requests++; request.resume(); response.on("close", () => { closed++; });
    if (!stalled) response.end(JSON.stringify({ data: [{ index: 0, embedding: vector("recovered") }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const p = new OpenAiCompatibleEmbeddingProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", dimensions: 8 });
  try {
    await assert.rejects(p.embedQuery("stalled", AbortSignal.timeout(50)));
    stalled = false; assert.equal((await p.embedQuery("recovered")).length, 8);
    await new Promise((r) => setTimeout(r, 10)); assert.ok(closed >= 1); assert.ok(requests >= 1);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test("absent and incomplete provider configuration preserve offline retrieval without network", async (t) => {
  const previous = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("KNOWLEDGE_RAIL_EMBEDDING_")));
  for (const key of Object.keys(previous)) delete process.env[key];
  const { root } = await fixture(2);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network attempt"); });
  try {
    const base = await retrieveWikiHybrid({ wikiRoot: root, query: "Durable semantic" });
    const absent = await retrieveWikiHybrid({ wikiRoot: root, query: "Durable semantic", semanticEnabled: true });
    assert.equal(absent.semantic.error, undefined);
    assert.equal(absent.semantic.available, false);
    assert.deepEqual(absent.hits.map((h) => h.path), base.hits.map((h) => h.path));
    process.env.KNOWLEDGE_RAIL_EMBEDDING_MODEL = "incomplete";
    const incomplete = await retrieveWikiHybrid({ wikiRoot: root, query: "Durable semantic", semanticEnabled: true });
    assert.match(incomplete.semantic.error!, /requires/);
    assert.deepEqual(incomplete.hits.map((h) => h.path), base.hits.map((h) => h.path));
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_")) delete process.env[key];
    Object.assign(process.env, previous); await fs.rm(root, { recursive: true, force: true });
  }
});
