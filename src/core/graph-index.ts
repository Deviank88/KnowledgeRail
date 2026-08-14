import * as nodePath from "node:path";
import { atomicWriteText } from "./fs-service.js";
import { markdownLinkTargets, wikiLinkTargets } from "./link-resolution.js";
import { wikiMetaDir } from "./manifest-service.js";
import {
  getRetrievalIndexGeneration,
  getWikiPageRecords,
  refreshRetrievalIndex,
} from "./retrieval-index.js";
import {
  ensureDir,
  readFileSafe,
} from "./utils.js";
import { normalizeSearchText, tokenizeSearchText } from "./text-analysis.js";

export type GraphNodeKind =
  | "page"
  | "request"
  | "requirement"
  | "implementation"
  | "test_result"
  | "release"
  | "source"
  | "tag"
  | "client"
  | "project"
  | "api"
  | "data_model";

export type GraphEdgeKind =
  | "links_to"
  | "derived_from"
  | "same_request"
  | "implements"
  | "tests"
  | "released_by"
  | "has_tag"
  | "belongs_to_client"
  | "belongs_to_project";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  path?: string;
  pageType?: string;
  requestId?: string;
  tags?: string[];
  sources?: string[];
  summary?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface WikiGraph {
  version: 2;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

export interface GraphQueryResult {
  graph: WikiGraph;
  nodes: GraphNode[];
  edges: GraphEdge[];
  seedNodeIds: string[];
}

const graphCache = new Map<string, {
  graph: WikiGraph;
  builtAt: number;
  retrievalGeneration: number;
  persisted: boolean;
}>();

export function graphFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "graph.json");
}

export function graphReportFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "graph-report.md");
}

function tokenize(input: string): string[] {
  return tokenizeSearchText(input).filter((term) => term.length >= 2);
}

function slug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

function pageNodeId(relPath: string): string {
  return `page:${relPath}`;
}

function typedNodeId(kind: GraphNodeKind, value: string): string {
  return `${kind}:${slug(value)}`;
}

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  if (edge.from === edge.to) return;
  edges.set(`${edge.from}|${edge.kind}|${edge.to}`, edge);
}

function scoreNode(node: GraphNode, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const text = normalizeSearchText(
    [
      node.label,
      node.kind,
      node.pageType ?? "",
      node.requestId ?? "",
      node.tags?.join(" ") ?? "",
      node.sources?.join(" ") ?? "",
      node.summary ?? "",
      node.path ?? "",
    ].join(" ")
  );
  let score = 0;
  for (const term of queryTerms) {
    if (text.includes(term)) score += node.kind === "page" ? 2 : 1;
    if (normalizeSearchText(node.label).includes(term)) score += 4;
  }
  return score;
}

function resolveWikiTarget(
  relFrom: string,
  target: string,
  titleIndex: Map<string, string>,
  pathSet: Set<string>
): string | null {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.endsWith(".md")) {
    const fromDir = nodePath.posix.dirname(relFrom.replace(/\\/g, "/"));
    const resolved = nodePath.posix.normalize(nodePath.posix.join(fromDir, normalized));
    return pathSet.has(resolved) ? resolved : null;
  }
  const candidates = [
    `${normalized}.md`,
    `${normalized.replace(/ /g, "_")}.md`,
    `${normalized.replace(/ /g, "-")}.md`,
  ].map((value) => value.toLowerCase());
  for (const [title, path] of titleIndex) {
    if (title === normalized.toLowerCase()) return path;
  }
  for (const path of pathSet) {
    const lower = path.toLowerCase();
    if (candidates.some((candidate) => lower === candidate || lower.endsWith(`/${candidate}`))) {
      return path;
    }
  }
  return null;
}

async function persistGraph(wikiRoot: string, graph: WikiGraph): Promise<void> {
  await ensureDir(wikiMetaDir(wikiRoot));
  await atomicWriteText(graphFile(wikiRoot), JSON.stringify(graph, null, 2) + "\n");
  await atomicWriteText(graphReportFile(wikiRoot), formatGraphReport(graph));
}

