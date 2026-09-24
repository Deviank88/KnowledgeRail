import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ExactAnnEngine } from "../src/core/semantic/exact-engine.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import { HnswAnnEngine } from "../src/core/semantic/hnsw-engine.js";
import { storeVector } from "../src/core/semantic/vector.js";
import type { AnnEngine } from "../src/core/semantic/types.js";

const arg = (name: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const count = Number(arg("count", "1000")), kind = arg("engine", "lsh"), dimensions = 1024;
const output = arg("output", "benchmarks/results/retrieval-extension-292");
let state = 292;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 - .5; };
const centers = Array.from({ length: 128 }, () => Array.from({ length: dimensions }, random));
const entries = Array.from({ length: count }, (_, i) => ({ id: `v${i.toString().padStart(6, "0")}`,
  ...storeVector(centers[i % centers.length]!.map((v) => v + random() * .8), dimensions, "i8"), normalized: true }));
const queries = Array.from({ length: 32 }, (_, i) => centers[(i * 17) % centers.length]!.map((v) => v + random() * .8));
const exact = new ExactAnnEngine({ dimensions, minimumScore: -1 }); exact.rebuild(entries);
const expected = queries.map((q) => new Set(exact.search(q, 32).hits.map((h) => h.id))); exact.dispose();
global.gc?.(); const before = process.memoryUsage();
const engine: AnnEngine = kind === "exact" ? new ExactAnnEngine({ dimensions, minimumScore: -1 }) : kind === "hnsw" ? new HnswAnnEngine({ dimensions, minimumScore: -1 }) : new LshAnnEngine({ dimensions, minimumScore: -1, probes: kind === "lsh8" ? 8 : 4 });
let heartbeat = 0; const timer = setInterval(() => heartbeat++, 10);
const start = performance.now(); engine.restore!(entries, true); await engine.ready?.(); const buildMs = performance.now() - start;
global.gc?.(); const built = process.memoryUsage();
const latency: number[] = [], recalls: number[] = [], visited: number[] = [];
for (let repetition = 0; repetition < 3; repetition++) for (const [i, query] of queries.entries()) {
  const begin = performance.now(), result = engine.search(query, 32); latency.push(performance.now() - begin);
  if (!repetition) { recalls.push(result.hits.filter((h) => expected[i]!.has(h.id)).length / 32); visited.push(result.diagnostics.distanceComputations ?? result.diagnostics.candidateCount); }
}
const restart = performance.now(); engine.restore!(entries, true);
const during = engine.search(queries[0]!, 32); await engine.ready?.(); const restoreMs = performance.now() - restart;
const restored = engine.search(queries[0]!, 32);
const preDelete = engine.search(queries[1]!, 32).hits[0]?.id;
const updateStart = performance.now(); if (preDelete) engine.remove(preDelete); await engine.ready?.();
const updateMs = performance.now() - updateStart;
if (preDelete && engine.search(queries[1]!, 32).hits.some((h) => h.id === preDelete)) throw new Error("Deleted vector returned after rebuild");
clearInterval(timer); latency.sort((a, b) => a - b);
const report = { count, kind, dimensions, dtype: "i8", corpus: "seed292, 128 synthetic clusters, separate query noise; not domain relevance", cpu: os.cpus()[0]?.model, node: process.version,
  descriptor: engine.descriptor, buildMs, restoreMs, removalMs: updateMs, heartbeat,
  p50Ms: latency[Math.ceil(latency.length * .5) - 1], p95Ms: latency[Math.ceil(latency.length * .95) - 1],
  recallAt32: recalls.reduce((a, b) => a + b, 0) / recalls.length, distanceComputations: visited.reduce((a, b) => a + b, 0) / visited.length,
  memoryBefore: before, memoryAfterBuild: built, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  restoreQueryMode: during.diagnostics.indexMode, restoredQueryMode: restored.diagnostics.indexMode };
await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, `scale-${count}-${kind}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); engine.dispose?.();
