import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExactAnnEngine } from "../src/core/semantic/exact-engine.js";
import { HnswAnnEngine } from "../src/core/semantic/hnsw-engine.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import { PersistentSemanticIndex, semanticIndexFile } from "../src/core/semantic/index.js";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { storeVector } from "../src/core/semantic/vector.js";
import type { AnnEngine, AnnVectorEntry, EmbeddingProvider } from "../src/core/semantic/types.js";

function corpus(count: number, dimensions = 32, seed = 292): AnnVectorEntry[] {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 - 0.5; };
  return Array.from({ length: count }, (_, i) => ({ id: `v-${i.toString().padStart(5, "0")}`, vector: Array.from({ length: dimensions }, random) }));
}

test("exact and HNSW validate vectors, dimensions, limits and cancellation", () => {
  for (const Engine of [ExactAnnEngine, HnswAnnEngine]) {
    const engine = new Engine({ dimensions: 3 });
    assert.throws(() => engine.upsert({ id: "bad", vector: [0, 0, 0] }));
    assert.throws(() => engine.upsert({ id: "bad", vector: [1, 2] }));
    assert.throws(() => engine.search([1, 0, 0], 0));
    assert.throws(() => engine.search([1, 0, 0], 1, { minimumScore: NaN }));
    assert.throws(() => engine.search([1, 0, 0], 1, { signal: AbortSignal.abort() }));
    engine.dispose();
  }
});

test("HNSW repairs coalesced deletions, moved vectors and the entry point without a full rebuild", async () => {
  for (const dtype of ["i8", "f32"] as const) {
    const stored = corpus(800).map((e) => ({ id: e.id, ...storeVector(e.vector, 32, dtype), normalized: true }));
    const current = new Map(stored.map((e) => [e.id, e]));
    const graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1, efSearch: 120 }); graph.rebuild(stored);
    const snapshot = Buffer.from(graph.snapshot()!);
    const entry = [...current.keys()].sort()[snapshot.readUInt32LE(12)]!;
    for (const id of [entry, ...stored.slice(0, 30).map((e) => e.id)]) { graph.remove(id); current.delete(id); }
    const changed = { ...stored[40]!, ...storeVector(corpus(1, 32, 401)[0]!.vector, 32, dtype) };
    current.set(changed.id, changed); graph.upsert(changed);
    const query = [...changed.vector];
    assert.equal(graph.search(query, 10).diagnostics.indexMode, "exact");
    assert.equal(graph.search(query, 10).hits[0]!.id, changed.id);
    assert.equal(graph.snapshot(), undefined, "partial graph cannot be checkpointed");
    await graph.ready();
    assert.equal(graph.maintenanceStats.fullBuilds, 1);
    assert.equal(graph.maintenanceStats.repairBatches, 1);
    assert.ok(graph.maintenanceStats.repairedNodes > 0 && graph.maintenanceStats.repairedNodes < stored.length);
    const exact = new ExactAnnEngine({ dimensions: 32, minimumScore: -1 }); exact.rebuild([...current.values()]);
    let matched = 0;
    for (const e of corpus(30, 32, 831)) {
      const wanted = new Set(exact.search([...e.vector], 10).hits.map((hit) => hit.id));
      const actual = graph.search([...e.vector], 10);
      assert.equal(actual.diagnostics.indexMode, "ann");
      for (const hit of actual.hits) { assert.ok(current.has(hit.id)); if (wanted.has(hit.id)) matched++; }
    }
    assert.ok(matched / 300 >= .95, `${dtype} recall after repair ${matched / 300}`);
    const next = graph.snapshot()!, reloaded = new HnswAnnEngine({ dimensions: 32, minimumScore: -1, efSearch: 120 });
    assert.equal(reloaded.restoreSnapshot([...current.values()], next), true);
    assert.deepEqual(reloaded.search(query, 10).hits, graph.search(query, 10).hits);
    for (const e of current.values()) graph.upsert(e);
    assert.deepEqual(graph.snapshot(), next, "identical upserts must not alter topology");
    for (const id of current.keys()) graph.remove(id);
    await graph.ready(); assert.equal(graph.search(query, 10).hits.length, 0);
    graph.upsert(changed); assert.equal(graph.search(query, 1).hits[0]!.id, changed.id);
    exact.dispose(); graph.dispose(); reloaded.dispose();
  }
});

