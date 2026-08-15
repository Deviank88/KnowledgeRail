import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  queryWikiGraph,
  type GraphEdge,
  type GraphNode,
  type WikiGraph,
} from "../src/core/graph-index.js";
import {
  buildRuntimeGraph,
  expandRuntimeGraphFromSeeds,
} from "../src/core/graph-runtime.js";
import {
  patchRuntimeGraphPaths,
  type RuntimeGraphMutationStats,
} from "../src/core/graph-runtime-mutation.js";

interface LatencyStats {
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
}

interface ScaleResult {
  globalNodes: number;
  globalEdges: number;
  buildMs: number;
  localQuery: LatencyStats;
  legacyGlobalQuery: LatencyStats;
  localTraversal: {
    visitedNodes: number;
    visitedEdges: number;
    emittedNodes: number;
    emittedEdges: number;
  };
  warmMutation: LatencyStats;
  mutationWork: RuntimeGraphMutationStats;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function scalesFromEnv(): number[] {
  const raw = process.env["GRAPH_RUNTIME_BENCH_SCALES"] ?? "1000,10000,50000";
  const parsed = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 100);
  if (parsed.length === 0) throw new Error("GRAPH_RUNTIME_BENCH_SCALES must contain positive integer scales >= 100.");
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function latencyStats(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations: samples.length,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
  };
}

const REQUIREMENT_PATH = "requirements/REQ_LOCAL.md";
const REQUIREMENT_ID = `page:${REQUIREMENT_PATH}`;
const IMPLEMENTATION_ID = "page:implementations/Worker.md";
const REQUEST_NODE_ID = "request:REQ_LOCAL";
const TAG_NODE_ID = "tag:runtime_bench";
const SOURCE_NODE_ID = "source:bench_spec_md";

function localNodes(): GraphNode[] {
  return [
    {
      id: REQUIREMENT_ID,
      kind: "page",
      label: "Local retry requirement",
      path: REQUIREMENT_PATH,
      pageType: "requirement",
      requestId: "REQ-LOCAL",
      tags: ["runtime-bench"],
      sources: ["bench/spec.md"],
      summary: "Retry stops after three attempts and emits escalation evidence.",
    },
    {
      id: IMPLEMENTATION_ID,
      kind: "page",
      label: "Local retry worker",
      path: "implementations/Worker.md",
      pageType: "implementation",
      requestId: "REQ-LOCAL",
      tags: [],
      sources: [],
      summary: "Worker implementation for local retry policy.",
    },
    { id: REQUEST_NODE_ID, kind: "request", label: "REQ-LOCAL", requestId: "REQ-LOCAL" },
    { id: TAG_NODE_ID, kind: "tag", label: "runtime-bench" },
    { id: SOURCE_NODE_ID, kind: "source", label: "bench/spec.md" },
  ];
}

function localEdges(): GraphEdge[] {
  return [
    { from: REQUIREMENT_ID, to: REQUEST_NODE_ID, kind: "same_request" },
    { from: IMPLEMENTATION_ID, to: REQUEST_NODE_ID, kind: "same_request" },
    { from: REQUIREMENT_ID, to: IMPLEMENTATION_ID, kind: "implements" },
    { from: REQUIREMENT_ID, to: TAG_NODE_ID, kind: "has_tag" },
    { from: REQUIREMENT_ID, to: SOURCE_NODE_ID, kind: "derived_from" },
  ];
}

function syntheticGraph(targetGlobalNodes: number): WikiGraph {
  const nodes = localNodes();
  const edges = localEdges();
  const unrelatedCount = Math.max(0, targetGlobalNodes - nodes.length);

  for (let index = 0; index < unrelatedCount; index++) {
    const id = `page:unrelated/P_${index}.md`;
    nodes.push({
      id,
      kind: "page",
      label: `Unrelated knowledge ${index}`,
      path: `unrelated/P_${index}.md`,
      pageType: "analysis",
      tags: [],
      sources: [],
      summary: "Synthetic unrelated evidence used only to grow global graph size.",
    });
    if (index > 0) {
      edges.push({
        from: `page:unrelated/P_${index - 1}.md`,
        to: id,
        kind: "links_to",
      });
    }
  }

  return {
    version: 2,
    generatedAt: "2026-08-13T00:00:00.000Z",
    nodes,
    edges,
    warnings: [],
  };
}

function pageMarkdown(iteration: number): string {
  const attempts = iteration % 2 === 0 ? "three" : "four";
  return [
    "---",
    `title: \"Local retry requirement ${iteration % 2}\"`,
    "type: requirement",
    "tags: [runtime-bench]",
    'request_id: "REQ-LOCAL"',
    'sources: ["bench/spec.md"]',
    "created: 2026-08-13",
    "updated: 2026-08-13",
    "---",
    "",
    "# Local retry requirement",
    "",
    `Retry stops after ${attempts} attempts and emits escalation evidence for the local policy.`,
    "",
  ].join("\n");
}

async function writeRequirement(wikiRoot: string, iteration: number): Promise<void> {
  const file = path.join(wikiRoot, REQUIREMENT_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, pageMarkdown(iteration), "utf8");
}

