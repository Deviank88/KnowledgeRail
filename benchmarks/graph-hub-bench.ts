// Edge work of seeded graph expansion around high-degree hubs (milestone 2.9.4, P2).
// Compares the rejected edge-work cap with current production traversal on the same graph.
import { performance } from "node:perf_hooks";
import type { GraphEdge, GraphNode, WikiGraph } from "../src/core/graph-index.js";
import { buildRuntimeGraph, expandRuntimeGraphFromSeeds, type SeededGraphQueryParams } from "../src/core/graph-runtime.js";

const DEGREES = (process.env["GRAPH_HUB_BENCH_DEGREES"] ?? "1000,10000,100000").split(",").map(Number);
const ITERATIONS = 7;

const page = (id: string): GraphNode => ({ id: `page:${id}.md`, kind: "page", label: id, path: `${id}.md`, pageType: "concept" });
const graph = (nodes: GraphNode[], edges: GraphEdge[]): WikiGraph => ({ version: 2, generatedAt: "2026-09-26T00:00:00.000Z", nodes, edges, warnings: [] });

/** A seed linked to a page hub that D pages link to. */
function pageHub(degree: number) {
  const seed = page("Seed"), hub = page("Hub"), leaves = Array.from({ length: degree }, (_, i) => page(`Leaf${i}`));
  return { graph: graph([seed, hub, ...leaves], [
    { from: seed.id, to: hub.id, kind: "links_to" },
    ...leaves.map((leaf) => ({ from: leaf.id, to: hub.id, kind: "links_to" as const })),
  ]), seeds: [seed.id] };
}

/** The selected page hub owns the outgoing adjacency used to emit result edges. */
function outgoingPageHub(degree: number) {
  const fixture = pageHub(degree);
  fixture.graph.edges = fixture.graph.edges.map((edge) => ({ ...edge, from: edge.to, to: edge.from }));
  return fixture;
}

/** Eight seed pages of one request with D sibling pages: each seed rescans every sibling. */
function requestHub(degree: number) {
  const request: GraphNode = { id: "request:REQ_1", kind: "request", label: "REQ-1", requestId: "REQ-1" };
  const pages = Array.from({ length: degree }, (_, i) => page(`Req${i}`));
  return { graph: graph([request, ...pages], pages.map((p) => ({ from: p.id, to: request.id, kind: "same_request" as const }))),
    seeds: pages.slice(0, 8).map((p) => p.id) };
}

function measure(runtime: ReturnType<typeof buildRuntimeGraph>, params: SeededGraphQueryParams) {
  const times: number[] = [];
  let result = expandRuntimeGraphFromSeeds(runtime, params);
  for (let i = 0; i < ITERATIONS; i++) {
    const started = performance.now();
    result = expandRuntimeGraphFromSeeds(runtime, params);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const { edgeWork, edgeBudgetExhausted, visitedNodes, truncatedFrontierCount } = result.stats;
  return { p50Ms: Number(times[Math.floor(times.length / 2)]!.toFixed(3)), edgeWork, edgeBudgetExhausted, visitedNodes,
    truncatedFrontierCount, emitted: result.nodes.map((node) => node.id) };
}

const rows = [];
for (const degree of DEGREES) {
  for (const [scenario, build] of [["page_hub", pageHub], ["outgoing_page_hub", outgoingPageHub], ["request_hub", requestHub]] as const) {
    const fixture = build(degree);
    const runtime = buildRuntimeGraph(fixture.graph);
    // Widest default retrieval budget (level 2 with 8 results): 192 visited nodes, depth 3, 96 emitted, beam 64.
    const params: SeededGraphQueryParams = { seedNodeIds: fixture.seeds, maxNodes: 96, maxDepth: 3, beamWidth: 64, maxVisitedNodes: 192 };
    const bounded = measure(runtime, { ...params, maxEdgeWork: 192 * 64 });
    const production = measure(runtime, params);
    const shared = bounded.emitted.filter((id) => production.emitted.includes(id)).length;
    rows.push({ scenario, degree,
      bounded: { ...bounded, emitted: bounded.emitted.length },
      production: { ...production, emitted: production.emitted.length },
      emittedOverlap: shared });
  }
}
console.log(JSON.stringify({ benchmark: "graph-hub", iterations: ITERATIONS, rows }, null, 2));