test("updates arriving during initial construction and repair do not restart completed graph work", async () => {
  const entries = corpus(1800), graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 });
  graph.restore(entries);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const progress = graph.maintenanceStats.insertedNodes; assert.ok(progress > 0 && progress < entries.length);
  graph.remove(entries[0]!.id);
  const changed = { id: entries[1]!.id, vector: corpus(1, 32, 919)[0]!.vector };
  graph.upsert(changed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  graph.remove(entries[2]!.id);
  graph.upsert({ id: "new", vector: changed.vector });
  await graph.ready();
  assert.equal(graph.maintenanceStats.fullBuilds, 1);
  assert.ok(graph.maintenanceStats.insertedNodes <= entries.length + 2, "preserve already built nodes");
  const result = graph.search([...changed.vector], 10);
  assert.equal(result.diagnostics.indexMode, "ann");
  assert.ok(!result.hits.some((hit) => [entries[0]!.id, entries[2]!.id].includes(hit.id)));
  assert.ok(result.hits.some((hit) => hit.id === changed.id));
  assert.ok(graph.snapshot());
  graph.dispose();
});

test("repeated HNSW churn preserves held-out neighbor recall and checkpoint correctness", async () => {
  const entries = corpus(1200), current = new Map(entries.map((entry) => [entry.id, entry]));
  const graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1, efSearch: 120 }); graph.rebuild(entries);
  const exact = new ExactAnnEngine({ dimensions: 32, minimumScore: -1 });
  const queries = corpus(20, 32, 984);
  for (let round = 0; round < 20; round++) {
    const updates = corpus(20, 32, 400 + round);
    for (let i = 0; i < 20; i++) {
      const id = entries[(round * 20 + i) % entries.length]!.id;
      graph.remove(id); const entry = { id, vector: updates[i]!.vector }; graph.upsert(entry); current.set(id, entry);
    }
    await graph.ready(); exact.rebuild([...current.values()]);
    let matched = 0;
    for (const query of queries) {
      const wanted = new Set(exact.search([...query.vector], 10).hits.map((hit) => hit.id));
      matched += graph.search([...query.vector], 10).hits.filter((hit) => wanted.has(hit.id)).length;
    }
    assert.ok(matched / 200 >= .95, `round ${round}: recall ${matched / 200}`);
    assert.equal(graph.maintenanceStats.fullBuilds, 1);
  }
  const restored = new HnswAnnEngine({ dimensions: 32, minimumScore: -1, efSearch: 120 });
  assert.equal(restored.restoreSnapshot([...current.values()], graph.snapshot()!), true);
  for (const query of queries) assert.deepEqual(restored.search([...query.vector], 10).hits, graph.search([...query.vector], 10).hits);
  graph.dispose(); restored.dispose(); exact.dispose();
});

test("repair follows consecutive deleted bridge nodes and cycles without losing the surviving component", async () => {
  const entries = corpus(5, 3), graph = new HnswAnnEngine({ dimensions: 3, minimumScore: -1 }); graph.rebuild(entries);
  // Valid, deliberately sparse level-zero cycle; force a bridge-deletion case
  // independently of the insertion heuristic and random level assignment.
  const source = Buffer.from(graph.snapshot()!), bytes = Buffer.alloc(128 + entries.length * 12);
  source.copy(bytes, 0, 0, 128); bytes.writeUInt32LE(0, 12);
  for (let i = 0; i < entries.length; i++) {
    const offset = 128 + i * 12; bytes.writeUInt32LE(1, offset); bytes.writeUInt32LE(1, offset + 4);
    bytes.writeUInt32LE((i + 1) % entries.length, offset + 8);
  }
  createHash("sha256").update(bytes.subarray(128)).digest().copy(bytes, 80);
  assert.equal(graph.restoreSnapshot(entries, bytes), true);
  for (const i of [0, 1, 2]) graph.remove(entries[i]!.id);
  await graph.ready();
  const actual = graph.search([...entries[3]!.vector], 5);
  assert.equal(actual.diagnostics.indexMode, "ann");
  assert.deepEqual(new Set(actual.hits.map((hit) => hit.id)), new Set(entries.slice(3).map((entry) => entry.id)));
  assert.equal(graph.maintenanceStats.fullBuilds, 1);
  const reloaded = new HnswAnnEngine({ dimensions: 3, minimumScore: -1 });
  assert.equal(reloaded.restoreSnapshot(entries.slice(3), graph.snapshot()!), true);
  graph.dispose(); reloaded.dispose();
});

