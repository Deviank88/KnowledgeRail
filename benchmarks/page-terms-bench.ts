import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import { parseWikiPageRecord } from "../src/core/page-record.js";
import { indexedTermsForRecord } from "../src/core/retrieval-terms.js";
const results = [];
for (const pages of [1000, 10000, 50000]) {
  const records = Array.from({ length: pages }, (_, i) => parseWikiPageRecord(`concepts/Page${i}.md`, `---\ntitle: Page${i}\ntype: concept\n---\n# Terms\n` + Array.from({ length: 20 }, (_, j) => `word${i}unique${j}`).join(" "), { mtimeMs: 1, size: 1 }));
  const postings = new Map<string, Set<string>>();
  for (const record of records) for (const [term] of indexedTermsForRecord(record)) {
    let entries = postings.get(term);
    if (!entries) { entries = new Set(); postings.set(term, entries); }
    entries.add(record.path);
  }
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const inverse = new Map(records.map((record) => [record.path, indexedTermsForRecord(record).map(([term]) => term)]));
  global.gc?.();
  const inverseHeapBytes = process.memoryUsage().heapUsed - before;
  const target = records[0]!;
  const modes = {
    vocabularyScan: () => { let count = 0; for (const paths of postings.values()) if (paths.has(target.path)) count++; return count; },
    derivePageTerms: () => indexedTermsForRecord(target).filter(([term]) => postings.get(term)?.has(target.path)).length,
    inverseMap: () => inverse.get(target.path)!.filter((term) => postings.get(term)?.has(target.path)).length,
  };
  const timings: Record<string, unknown> = {};
  for (const [mode, operation] of Object.entries(modes)) {
    const samples = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); assert.equal(operation(), inverse.get(target.path)!.length); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    timings[mode] = { p50Ms: samples[14], p95Ms: samples[28] };
  }
  results.push({ pages, vocabulary: postings.size, inverseHeapBytes, timings });
}
await fs.writeFile("benchmarks/results/274-page-terms.json", JSON.stringify({ node: process.version, gcExposed: Boolean(global.gc), results }, null, 2) + "\n");