export async function buildWikiGraph(
  wikiRoot: string,
  options: { persist?: boolean } = {}
): Promise<WikiGraph> {
  const records = await getWikiPageRecords(wikiRoot, true, { persist: options.persist });

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: string[] = [];
  const pageByRequest = new Map<string, string[]>();
  const pageByTypeAndRequest = new Map<string, string[]>();
  const titleIndex = new Map<string, string>();
  const pathSet = new Set(records.map((record) => record.path));
  const rawByPath = new Map<string, string>();

  for (const record of records.sort((a, b) => a.path.localeCompare(b.path))) {
    const relPath = record.path;
    rawByPath.set(relPath, record.raw);
    const type = record.type;
    const title = record.title;
    const requestId = record.requestId;
    const tags = record.tags;
    const sources = record.sources;
    const client = record.client;
    const project = record.project;
    const id = pageNodeId(relPath);

    titleIndex.set(title.toLowerCase(), relPath);
    addNode(nodes, {
      id,
      kind: "page",
      label: title,
      path: relPath,
      pageType: type,
      requestId,
      tags,
      sources,
      summary: record.passages[0]?.text.replace(/\s+/g, " ").slice(0, 500) ?? "",
    });

    for (const source of sources) {
      const sourceId = typedNodeId("source", source);
      addNode(nodes, { id: sourceId, kind: "source", label: source });
      addEdge(edges, { from: id, to: sourceId, kind: "derived_from" });
    }
    for (const tag of tags) {
      const tagId = typedNodeId("tag", tag);
      addNode(nodes, { id: tagId, kind: "tag", label: tag });
      addEdge(edges, { from: id, to: tagId, kind: "has_tag" });
    }
    if (client) {
      const clientId = typedNodeId("client", client);
      addNode(nodes, { id: clientId, kind: "client", label: client });
      addEdge(edges, { from: id, to: clientId, kind: "belongs_to_client" });
    }
    if (project) {
      const projectId = typedNodeId("project", project);
      addNode(nodes, { id: projectId, kind: "project", label: project });
      addEdge(edges, { from: id, to: projectId, kind: "belongs_to_project" });
    }
    if (requestId) {
      const requestNodeId = typedNodeId("request", requestId);
      addNode(nodes, { id: requestNodeId, kind: "request", label: requestId, requestId });
      addEdge(edges, { from: id, to: requestNodeId, kind: "same_request" });
      const bucket = pageByRequest.get(requestId) ?? [];
      bucket.push(id);
      pageByRequest.set(requestId, bucket);
      const typeBucket = pageByTypeAndRequest.get(`${requestId}:${type}`) ?? [];
      typeBucket.push(id);
      pageByTypeAndRequest.set(`${requestId}:${type}`, typeBucket);
    }
  }

  for (const [relPath, raw] of rawByPath) {
    const fromId = pageNodeId(relPath);
    for (const target of [...wikiLinkTargets(raw), ...markdownLinkTargets(raw)]) {
      const resolved = resolveWikiTarget(relPath, target, titleIndex, pathSet);
      if (resolved) {
        addEdge(edges, { from: fromId, to: pageNodeId(resolved), kind: "links_to" });
      } else {
        warnings.push(`${relPath}: link non risolto '${target}'`);
      }
    }
  }

  for (const requestId of pageByRequest.keys()) {
    const requests = pageByTypeAndRequest.get(`${requestId}:request`) ?? [];
    const requirements = pageByTypeAndRequest.get(`${requestId}:requirement`) ?? [];
    const implementations = pageByTypeAndRequest.get(`${requestId}:implementation`) ?? [];
    const tests = pageByTypeAndRequest.get(`${requestId}:test_result`) ?? [];
    const releases = pageByTypeAndRequest.get(`${requestId}:release`) ?? [];
    for (const req of [...requests, ...requirements]) {
      for (const impl of implementations) addEdge(edges, { from: req, to: impl, kind: "implements" });
    }
    for (const target of [...requirements, ...implementations]) {
      for (const test of tests) addEdge(edges, { from: target, to: test, kind: "tests" });
    }
    for (const target of [...requests, ...implementations]) {
      for (const release of releases) addEdge(edges, { from: target, to: release, kind: "released_by" });
    }
  }

  const graph: WikiGraph = {
    version: 2,
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to)
    ),
    warnings: [...new Set(warnings)].sort(),
  };

  const persisted = options.persist !== false;
  if (persisted) await persistGraph(wikiRoot, graph);
  graphCache.set(nodePath.resolve(wikiRoot), {
    graph,
    builtAt: Date.now(),
    retrievalGeneration: getRetrievalIndexGeneration(wikiRoot),
    persisted,
  });
  return graph;
}

