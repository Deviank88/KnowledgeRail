import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { codeQueryFixture } from "./code-query-fixture.js";
import { codeEvidenceIndexFile, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

function argument(name: string, fallback: string): string {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function distribution(samples: number[]) {
  samples.sort((a, b) => a - b);
  return { samples: samples.length, p50Ms: samples[Math.ceil(samples.length * .5) - 1], p95Ms: samples[Math.ceil(samples.length * .95) - 1], p99Ms: samples[Math.ceil(samples.length * .99) - 1] };
}

const scales = argument("scales", "1000,10000").split(",").map(Number);
const iterations = Number(argument("iterations", "30"));
if (!scales.every((value) => Number.isInteger(value) && value >= 10) || !Number.isInteger(iterations) || iterations < 5) {
  throw new Error("Use integer scales >= 10 and iterations >= 5.");
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-code-query-bench-"));
const results = [];
try {
  for (const count of scales) {
    const repositoryRoot = path.join(root, String(count));
    const wikiRoot = path.join(repositoryRoot, "wiki");
    const snapshotPath = codeEvidenceIndexFile(wikiRoot);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    const serialized = JSON.stringify(codeQueryFixture(count));
    await fs.writeFile(snapshotPath, serialized);
    clearWorkspaceStates();
    global.gc?.();
    const baselineHeapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    // Match the MCP lifecycle: every operation gets a new index instance.
    const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
    const operations = {
      symbolTop1: () => index().symbol("handleOrder5", { maxResults: 1 }),
      symbolDefault: () => index().symbol("handleOrder5"),
      references: () => index().references("fragment-5"),
      search: () => index().search("handleOrder5 bounded retry"),
      searchExact: () => index().search("handleOrder5"),
      searchSubstring: () => index().search("andleOrd"),
      searchMissing: () => index().search("unfindableNeedle"),
      searchBroad: () => index().search("order"),
      searchFiltered: () => index().search("order", { paths: ["src/Service1.ts"], kinds: ["method"], maxResults: 1 }),
    };
    const measurements: Record<string, unknown> = {};
    const digest = createHash("sha256");
    const coldSamples: number[] = [];
    let peakHeap = process.memoryUsage().heapUsed, peakRss = process.memoryUsage().rss;
    for (let cold = 0; cold < iterations; cold++) {
      clearWorkspaceStates();
      global.gc?.();
      const started = performance.now();
      await operations.symbolTop1();
      coldSamples.push(performance.now() - started);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const coldSymbol = distribution(coldSamples);
    for (const [name, operation] of Object.entries(operations)) {
      for (let warmup = 0; warmup < 3; warmup++) await operation();
      const samples: number[] = [];
      for (let iteration = 0; iteration < iterations; iteration++) {
        const start = performance.now();
        const value = await operation();
        samples.push(performance.now() - start);
        digest.update(JSON.stringify(value));
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      measurements[name] = distribution(samples);
    }
    global.gc?.();
    const warmHeapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    clearWorkspaceStates();
    await new Promise<void>((resolve) => setImmediate(resolve));
    global.gc?.();
    results.push({ fragments: count, files: Math.ceil(count / 5), snapshotBytes: Buffer.byteLength(serialized), coldSymbol, peakHeap, peakRss,
      measurements, resultDigest: digest.digest("hex"), baselineHeapMb, warmHeapMb,
      evictedHeapMb: process.memoryUsage().heapUsed / 1024 / 1024 });
  }
  const report = { node: process.version, iterations, gcExposed: Boolean(global.gc), results };
  const output = argument("json", "");
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearWorkspaceStates();
  await fs.rm(root, { recursive: true, force: true });
}