test("mutations and generation replacement during a partial repair cannot publish stale or dangling links", async (t) => {
  const entries = corpus(300), graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 }); graph.rebuild(entries);
  let clock = 0;
  t.mock.method(performance, "now", () => clock += 2); // deterministic cooperative boundaries
  graph.remove(entries[2]!.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(graph.maintenanceStats.scannedNodes > 0 && graph.maintenanceStats.scannedNodes < entries.length);
  graph.remove(entries[80]!.id);
  const updated = { id: entries[50]!.id, vector: corpus(1, 32, 992)[0]!.vector }; graph.upsert(updated);
  await graph.ready();
  const survivors = entries.filter((e) => ![entries[2]!.id, entries[80]!.id, updated.id].includes(e.id)); survivors.push(updated);
  const next = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 });
  assert.equal(next.restoreSnapshot(survivors, graph.snapshot()!), true);
  assert.equal(graph.search([...updated.vector], 1).hits[0]!.id, updated.id);
  assert.equal(graph.maintenanceStats.fullBuilds, 1); assert.ok(graph.maintenanceStats.repairBatches >= 2);
  graph.remove(updated.id); await new Promise<void>((resolve) => setImmediate(resolve));
  graph.restore(entries); await graph.ready();
  const expected = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 }); expected.rebuild(entries);
  assert.deepEqual(graph.search([...entries[5]!.vector], 10).hits, expected.search([...entries[5]!.vector], 10).hits);
  graph.remove(entries[0]!.id); graph.dispose(); await graph.ready();
  assert.equal(graph.search([...entries[0]!.vector], 10).hits.length, 0);
  next.dispose(); expected.dispose();
});

test("candidate top-k is separate from the score threshold for all engines", async () => {
  for (const engine of [new ExactAnnEngine({ dimensions: 3 }), new HnswAnnEngine({ dimensions: 3 }), new LshAnnEngine({ dimensions: 3, bitsPerTable: 1, probes: 2 })]) {
    engine.rebuild([{ id: "relevant", vector: [0.49, Math.sqrt(1 - 0.49 ** 2), 0] }, { id: "other", vector: [0, 0, 1] }]);
    assert.equal(engine.search([1, 0, 0], 2).hits.length, 0);
    assert.equal(engine.search([1, 0, 0], 2, { minimumScore: -1 }).hits[0]!.id, "relevant");
    engine.dispose();
  }
});

test("HNSW recall is measured against exhaustive cosine, for int8 and float32", async () => {
  for (const dtype of ["i8", "f32"] as const) {
    const entries = corpus(1200), stored = entries.map((e) => ({ id: e.id, ...storeVector(e.vector, 32, dtype), normalized: true }));
    const exact = new ExactAnnEngine({ dimensions: 32, minimumScore: -1 }); exact.rebuild(stored);
    const graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1, m: 12, efSearch: 100 }); graph.rebuild(stored);
    let matched = 0, visited = 0;
    for (const entry of corpus(20)) {
      const query = [...entry.vector], expected = new Set(exact.search(query, 10).hits.map((h) => h.id)), actual = graph.search(query, 10);
      matched += actual.hits.filter((h) => expected.has(h.id)).length; visited += actual.diagnostics.distanceComputations!;
    }
    assert.ok(matched / 200 >= 0.95, `${dtype} recall ${matched / 200}`);
    assert.ok(visited / 20 < entries.length, "graph should visit fewer vectors than exhaustive search");
    exact.dispose(); graph.dispose();
  }
});

test("graph restore is deterministic and queries remain current during rebuild/removal", async () => {
  const entries = corpus(160), graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 }); graph.rebuild(entries);
  const query = [...entries[12]!.vector], expected = graph.search(query, 8).hits;
  graph.restore([...entries].reverse());
  assert.equal(graph.search(query, 8).diagnostics.indexMode, "exact");
  graph.remove(entries[12]!.id);
  graph.upsert({ id: "replacement", vector: query });
  assert.equal(graph.search(query, 8).hits[0]!.id, "replacement");
  await graph.ready();
  assert.ok(!graph.search(query, 8).hits.some((h) => h.id === entries[12]!.id));
  graph.restore(entries); await graph.ready();
  assert.deepEqual(graph.search(query, 8).hits, expected);
  graph.restore([]); await graph.ready(); assert.equal(graph.search(query, 8).hits.length, 0);
  graph.restore(entries); graph.dispose(); await graph.ready();
});