export async function getWikiGraph(
  wikiRoot: string,
  force = false,
  options: { persist?: boolean } = {}
): Promise<WikiGraph> {
  const root = nodePath.resolve(wikiRoot);
  const cached = graphCache.get(root);
  if (!force && cached) {
    await refreshRetrievalIndex(wikiRoot, { persist: options.persist });
    if (cached.retrievalGeneration === getRetrievalIndexGeneration(wikiRoot)) {
      if (options.persist !== false && !cached.persisted) {
        await persistGraph(wikiRoot, cached.graph);
        cached.persisted = true;
      }
      return cached.graph;
    }
  }
  return buildWikiGraph(wikiRoot, options);
}

export function markWikiGraphSynchronized(wikiRoot: string): void {
  const cached = graphCache.get(nodePath.resolve(wikiRoot));
  if (cached) {
    cached.retrievalGeneration = getRetrievalIndexGeneration(wikiRoot);
    cached.persisted = false;
  }
}

export function invalidateWikiGraph(wikiRoot: string): void {
  graphCache.delete(nodePath.resolve(wikiRoot));
}

export async function readGraph(wikiRoot: string): Promise<WikiGraph | null> {
  const raw = await readFileSafe(graphFile(wikiRoot));
  if (!raw) return null;
  try {
    const graph = JSON.parse(raw) as WikiGraph;
    if (graph.version !== 2 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
    return graph;
  } catch {
    return null;
  }
}

export function queryWikiGraph(
  graph: WikiGraph,
  params: {
    query: string;
    maxNodes?: number;
    maxDepth?: number;
    pageTypes?: string[];
  }
): GraphQueryResult {
  const maxNodes = params.maxNodes ?? 12;
  const maxDepth = params.maxDepth ?? 1;
  const queryTerms = tokenize(params.query);
  const pageTypeFilter = params.pageTypes ? new Set(params.pageTypes) : null;
  const scored = graph.nodes
    .filter((node) => !pageTypeFilter || node.kind !== "page" || pageTypeFilter.has(node.pageType ?? ""))
    .map((node) => ({ node, score: scoreNode(node, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

  const edgeWeights: Record<GraphEdgeKind, number> = {
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
  const included = new Set<string>();
  const ranks = new Map<string, number>();
  const seedLimit = Math.min(scored.length, Math.max(1, Math.ceil(maxNodes / 2)));
  const frontier = scored.slice(0, seedLimit).map((item) => item.node.id);
  const seedNodeIds = [...frontier];
  const adjacency = new Map<string, Array<{ id: string; weight: number }>>();
  for (const edge of graph.edges) {
    const forward = adjacency.get(edge.from) ?? [];
    forward.push({ id: edge.to, weight: edgeWeights[edge.kind] });
    adjacency.set(edge.from, forward);
    const reverse = adjacency.get(edge.to) ?? [];
    reverse.push({ id: edge.from, weight: edgeWeights[edge.kind] });
    adjacency.set(edge.to, reverse);
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const item of scored.slice(0, seedLimit)) ranks.set(item.node.id, item.score);
  let current = frontier.map((id) => ({ id, rank: ranks.get(id) ?? 1 }));
  for (let depth = 0; depth <= maxDepth && included.size < maxNodes; depth++) {
    const next = new Map<string, number>();
    current.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
    for (const { id, rank } of current) {
      if (included.size >= maxNodes) break;
      if (!included.has(id)) included.add(id);
      if (depth >= maxDepth) continue;
      for (const neighbor of adjacency.get(id) ?? []) {
        if (included.has(neighbor.id)) continue;
        const propagated = rank * neighbor.weight * 0.6;
        next.set(neighbor.id, Math.max(next.get(neighbor.id) ?? 0, propagated));
        ranks.set(neighbor.id, Math.max(ranks.get(neighbor.id) ?? 0, propagated));
        // request hubs encode same_request in O(n) edges but behave as one logical hop.
        if (nodesById.get(neighbor.id)?.kind === "request") {
          for (const sibling of adjacency.get(neighbor.id) ?? []) {
            if (sibling.id === id || included.has(sibling.id)) continue;
            const siblingRank = propagated * sibling.weight;
            next.set(sibling.id, Math.max(next.get(sibling.id) ?? 0, siblingRank));
            ranks.set(sibling.id, Math.max(ranks.get(sibling.id) ?? 0, siblingRank));
          }
        }
      }
    }
    current = [...next].map(([id, rank]) => ({ id, rank }));
  }

  const nodes = graph.nodes
    .filter((node) => included.has(node.id))
    .filter((node) => !pageTypeFilter || node.kind !== "page" || pageTypeFilter.has(node.pageType ?? ""))
    .sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, maxNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  return { graph, nodes, edges, seedNodeIds };
}

export function formatGraphQueryResult(result: GraphQueryResult): string {
  const pageNodes = result.nodes.filter((node) => node.kind === "page");
  const lines = [
    "# Graph query",
    "",
    `> Nodi inclusi: ${result.nodes.length}`,
    `> Relazioni incluse: ${result.edges.length}`,
    `> Seed: ${result.seedNodeIds.length}`,
    "",
    "## Nodi",
    "",
  ];
  for (const node of result.nodes) {
    lines.push(
      `- ${node.kind}: ${node.label}${node.path ? ` (${node.path})` : ""}${
        node.requestId ? ` [${node.requestId}]` : ""
      }`
    );
  }
  lines.push("", "## Relazioni", "");
  if (result.edges.length === 0) lines.push("_Nessuna relazione nel sotto-grafo._");
  const labels = new Map(result.nodes.map((node) => [node.id, node.label]));
  for (const edge of result.edges) {
    lines.push(`- ${labels.get(edge.from) ?? edge.from} --${edge.kind}--> ${labels.get(edge.to) ?? edge.to}`);
  }
  lines.push("", "## Pagine suggerite", "");
  if (pageNodes.length === 0) lines.push("_Nessuna pagina suggerita._");
  for (const node of pageNodes) {
    lines.push(`- ${node.path}: ${node.label}`);
  }
  return lines.join("\n");
}

export function formatGraphReport(graph: WikiGraph): string {
  const byKind = new Map<string, number>();
  for (const node of graph.nodes) byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + 1);
  const byEdge = new Map<string, number>();
  for (const edge of graph.edges) byEdge.set(edge.kind, (byEdge.get(edge.kind) ?? 0) + 1);
  return [
    "# Graph report",
    "",
    `Generated: ${graph.generatedAt}`,
    `Nodes: ${graph.nodes.length}`,
    `Edges: ${graph.edges.length}`,
    "",
    "## Nodes by kind",
    "",
    ...[...byKind.entries()].sort().map(([kind, count]) => `- ${kind}: ${count}`),
    "",
    "## Edges by kind",
    "",
    ...[...byEdge.entries()].sort().map(([kind, count]) => `- ${kind}: ${count}`),
    "",
    "## Warnings",
    "",
    ...(graph.warnings.length === 0 ? ["_No warnings._"] : graph.warnings.map((warning) => `- ${warning}`)),
    "",
  ].join("\n");
}

export function graphSummaryForPagePaths(graph: WikiGraph, pagePaths: string[]): string {
  const pageIds = new Set(pagePaths.map(pageNodeId));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const relevantEdges = graph.edges.filter((edge) => pageIds.has(edge.from) || pageIds.has(edge.to));
  if (relevantEdges.length === 0) return "";
  const lines = ["## Sintesi graph-based", ""];
  for (const edge of relevantEdges.slice(0, 40)) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) continue;
    lines.push(`- ${from.label} --${edge.kind}--> ${to.label}`);
  }
  lines.push("");
  return lines.join("\n");
}
