import * as nodePath from "node:path";
import {
  patchRuntimeGraphPaths,
  primeRuntimeGraphMutationState,
} from "./graph-runtime-mutation.js";
import {
  getWikiGraph,
  markWikiGraphSynchronized,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNode,
  type GraphQueryResult,
  type WikiGraph,
} from "./graph-index.js";
import { registerWorkspaceState, touchWorkspaceState } from "./workspace-state.js";

export interface GraphNeighbor {
  id: string;
  edgeKind: GraphEdgeKind;
  weight: number;
}

export interface RuntimeGraph {
  graph: WikiGraph;
  nodesById: ReadonlyMap<string, GraphNode>;
  outgoing: ReadonlyMap<string, readonly GraphNeighbor[]>;
  incoming: ReadonlyMap<string, readonly GraphNeighbor[]>;
  degree: ReadonlyMap<string, number>;
  pageNodeByPath: ReadonlyMap<string, string>;
}

export interface SeededGraphTraversalStats {
  seedCount: number;
  visitedNodes: number;
  visitedEdges: number;
  emittedNodes: number;
  emittedEdges: number;
  maxDepthReached: number;
  truncatedFrontierCount: number;
}

export interface SeededGraphQueryResult extends GraphQueryResult {
  stats: SeededGraphTraversalStats;
}

export interface SeededGraphQueryParams {
  seedNodeIds: readonly string[];
  seedScores?: ReadonlyMap<string, number>;
  maxNodes?: number;
  maxDepth?: number;
  beamWidth?: number;
  maxVisitedNodes?: number;
  pageTypes?: readonly string[];
  hopDecay?: number;
  hubPenalty?: boolean;
}

const EDGE_WEIGHTS: Readonly<Record<GraphEdgeKind, number>> = {
  implements: 1,
  tests: 1,
  released_by: 0.9,
  same_request: 0.9,
  links_to: 0.7,
  derived_from: 0.55,
  belongs_to_client: 0.4,
  belongs_to_project: 0.4,
  has_tag: 0.25,
};

const runtimeByRoot = new Map<string, RuntimeGraph>();

function cacheRuntime(root: string, runtime: RuntimeGraph): void {
  runtimeByRoot.set(root, runtime);
  registerWorkspaceState(root, "graph-runtime", () => runtimeByRoot.delete(root));
}
const NON_TRANSITIVE_METADATA_HUBS = new Set<GraphNode["kind"]>([
  "source",
  "tag",
  "client",
  "project",
]);

function pushNeighbor(
  map: Map<string, GraphNeighbor[]>,
  from: string,
  neighbor: GraphNeighbor
): void {
  const list = map.get(from);
  if (list) {
    list.push(neighbor);
  } else {
    map.set(from, [neighbor]);
  }
}

function stableNeighbors(map: Map<string, GraphNeighbor[]>): Map<string, readonly GraphNeighbor[]> {
  for (const neighbors of map.values()) {
    neighbors.sort((a, b) =>
      b.weight - a.weight || a.edgeKind.localeCompare(b.edgeKind) || a.id.localeCompare(b.id)
    );
  }
  return map;
}

