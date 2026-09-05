import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  clearRetrievalIndexes,
  searchRetrievalIndex,
  updateRetrievalPaths,
  refreshRetrievalIndex,
} from "../src/core/retrieval-index.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function pagePath(index: number): string {
  return `requirements/Page-${String(index).padStart(5, "0")}.md`;
}

const vocabularyPerPage = Math.max(0, Number(argument("vocabulary") ?? 0));

function pageRaw(index: number, revision = 0): string {
  return [
    "---",
    `title: Requirement ${index}`,
    "type: requirement",
    `tags: [domain-${index % 40}]`,
    `aliases: [REQ-${String(index).padStart(5, "0")}]`,
    "sources: []",
    "---",
    "",
    `# Ordered invoice recovery ${index}`,
    "",
    `Payment authorization preserves HTTP 429 Retry-After and idempotency key REQ-${index}.`,
    "",
    "## Verification",
    "",
    `The durable ledger is verified before retry. Revision ${revision}.`,
    Array.from({ length: vocabularyPerPage }, (_, term) => `vocab${index}unique${term}`).join(" "),
  ].join("\n");
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

async function main(): Promise<void> {
  const pages = Math.max(1, Number(argument("pages") ?? 10_000));
  const iterations = Math.max(5, Number(argument("iterations") ?? 20));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-update-bench-"));
  try {
    for (let start = 0; start < pages; start += 200) {
      await Promise.all(Array.from({ length: Math.min(200, pages - start) }, async (_, offset) => {
        const index = start + offset;
        const absolute = path.join(root, pagePath(index));
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, pageRaw(index));
      }));
    }
    clearRetrievalIndexes();
    await searchRetrievalIndex({ wikiRoot: root, query: "payment authorization", forceRefresh: true });
    const state = await refreshRetrievalIndex(root);
    state.watcher?.close();
    const vocabulary = state.postings.size;
    global.gc?.();
    const beforeMemory = process.memoryUsage();
    const samples: number[] = [];
    const removalSamples: number[] = [];
    let peakHeap = beforeMemory.heapUsed;
    let peakRss = beforeMemory.rss;
    for (let revision = 1; revision <= iterations; revision++) {
      await fs.writeFile(path.join(root, pagePath(0)), pageRaw(0, revision));
      const startedAt = performance.now();
      await updateRetrievalPaths(root, [pagePath(0)]);
      samples.push(performance.now() - startedAt);
      await fs.unlink(path.join(root, pagePath(0)));
      const removalStart = performance.now();
      await updateRetrievalPaths(root, [pagePath(0)]);
      removalSamples.push(performance.now() - removalStart);
      await fs.writeFile(path.join(root, pagePath(0)), pageRaw(0, revision));
      await updateRetrievalPaths(root, [pagePath(0)]);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    global.gc?.();
    const report = {
      pages, iterations, vocabularyPerPage, vocabulary, node: process.version,
      gcExposed: Boolean(global.gc), beforeMemory, afterMemory: process.memoryUsage(), peakHeap, peakRss,
      removalP50Ms: percentile(removalSamples.sort((a, b) => a - b), .5),
      removalP95Ms: percentile(removalSamples, .95),
      p99Ms: percentile(sorted, .99),
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    };
    const output = argument("json");
    if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
