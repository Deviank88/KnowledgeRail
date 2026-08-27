import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { atomicWriteText } from "./fs-service.js";
import {
  usingDerivedCheckpointLock,
  type DerivedCheckpointLock,
} from "./checkpoint-lock.js";
import { registerWorkspaceState, touchWorkspaceState } from "./workspace-state.js";
import { markdownLinkTargets, wikiLinkTargets } from "./link-resolution.js";
import { wikiMetaDir } from "./manifest-service.js";
import {
  getRetrievalCorpusRevision,
  getRetrievalIndexGeneration,
  getRetrievalPersistenceIdentity,
  getVerifiedWikiCorpus,
} from "./retrieval-index.js";
import {
  ensureDir,
} from "./utils.js";
import { normalizeSearchText, tokenizeSearchText } from "./text-analysis.js";
import type { WikiPageRecord } from "./page-record.js";
import {
  GraphCheckpointBoundsError,
  graphArtifactToken,
  graphDeltaFile,
  readGraphCheckpoint,
  serializeGraphCheckpoint,
  serializeGraphDelta,
  type GraphDeltaInput,
  type GraphCheckpointFallbackReason,
  type GraphCheckpointWriteBoundsReason,
} from "./graph-checkpoint.js";
import { retrievalArtifactToken } from "./retrieval-checkpoint.js";

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

export interface WikiGraphDiagnostics {
  recovery: "restored" | "rebuilt";
  fallbackReason: GraphCheckpointFallbackReason;
  inputCorpusRevision: string;
  persisted: boolean;
  persistenceReason: GraphPersistenceSkipReason;
  deltaCount: number;
}

export type GraphPersistenceSkipReason =
  | GraphCheckpointWriteBoundsReason
  | "retrieval_not_persisted"
  | null;

const graphCache = new Map<string, {
  graph: WikiGraph;
  builtAt: number;
  retrievalGeneration: number;
  corpusRevision: string;
  persistedRevision: string | null;
  persisted: boolean;
  persistenceReason: GraphPersistenceSkipReason;
  artifactToken: string | null;
  deltaCount: number;
  deltaBytes: number;
  fallbackReason: GraphCheckpointFallbackReason;
}>();

const GRAPH_DELTA_COMPACT_COUNT = 100;
const GRAPH_DELTA_COMPACT_BYTES = 4 * 1024 * 1024;

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
  pathSet: Set<string>,
  pathSuffixIndex: ReadonlyMap<string, string>
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
  const titleMatch = titleIndex.get(normalized.toLowerCase());
  if (titleMatch) return titleMatch;
  for (const candidate of candidates) {
    const pathMatch = pathSuffixIndex.get(candidate);
    if (pathMatch) return pathMatch;
  }
  return null;
}

function buildPathSuffixIndex(paths: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const relPath of paths) {
    const segments = relPath.toLowerCase().split("/");
    for (let start = 0; start < segments.length; start++) {
      const suffix = segments.slice(start).join("/");
      // Sorted canonical paths make ambiguous basename resolution stable and
      // preserve the legacy resolver's first-match behavior.
      if (!index.has(suffix)) index.set(suffix, relPath);
    }
  }
  return index;
}

async function persistGraph(
  wikiRoot: string,
  graph: WikiGraph,
  inputCorpusRevision: string,
  checkpointLock?: DerivedCheckpointLock
): Promise<{ artifactToken: string; persisted: boolean; persistenceReason: GraphPersistenceSkipReason }> {
  const retrieval = getRetrievalPersistenceIdentity(wikiRoot);
  if (retrieval?.persistenceStatus === "skipped_oversized") {
    return {
      artifactToken: await graphArtifactToken(wikiRoot),
      persisted: false,
      persistenceReason: "retrieval_not_persisted",
    };
  }
  if (!retrieval || retrieval.persistedRevision !== inputCorpusRevision || !retrieval.artifactToken) {
    throw new Error("Graph checkpoint input revision is not durably synchronized.");
  }
  let serialized: string;
  try {
    serialized = serializeGraphCheckpoint(graph, inputCorpusRevision);
  } catch (error) {
    if (!(error instanceof GraphCheckpointBoundsError)) throw error;
    return {
      artifactToken: await graphArtifactToken(wikiRoot),
      persisted: false,
      persistenceReason: error.reason,
    };
  }
  await usingDerivedCheckpointLock(wikiRoot, checkpointLock, async () => {
    await ensureDir(wikiMetaDir(wikiRoot));
    const diskToken = await retrievalArtifactToken(wikiRoot);
    if (diskToken !== retrieval.artifactToken) {
      throw new Error("Graph checkpoint input revision changed before persistence; rebuild from canonical records.");
    }
    await atomicWriteText(graphFile(wikiRoot), serialized);
    await fs.rm(graphDeltaFile(wikiRoot), { force: true });
    await atomicWriteText(graphReportFile(wikiRoot), formatGraphReport(graph));
  });
  return {
    artifactToken: await graphArtifactToken(wikiRoot),
    persisted: true,
    persistenceReason: null,
  };
}

