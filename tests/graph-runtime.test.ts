import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphEdge, GraphNode, WikiGraph } from "../src/core/graph-index.js";
import {
  buildRuntimeGraph,
  expandRuntimeGraphFromSeeds,
} from "../src/core/graph-runtime.js";

function page(id: string, requestId?: string): GraphNode {
  return {
    id: `page:${id}.md`,
    kind: "page",
    label: id,
    path: `${id}.md`,
    pageType: "requirement",
    requestId,
  };
}

function graph(nodes: GraphNode[], edges: GraphEdge[]): WikiGraph {
  return {
    version: 2,
    generatedAt: "2026-08-13T00:00:00.000Z",
    nodes,
    edges,
    warnings: [],
  };
}

test("runtime graph indexes nodes, adjacency, degree and page paths once", () => {
  const a = page("A");
  const b = page("B");
  const source: GraphNode = { id: "source:spec", kind: "source", label: "spec" };
  const runtime = buildRuntimeGraph(graph(
    [a, b, source],
    [
      { from: a.id, to: b.id, kind: "links_to" },
      { from: a.id, to: source.id, kind: "derived_from" },
    ]
  ));

  assert.equal(runtime.nodesById.get(a.id)?.label, "A");
  assert.equal(runtime.pageNodeByPath.get("A.md"), a.id);
  assert.equal(runtime.outgoing.get(a.id)?.length, 2);
  assert.equal(runtime.incoming.get(b.id)?.[0]?.id, a.id);
  assert.equal(runtime.degree.get(a.id), 2);
});

test("seeded expansion visits the same local neighborhood when unrelated graph size grows", () => {
  const seed = page("Seed");
  const nearA = page("NearA");
  const nearB = page("NearB");
  const localEdges: GraphEdge[] = [
    { from: seed.id, to: nearA.id, kind: "links_to" },
    { from: nearA.id, to: nearB.id, kind: "implements" },
  ];

  const small = buildRuntimeGraph(graph([seed, nearA, nearB], localEdges));
  const unrelatedNodes = Array.from({ length: 2_000 }, (_, index) => page(`Far${index}`));
  const unrelatedEdges: GraphEdge[] = unrelatedNodes.slice(1).map((node, index) => ({
    from: unrelatedNodes[index]!.id,
    to: node.id,
    kind: "links_to",
  }));
  const large = buildRuntimeGraph(graph(
    [seed, nearA, nearB, ...unrelatedNodes],
    [...localEdges, ...unrelatedEdges]
  ));

  const params = {
    seedNodeIds: [seed.id],
    maxNodes: 8,
    maxDepth: 2,
    beamWidth: 8,
    maxVisitedNodes: 32,
    hubPenalty: false,
  } as const;
  const smallResult = expandRuntimeGraphFromSeeds(small, params);
  const largeResult = expandRuntimeGraphFromSeeds(large, params);

  assert.deepEqual(
    largeResult.nodes.map((node) => node.id),
    smallResult.nodes.map((node) => node.id)
  );
  assert.equal(largeResult.stats.visitedNodes, smallResult.stats.visitedNodes);
  assert.equal(largeResult.stats.visitedEdges, smallResult.stats.visitedEdges);
  assert.equal(largeResult.stats.visitedNodes, 3);
  assert.equal(largeResult.stats.visitedEdges, 3);
  assert.equal(largeResult.stats.truncatedFrontierCount, 0);
});

test("request hub behaves as one logical hop for same-request siblings", () => {
  const requirement = page("REQ", "REQ-7");
  const implementation = { ...page("IMPL", "REQ-7"), pageType: "implementation" };
  const request: GraphNode = {
    id: "request:REQ_7",
    kind: "request",
    label: "REQ-7",
    requestId: "REQ-7",
  };
  const runtime = buildRuntimeGraph(graph(
    [requirement, implementation, request],
    [
      { from: requirement.id, to: request.id, kind: "same_request" },
      { from: implementation.id, to: request.id, kind: "same_request" },
    ]
  ));

  const result = expandRuntimeGraphFromSeeds(runtime, {
    seedNodeIds: [requirement.id],
    maxNodes: 6,
    maxDepth: 1,
    beamWidth: 6,
    hubPenalty: false,
  });

  assert.equal(result.nodes.some((node) => node.id === implementation.id), true);
  assert.equal(result.stats.maxDepthReached, 1);
});

test("bounded expansion respects beam and visited-node budgets", () => {
  const seed = page("Seed");
  const neighbors = Array.from({ length: 100 }, (_, index) => page(`N${index}`));
  const runtime = buildRuntimeGraph(graph(
    [seed, ...neighbors],
    neighbors.map((node) => ({ from: seed.id, to: node.id, kind: "links_to" as const }))
  ));

  const result = expandRuntimeGraphFromSeeds(runtime, {
    seedNodeIds: [seed.id],
    maxNodes: 6,
    maxDepth: 1,
    beamWidth: 4,
    maxVisitedNodes: 6,
  });

  assert.equal(result.nodes.length <= 6, true);
  assert.equal(result.stats.visitedNodes <= 6, true);
  assert.equal(result.stats.truncatedFrontierCount > 0, true);
});

test("depth-bounded expansion reports an unvisited page frontier without counting metadata hubs", () => {
  const seed = page("Seed");
  const bridge = page("Bridge");
  const target = page("Target");
  const tag: GraphNode = { id: "tag:shared", kind: "tag", label: "shared" };
  const runtime = buildRuntimeGraph(graph(
    [seed, bridge, target, tag],
    [
      { from: seed.id, to: bridge.id, kind: "links_to" },
      { from: bridge.id, to: target.id, kind: "links_to" },
      { from: seed.id, to: tag.id, kind: "has_tag" },
      { from: target.id, to: tag.id, kind: "has_tag" },
    ]
  ));

  const result = expandRuntimeGraphFromSeeds(runtime, {
    seedNodeIds: [seed.id],
    maxNodes: 8,
    maxDepth: 1,
    beamWidth: 8,
    maxVisitedNodes: 8,
  });

  assert.equal(result.nodes.some((node) => node.id === target.id), false);
  assert.equal(result.stats.truncatedFrontierCount, 1);
});

test("metadata hubs do not turn same-project pages into graph evidence", () => {
  const seed = page("LeaseSeed");
  const unrelated = page("TableSortRequest");
  const project: GraphNode = { id: "project:silverfir", kind: "project", label: "SilverFir" };
  const runtime = buildRuntimeGraph(graph(
    [seed, unrelated, project],
    [
      { from: seed.id, to: project.id, kind: "belongs_to_project" },
      { from: unrelated.id, to: project.id, kind: "belongs_to_project" },
    ]
  ));

  const result = expandRuntimeGraphFromSeeds(runtime, {
    seedNodeIds: [seed.id],
    maxNodes: 8,
    maxDepth: 3,
    beamWidth: 8,
    maxVisitedNodes: 8,
  });

  assert.equal(result.nodes.some((node) => node.id === project.id), true);
  assert.equal(result.nodes.some((node) => node.id === unrelated.id), false);
  assert.equal(result.stats.truncatedFrontierCount, 0);
});
