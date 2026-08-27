import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { buildWikiGraph, invalidateWikiGraph } from "../src/core/graph-index.js";
import { withDerivedCheckpointLock } from "../src/core/checkpoint-lock.js";
import {
  clearRuntimeWikiGraphs,
  getRuntimeWikiGraph,
  updateRuntimeWikiGraphPaths,
} from "../src/core/graph-runtime.js";
import {
  clearRetrievalIndexes,
  searchRetrievalIndex,
  updateRetrievalPaths,
} from "../src/core/retrieval-index.js";

interface Distribution {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

const DEFAULT_SCALES = [1_000, 5_000, 10_000];

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function scales(): number[] {
  const raw = argument("scales") ?? "1000,5000,10000";
  return [...new Set(raw.split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
  };
}

async function measure(iterations: number, operation: () => Promise<unknown>): Promise<Distribution> {
  const values: number[] = [];
  for (let index = 0; index < iterations; index++) {
    global.gc?.();
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  return distribution(values);
}

function clear(root: string): void {
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(root);
}

function pagePath(index: number): string {
  return `requirements/Page-${String(index).padStart(5, "0")}.md`;
}

function pageRaw(index: number, count: number, revision = 0): string {
  const next = (index + 1) % count;
  const second = (index + 17) % count;
  const third = (index + 97) % count;
  return [
    "---",
    `title: Requirement ${index}`,
    "type: requirement",
    `tags: [domain-${index % 40}, workflow-${index % 17}]`,
    `aliases: [REQ-${String(index).padStart(5, "0")}]`,
    `sources: [source-${index % 23}]`,
    `request_id: REQ-${String(index % Math.max(1, Math.floor(count / 4))).padStart(5, "0")}`,
    "client: benchmark-client",
    "project: warm-start-e2e",
    "---",
    "",
    `# Ordered invoice recovery ${index}`,
    "",
    `The payment authorization flow preserves HTTP 429 Retry-After and idempotency key REQ-${index}.`,
    `It links [[Page-${String(next).padStart(5, "0")}]], [[Page-${String(second).padStart(5, "0")}]], and [[Page-${String(third).padStart(5, "0")}]].`,
    "",
    "## Verification and rollback",
    "",
    `Rollback sequence ${index % 11} verifies durable ledger state before retrying the ordered workflow. Revision ${revision}.`,
  ].join("\n");
}

async function materialize(root: string, count: number): Promise<void> {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(Array.from({ length: Math.min(batchSize, count - start) }, async (_, offset) => {
      const index = start + offset;
      const absolute = path.join(root, pagePath(index));
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, pageRaw(index, count));
    }));
  }
}

const CHECKPOINT_FILES = [
  "retrieval-index.json",
  "retrieval-delta.jsonl",
  "graph.json",
  "graph-delta.jsonl",
] as const;

async function withCheckpointsHeld<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.join(root, ".knowledge-rail");
  const held: Array<{ source: string; target: string }> = [];
  try {
    for (const filename of CHECKPOINT_FILES) {
      const source = path.join(directory, filename);
      const target = `${source}.benchmark-hold`;
      try {
        await fs.rename(source, target);
        held.push({ source, target });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return await operation();
  } finally {
    for (const item of held.reverse()) await fs.rename(item.target, item.source);
  }
}

async function checkpointBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const filename of CHECKPOINT_FILES) {
    const stat = await fs.stat(path.join(root, ".knowledge-rail", filename)).catch(() => null);
    bytes += stat?.size ?? 0;
  }
  return bytes;
}

