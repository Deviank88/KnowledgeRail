import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import * as nodePath from "node:path";
import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  WikiGraph,
} from "./graph-index.js";
import { wikiMetaDir } from "./manifest-service.js";
import { derivedCheckpointDirectoryKind } from "./checkpoint-lock.js";

export const GRAPH_CHECKPOINT_SCHEMA_VERSION = 3;
export const GRAPH_BUILDER_VERSION = "wiki-graph-v3";

const MAX_GRAPH_BYTES = 256 * 1024 * 1024;
const MAX_GRAPH_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_GRAPH_NODES = 500_000;
const MAX_GRAPH_EDGES = 2_000_000;
const MAX_GRAPH_WARNINGS = 500_000;
const MAX_GRAPH_STRING_BYTES = 1024 * 1024;

export interface GraphCheckpointWriteLimits {
  maxSnapshotBytes?: number;
  maxJournalBytes?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxWarnings?: number;
}

export type GraphCheckpointWriteBoundsReason =
  | "snapshot_bytes"
  | "journal_bytes"
  | "node_limit"
  | "edge_limit"
  | "warning_limit"
  | "payload_invalid";

export class GraphCheckpointBoundsError extends Error {
  readonly code = "graph_checkpoint_bounds_exceeded";

  constructor(readonly reason: GraphCheckpointWriteBoundsReason) {
    super(`Graph checkpoint exceeds the reader-compatible ${reason} bound.`);
    this.name = "GraphCheckpointBoundsError";
  }
}

const NODE_KINDS = new Set<GraphNodeKind>([
  "page", "request", "requirement", "implementation", "test_result", "release",
  "source", "tag", "client", "project", "api", "data_model",
]);
const EDGE_KINDS = new Set<GraphEdgeKind>([
  "links_to", "derived_from", "same_request", "implements", "tests", "released_by",
  "has_tag", "belongs_to_client", "belongs_to_project",
]);

interface GraphPayloadV3 {
  schemaVersion: 3;
  builderVersion: typeof GRAPH_BUILDER_VERSION;
  inputCorpusRevision: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

interface GraphEnvelopeV3 {
  payload: GraphPayloadV3;
  payloadChecksum: string;
}

export interface GraphDeltaInput {
  removedNodeIds: readonly string[];
  upsertNodes: readonly GraphNode[];
  removedEdges: readonly GraphEdge[];
  upsertEdges: readonly GraphEdge[];
  warningPatches: ReadonlyArray<{ path: string; warnings: readonly string[] }>;
}

interface GraphDeltaPayloadV3 extends GraphDeltaInput {
  schemaVersion: 3;
  builderVersion: typeof GRAPH_BUILDER_VERSION;
  baseRevision: string;
  newRevision: string;
}

interface GraphDeltaEnvelopeV3 {
  payload: GraphDeltaPayloadV3;
  payloadChecksum: string;
}

export type GraphCheckpointFallbackReason =
  | "none"
  | "force_rebuild"
  | "graph_missing"
  | "graph_v2_migration"
  | "checkpoint_directory_symlink"
  | "checkpoint_directory_not_directory"
  | "graph_symlink"
  | "graph_not_regular"
  | "graph_oversized"
  | "graph_malformed"
  | "graph_schema_mismatch"
  | "graph_builder_mismatch"
  | "graph_checksum_mismatch"
  | "graph_bounds_invalid"
  | "graph_revision_mismatch"
  | "graph_journal_without_snapshot"
  | "graph_journal_symlink"
  | "graph_journal_oversized"
  | "graph_journal_malformed"
  | "graph_journal_lineage_mismatch";

export type GraphCheckpointRead =
  | {
    kind: "v3";
    graph: WikiGraph;
    inputCorpusRevision: string;
    deltaCount: number;
    deltaBytes: number;
    artifactToken: string;
    fallbackReason: "none";
  }
  | { kind: "legacy"; graph: WikiGraph; fallbackReason: "graph_v2_migration" }
  | { kind: "empty"; fallbackReason: GraphCheckpointFallbackReason };

function graphPath(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "graph.json");
}

export function graphDeltaFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "graph-delta.jsonl");
}