export function buildRuntimeGraph(graph: WikiGraph): RuntimeGraph {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, GraphNeighbor[]>();
  const incoming = new Map<string, GraphNeighbor[]>();
  const degree = new Map<string, number>();
  const pageNodeByPath = new Map<string, string>();

  for (const node of graph.nodes) {
    if (node.kind === "page" && node.path) pageNodeByPath.set(node.path, node.id);
  }

  for (const edge of graph.edges) {
    const weight = EDGE_WEIGHTS[edge.kind];
    pushNeighbor(outgoing, edge.from, { id: edge.to, edgeKind: edge.kind, weight });
    pushNeighbor(incoming, edge.to, { id: edge.from, edgeKind: edge.kind, weight });
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const runtime: RuntimeGraph = {
    graph,
    nodesById,
    outgoing: stableNeighbors(outgoing),
    incoming: stableNeighbors(incoming),
    degree,
    pageNodeByPath,
  };
  primeRuntimeGraphMutationState(runtime);
  return runtime;
}

export async function getRuntimeWikiGraph(
  wikiRoot: string,
  force = false,
  options: { persist?: boolean } = {}
): Promise<RuntimeGraph> {
  const root = nodePath.resolve(wikiRoot);
  touchWorkspaceState(root);
  if (!force) {
    const cached = runtimeByRoot.get(root);
    if (cached) {
      const currentGraph = await getWikiGraph(wikiRoot, false, options);
      if (currentGraph === cached.graph) return cached;
      const refreshed = buildRuntimeGraph(currentGraph);
      cacheRuntime(root, refreshed);
      return refreshed;
    }
  }
  const runtime = buildRuntimeGraph(await getWikiGraph(wikiRoot, force, options));
  cacheRuntime(root, runtime);
  return runtime;
}

export function peekRuntimeWikiGraph(wikiRoot: string): RuntimeGraph | undefined {
  const root = nodePath.resolve(wikiRoot);
  touchWorkspaceState(root);
  return runtimeByRoot.get(root);
}

export async function updateRuntimeWikiGraphPaths(
  wikiRoot: string,
  relPaths: readonly string[]
): Promise<boolean> {
  const runtime = peekRuntimeWikiGraph(wikiRoot);
  if (!runtime) return false;
  await patchRuntimeGraphPaths(runtime, wikiRoot, relPaths);
  markWikiGraphSynchronized(wikiRoot);
  return true;
}

export function invalidateRuntimeWikiGraph(wikiRoot: string): void {
  runtimeByRoot.delete(nodePath.resolve(wikiRoot));
}

export function clearRuntimeWikiGraphs(): void {
  runtimeByRoot.clear();
}

function hubFactor(runtime: RuntimeGraph, nodeId: string, enabled: boolean): number {
  if (!enabled) return 1;
  return 1 / Math.log2(2 + (runtime.degree.get(nodeId) ?? 0));
}

function neighborsOf(runtime: RuntimeGraph, nodeId: string): GraphNeighbor[] {
  const merged = new Map<string, GraphNeighbor>();
  for (const neighbor of runtime.outgoing.get(nodeId) ?? []) {
    merged.set(`${neighbor.id}|${neighbor.edgeKind}`, neighbor);
  }
  for (const neighbor of runtime.incoming.get(nodeId) ?? []) {
    const key = `${neighbor.id}|${neighbor.edgeKind}`;
    const existing = merged.get(key);
    if (!existing || neighbor.weight > existing.weight) merged.set(key, neighbor);
  }
  return [...merged.values()].sort((a, b) =>
    b.weight - a.weight || a.edgeKind.localeCompare(b.edgeKind) || a.id.localeCompare(b.id)
  );
}

function inducedEdges(runtime: RuntimeGraph, nodeIds: ReadonlySet<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const from of nodeIds) {
    for (const neighbor of runtime.outgoing.get(from) ?? []) {
      if (!nodeIds.has(neighbor.id)) continue;
      edges.push({ from, to: neighbor.id, kind: neighbor.edgeKind });
    }
  }
  return edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to)
  );
}