async function benchmarkScale(root: string, count: number, iterations: number): Promise<Record<string, unknown>> {
  await materialize(root, count);
  clear(root);
  await searchRetrievalIndex({
    wikiRoot: root,
    query: "payment authorization HTTP 429 Retry-After",
    forceRefresh: true,
  });
  await buildWikiGraph(root);
  clear(root);

  // Untimed filesystem/JIT warm-ups for both paths.
  await getRuntimeWikiGraph(root, false, { persist: false });
  clear(root);
  await withCheckpointsHeld(root, async () => {
    await getRuntimeWikiGraph(root, false, { persist: false });
    clear(root);
  });

  const warm = await measure(iterations, async () => {
    clear(root);
    await getRuntimeWikiGraph(root, false, { persist: false });
  });
  clear(root);
  const cold = await withCheckpointsHeld(root, () => measure(iterations, async () => {
    clear(root);
    await getRuntimeWikiGraph(root, false, { persist: false });
  }));

  clear(root);
  await getRuntimeWikiGraph(root, false, { persist: false });
  const queryIterations = Math.max(10, iterations * 2);
  const baselineQuery = await measure(queryIterations, () => searchRetrievalIndex({
    wikiRoot: root,
    query: "payment authorization HTTP 429 Retry-After",
    maxResults: 10,
    phraseRerank: false,
    persist: false,
  }));
  const phraseQuery = await measure(queryIterations, () => searchRetrievalIndex({
    wikiRoot: root,
    query: "payment authorization HTTP 429 Retry-After",
    maxResults: 10,
    phraseRerank: true,
    persist: false,
  }));

  const updateSamples: number[] = [];
  const graphUpdateSamples: number[] = [];
  const authorizedUpdateSamples: number[] = [];
  const mutationPath = pagePath(0);
  const updateIterations = Math.max(10, Number(argument("update-iterations") ?? queryIterations));
  for (let revision = 1; revision <= updateIterations; revision++) {
    await fs.writeFile(path.join(root, mutationPath), pageRaw(0, count, revision));
    const totalStartedAt = performance.now();
    await withDerivedCheckpointLock(root, async (checkpointLock) => {
      let startedAt = performance.now();
      await updateRetrievalPaths(root, [mutationPath], { checkpointLock });
      updateSamples.push(performance.now() - startedAt);
      startedAt = performance.now();
      await updateRuntimeWikiGraphPaths(root, [mutationPath], { checkpointLock });
      graphUpdateSamples.push(performance.now() - startedAt);
    });
    authorizedUpdateSamples.push(performance.now() - totalStartedAt);
  }

  return {
    pages: count,
    iterations,
    coldRebuild: cold,
    verifiedWarmResume: warm,
    speedup: { p50: cold.p50Ms / warm.p50Ms, p95: cold.p95Ms / warm.p95Ms },
    warmQueryBaseline: baselineQuery,
    warmQueryBigram: phraseQuery,
    phraseP95Overhead: baselineQuery.p95Ms === 0 ? 0 : phraseQuery.p95Ms / baselineQuery.p95Ms - 1,
    lexicalOnePageUpdate: distribution(updateSamples),
    graphOnePagePersistence: distribution(graphUpdateSamples),
    authorizedOnePageUpdate: distribution(authorizedUpdateSamples),
    checkpointBytes: await checkpointBytes(root),
    heapUsedMb: process.memoryUsage().heapUsed / 1024 / 1024,
  };
}

async function main(): Promise<void> {
  const requested = scales();
  if (requested.length === 0) requested.push(...DEFAULT_SCALES);
  const iterations = Math.max(5, Number(argument("iterations") ?? 5));
  const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-warm-e2e-"));
  const results: Record<string, unknown>[] = [];
  try {
    for (const count of requested) {
      const root = path.join(benchmarkRoot, String(count));
      await fs.mkdir(root, { recursive: true });
      const result = await benchmarkScale(root, count, iterations);
      results.push(result);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    if (flag("gate")) {
      for (const result of results) {
        const pages = result["pages"] as number;
        const cold = result["coldRebuild"] as Distribution;
        const warm = result["verifiedWarmResume"] as Distribution;
        if (warm.samples !== iterations || cold.samples !== iterations) {
          throw new Error(`Warm-start gate at ${pages} pages did not collect every requested sample.`);
        }
        // Relative, same-run direction gates are portable across hosted OS
        // runners. Absolute release latency remains a separately pinned bench.
        if (cold.p50Ms / Math.max(warm.p50Ms, 1e-9) < 1.25) {
          throw new Error(`Warm-start p50 gate failed at ${pages} pages: ${cold.p50Ms} / ${warm.p50Ms}.`);
        }
        if (cold.p95Ms / Math.max(warm.p95Ms, 1e-9) < 1.10) {
          throw new Error(`Warm-start p95 gate failed at ${pages} pages: ${cold.p95Ms} / ${warm.p95Ms}.`);
        }
        if ((result["checkpointBytes"] as number) <= 0) {
          throw new Error(`Warm-start gate at ${pages} pages produced no durable checkpoint.`);
        }
      }
    }
    process.stdout.write(`${JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, results }, null, 2)}\n`);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    await fs.rm(benchmarkRoot, { recursive: true, force: true });
  }
}

await main();