test("switching engines and restarting reuses durable document vectors and candidate policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-engines-"));
  let calls = 0;
  const provider: EmbeddingProvider = { descriptor: { id: "test", model: "vectors", version: "1", dimensions: 3 },
    async embedDocuments(texts) { calls += texts.length; return texts.map(() => [0.49, Math.sqrt(1 - 0.49 ** 2), 0]); }, async embedQuery() { return [1, 0, 0]; } };
  try {
    await fs.writeFile(path.join(root, "page.md"), "---\ntitle: unrelated\ntype: concept\n---\nA canonical passage with no shared words.");
    const records = await getWikiPageRecords(root, true, { persist: false });
    let previous: string[] | undefined;
    for (const engine of [new LshAnnEngine({ dimensions: 3, bitsPerTable: 1, probes: 2 }), new ExactAnnEngine({ dimensions: 3 }), new HnswAnnEngine({ dimensions: 3 }), new HnswAnnEngine({ dimensions: 3 })] as AnnEngine[]) {
      const index = new PersistentSemanticIndex(root, provider, engine, { candidatePolicy: "top-k" });
      try {
        await index.synchronize(records); await engine.ready?.();
        const result = await index.searchWithDiagnostics("question", 8);
        assert.equal(result.hits.length, 1); assert.equal(result.diagnostics.candidatePolicy, "top-k");
        if (previous) assert.deepEqual(result.hits.map((h) => h.pagePath), previous);
        previous = result.hits.map((h) => h.pagePath);
        assert.equal((await index.search("question", 8, { candidatePolicy: "threshold" })).length, 0);
      } finally { index.dispose(); }
    }
    assert.equal(calls, 1);
    const metadata = JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8"));
    assert.equal(metadata.engine.id, "hnsw-cosine"); assert.ok(metadata.graphHash, "switching an existing index must persist the new graph without embedding changed pages");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("HNSW snapshots preserve topology, reject corrupt or mismatched data, and never mutate on rejection", async () => {
  const entries = corpus(1000).map((entry) => ({ id: entry.id, ...storeVector(entry.vector, 32, "i8"), normalized: true }));
  const graph = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 }); graph.rebuild(entries);
  const query = [...entries[8]!.vector], expected = graph.search(query, 32).hits, snapshot = graph.snapshot()!;
  for (let i = 0; i < 5; i++) {
    const restored = new HnswAnnEngine({ dimensions: 32, minimumScore: -1 });
    assert.equal(restored.restoreSnapshot([...entries].reverse(), snapshot), true);
    assert.deepEqual(restored.search(query, 32).hits, expected);
    assert.equal(restored.search(query, 32).diagnostics.graphRestored, true);
    for (const bad of [snapshot.subarray(0, -1), Uint8Array.from(snapshot, (byte, index) => index === 150 ? byte ^ 1 : byte)]) {
      assert.equal(restored.restoreSnapshot(entries, bad), false); assert.deepEqual(restored.search(query, 32).hits, expected);
    }
    const changed = [...entries]; changed[0] = { ...changed[0]!, vector: entries[1]!.vector };
    assert.equal(restored.restoreSnapshot(changed, snapshot), false); restored.dispose();
  }
  const incompatible = new HnswAnnEngine({ dimensions: 32, minimumScore: -1, m: 8 });
  assert.equal(incompatible.restoreSnapshot(entries, snapshot), false); incompatible.dispose(); graph.dispose();
});

