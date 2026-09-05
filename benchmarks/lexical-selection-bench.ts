import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mapConcurrent } from "../src/core/concurrent-map.js";
import { TopResults } from "../src/core/top-results.js";

const arg = (key: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const runtime = await import(pathToFileURL(path.resolve(arg("runtime", "."), "src/core/retrieval-index.ts")).href) as typeof import("../src/core/retrieval-index.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-lexical-bench-"));
const results = [];
const iterations = Number(arg("iterations", "100"));
try {
  await fs.mkdir(path.join(root, "concepts"));
  let created = 0;
  for (const pages of [1000, 10000]) {
    await mapConcurrent(Array.from({ length: pages - created }, (_, i) => i + created), 32, async (i) => {
      await fs.writeFile(path.join(root, `concepts/Page${i}.md`), `---\ntitle: Page${i}\ntype: concept\ntags: [Tag${i % 5}]\nsources: []\n---\n# Evidence\npayment authorization ordered retry ${"invoice ".repeat(i % 20)} REQ-${i % 10}\n## Details\n${i % 3 === 0 ? "ordered payment" : "payment ordered"} authorization`);
    });
    created = pages;
    runtime.clearRetrievalIndexes();
    await runtime.refreshRetrievalIndex(root, { persist: false });
    const digest = createHash("sha256");
    const measurements = [];
    global.gc?.();
    const baselineMemory = process.memoryUsage();
    for (const profile of ["balanced", "precision", "coverage"] as const) for (const phraseRerank of [false, true]) {
      const times: number[] = [], scoring: number[] = [], sorting: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const query = ["ordered payment", "REQ-4 authorization", "invoice", "unfindable"][i % 4]!;
        const start = performance.now();
        const hits = await runtime.searchRetrievalIndex({ wikiRoot: root, query, profile, phraseRerank, persist: false, maxResults: [1, 12, 50][i % 3], onLexicalDiagnostics: (d) => { scoring.push(d.scoringMs); sorting.push(d.sortingMs); } });
        times.push(performance.now() - start);
        digest.update(JSON.stringify(hits.map(({ record: _record, ...hit }) => hit)));
      }
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
      times.sort((a, b) => a - b);
      measurements.push({ profile, phraseRerank, p50Ms: times[Math.ceil(iterations * .5) - 1], p95Ms: times[Math.ceil(iterations * .95) - 1], p99Ms: times[Math.ceil(iterations * .99) - 1], meanScoringMs: mean(scoring), meanSortingMs: mean(sorting) });
    }
    // Isolate stable top-K against full sorting using the same deterministic keys.
    const values = Array.from({ length: pages }, (_, i) => ({ score: (i * 15485863) % 83, path: `concepts/Page${i}.md` }));
    const compare = (a: typeof values[number], b: typeof values[number]) => b.score - a.score || a.path.localeCompare(b.path);
    const selection: Record<string, number> = {};
    for (const mode of ["sort", "topK"]) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        if (mode === "sort") values.slice().sort(compare).slice(0, 100);
        else { const best = new TopResults(100, compare); for (const value of values) best.add(value); best.sorted(); }
      }
      selection[mode] = (performance.now() - start) / iterations;
    }
    global.gc?.();
    results.push({ pages, baselineMemory, afterMemory: process.memoryUsage(), measurements, selectionMeanMs: selection, digest: digest.digest("hex") });
  }
  await fs.writeFile(arg("json", "benchmarks/results/274-lexical.json"), JSON.stringify({ node: process.version, iterations, results }, null, 2) + "\n");
} finally { runtime.clearRetrievalIndexes(); await fs.rm(root, { recursive: true, force: true }); }