async function persistGraphDelta(
  wikiRoot: string,
  baseRevision: string,
  newRevision: string,
  delta: GraphDeltaInput,
  expectedGraphToken: string,
  checkpointLock?: DerivedCheckpointLock
): Promise<{
  artifactToken: string;
  bytes: number;
  persisted: boolean;
  persistenceReason: GraphPersistenceSkipReason;
}> {
  const retrieval = getRetrievalPersistenceIdentity(wikiRoot);
  if (retrieval?.persistenceStatus === "skipped_oversized") {
    return {
      artifactToken: await graphArtifactToken(wikiRoot),
      bytes: 0,
      persisted: false,
      persistenceReason: "retrieval_not_persisted",
    };
  }
  if (!retrieval || retrieval.persistedRevision !== newRevision || !retrieval.artifactToken) {
    throw new Error("Graph delta input revision is not durably synchronized.");
  }
  let serialized: string;
  try {
    serialized = serializeGraphDelta(baseRevision, newRevision, delta);
  } catch (error) {
    if (!(error instanceof GraphCheckpointBoundsError)) throw error;
    return {
      artifactToken: await graphArtifactToken(wikiRoot),
      bytes: 0,
      persisted: false,
      persistenceReason: error.reason,
    };
  }
  await usingDerivedCheckpointLock(wikiRoot, checkpointLock, async () => {
    await ensureDir(wikiMetaDir(wikiRoot));
    const [retrievalToken, currentGraphToken] = await Promise.all([
      retrievalArtifactToken(wikiRoot),
      graphArtifactToken(wikiRoot),
    ]);
    if (retrievalToken !== retrieval.artifactToken || currentGraphToken !== expectedGraphToken) {
      throw new Error("Graph checkpoint changed before delta persistence; rebuild from canonical records.");
    }
    await fs.appendFile(graphDeltaFile(wikiRoot), serialized, "utf8");
  });
  return {
    artifactToken: await graphArtifactToken(wikiRoot),
    bytes: Buffer.byteLength(serialized),
    persisted: true,
    persistenceReason: null,
  };
}