async function artifactIdentity(filePath: string): Promise<Record<string, unknown>> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { kind: "missing" };
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "other" };
  return {
    kind: "file",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

export async function graphArtifactToken(wikiRoot: string): Promise<string> {
  const directoryKind = await derivedCheckpointDirectoryKind(wikiRoot);
  if (directoryKind === "symlink" || directoryKind === "other") {
    return JSON.stringify({ checkpointDirectory: directoryKind });
  }
  const [snapshot, journal] = await Promise.all([
    artifactIdentity(graphPath(wikiRoot)),
    artifactIdentity(graphDeltaFile(wikiRoot)),
  ]);
  return JSON.stringify({ snapshot, journal });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function checksumMatches(payload: unknown, checksum: unknown): boolean {
  if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return false;
  const actual = Buffer.from(hashPayload(payload), "hex");
  const expected = Buffer.from(checksum, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, maxBytes = MAX_GRAPH_STRING_BYTES): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maxBytes;
}

function safeStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_GRAPH_WARNINGS && value.every((item) => safeString(item));
}

function validNode(value: unknown): value is GraphNode {
  if (!isObject(value) || !safeString(value.id) || !NODE_KINDS.has(value.kind as GraphNodeKind) ||
      !safeString(value.label)) return false;
  for (const key of ["path", "pageType", "requestId", "summary"] as const) {
    if (value[key] !== undefined && !safeString(value[key])) return false;
  }
  return (value.tags === undefined || safeStringArray(value.tags)) &&
    (value.sources === undefined || safeStringArray(value.sources));
}

function validEdge(value: unknown): value is GraphEdge {
  return isObject(value) && safeString(value.from) && safeString(value.to) &&
    EDGE_KINDS.has(value.kind as GraphEdgeKind) && value.from !== value.to;
}

function parseLegacy(value: unknown): WikiGraph | null {
  if (!isObject(value) || value.version !== 2 || !safeString(value.generatedAt) ||
      !Array.isArray(value.nodes) || value.nodes.length > MAX_GRAPH_NODES || !value.nodes.every(validNode) ||
      !Array.isArray(value.edges) || value.edges.length > MAX_GRAPH_EDGES || !value.edges.every(validEdge) ||
      !safeStringArray(value.warnings)) return null;
  return value as unknown as WikiGraph;
}

function parsePayload(value: unknown): { graph: WikiGraph; inputCorpusRevision: string } | GraphCheckpointFallbackReason {
  if (!isObject(value) || value.schemaVersion !== 3) return "graph_schema_mismatch";
  if (value.builderVersion !== GRAPH_BUILDER_VERSION) return "graph_builder_mismatch";
  if (typeof value.inputCorpusRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.inputCorpusRevision)) {
    return "graph_bounds_invalid";
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > MAX_GRAPH_NODES || !value.nodes.every(validNode) ||
      !Array.isArray(value.edges) || value.edges.length > MAX_GRAPH_EDGES || !value.edges.every(validEdge) ||
      !safeStringArray(value.warnings)) return "graph_bounds_invalid";
  const nodeIds = new Set<string>();
  let previousNode = "";
  for (const node of value.nodes as GraphNode[]) {
    if (compareText(node.id, previousNode) <= 0 || nodeIds.has(node.id)) return "graph_bounds_invalid";
    previousNode = node.id;
    nodeIds.add(node.id);
  }
  let previousEdge = "";
  for (const edge of value.edges as GraphEdge[]) {
    const key = `${edge.from}\0${edge.kind}\0${edge.to}`;
    if (compareText(key, previousEdge) <= 0 || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      return "graph_bounds_invalid";
    }
    previousEdge = key;
  }
  let previousWarning = "";
  for (const warning of value.warnings as string[]) {
    if (warning <= previousWarning) return "graph_bounds_invalid";
    previousWarning = warning;
  }
  return {
    inputCorpusRevision: value.inputCorpusRevision,
    graph: {
      version: 2,
      generatedAt: "restored-from-revisioned-checkpoint",
      nodes: value.nodes as GraphNode[],
      edges: value.edges as GraphEdge[],
      warnings: value.warnings as string[],
    },
  };
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\0${edge.kind}\0${edge.to}`;
}

function validRelativeMarkdownPath(value: unknown): value is string {
  return safeString(value, 16 * 1024) && value === value.replace(/\\/g, "/").normalize("NFC") &&
    !nodePath.posix.isAbsolute(value) && value.toLowerCase().endsWith(".md") &&
    value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function strictlySorted<T>(values: readonly T[], key: (value: T) => string): boolean {
  let previous = "";
  for (const value of values) {
    const current = key(value);
    if (compareText(current, previous) <= 0) return false;
    previous = current;
  }
  return true;
}

function parseDeltaLine(line: string): GraphDeltaPayloadV3 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isObject(parsed.payload) ||
      !checksumMatches(parsed.payload, parsed.payloadChecksum)) return null;
  const payload = parsed.payload;
  if (payload.schemaVersion !== 3 || payload.builderVersion !== GRAPH_BUILDER_VERSION ||
      typeof payload.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(payload.baseRevision) ||
      typeof payload.newRevision !== "string" || !/^[a-f0-9]{64}$/.test(payload.newRevision) ||
      !Array.isArray(payload.removedNodeIds) || payload.removedNodeIds.length > MAX_GRAPH_NODES ||
      !payload.removedNodeIds.every((id) => safeString(id)) ||
      !strictlySorted(payload.removedNodeIds as string[], (id) => id) ||
      !Array.isArray(payload.upsertNodes) || payload.upsertNodes.length > MAX_GRAPH_NODES ||
      !payload.upsertNodes.every(validNode) ||
      !strictlySorted(payload.upsertNodes as GraphNode[], (node) => node.id) ||
      !Array.isArray(payload.removedEdges) || payload.removedEdges.length > MAX_GRAPH_EDGES ||
      !payload.removedEdges.every(validEdge) ||
      !strictlySorted(payload.removedEdges as GraphEdge[], edgeKey) ||
      !Array.isArray(payload.upsertEdges) || payload.upsertEdges.length > MAX_GRAPH_EDGES ||
      !payload.upsertEdges.every(validEdge) ||
      !strictlySorted(payload.upsertEdges as GraphEdge[], edgeKey) ||
      !Array.isArray(payload.warningPatches) || payload.warningPatches.length > MAX_GRAPH_WARNINGS ||
      !strictlySorted(payload.warningPatches as Array<{ path?: unknown }>, (patch) => String(patch.path ?? ""))) {
    return null;
  }
  for (const patch of payload.warningPatches) {
    if (!isObject(patch) || !validRelativeMarkdownPath(patch.path) || !safeStringArray(patch.warnings) ||
        !strictlySorted(patch.warnings, (warning) => warning) ||
        !patch.warnings.every((warning) => warning.startsWith(`${patch.path}:`))) return null;
  }
  return payload as unknown as GraphDeltaPayloadV3;
}

function applyGraphDelta(
  graph: WikiGraph,
  delta: GraphDeltaPayloadV3
): WikiGraph | null {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edgeKey(edge), edge]));
  for (const edge of delta.removedEdges) edges.delete(edgeKey(edge));
  for (const nodeId of delta.removedNodeIds) {
    nodes.delete(nodeId);
    for (const [key, edge] of edges) {
      if (edge.from === nodeId || edge.to === nodeId) edges.delete(key);
    }
  }
  for (const node of delta.upsertNodes) nodes.set(node.id, node);
  for (const edge of delta.upsertEdges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return null;
    edges.set(edgeKey(edge), edge);
  }
  const patchedPaths = new Set(delta.warningPatches.map((patch) => patch.path));
  const warnings = graph.warnings.filter((warning) =>
    ![...patchedPaths].some((relPath) => warning.startsWith(`${relPath}:`))
  );
  warnings.push(...delta.warningPatches.flatMap((patch) => [...patch.warnings]));
  return {
    version: 2,
    generatedAt: "restored-from-revisioned-checkpoint",
    nodes: [...nodes.values()].sort((left, right) => compareText(left.id, right.id)),
    edges: [...edges.values()].sort((left, right) => compareText(edgeKey(left), edgeKey(right))),
    warnings: [...new Set(warnings)].sort(compareText),
  };
}

async function readGraphText(wikiRoot: string): Promise<string | null | GraphCheckpointFallbackReason> {
  const file = graphPath(wikiRoot);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return "graph_symlink";
  if (!stat.isFile()) return "graph_not_regular";
  if (stat.size > MAX_GRAPH_BYTES) return "graph_oversized";
  try {
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return "graph_not_regular";
      if (opened.size > MAX_GRAPH_BYTES) return "graph_oversized";
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "graph_malformed";
  }
}

async function readGraphJournal(
  wikiRoot: string
): Promise<{ deltas: GraphDeltaPayloadV3[]; bytes: number } | GraphCheckpointFallbackReason> {
  const file = graphDeltaFile(wikiRoot);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { deltas: [], bytes: 0 };
  if (stat.isSymbolicLink()) return "graph_journal_symlink";
  if (!stat.isFile()) return "graph_journal_malformed";
  if (stat.size > MAX_GRAPH_JOURNAL_BYTES) return "graph_journal_oversized";
  let raw: string;
  try {
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return "graph_journal_malformed";
      if (opened.size > MAX_GRAPH_JOURNAL_BYTES) return "graph_journal_oversized";
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "graph_journal_malformed";
  }
  if (!raw) return { deltas: [], bytes: 0 };
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const deltas: GraphDeltaPayloadV3[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) continue;
    const delta = parseDeltaLine(line);
    if (delta) {
      deltas.push(delta);
      continue;
    }
    const incompleteTail = index === lines.length - 1 && !raw.endsWith("\n");
    if (!incompleteTail) return "graph_journal_malformed";
  }
  return { deltas, bytes: Buffer.byteLength(raw) };
}

async function readGraphCheckpointOnce(wikiRoot: string): Promise<GraphCheckpointRead> {
  const directoryKind = await derivedCheckpointDirectoryKind(wikiRoot);
  if (directoryKind === "symlink") {
    return { kind: "empty", fallbackReason: "checkpoint_directory_symlink" };
  }
  if (directoryKind === "other") {
    return { kind: "empty", fallbackReason: "checkpoint_directory_not_directory" };
  }
  const raw = await readGraphText(wikiRoot).catch(() => "graph_malformed" as const);
  if (raw === null) {
    const journal = await readGraphJournal(wikiRoot).catch(() => "graph_journal_malformed" as const);
    if (typeof journal === "string") return { kind: "empty", fallbackReason: journal };
    return {
      kind: "empty",
      fallbackReason: journal.bytes > 0 ? "graph_journal_without_snapshot" : "graph_missing",
    };
  }
  if ([
    "graph_symlink", "graph_not_regular", "graph_oversized", "graph_malformed",
  ].includes(raw)) return { kind: "empty", fallbackReason: raw as GraphCheckpointFallbackReason };
  if (raw !== "" && !raw.trimStart().startsWith("{")) return { kind: "empty", fallbackReason: "graph_malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "empty", fallbackReason: "graph_malformed" };
  }
  const legacy = parseLegacy(parsed);
  if (legacy) return { kind: "legacy", graph: legacy, fallbackReason: "graph_v2_migration" };
  if (!isObject(parsed) || !isObject(parsed.payload)) {
    return { kind: "empty", fallbackReason: "graph_schema_mismatch" };
  }
  if (!checksumMatches(parsed.payload, parsed.payloadChecksum)) {
    return { kind: "empty", fallbackReason: "graph_checksum_mismatch" };
  }
  const payload = parsePayload(parsed.payload);
  if (typeof payload === "string") return { kind: "empty", fallbackReason: payload };
  const journal = await readGraphJournal(wikiRoot).catch(() => "graph_journal_malformed" as const);
  if (typeof journal === "string") return { kind: "empty", fallbackReason: journal };
  let graph = payload.graph;
  let revision = payload.inputCorpusRevision;
  let startIndex = 0;
  if (journal.deltas.length > 0 && journal.deltas[0]!.baseRevision !== revision) {
    const includedIndex = journal.deltas.findIndex((delta) => delta.newRevision === revision);
    if (includedIndex < 0) return { kind: "empty", fallbackReason: "graph_journal_lineage_mismatch" };
    startIndex = includedIndex + 1;
  }
  for (const delta of journal.deltas.slice(startIndex)) {
    if (delta.baseRevision !== revision) {
      return { kind: "empty", fallbackReason: "graph_journal_lineage_mismatch" };
    }
    const patched = applyGraphDelta(graph, delta);
    if (!patched) return { kind: "empty", fallbackReason: "graph_journal_malformed" };
    graph = patched;
    revision = delta.newRevision;
  }
  return {
    kind: "v3",
    graph,
    inputCorpusRevision: revision,
    deltaCount: journal.deltas.length,
    deltaBytes: journal.bytes,
    artifactToken: await graphArtifactToken(wikiRoot),
    fallbackReason: "none",
  };
}

export async function readGraphCheckpoint(wikiRoot: string): Promise<GraphCheckpointRead> {
  let before = await graphArtifactToken(wikiRoot);
  for (let attempt = 0; attempt < 3; attempt++) {
    const checkpoint = await readGraphCheckpointOnce(wikiRoot);
    const after = await graphArtifactToken(wikiRoot);
    if (before === after) {
      if (checkpoint.kind === "v3") checkpoint.artifactToken = after;
      return checkpoint;
    }
    before = after;
  }
  return { kind: "empty", fallbackReason: "graph_malformed" };
}

function resolvedWriteLimits(limits: GraphCheckpointWriteLimits): Required<GraphCheckpointWriteLimits> {
  return {
    maxSnapshotBytes: Math.min(MAX_GRAPH_BYTES, limits.maxSnapshotBytes ?? MAX_GRAPH_BYTES),
    maxJournalBytes: Math.min(MAX_GRAPH_JOURNAL_BYTES, limits.maxJournalBytes ?? MAX_GRAPH_JOURNAL_BYTES),
    maxNodes: Math.min(MAX_GRAPH_NODES, limits.maxNodes ?? MAX_GRAPH_NODES),
    maxEdges: Math.min(MAX_GRAPH_EDGES, limits.maxEdges ?? MAX_GRAPH_EDGES),
    maxWarnings: Math.min(MAX_GRAPH_WARNINGS, limits.maxWarnings ?? MAX_GRAPH_WARNINGS),
  };
}

export function serializeGraphCheckpoint(
  graph: WikiGraph,
  inputCorpusRevision: string,
  writeLimits: GraphCheckpointWriteLimits = {}
): string {
  const limits = resolvedWriteLimits(writeLimits);
  if (!/^[a-f0-9]{64}$/.test(inputCorpusRevision)) {
    throw new GraphCheckpointBoundsError("payload_invalid");
  }
  if (graph.nodes.length > limits.maxNodes) throw new GraphCheckpointBoundsError("node_limit");
  if (graph.edges.length > limits.maxEdges) throw new GraphCheckpointBoundsError("edge_limit");
  if (graph.warnings.length > limits.maxWarnings) throw new GraphCheckpointBoundsError("warning_limit");
  const payload: GraphPayloadV3 = {
    schemaVersion: 3,
    builderVersion: GRAPH_BUILDER_VERSION,
    inputCorpusRevision,
    nodes: [...graph.nodes].sort((left, right) => compareText(left.id, right.id)),
    edges: [...graph.edges].sort((left, right) =>
      compareText(left.from, right.from) || compareText(left.kind, right.kind) || compareText(left.to, right.to)),
    warnings: [...new Set(graph.warnings)].sort(compareText),
  };
  const validation = parsePayload(payload);
  if (typeof validation === "string") throw new GraphCheckpointBoundsError("payload_invalid");
  const envelope: GraphEnvelopeV3 = { payload, payloadChecksum: hashPayload(payload) };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized) > limits.maxSnapshotBytes) {
    throw new GraphCheckpointBoundsError("snapshot_bytes");
  }
  return serialized;
}

export function serializeGraphDelta(
  baseRevision: string,
  newRevision: string,
  input: GraphDeltaInput,
  writeLimits: GraphCheckpointWriteLimits = {}
): string {
  const limits = resolvedWriteLimits(writeLimits);
  if (!/^[a-f0-9]{64}$/.test(baseRevision) || !/^[a-f0-9]{64}$/.test(newRevision)) {
    throw new GraphCheckpointBoundsError("payload_invalid");
  }
  if (input.removedNodeIds.length > limits.maxNodes || input.upsertNodes.length > limits.maxNodes) {
    throw new GraphCheckpointBoundsError("node_limit");
  }
  if (input.removedEdges.length > limits.maxEdges || input.upsertEdges.length > limits.maxEdges) {
    throw new GraphCheckpointBoundsError("edge_limit");
  }
  if (input.warningPatches.length > limits.maxWarnings) {
    throw new GraphCheckpointBoundsError("warning_limit");
  }
  const payload: GraphDeltaPayloadV3 = {
    schemaVersion: 3,
    builderVersion: GRAPH_BUILDER_VERSION,
    baseRevision,
    newRevision,
    removedNodeIds: [...new Set(input.removedNodeIds)].sort(compareText),
    upsertNodes: [...input.upsertNodes].sort((left, right) => compareText(left.id, right.id)),
    removedEdges: [...input.removedEdges].sort((left, right) => compareText(edgeKey(left), edgeKey(right))),
    upsertEdges: [...input.upsertEdges].sort((left, right) => compareText(edgeKey(left), edgeKey(right))),
    warningPatches: [...input.warningPatches]
      .map((patch) => ({ path: patch.path, warnings: [...new Set(patch.warnings)].sort(compareText) }))
      .sort((left, right) => compareText(left.path, right.path)),
  };
  if (!parseDeltaLine(`${JSON.stringify({ payload, payloadChecksum: hashPayload(payload) })}\n`)) {
    throw new GraphCheckpointBoundsError("payload_invalid");
  }
  const envelope: GraphDeltaEnvelopeV3 = { payload, payloadChecksum: hashPayload(payload) };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized) > limits.maxJournalBytes) {
    throw new GraphCheckpointBoundsError("journal_bytes");
  }
  return serialized;
}