test("persistent graph restarts without rebuild, while corruption and unreconciled journal changes reuse vectors safely", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-graph-storage-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  let calls = 0;
  const provider: EmbeddingProvider = { descriptor: { id: "test", model: "graph-storage", version: "1", dimensions: 3 },
    async embedDocuments(texts) { calls += texts.length; return texts.map((text) => text.includes("changed") ? [0, 1, 0] : [1, 0, 0]); }, async embedQuery() { return [1, 0, 0]; } };
  const create = () => { const engine = new HnswAnnEngine({ dimensions: 3 }); return { engine, index: new PersistentSemanticIndex(root, provider, engine) }; };
  const file = path.join(root, "page.md"); await fs.writeFile(file, "---\ntitle: Storage\ntype: concept\n---\nOriginal content.");
  let current = create();
  try {
    await current.index.synchronize(await getWikiPageRecords(root, true, { persist: false }));
    const knowledgeGraph = path.join(path.dirname(semanticIndexFile(root)), "graph.json");
    const knowledgeBytes = '{"fixture":"documented relationships are independent of ANN"}';
    await fs.writeFile(knowledgeGraph, knowledgeBytes);
    const expected = (await current.index.search("query", 8)).map((h) => h.pagePath);
    current.index.dispose(); current = create();
    const restarted = await current.index.searchWithDiagnostics("query", 8);
    assert.deepEqual(restarted.hits.map((h) => h.pagePath), expected); assert.equal(restarted.diagnostics.graphRestored, true); assert.equal(calls, 1);
    const metadata = JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8")); assert.ok(metadata.graphHash);
    await fs.writeFile(path.join(path.dirname(semanticIndexFile(root)), "semantic-graph.bin"), "corrupt graph");
    current.index.dispose(); current = create();
    assert.deepEqual((await current.index.search("query", 8)).map((h) => h.pagePath), expected); assert.equal(calls, 1);
    let checkpoints = 0;
    const checkpoint = current.index.checkpoint.bind(current.index);
    current.index.checkpoint = async (force?: boolean) => { checkpoints++; return checkpoint(force); };
    const records = await getWikiPageRecords(root, true, { persist: false });
    await Promise.all(Array.from({ length: 3 }, () => current.index.startBackground(records)));
    assert.equal(checkpoints, 1, "concurrent readers should coalesce repair persistence");
    await fs.writeFile(file, "---\ntitle: Storage\ntype: concept\n---\nThe policy changed completely.");
    const record = (await getWikiPageRecords(root, true, { persist: false }))[0]!;
    await current.index.upsertPassages(record.path, record.passages); // Journal only; old graph remains on disk.
    current.index.dispose(); current = create();
    const updated = await current.index.searchWithDiagnostics("query", 8);
    assert.equal(updated.hits.length, 0); assert.notEqual(updated.diagnostics.graphRestored, true); assert.equal(calls, 2);
    assert.equal(current.engine.maintenanceStats.fullBuilds, 0, "journal changes reuse the checkpoint graph");
    await current.engine.ready();
    assert.equal(current.engine.maintenanceStats.fullBuilds, 0);
    assert.equal(current.engine.search([0, 1, 0], 8).hits.length, 1, "the replacement vector is searchable after journal repair");
    await current.index.checkpoint(); current.index.dispose(); current = create();
    assert.equal((await current.index.searchWithDiagnostics("query", 8)).diagnostics.graphRestored, true);
    assert.equal(current.engine.maintenanceStats.fullBuilds, 0); assert.equal(calls, 2);
    await current.index.removePage("page.md"); await fs.unlink(file);
    current.index.dispose(); current = create();
    assert.equal((await current.index.search("query", 8)).length, 0);
    await current.engine.ready(); assert.equal(current.engine.maintenanceStats.fullBuilds, 0);
    assert.equal(calls, 2, "journal deletions do not re-embed or rebuild");
    assert.equal(await fs.readFile(knowledgeGraph, "utf8"), knowledgeBytes);
  } finally { current.index.dispose(); }
});

test("disposing an index during graph repair cannot overwrite its durable vectors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-graph-dispose-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "page.md"), "---\ntitle: State\ntype: concept\n---\nDurable state.");
  const records = await getWikiPageRecords(root, true, { persist: false });
  const provider: EmbeddingProvider = { descriptor: { id: "test", model: "dispose", version: "1", dimensions: 3 }, async embedDocuments(texts) { return texts.map(() => [1, 0, 0]); }, async embedQuery() { return [1, 0, 0]; } };
  const baseline = new PersistentSemanticIndex(root, provider, new LshAnnEngine({ dimensions: 3 }));
  await baseline.synchronize(records); baseline.dispose();
  const before = await fs.readFile(semanticIndexFile(root));
  const engine = new HnswAnnEngine({ dimensions: 3 }), index = new PersistentSemanticIndex(root, provider, engine);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  const ready = engine.ready.bind(engine); engine.ready = async () => { entered(); await released; await ready(); };
  const pending = index.startBackground(records); await started; index.dispose(); release();
  await assert.rejects(pending, /abort|disposed/iu);
  assert.deepEqual(await fs.readFile(semanticIndexFile(root)), before);
});
