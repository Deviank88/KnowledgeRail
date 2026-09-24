/** Fixed before/after maintenance workload; synthetic ANN recall is not relevance. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HnswAnnEngine } from "../src/core/semantic/hnsw-engine.js";
import { ExactAnnEngine } from "../src/core/semantic/exact-engine.js";
import { storeVector } from "../src/core/semantic/vector.js";
import type { AnnVectorEntry } from "../src/core/semantic/types.js";

const arg = (name: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const count = Number(arg("count", "10000")), rounds = Number(arg("rounds", "0")), dimensions = 1024;
assert.ok(Number.isInteger(count) && count >= 1000 && count <= 50000);
assert.ok(Number.isInteger(rounds) && rounds >= 0 && rounds <= 100);
const output = arg("output", "benchmarks/results/hnsw-maintenance-292/current-10000.json");
await fs.mkdir(path.dirname(output), { recursive: true });
const file = await fs.open(output, "wx");
const legacy = arg("legacy", "");
const Engine: typeof HnswAnnEngine = legacy ? (await import(pathToFileURL(path.resolve(legacy)).href)).HnswAnnEngine : HnswAnnEngine;
let seed = 292;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 - .5; };
const centers = Array.from({ length: 128 }, () => Array.from({ length: dimensions }, random));
const vector = (cluster: number) => storeVector(centers[cluster % centers.length]!.map((v) => v + random() * .8), dimensions, "i8").vector;
const entries = new Map<string, AnnVectorEntry>(Array.from({ length: count }, (_, i) => {
  const id = `v${i.toString().padStart(6, "0")}`; return [id, { id, vector: vector(i), normalized: true }];
}));
const queries = Array.from({ length: 32 }, (_, i) => centers[(i * 17) % centers.length]!.map((v) => v + random() * .8));
const graph = new Engine({ dimensions, minimumScore: -1 }), exact = new ExactAnnEngine({ dimensions, minimumScore: -1 });
const rows: unknown[] = [];
let pulses = 0, last = performance.now(), maxPauseMs = 0;
const timer = setInterval(() => { const now = performance.now(); maxPauseMs = Math.max(maxPauseMs, now - last); last = now; pulses++; }, 10);
const quality = () => {
  exact.rebuild([...entries.values()]);
  const latency: number[] = []; let matched = 0, distances = 0;
  for (const query of queries) {
    const wanted = new Set(exact.search(query, 32).hits.map((hit) => hit.id));
    const start = performance.now(), actual = graph.search(query, 32); latency.push(performance.now() - start);
    assert.equal(actual.diagnostics.indexMode, "ann");
    for (const hit of actual.hits) { assert.ok(entries.has(hit.id)); if (wanted.has(hit.id)) matched++; }
    distances += actual.diagnostics.distanceComputations ?? 0;
  }
  latency.sort((a, b) => a - b);
  return { recallAt32: matched / (queries.length * 32), queryP50Ms: latency[15], queryP95Ms: latency[30], meanDistances: distances / queries.length };
};
const measure = async (name: string, change: () => void) => {
  maxPauseMs = 0; last = performance.now(); const beforePulses = pulses, start = performance.now();
  change(); await graph.ready(); const milliseconds = performance.now() - start;
  const responsiveness = { pulses: pulses - beforePulses, maxPauseMs };
  const snapshotStart = performance.now(), snapshot = graph.snapshot()!; assert.ok(snapshot);
  const snapshotMs = performance.now() - snapshotStart;
  const restored = new HnswAnnEngine({ dimensions, minimumScore: -1 }), reloadStart = performance.now();
  assert.equal(restored.restoreSnapshot([...entries.values()], snapshot), true);
  const reloadMs = performance.now() - reloadStart;
  for (const query of queries.slice(0, 4)) assert.deepEqual(restored.search(query, 32).hits, graph.search(query, 32).hits);
  restored.dispose();
  const row = { name, milliseconds, ...responsiveness, ...quality(), snapshotMs, graphBytes: snapshot.byteLength, reloadMs,
    maintenance: graph.maintenanceStats, memory: process.memoryUsage() };
  rows.push(row); console.log(JSON.stringify(row));
};
try {
  await measure("initial-build", () => graph.restore([...entries.values()], true));
  await measure("delete-one", () => { const id = graph.search(queries[0]!, 1).hits[0]!.id; entries.delete(id); graph.remove(id); });
  await measure("replace-32", () => {
    for (let i = 100; i < 132; i++) { const id = `v${i.toString().padStart(6, "0")}`, entry = { id, vector: vector(i + 71), normalized: true }; entries.set(id, entry); graph.upsert(entry); }
  });
  await measure("mixed-32", () => {
    for (let i = 200; i < 216; i++) { const id = `v${i.toString().padStart(6, "0")}`; entries.delete(id); graph.remove(id); }
    for (let i = 0; i < 16; i++) { const id = `new-${i}`, entry = { id, vector: vector(i + 91), normalized: true }; entries.set(id, entry); graph.upsert(entry); }
  });
  const churnStart = performance.now();
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < 32; i++) {
      const id = `v${(300 + (round * 32 + i) % (count - 400)).toString().padStart(6, "0")}`;
      const entry = { id, vector: vector(round * 17 + i), normalized: true };
      graph.remove(id); entries.set(id, entry); graph.upsert(entry);
    }
    await graph.ready();
  }
  if (rounds) rows.push({ name: "churn-completed", rounds, mutations: rounds * 32, milliseconds: performance.now() - churnStart, ...quality(), maintenance: graph.maintenanceStats });
  const source = legacy || "src/core/semantic/hnsw-engine.ts";
  await file.writeFile(JSON.stringify({ count, dimensions, seed: 292, cpu: os.cpus()[0]?.model, node: process.version, legacy: !!legacy,
    sourceSha256: createHash("sha256").update(await fs.readFile(source)).digest("hex"), rows,
    limitations: ["Synthetic clustered vectors and held-out noise, not domain relevance.", "Warm local process; times exclude embedding, full MCP and storage journal IO.", "One run per scale/implementation; distributions describe 32 queries, not update latency populations."] }, null, 2));
} finally { clearInterval(timer); graph.dispose(); exact.dispose(); await file.close(); }
