import * as nodePath from "node:path";
import { markdownLinkTargets, wikiLinkTargets } from "./link-resolution.js";
import { readWikiPageRecord, type WikiPageRecord } from "./page-record.js";
import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
} from "./graph-index.js";
import type { GraphNeighbor, RuntimeGraph } from "./graph-runtime.js";

interface RuntimeMutationState {
  nodeIndex: Map<string, number>;
  edgeIndex: Map<string, number>;
  pageByTitle: Map<string, string>;
  pageIdsByBasename: Map<string, Set<string>>;
  pageIdsByRequest: Map<string, Set<string>>;
  warningsByPath: Map<string, Set<string>>;
}

export interface RuntimeGraphMutationStats {
  touchedPaths: number;
  affectedRequestGroups: number;
  affectedRequestPages: number;
  orphanCandidatesChecked: number;
}

const stateByRuntime = new WeakMap<RuntimeGraph, RuntimeMutationState>();

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

const REQUEST_RELATIONS = new Set<GraphEdgeKind>(["implements", "tests", "released_by"]);

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

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}|${edge.kind}|${edge.to}`;
}

function mutableNodes(runtime: RuntimeGraph): Map<string, GraphNode> {
  return runtime.nodesById as Map<string, GraphNode>;
}

function mutableOutgoing(runtime: RuntimeGraph): Map<string, GraphNeighbor[]> {
  return runtime.outgoing as Map<string, GraphNeighbor[]>;
}

function mutableIncoming(runtime: RuntimeGraph): Map<string, GraphNeighbor[]> {
  return runtime.incoming as Map<string, GraphNeighbor[]>;
}

function mutableDegree(runtime: RuntimeGraph): Map<string, number> {
  return runtime.degree as Map<string, number>;
}

function mutablePageByPath(runtime: RuntimeGraph): Map<string, string> {
  return runtime.pageNodeByPath as Map<string, string>;
}

function addSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function removeSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (!values) return;
  values.delete(value);
  if (values.size === 0) map.delete(key);
}

function buildMutationState(runtime: RuntimeGraph): RuntimeMutationState {
  const state: RuntimeMutationState = {
    nodeIndex: new Map(runtime.graph.nodes.map((node, index) => [node.id, index] as const)),
    edgeIndex: new Map(runtime.graph.edges.map((edge, index) => [edgeKey(edge), index] as const)),
    pageByTitle: new Map(),
    pageIdsByBasename: new Map(),
    pageIdsByRequest: new Map(),
    warningsByPath: new Map(),
  };

  for (const node of runtime.nodesById.values()) {
    if (node.kind !== "page" || !node.path) continue;
    state.pageByTitle.set(node.label.toLowerCase(), node.id);
    addSetValue(state.pageIdsByBasename, nodePath.posix.basename(node.path).toLowerCase(), node.id);
    if (node.requestId) addSetValue(state.pageIdsByRequest, node.requestId, node.id);
  }
  for (const warning of runtime.graph.warnings) {
    const separator = warning.indexOf(":");
    if (separator <= 0) continue;
    const relPath = warning.slice(0, separator);
    const warnings = state.warningsByPath.get(relPath) ?? new Set<string>();
    warnings.add(warning);
    state.warningsByPath.set(relPath, warnings);
  }
  stateByRuntime.set(runtime, state);
  return state;
}

function mutationState(runtime: RuntimeGraph): RuntimeMutationState {
  return stateByRuntime.get(runtime) ?? buildMutationState(runtime);
}

export function primeRuntimeGraphMutationState(runtime: RuntimeGraph): void {
  if (!stateByRuntime.has(runtime)) buildMutationState(runtime);
}

function reindexMovedNode(runtime: RuntimeGraph, state: RuntimeMutationState, index: number): void {
  const node = runtime.graph.nodes[index];
  if (node) state.nodeIndex.set(node.id, index);
}

function reindexMovedEdge(runtime: RuntimeGraph, state: RuntimeMutationState, index: number): void {
  const edge = runtime.graph.edges[index];
  if (edge) state.edgeIndex.set(edgeKey(edge), index);
}

function removeNeighbor(
  map: Map<string, GraphNeighbor[]>,
  from: string,
  id: string,
  edgeKind: GraphEdgeKind
): void {
  const neighbors = map.get(from);
  if (!neighbors) return;
  const index = neighbors.findIndex((neighbor) => neighbor.id === id && neighbor.edgeKind === edgeKind);
  if (index >= 0) neighbors.splice(index, 1);
  if (neighbors.length === 0) map.delete(from);
}

function decrementDegree(degree: Map<string, number>, id: string): void {
  const next = (degree.get(id) ?? 0) - 1;
  if (next > 0) degree.set(id, next);
  else degree.delete(id);
}

function removeEdge(runtime: RuntimeGraph, state: RuntimeMutationState, edge: GraphEdge): boolean {
  const key = edgeKey(edge);
  const index = state.edgeIndex.get(key);
  if (index === undefined) return false;

  const outgoing = mutableOutgoing(runtime);
  const incoming = mutableIncoming(runtime);
  const degree = mutableDegree(runtime);
  removeNeighbor(outgoing, edge.from, edge.to, edge.kind);
  removeNeighbor(incoming, edge.to, edge.from, edge.kind);
  decrementDegree(degree, edge.from);
  decrementDegree(degree, edge.to);

  const lastIndex = runtime.graph.edges.length - 1;
  const last = runtime.graph.edges[lastIndex];
  if (index !== lastIndex && last) {
    runtime.graph.edges[index] = last;
    reindexMovedEdge(runtime, state, index);
  }
  runtime.graph.edges.pop();
  state.edgeIndex.delete(key);
  return true;
}

function addNeighbor(
  map: Map<string, GraphNeighbor[]>,
  from: string,
  neighbor: GraphNeighbor
): void {
  const neighbors = map.get(from) ?? [];
  if (!neighbors.some((item) => item.id === neighbor.id && item.edgeKind === neighbor.edgeKind)) {
    neighbors.push(neighbor);
    neighbors.sort((a, b) =>
      b.weight - a.weight || a.edgeKind.localeCompare(b.edgeKind) || a.id.localeCompare(b.id)
    );
  }
  map.set(from, neighbors);
}

function addEdge(runtime: RuntimeGraph, state: RuntimeMutationState, edge: GraphEdge): boolean {
  if (edge.from === edge.to || state.edgeIndex.has(edgeKey(edge))) return false;
  if (!runtime.nodesById.has(edge.from) || !runtime.nodesById.has(edge.to)) return false;

  state.edgeIndex.set(edgeKey(edge), runtime.graph.edges.length);
  runtime.graph.edges.push(edge);
  addNeighbor(mutableOutgoing(runtime), edge.from, {
    id: edge.to,
    edgeKind: edge.kind,
    weight: EDGE_WEIGHTS[edge.kind],
  });
  addNeighbor(mutableIncoming(runtime), edge.to, {
    id: edge.from,
    edgeKind: edge.kind,
    weight: EDGE_WEIGHTS[edge.kind],
  });
  const degree = mutableDegree(runtime);
  degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
  degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  return true;
}

function unregisterPageIndexes(state: RuntimeMutationState, node: GraphNode): void {
  if (node.kind !== "page" || !node.path) return;
  if (state.pageByTitle.get(node.label.toLowerCase()) === node.id) {
    state.pageByTitle.delete(node.label.toLowerCase());
  }
  removeSetValue(state.pageIdsByBasename, nodePath.posix.basename(node.path).toLowerCase(), node.id);
  if (node.requestId) removeSetValue(state.pageIdsByRequest, node.requestId, node.id);
}

function registerPageIndexes(state: RuntimeMutationState, node: GraphNode): void {
  if (node.kind !== "page" || !node.path) return;
  state.pageByTitle.set(node.label.toLowerCase(), node.id);
  addSetValue(state.pageIdsByBasename, nodePath.posix.basename(node.path).toLowerCase(), node.id);
  if (node.requestId) addSetValue(state.pageIdsByRequest, node.requestId, node.id);
}

function removeNode(runtime: RuntimeGraph, state: RuntimeMutationState, id: string): GraphNode | null {
  const nodes = mutableNodes(runtime);
  const node = nodes.get(id);
  if (!node) return null;

  const outgoingEdges = [...(runtime.outgoing.get(id) ?? [])].map((neighbor) => ({
    from: id,
    to: neighbor.id,
    kind: neighbor.edgeKind,
  }));
  const incomingEdges = [...(runtime.incoming.get(id) ?? [])].map((neighbor) => ({
    from: neighbor.id,
    to: id,
    kind: neighbor.edgeKind,
  }));
  for (const edge of [...outgoingEdges, ...incomingEdges]) removeEdge(runtime, state, edge);

  unregisterPageIndexes(state, node);
  if (node.kind === "page" && node.path) mutablePageByPath(runtime).delete(node.path);
  nodes.delete(id);

  const index = state.nodeIndex.get(id);
  if (index !== undefined) {
    const lastIndex = runtime.graph.nodes.length - 1;
    const last = runtime.graph.nodes[lastIndex];
    if (index !== lastIndex && last) {
      runtime.graph.nodes[index] = last;
      reindexMovedNode(runtime, state, index);
    }
    runtime.graph.nodes.pop();
    state.nodeIndex.delete(id);
  }
  return node;
}

function addNode(runtime: RuntimeGraph, state: RuntimeMutationState, node: GraphNode): void {
  if (runtime.nodesById.has(node.id)) return;
  mutableNodes(runtime).set(node.id, node);
  state.nodeIndex.set(node.id, runtime.graph.nodes.length);
  runtime.graph.nodes.push(node);
  if (node.kind === "page" && node.path) {
    mutablePageByPath(runtime).set(node.path, node.id);
    registerPageIndexes(state, node);
  }
}

function cleanupOrphanTypedNodes(
  runtime: RuntimeGraph,
  state: RuntimeMutationState,
  candidateIds: ReadonlySet<string>
): void {
  for (const id of candidateIds) {
    const node = runtime.nodesById.get(id);
    if (!node || node.kind === "page") continue;
    if ((runtime.degree.get(id) ?? 0) === 0) removeNode(runtime, state, id);
  }
}

function resolveLinkTarget(
  runtime: RuntimeGraph,
  state: RuntimeMutationState,
  relFrom: string,
  target: string
): string | null {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.endsWith(".md")) {
    const fromDir = nodePath.posix.dirname(relFrom.replace(/\\/g, "/"));
    const resolved = nodePath.posix.normalize(nodePath.posix.join(fromDir, normalized));
    return runtime.pageNodeByPath.get(resolved) ?? null;
  }

  const byTitle = state.pageByTitle.get(normalized.toLowerCase());
  if (byTitle) return byTitle;
  const candidates = [
    `${normalized}.md`,
    `${normalized.replace(/ /g, "_")}.md`,
    `${normalized.replace(/ /g, "-")}.md`,
  ].map((value) => value.toLowerCase());

  for (const candidate of candidates) {
    const matches = [...(state.pageIdsByBasename.get(nodePath.posix.basename(candidate)) ?? [])]
      .sort((a, b) => a.localeCompare(b));
    if (matches.length > 0) return matches[0] ?? null;
  }
  return null;
}

function pageNodeFromRecord(record: WikiPageRecord): GraphNode {
  return {
    id: pageNodeId(record.path),
    kind: "page",
    label: record.title,
    path: record.path,
    pageType: record.type,
    requestId: record.requestId,
    tags: record.tags,
    sources: record.sources,
    summary: record.passages[0]?.text.replace(/\s+/g, " ").slice(0, 500) ?? "",
  };
}

function addMetadataEdges(runtime: RuntimeGraph, state: RuntimeMutationState, record: WikiPageRecord): void {
  const pageId = pageNodeId(record.path);
  for (const source of record.sources) {
    const sourceId = typedNodeId("source", source);
    addNode(runtime, state, { id: sourceId, kind: "source", label: source });
    addEdge(runtime, state, { from: pageId, to: sourceId, kind: "derived_from" });
  }
  for (const tag of record.tags) {
    const tagId = typedNodeId("tag", tag);
    addNode(runtime, state, { id: tagId, kind: "tag", label: tag });
    addEdge(runtime, state, { from: pageId, to: tagId, kind: "has_tag" });
  }
  if (record.client) {
    const clientId = typedNodeId("client", record.client);
    addNode(runtime, state, { id: clientId, kind: "client", label: record.client });
    addEdge(runtime, state, { from: pageId, to: clientId, kind: "belongs_to_client" });
  }
  if (record.project) {
    const projectId = typedNodeId("project", record.project);
    addNode(runtime, state, { id: projectId, kind: "project", label: record.project });
    addEdge(runtime, state, { from: pageId, to: projectId, kind: "belongs_to_project" });
  }
  if (record.requestId) {
    const requestId = typedNodeId("request", record.requestId);
    addNode(runtime, state, {
      id: requestId,
      kind: "request",
      label: record.requestId,
      requestId: record.requestId,
    });
    addEdge(runtime, state, { from: pageId, to: requestId, kind: "same_request" });
  }
}

function addOutgoingLinks(runtime: RuntimeGraph, state: RuntimeMutationState, record: WikiPageRecord): void {
  const warnings = new Set<string>();
  const from = pageNodeId(record.path);
  for (const target of [...wikiLinkTargets(record.raw), ...markdownLinkTargets(record.raw)]) {
    const resolved = resolveLinkTarget(runtime, state, record.path, target);
    if (resolved) addEdge(runtime, state, { from, to: resolved, kind: "links_to" });
    else warnings.add(`${record.path}: unresolved link '${target}'`);
  }
  state.warningsByPath.set(record.path, warnings);
}

function removeRequestRelations(runtime: RuntimeGraph, state: RuntimeMutationState, requestId: string): void {
  const group = state.pageIdsByRequest.get(requestId) ?? new Set<string>();
  const groupSet = new Set(group);
  for (const pageId of group) {
    for (const neighbor of [...(runtime.outgoing.get(pageId) ?? [])]) {
      if (REQUEST_RELATIONS.has(neighbor.edgeKind) && groupSet.has(neighbor.id)) {
        removeEdge(runtime, state, { from: pageId, to: neighbor.id, kind: neighbor.edgeKind });
      }
    }
  }
}

function addRequestRelations(runtime: RuntimeGraph, state: RuntimeMutationState, requestId: string): void {
  const group = [...(state.pageIdsByRequest.get(requestId) ?? [])]
    .map((id) => runtime.nodesById.get(id))
    .filter((node): node is GraphNode => Boolean(node));
  const byType = new Map<string, string[]>();
  for (const node of group) {
    const bucket = byType.get(node.pageType ?? "") ?? [];
    bucket.push(node.id);
    byType.set(node.pageType ?? "", bucket);
  }
  const requests = byType.get("request") ?? [];
  const requirements = byType.get("requirement") ?? [];
  const implementations = byType.get("implementation") ?? [];
  const tests = byType.get("test_result") ?? [];
  const releases = byType.get("release") ?? [];
  for (const req of [...requests, ...requirements]) {
    for (const impl of implementations) addEdge(runtime, state, { from: req, to: impl, kind: "implements" });
  }
  for (const target of [...requirements, ...implementations]) {
    for (const testResult of tests) addEdge(runtime, state, { from: target, to: testResult, kind: "tests" });
  }
  for (const target of [...requests, ...implementations]) {
    for (const release of releases) addEdge(runtime, state, { from: target, to: release, kind: "released_by" });
  }
}

function refreshWarnings(runtime: RuntimeGraph, state: RuntimeMutationState): void {
  runtime.graph.warnings = [...state.warningsByPath.values()]
    .flatMap((warnings) => [...warnings])
    .sort((a, b) => a.localeCompare(b));
}

export async function patchRuntimeGraphPaths(
  runtime: RuntimeGraph,
  wikiRoot: string,
  relPaths: readonly string[]
): Promise<RuntimeGraphMutationStats> {
  const state = mutationState(runtime);
  const affectedRequests = new Set<string>();
  const orphanCandidates = new Set<string>();
  const touchedPaths = [...new Set(relPaths)];

  for (const inputPath of touchedPaths) {
    const relPath = inputPath.replace(/\\/g, "/");
    const pageId = pageNodeId(relPath);
    const existing = runtime.nodesById.get(pageId);
    for (const neighbor of [
      ...(runtime.outgoing.get(pageId) ?? []),
      ...(runtime.incoming.get(pageId) ?? []),
    ]) {
      const adjacent = runtime.nodesById.get(neighbor.id);
      if (adjacent && adjacent.kind !== "page") orphanCandidates.add(adjacent.id);
    }
    const preservedIncomingLinks = [...(runtime.incoming.get(pageId) ?? [])]
      .filter((neighbor) => neighbor.edgeKind === "links_to")
      .map((neighbor) => ({ from: neighbor.id, to: pageId, kind: "links_to" as const }));
    if (existing?.requestId) affectedRequests.add(existing.requestId);
    removeNode(runtime, state, pageId);
    state.warningsByPath.delete(relPath);

    const record = await readWikiPageRecord(wikiRoot, relPath).catch(() => null);
    if (!record) continue;
    addNode(runtime, state, pageNodeFromRecord(record));
    addMetadataEdges(runtime, state, record);
    addOutgoingLinks(runtime, state, record);
    if (record.requestId) affectedRequests.add(record.requestId);
    for (const edge of preservedIncomingLinks) addEdge(runtime, state, edge);
  }

  for (const requestId of affectedRequests) removeRequestRelations(runtime, state, requestId);
  for (const requestId of affectedRequests) addRequestRelations(runtime, state, requestId);
  cleanupOrphanTypedNodes(runtime, state, orphanCandidates);
  refreshWarnings(runtime, state);
  const affectedRequestPages = [...affectedRequests].reduce(
    (sum, requestId) => sum + (state.pageIdsByRequest.get(requestId)?.size ?? 0),
    0
  );
  runtime.graph.generatedAt = new Date().toISOString();
  return {
    touchedPaths: touchedPaths.length,
    affectedRequestGroups: affectedRequests.size,
    affectedRequestPages,
    orphanCandidatesChecked: orphanCandidates.size,
  };
}
