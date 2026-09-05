import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import { mapConcurrent } from "../src/core/concurrent-map.js";
import { resolveRealWithin } from "../src/core/paths.js";

const arg = (key: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const scales = arg("scales", "100,10000,100000").split(",").map(Number);
const iterations = Number(arg("iterations", "10"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-reconcile-bench-"));
const results = [];
try {
  await fs.mkdir(path.join(root, "concepts"));
  let created = 0;
  for (const pages of scales) {
    await mapConcurrent(Array.from({ length: pages - created }, (_, i) => i + created), 32, async (i) => {
      await fs.writeFile(path.join(root, `concepts/Page${i}.md`), `# Page ${i}\nEvidence ${i}.`);
    });
    created = pages;
    const paths = Array.from({ length: pages }, (_, i) => `concepts/Page${i}.md`);
    for (const concurrency of [0, 8, 16, 32, 64]) {
      global.gc?.();
      const baseline = process.memoryUsage();
      let peakHeap = baseline.heapUsed, peakRss = baseline.rss, active = 0, peakActive = 0;
      const sampler = setInterval(() => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 5);
      const samples: number[] = [];
      for (let iteration = 0; iteration < iterations; iteration++) {
        const operation = async (rel: string) => {
          active++; peakActive = Math.max(peakActive, active);
          try { return (await fs.stat(await resolveRealWithin(root, rel))).size; }
          finally { active--; }
        };
        const start = performance.now();
        const result = concurrency ? await mapConcurrent(paths, concurrency, operation) : await Promise.all(paths.map(operation));
        samples.push(performance.now() - start);
        assert.equal(result.length, pages);
        assert.ok(result.every((size) => size > 0));
      }
      clearInterval(sampler);
      global.gc?.();
      samples.sort((a, b) => a - b);
      results.push({ pages, concurrency: concurrency || "unbounded", samples: iterations, p50Ms: samples[Math.ceil(iterations * .5) - 1], p95Ms: samples[Math.ceil(iterations * .95) - 1], baseline, after: process.memoryUsage(), peakHeap, peakRss, peakActive });
      console.error(`${pages} pages, ${concurrency || "unbounded"}: ${samples[Math.ceil(iterations * .5) - 1]} ms`);
    }
  }
  const report = { node: process.version, gcExposed: Boolean(global.gc), results };
  await fs.writeFile(arg("json", "benchmarks/results/274-reconcile.json"), JSON.stringify(report, null, 2) + "\n");
} finally { await fs.rm(root, { recursive: true, force: true }); }