export async function buildWikiGraph(
  wikiRoot: string,
  options: {
    persist?: boolean;
    corpus?: { records: WikiPageRecord[]; corpusRevision: string; generation: number };
    fallbackReason?: GraphCheckpointFallbackReason;
  } = {}
): Promise<WikiGraph> {
  const corpus = options.corpus ?? await getVerifiedWikiCorpus(wikiRoot, true, { persist: options.persist });
  const records = corpus.records.sort((left, right) => left.path.localeCompare(right.path));

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: string[] = [];
  const pageByRequest = new Map<string, string[]>();
  const pageByTypeAndRequest = new Map<string, string[]>();
  const titleIndex = new Map<string, string>();
  const pathSet = new Set(records.map((record) => record.path));
  const pathSuffixIndex = buildPathSuffixIndex([...pathSet]);
  const rawByPath = new Map<string, string>();

  for (const record of records) {
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
      const resolved = resolveWikiTarget(relPath, target, titleIndex, pathSet, pathSuffixIndex);
      if (resolved) {
        addEdge(edges, { from: fromId, to: pageNodeId(resolved), kind: "links_to" });
      } else {
        warnings.push(`${relPath}: unresolved link '${target}'`);
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

  const persistenceRequested = options.persist !== false;
  const persistence = persistenceRequested
    ? await persistGraph(wikiRoot, graph, corpus.corpusRevision)
    : {
      artifactToken: await graphArtifactToken(wikiRoot),
      persisted: false,
      persistenceReason: null,
    };
  const cacheRoot = nodePath.resolve(wikiRoot);
  graphCache.set(cacheRoot, {
    graph,
    builtAt: Date.now(),
    retrievalGeneration: corpus.generation,
    corpusRevision: corpus.corpusRevision,
    persistedRevision: persistence.persisted ? corpus.corpusRevision : null,
    persisted: persistence.persisted,
    persistenceReason: persistence.persistenceReason,
    artifactToken: persistence.artifactToken,
    deltaCount: 0,
    deltaBytes: 0,
    fallbackReason: options.fallbackReason ?? "graph_missing",
  });
  registerWorkspaceState(cacheRoot, "graph-index", () => graphCache.delete(cacheRoot));
  return graph;
}

export async function getWikiGraph(
  wikiRoot: string,
  force = false,
  options: { persist?: boolean } = {}
): Promise<WikiGraph> {
  const root = nodePath.resolve(wikiRoot);
  touchWorkspaceState(root);
  const corpus = await getVerifiedWikiCorpus(wikiRoot, force, { persist: options.persist });
  const cached = graphCache.get(root);
  if (!force && cached) {
    if (cached.retrievalGeneration === corpus.generation && cached.corpusRevision === corpus.corpusRevision) {
      if (options.persist !== false && !cached.persisted) {
        const persistence = await persistGraph(wikiRoot, cached.graph, corpus.corpusRevision);
        cached.persisted = persistence.persisted;
        cached.persistenceReason = persistence.persistenceReason;
        cached.persistedRevision = persistence.persisted ? corpus.corpusRevision : cached.persistedRevision;
        cached.artifactToken = persistence.artifactToken;
        cached.deltaCount = 0;
        cached.deltaBytes = 0;
      }
      return cached.graph;
    }
  }
  if (!force) {
    const checkpoint = await readGraphCheckpoint(wikiRoot);
    if (checkpoint.kind === "v3" && checkpoint.inputCorpusRevision === corpus.corpusRevision) {
      graphCache.set(root, {
        graph: checkpoint.graph,
        builtAt: Date.now(),
        retrievalGeneration: corpus.generation,
        corpusRevision: corpus.corpusRevision,
        persistedRevision: checkpoint.inputCorpusRevision,
        persisted: true,
        persistenceReason: null,
        artifactToken: checkpoint.artifactToken,
        deltaCount: checkpoint.deltaCount,
        deltaBytes: checkpoint.deltaBytes,
        fallbackReason: "none",
      });
      registerWorkspaceState(root, "graph-index", () => graphCache.delete(root));
      return checkpoint.graph;
    }
    const fallbackReason = checkpoint.kind === "v3"
      ? "graph_revision_mismatch"
      : checkpoint.fallbackReason;
    return buildWikiGraph(wikiRoot, { ...options, corpus, fallbackReason });
  }
  return buildWikiGraph(wikiRoot, { ...options, corpus, fallbackReason: "force_rebuild" });
}

export function getWikiGraphDiagnostics(wikiRoot: string): WikiGraphDiagnostics | null {
  const cached = graphCache.get(nodePath.resolve(wikiRoot));
  if (!cached) return null;
  return {
    recovery: cached.fallbackReason === "none" ? "restored" : "rebuilt",
    fallbackReason: cached.fallbackReason,
    inputCorpusRevision: cached.corpusRevision,
    persisted: cached.persisted,
    persistenceReason: cached.persistenceReason,
    deltaCount: cached.deltaCount,
  };
}

export function markWikiGraphSynchronized(wikiRoot: string): void {
  const cached = graphCache.get(nodePath.resolve(wikiRoot));
  if (cached) {
    cached.retrievalGeneration = getRetrievalIndexGeneration(wikiRoot);
    cached.corpusRevision = getRetrievalCorpusRevision(wikiRoot) ?? cached.corpusRevision;
    cached.persisted = false;
  }
}

export async function persistSynchronizedWikiGraph(
  wikiRoot: string,
  delta?: GraphDeltaInput | null,
  options: { checkpointLock?: DerivedCheckpointLock } = {}
): Promise<boolean> {
  const cached = graphCache.get(nodePath.resolve(wikiRoot));
  if (!cached || cached.persisted) return Boolean(cached);
  if (delta && cached.persistedRevision && cached.artifactToken) {
    const persistence = await persistGraphDelta(
      wikiRoot,
      cached.persistedRevision,
      cached.corpusRevision,
      delta,
      cached.artifactToken,
      options.checkpointLock
    );
    if (persistence.persisted) {
      cached.artifactToken = persistence.artifactToken;
      cached.persistedRevision = cached.corpusRevision;
      cached.deltaCount++;
      cached.deltaBytes += persistence.bytes;
      cached.persistenceReason = null;
    } else {
      const snapshot = await persistGraph(
        wikiRoot,
        cached.graph,
        cached.corpusRevision,
        options.checkpointLock
      );
      if (!snapshot.persisted) {
        cached.persistenceReason = snapshot.persistenceReason ?? persistence.persistenceReason;
        return false;
      }
      cached.artifactToken = snapshot.artifactToken;
      cached.persistedRevision = cached.corpusRevision;
      cached.deltaCount = 0;
      cached.deltaBytes = 0;
      cached.persistenceReason = null;
    }
  } else {
    const persistence = await persistGraph(
      wikiRoot,
      cached.graph,
      cached.corpusRevision,
      options.checkpointLock
    );
    if (!persistence.persisted) {
      cached.persistenceReason = persistence.persistenceReason;
      return false;
    }
    cached.artifactToken = persistence.artifactToken;
    cached.persistedRevision = cached.corpusRevision;
    cached.deltaCount = 0;
    cached.deltaBytes = 0;
    cached.persistenceReason = null;
  }
  cached.persisted = true;
  if (cached.deltaCount >= GRAPH_DELTA_COMPACT_COUNT || cached.deltaBytes >= GRAPH_DELTA_COMPACT_BYTES) {
    const compacted = await persistGraph(
      wikiRoot,
      cached.graph,
      cached.corpusRevision,
      options.checkpointLock
    );
    if (compacted.persisted) {
      cached.artifactToken = compacted.artifactToken;
      cached.deltaCount = 0;
      cached.deltaBytes = 0;
    }
  }
  return true;
}

export function invalidateWikiGraph(wikiRoot: string): void {
  graphCache.delete(nodePath.resolve(wikiRoot));
}

export async function readGraph(wikiRoot: string): Promise<WikiGraph | null> {
  const checkpoint = await readGraphCheckpoint(wikiRoot);
  return checkpoint.kind === "empty" ? null : checkpoint.graph;
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
    `> Included nodes: ${result.nodes.length}`,
    `> Included relations: ${result.edges.length}`,
    `> Seed: ${result.seedNodeIds.length}`,
    "",
    "## Nodes",
    "",
  ];
  for (const node of result.nodes) {
    lines.push(
      `- ${node.kind}: ${node.label}${node.path ? ` (${node.path})` : ""}${
        node.requestId ? ` [${node.requestId}]` : ""
      }`
    );
  }
  lines.push("", "## Relations", "");
  if (result.edges.length === 0) lines.push("_No relations in the subgraph._");
  const labels = new Map(result.nodes.map((node) => [node.id, node.label]));
  for (const edge of result.edges) {
    lines.push(`- ${labels.get(edge.from) ?? edge.from} --${edge.kind}--> ${labels.get(edge.to) ?? edge.to}`);
  }
  lines.push("", "## Suggested pages", "");
  if (pageNodes.length === 0) lines.push("_No suggested pages._");
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
  const lines = ["## Graph-based summary", ""];
  for (const edge of relevantEdges.slice(0, 40)) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) continue;
    lines.push(`- ${from.label} --${edge.kind}--> ${to.label}`);
  }
  lines.push("");
  return lines.join("\n");
}