function assertSameWork(
  baseline: Pick<ScaleResult, "localTraversal" | "mutationWork">,
  current: Pick<ScaleResult, "localTraversal" | "mutationWork">,
  scale: number
): void {
  const queryKeys = ["visitedNodes", "visitedEdges", "emittedNodes", "emittedEdges"] as const;
  for (const key of queryKeys) {
    if (current.localTraversal[key] !== baseline.localTraversal[key]) {
      throw new Error(
        `Local graph work changed at scale ${scale}: ${key}=${current.localTraversal[key]}, ` +
        `baseline=${baseline.localTraversal[key]}.`
      );
    }
  }
  const mutationKeys: Array<keyof RuntimeGraphMutationStats> = [
    "touchedPaths",
    "affectedRequestGroups",
    "affectedRequestPages",
    "orphanCandidatesChecked",
  ];
  for (const key of mutationKeys) {
    if (current.mutationWork[key] !== baseline.mutationWork[key]) {
      throw new Error(
        `Local mutation work changed at scale ${scale}: ${key}=${current.mutationWork[key]}, ` +
        `baseline=${baseline.mutationWork[key]}.`
      );
    }
  }
}

async function runScale(
  scale: number,
  queryIterations: number,
  mutationIterations: number
): Promise<ScaleResult> {
  const graph = syntheticGraph(scale);
  const buildStart = performance.now();
  const runtime = buildRuntimeGraph(graph);
  const buildMs = performance.now() - buildStart;

  const queryParams = {
    seedNodeIds: [REQUIREMENT_ID],
    maxNodes: 12,
    maxDepth: 1,
    beamWidth: 12,
    maxVisitedNodes: 32,
    hubPenalty: true,
  } as const;

  const warm = expandRuntimeGraphFromSeeds(runtime, queryParams);
  const localSamples: number[] = [];
  const legacySamples: number[] = [];
  for (let iteration = 0; iteration < queryIterations; iteration++) {
    let start = performance.now();
    expandRuntimeGraphFromSeeds(runtime, queryParams);
    localSamples.push(performance.now() - start);

    start = performance.now();
    queryWikiGraph(graph, {
      query: "local retry requirement escalation attempts",
      maxNodes: 12,
      maxDepth: 1,
      pageTypes: ["requirement", "implementation"],
    });
    legacySamples.push(performance.now() - start);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), `knowledge-rail-graph-runtime-${scale}-`));
  const wikiRoot = path.join(root, "wiki");
  const mutationSamples: number[] = [];
  let mutationWork: RuntimeGraphMutationStats | undefined;
  try {
    // One unmeasured mutation warms filesystem/module paths. Runtime mutation indexes
    // are already primed by buildRuntimeGraph(), so no O(V+E) setup is hidden here.
    await writeRequirement(wikiRoot, 0);
    await patchRuntimeGraphPaths(runtime, wikiRoot, [REQUIREMENT_PATH]);

    for (let iteration = 1; iteration <= mutationIterations; iteration++) {
      await writeRequirement(wikiRoot, iteration);
      const start = performance.now();
      const stats = await patchRuntimeGraphPaths(runtime, wikiRoot, [REQUIREMENT_PATH]);
      mutationSamples.push(performance.now() - start);
      mutationWork ??= stats;
      const baseline = mutationWork;
      if (
        stats.touchedPaths !== baseline.touchedPaths ||
        stats.affectedRequestGroups !== baseline.affectedRequestGroups ||
        stats.affectedRequestPages !== baseline.affectedRequestPages ||
        stats.orphanCandidatesChecked !== baseline.orphanCandidatesChecked
      ) {
        throw new Error(`Mutation structural work changed within scale ${scale}: ${JSON.stringify(stats)}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  if (!mutationWork) throw new Error("Mutation benchmark produced no samples.");
  return {
    globalNodes: graph.nodes.length,
    globalEdges: graph.edges.length,
    buildMs,
    localQuery: latencyStats(localSamples),
    legacyGlobalQuery: latencyStats(legacySamples),
    localTraversal: {
      visitedNodes: warm.stats.visitedNodes,
      visitedEdges: warm.stats.visitedEdges,
      emittedNodes: warm.stats.emittedNodes,
      emittedEdges: warm.stats.emittedEdges,
    },
    warmMutation: latencyStats(mutationSamples),
    mutationWork,
  };
}

async function main(): Promise<void> {
  const scales = scalesFromEnv();
  const queryIterations = positiveInteger(process.env["GRAPH_RUNTIME_QUERY_ITERATIONS"], 100);
  const mutationIterations = positiveInteger(process.env["GRAPH_RUNTIME_MUTATION_ITERATIONS"], 15);
  const results: ScaleResult[] = [];

  for (const scale of scales) {
    const result = await runScale(scale, queryIterations, mutationIterations);
    if (results[0]) assertSameWork(results[0], result, scale);
    results.push(result);
  }

  process.stdout.write(`${JSON.stringify({
    benchmark: "graph-runtime-locality-v1",
    scales,
    queryIterations,
    mutationIterations,
    invariant: {
      localQueryWorkIndependentOfGlobalGraphSize: true,
      warmMutationWorkIndependentOfGlobalGraphSize: true,
    },
    results,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