export function expandRuntimeGraphFromSeeds(
  runtime: RuntimeGraph,
  params: SeededGraphQueryParams
): SeededGraphQueryResult {
  const maxNodes = Math.max(1, params.maxNodes ?? 12);
  const maxDepth = Math.max(0, params.maxDepth ?? 1);
  const beamWidth = Math.max(1, params.beamWidth ?? Math.max(maxNodes, 8));
  const maxVisitedNodes = Math.max(maxNodes, params.maxVisitedNodes ?? Math.max(maxNodes * 4, 32));
  const hopDecay = Math.min(1, Math.max(0, params.hopDecay ?? 0.6));
  const useHubPenalty = params.hubPenalty ?? true;
  const pageTypeFilter = params.pageTypes ? new Set(params.pageTypes) : null;

  const seedNodeIds = [...new Set(params.seedNodeIds)].filter((id) => runtime.nodesById.has(id));
  const ranks = new Map<string, number>();
  const bestDepth = new Map<string, number>();
  const visited = new Set<string>();
  const truncatedFrontier = new Set<string>();
  let visitedEdges = 0;
  let maxDepthReached = 0;

  let frontier = seedNodeIds.map((id) => {
    const rank = params.seedScores?.get(id) ?? 1;
    ranks.set(id, rank);
    bestDepth.set(id, 0);
    return { id, rank, depth: 0 };
  });

  while (frontier.length > 0 && visited.size < maxVisitedNodes) {
    frontier.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
    const current = frontier.slice(0, beamWidth);
    const scheduledCurrent = new Set(current.map((item) => item.id));
    for (const omitted of frontier.slice(beamWidth)) {
      const node = runtime.nodesById.get(omitted.id);
      if (node?.kind === "page" || node?.kind === "request") truncatedFrontier.add(omitted.id);
    }
    const next = new Map<string, { id: string; rank: number; depth: number }>();

    for (const item of current) {
      if (visited.size >= maxVisitedNodes) break;
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      truncatedFrontier.delete(item.id);
      maxDepthReached = Math.max(maxDepthReached, item.depth);
      const itemNode = runtime.nodesById.get(item.id);
      // Metadata equality is useful as a label on a selected page, but it is
      // not evidence that every page from the same project/tag/source is
      // relevant. Treat these high-degree nodes as terminal to prevent
      // project-wide false positives and artificial frontier truncation.
      if (itemNode && NON_TRANSITIVE_METADATA_HUBS.has(itemNode.kind)) continue;
      if (item.depth >= maxDepth) {
        if (itemNode?.kind !== "page" && itemNode?.kind !== "request") continue;
        for (const neighbor of neighborsOf(runtime, item.id)) {
          if (visited.has(neighbor.id) || scheduledCurrent.has(neighbor.id)) continue;
          const node = runtime.nodesById.get(neighbor.id);
          if (node?.kind === "page" || node?.kind === "request") {
            truncatedFrontier.add(neighbor.id);
          }
        }
        continue;
      }

      for (const neighbor of neighborsOf(runtime, item.id)) {
        visitedEdges++;
        if (visited.has(neighbor.id)) continue;
        const depth = item.depth + 1;
        const propagated = item.rank * neighbor.weight * hopDecay * hubFactor(runtime, neighbor.id, useHubPenalty);
        if (propagated <= 0) continue;
        if ((bestDepth.get(neighbor.id) ?? Number.POSITIVE_INFINITY) < depth) continue;

        bestDepth.set(neighbor.id, depth);
        ranks.set(neighbor.id, Math.max(ranks.get(neighbor.id) ?? 0, propagated));
        const existing = next.get(neighbor.id);
        if (!existing || propagated > existing.rank) {
          next.set(neighbor.id, { id: neighbor.id, rank: propagated, depth });
        }

        // The request node is a compact O(n) representation of same_request.
        // Traverse its siblings within the same logical hop so callers do not
        // need maxDepth=2 just to recover pages from the same request.
        if (runtime.nodesById.get(neighbor.id)?.kind === "request") {
          for (const sibling of neighborsOf(runtime, neighbor.id)) {
            visitedEdges++;
            if (sibling.id === item.id || visited.has(sibling.id)) continue;
            const siblingRank = propagated * sibling.weight * hubFactor(runtime, sibling.id, useHubPenalty);
            ranks.set(sibling.id, Math.max(ranks.get(sibling.id) ?? 0, siblingRank));
            const siblingExisting = next.get(sibling.id);
            if (!siblingExisting || siblingRank > siblingExisting.rank) {
              bestDepth.set(sibling.id, depth);
              next.set(sibling.id, { id: sibling.id, rank: siblingRank, depth });
            }
          }
        }
      }
    }

    if (visited.size >= maxVisitedNodes) {
      for (const omitted of current) {
        if (visited.has(omitted.id)) continue;
        const node = runtime.nodesById.get(omitted.id);
        if (node?.kind === "page" || node?.kind === "request") truncatedFrontier.add(omitted.id);
      }
    }

    frontier = [...next.values()];
  }

  for (const omitted of frontier) {
    if (visited.has(omitted.id)) continue;
    const node = runtime.nodesById.get(omitted.id);
    if (node?.kind === "page" || node?.kind === "request") truncatedFrontier.add(omitted.id);
  }

  const rankedCandidates = [...visited]
    .map((id) => runtime.nodesById.get(id))
    .filter((node): node is GraphNode => Boolean(node))
    .filter((node) => !pageTypeFilter || node.kind !== "page" || pageTypeFilter.has(node.pageType ?? ""))
    .sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  for (const omitted of rankedCandidates.slice(maxNodes)) {
    if (omitted.kind === "page" || omitted.kind === "request") truncatedFrontier.add(omitted.id);
  }
  const ranked = rankedCandidates.slice(0, maxNodes);

  const nodeIds = new Set(ranked.map((node) => node.id));
  const edges = inducedEdges(runtime, nodeIds);
  return {
    graph: runtime.graph,
    nodes: ranked,
    edges,
    seedNodeIds,
    stats: {
      seedCount: seedNodeIds.length,
      visitedNodes: visited.size,
      visitedEdges,
      emittedNodes: ranked.length,
      emittedEdges: edges.length,
      maxDepthReached,
      truncatedFrontierCount: truncatedFrontier.size,
    },
  };
}
