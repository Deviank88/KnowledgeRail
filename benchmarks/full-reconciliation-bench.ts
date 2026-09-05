import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { mapConcurrent } from "../src/core/concurrent-map.js";
const arg = (key: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const runtimes = arg("runtimes", ".").split(",");
const scales = arg("scales", "1000,10000,100000").split(",").map(Number);
const iterations = Number(arg("iterations", "10"));
// Compare implementations in separate processes so prior heaps and allocator
// high-water marks cannot inflate the next implementation's memory readings.
if (runtimes.length > 1) {
  const outputs = await fs.mkdtemp(path.join(os.tmpdir(), "kr-reconcile-processes-"));
  const combined = [];
  try {
    for (const [ordinal, runtimeRoot] of runtimes.entries()) {
      const output = path.join(outputs, `${ordinal}.json`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), `--runtimes=${runtimeRoot}`, `--scales=${scales.join(",")}`, `--iterations=${iterations}`, `--json=${output}`], { stdio: ["ignore", "ignore", "inherit"] });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Reconciliation child exited ${code}`)));
      });
      const report = JSON.parse(await fs.readFile(output, "utf8"));
      combined.push(...report.results.map((result: Record<string, unknown>) => ({ ...result, runtime: ordinal })));
    }
    await fs.writeFile(arg("json", "benchmarks/results/274-full-reconcile.json"), JSON.stringify({ node: process.version, gcExposed: true, isolatedProcesses: true, results: combined }, null, 2) + "\n");
  } finally { await fs.rm(outputs, { recursive: true, force: true }); }
  process.exit(0);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-full-reconcile-"));
const results = [];
try {
  await fs.mkdir(path.join(root, "concepts"));
  let created = 0;
  for (const pages of scales) {
    await mapConcurrent(Array.from({ length: pages - created }, (_, i) => i + created), 64, async (i) => {
      await fs.writeFile(path.join(root, `concepts/Page${i}.md`), `---\ntitle: Page${i}\ntype: concept\nsources: []\n---\n# Evidence\ninvoice payment evidence${i}\n`);
    });
    created = pages;
    for (const [ordinal, runtimeRoot] of runtimes.entries()) {
      const runtime = await import(pathToFileURL(path.resolve(runtimeRoot, "src/core/retrieval-index.ts")).href) as typeof import("../src/core/retrieval-index.js");
      runtime.clearRetrievalIndexes();
      global.gc?.();
      const memoryBeforeCold = process.memoryUsage();
      let peakHeap = memoryBeforeCold.heapUsed, peakRss = memoryBeforeCold.rss;
      const timer = setInterval(() => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 5);
      try {
        const coldStart = performance.now();
        await runtime.refreshRetrievalIndex(root, { persist: false });
        const coldMs = performance.now() - coldStart;
        global.gc?.();
        const warmMemory = process.memoryUsage();
        const samples: number[] = [];
        for (let i = 0; i < iterations; i++) {
          const start = performance.now();
          const state = await runtime.refreshRetrievalIndex(root, { force: true, persist: false });
          samples.push(performance.now() - start);
          assert.equal(state.records.size, pages);
          assert.equal(state.reusedRecords, pages);
          assert.equal(state.changedRecords, 0);
        }
        runtime.clearRetrievalIndexes();
        await new Promise<void>((resolve) => setImmediate(resolve));
        global.gc?.();
        samples.sort((a, b) => a - b);
        results.push({ pages, runtime: ordinal, samples: iterations, coldMs, memoryBeforeCold, warmMemory, releasedMemory: process.memoryUsage(), peakHeap, peakRss, p50Ms: samples[Math.ceil(iterations * .5) - 1], p95Ms: samples[Math.ceil(iterations * .95) - 1] });
        console.error(`${pages} pages / runtime ${ordinal}: cold ${coldMs.toFixed(1)}, warm ${samples[Math.ceil(iterations * .5) - 1]?.toFixed(1)} ms`);
      } finally { clearInterval(timer); runtime.clearRetrievalIndexes(); }
    }
  }
  await fs.writeFile(arg("json", "benchmarks/results/274-full-reconcile.json"), JSON.stringify({ node: process.version, gcExposed: Boolean(global.gc), results }, null, 2) + "\n");
} finally { await fs.rm(root, { recursive: true, force: true }); }
