import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { createSectionContext, formatSectionContext } from "../src/core/document-workflow.js";
import { buildWikiGraph, getWikiGraph, queryWikiGraph } from "../src/core/graph-index.js";
import {
  clearRetrievalIndexes,
  searchRetrievalIndex,
  updateRetrievalPaths,
} from "../src/core/retrieval-index.js";
import { tokenizeSearchText } from "../src/core/text-analysis.js";

interface LatencyStats {
  iterations: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

interface ScaleResult {
  pageCount: number;
  graphNodes: number;
  graphEdges: number;
  /** Current v3 graph query globally considers every graph node before local expansion. */
  graphQueryMinGlobalNodeVisits: number;
  /** Current v3 graph query globally indexes every graph edge before local expansion. */
  graphQueryMinGlobalEdgeVisits: number;
  coldBm25Ms: number;
  forcedRefreshBm25Ms: number;
  warmBm25: LatencyStats;
  incrementalUpdateMs: number;
  graphBuildMs: number;
  graphQuery: LatencyStats;
  warmGraphLoad: LatencyStats;
  plainContext: LatencyStats;
  graphContext: LatencyStats;
  searchExcerptChars: number;
  contextChars: number;
  /** Lexical tokenizer count: useful as a stable context-size proxy, not a model-specific token count. */
  contextSearchTokens: number;
  contextPages: number;
  heapUsedMb: number;
}

const ROLES = ["request", "requirement", "implementation", "test_result", "release"] as const;
const ROLE_DIR: Record<(typeof ROLES)[number], string> = {
  request: "requests",
  requirement: "requirements",
  implementation: "implementations",
  test_result: "tests",
  release: "releases",
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requestedScales(): number[] {
  const raw = argValue("scales") ?? process.env["BENCH_SCALES"] ?? "1000,5000,10000";
  return [...new Set(raw.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
}

function roleFor(index: number): (typeof ROLES)[number] {
  return ROLES[index % ROLES.length];
}

function pageRelPath(index: number): string {
  const role = roleFor(index);
  return path.join(ROLE_DIR[role], `Page_${index}.md`).replace(/\\/g, "/");
}

async function writePage(root: string, index: number, mutated = false): Promise<void> {
  const role = roleFor(index);
  const group = Math.floor(index / ROLES.length);
  const rel = pageRelPath(index);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const isNeedle = group % 10 === 0;
  const topic = isNeedle
    ? "needle performance cache distributed retry context retrieval"
    : "general project knowledge architecture requirement implementation verification";
  const mutationText = mutated ? " mutation_marker updated evidence" : "";
  const relationshipHint = role === "request"
    ? `\n\nSee [[Benchmark requirement ${group}]] for acceptance details.`
    : "";

  await fs.writeFile(
    abs,
    [
      "---",
      `title: "Benchmark ${role} ${group}"`,
      `type: ${role}`,
      `tags: [benchmark, cohort_${group % 100}]`,
      "created: 2026-08-12",
      "updated: 2026-08-12",
      "sources: []",
      `request_id: "BENCH-${group}"`,
      "---",
      "",
      `# Benchmark ${role} ${group}`,
      "",
      `${topic}${mutationText} `.repeat(60),
      relationshipHint,
    ].join("\n"),
    "utf-8"
  );
}

async function growWiki(root: string, from: number, to: number): Promise<void> {
  const batchSize = 250;
  for (let start = from; start < to; start += batchSize) {
    const count = Math.min(batchSize, to - start);
    await Promise.all(Array.from({ length: count }, (_, offset) => writePage(root, start + offset)));
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; elapsedMs: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, elapsedMs: performance.now() - start };
}

async function measureMany(iterations: number, fn: () => Promise<unknown> | unknown): Promise<LatencyStats> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: samples.reduce((sum, sample) => sum + sample, 0) / Math.max(samples.length, 1),
  };
}

function compact(stats: LatencyStats): string {
  return `p50=${stats.p50Ms.toFixed(2)} p95=${stats.p95Ms.toFixed(2)} p99=${stats.p99Ms.toFixed(2)} ms`;
}

async function benchmarkScale(wikiRoot: string, pageCount: number, iterations: number): Promise<ScaleResult> {
  clearRetrievalIndexes();

  const cold = await timed(() => searchRetrievalIndex({
    wikiRoot,
    query: "needle performance cache",
    maxResults: 10,
    forceRefresh: true,
  }));

  const forcedRefresh = await timed(() => searchRetrievalIndex({
    wikiRoot,
    query: "needle performance cache",
    maxResults: 10,
    forceRefresh: true,
  }));

  const warmBm25 = await measureMany(iterations, () => searchRetrievalIndex({
    wikiRoot,
    query: "needle performance cache",
    maxResults: 10,
  }));

  const mutationIndex = Math.min(10, pageCount - 1);
  await writePage(wikiRoot, mutationIndex, true);
  const incrementalUpdate = await timed(() => updateRetrievalPaths(wikiRoot, [pageRelPath(mutationIndex)]));

  const graphBuild = await timed(() => buildWikiGraph(wikiRoot));
  const graph = graphBuild.value;
  const graphQuery = await measureMany(iterations, () => queryWikiGraph(graph, {
    query: "needle performance cache",
    maxNodes: 16,
    maxDepth: 1,
  }));
  const warmGraphLoad = await measureMany(Math.min(iterations, 10), () => getWikiGraph(wikiRoot));

  const contextIterations = Math.max(3, Math.min(10, Math.ceil(iterations / 5)));
  const plainContext = await measureMany(contextIterations, () => createSectionContext({
    wikiRoot,
    sectionTitle: "needle performance",
    query: "cache retrieval",
    maxPages: 8,
    maxCharsPerPage: 1000,
    maxTotalChars: 8000,
    useGraph: false,
  }));
  const graphContext = await measureMany(contextIterations, () => createSectionContext({
    wikiRoot,
    sectionTitle: "needle performance",
    query: "cache retrieval",
    maxPages: 8,
    maxCharsPerPage: 1000,
    maxTotalChars: 8000,
    useGraph: true,
  }));

  const searchOutput = await searchRetrievalIndex({
    wikiRoot,
    query: "needle performance cache",
    maxResults: 10,
  });
  const context = await createSectionContext({
    wikiRoot,
    sectionTitle: "needle performance",
    query: "cache retrieval",
    maxPages: 8,
    maxCharsPerPage: 1000,
    maxTotalChars: 8000,
    maxOutputChars: 6000,
    useGraph: true,
  });
  const formattedContext = formatSectionContext(context, "needle performance", 6000);

  return {
    pageCount,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    graphQueryMinGlobalNodeVisits: graph.nodes.length,
    graphQueryMinGlobalEdgeVisits: graph.edges.length,
    coldBm25Ms: cold.elapsedMs,
    forcedRefreshBm25Ms: forcedRefresh.elapsedMs,
    warmBm25,
    incrementalUpdateMs: incrementalUpdate.elapsedMs,
    graphBuildMs: graphBuild.elapsedMs,
    graphQuery,
    warmGraphLoad,
    plainContext,
    graphContext,
    searchExcerptChars: searchOutput.reduce((sum, hit) => sum + hit.excerpt.length, 0),
    contextChars: formattedContext.length,
    contextSearchTokens: tokenizeSearchText(formattedContext).length,
    contextPages: context.pages.length,
    heapUsedMb: process.memoryUsage().heapUsed / (1024 * 1024),
  };
}

function printResult(result: ScaleResult): void {
  process.stdout.write(`\n=== ${result.pageCount.toLocaleString()} pages ===\n`);
  process.stdout.write(`graph: ${result.graphNodes.toLocaleString()} nodes / ${result.graphEdges.toLocaleString()} edges\n`);
  process.stdout.write(
    `graph query global-scan lower bound: ${result.graphQueryMinGlobalNodeVisits.toLocaleString()} nodes / ` +
    `${result.graphQueryMinGlobalEdgeVisits.toLocaleString()} edges per query\n`
  );
  process.stdout.write(`cold BM25: ${result.coldBm25Ms.toFixed(2)} ms\n`);
  process.stdout.write(`forced-refresh BM25: ${result.forcedRefreshBm25Ms.toFixed(2)} ms\n`);
  process.stdout.write(`warm BM25: ${compact(result.warmBm25)}\n`);
  process.stdout.write(`one-page incremental update: ${result.incrementalUpdateMs.toFixed(2)} ms\n`);
  process.stdout.write(`graph build: ${result.graphBuildMs.toFixed(2)} ms\n`);
  process.stdout.write(`graph query: ${compact(result.graphQuery)}\n`);
  process.stdout.write(`warm graph load: ${compact(result.warmGraphLoad)}\n`);
  process.stdout.write(`plain context: ${compact(result.plainContext)}\n`);
  process.stdout.write(`graph context: ${compact(result.graphContext)}\n`);
  process.stdout.write(
    `context: ${result.contextPages} pages / ${result.contextChars} chars / ` +
    `${result.contextSearchTokens} lexical-token proxy; search excerpts=${result.searchExcerptChars} chars\n`
  );
  process.stdout.write(`heap used: ${result.heapUsedMb.toFixed(1)} MB\n`);
}

async function main(): Promise<void> {
  const scales = requestedScales();
  const iterations = parsePositiveInteger(argValue("iterations") ?? process.env["BENCH_ITERATIONS"], 25);
  const outputPath = argValue("json") ?? process.env["BENCH_JSON"];
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-scale-bench-"));
  const results: ScaleResult[] = [];
  let materialized = 0;

  process.stdout.write(`Scaling benchmark: scales=${scales.join(",")} iterations=${iterations}\n`);
  process.stdout.write(`Synthetic wiki root: ${wikiRoot}\n`);

  try {
    for (const pageCount of scales) {
      await growWiki(wikiRoot, materialized, pageCount);
      materialized = pageCount;
      const result = await benchmarkScale(wikiRoot, pageCount, iterations);
      results.push(result);
      printResult(result);
    }

    if (outputPath) {
      await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
      await fs.writeFile(
        path.resolve(outputPath),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), iterations, scales, results }, null, 2)}\n`,
        "utf-8"
      );
      process.stdout.write(`\nJSON written to ${path.resolve(outputPath)}\n`);
    }
  } finally {
    clearRetrievalIndexes();
    await fs.rm(wikiRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
