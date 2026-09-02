import * as fs from "node:fs/promises";
import { watch, type FSWatcher, type Stats } from "node:fs";
import * as nodePath from "node:path";
import { performance } from "node:perf_hooks";
import { atomicWriteText } from "./fs-service.js";
import { withKeyedLock } from "./lock-service.js";
import {
  usingDerivedCheckpointLock,
  type DerivedCheckpointLock,
} from "./checkpoint-lock.js";
import {
  evictWorkspaceState,
  registerWorkspaceState,
  touchWorkspaceState,
} from "./workspace-state.js";
import { listWikiPagePaths, readWikiPageRecord, type WikiPageRecord } from "./page-record.js";
import {
  isCanonicalWikiPagePath,
  nestedWikiPageRepairTarget,
  normalizeWikiPagePath,
} from "./wiki-page-path.js";
import { resolveRealWithin } from "./paths.js";
import { wikiMetaDir } from "./manifest-service.js";
import { ensureDir } from "./utils.js";
import { normalizeSearchText, tokenizeSearchText, type RetrievalProfile } from "./text-analysis.js";
import {
  orderedWordBigrams,
  scoreBigramRerankCandidate,
  scoreOrderedPhraseSegments,
  surfacePhraseTokens,
} from "./phrase-scoring.js";
import {
  addCheckpointRecord,
  CorpusRevisionLedger,
  computeCorpusRevision,
  emptyRetrievalCheckpointData,
  fingerprintWikiRaw,
  readRetrievalCheckpoint,
  removeCheckpointRecord,
  RetrievalCheckpointBoundsError,
  retrievalArtifactToken,
  retrievalDeltaFile,
  retrievalSnapshotFile,
  serializeRetrievalCheckpoint,
  serializeRetrievalDelta,
  type IndexedTermTuple,
  type RetrievalCheckpointData,
  type RetrievalCheckpointRead,
  type RetrievalCheckpointWriteBoundsReason,
  type RetrievalFallbackReason,
  type RetrievalFileMetadata,
  type RetrievalPosting,
} from "./retrieval-checkpoint.js";

interface IndexState extends RetrievalCheckpointData {
  records: Map<string, WikiPageRecord>;
  postings: Map<string, Map<string, RetrievalPosting>>;
  totalTokenCount: number;
  lastScanMs: number;
  loaded: boolean;
  dirty: boolean;
  persistenceDirty: boolean;
  persistenceStatus: "available" | "skipped_oversized";
  persistenceReason: RetrievalCheckpointWriteBoundsReason | null;
  watcherReliable: boolean;
  generation: number;
  persistedRevision: string | null;
  persistedArtifactToken: string | null;
  revisionLedger: CorpusRevisionLedger;
  deltaCount: number;
  deltaBytes: number;
  fallbackReason: RetrievalFallbackReason;
  recovery: "pending" | "restored" | "patched" | "rebuilt";
  verificationMode: RetrievalVerificationMode;
  reusedRecords: number;
  changedRecords: number;
  snapshotLoadMs: number;
  verificationMs: number;
  refreshPromise?: Promise<IndexState>;
  persistencePromise?: Promise<void>;
  watcher?: FSWatcher;
}

export type RetrievalVerificationMode = "metadata" | "content";

export interface RetrievalIndexDiagnostics {
  snapshotLoaded: boolean;
  deltaCount: number;
  reusedRecords: number;
  changedRecords: number;
  verificationMode: RetrievalVerificationMode;
  fallbackReason: RetrievalFallbackReason;
  recovery: IndexState["recovery"];
  persistenceStatus: IndexState["persistenceStatus"];
  persistenceReason: RetrievalCheckpointWriteBoundsReason | null;
  corpusRevision: string;
  timingsMs: { snapshotLoad: number; verification: number };
}

export interface RetrievalPersistenceIdentity {
  corpusRevision: string;
  persistedRevision: string | null;
  artifactToken: string | null;
  persistenceStatus: IndexState["persistenceStatus"];
  persistenceReason: RetrievalCheckpointWriteBoundsReason | null;
}

export interface RetrievalHit {
  path: string;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  requestId?: string;
  score: number;
  /** Internal pre-phrase lexical signal used for coverage-safe graph seeding. */
  lexicalBaselineScore?: number;
  /** Internal one-based pre-phrase rank; never serialized by MCP tools. */
  lexicalBaselineRank?: number;
  excerpt: string;
  heading: string;
  record: WikiPageRecord;
}

export interface PhraseRankChange {
  path: string;
  baselineRank: number;
  rerankedRank: number;
  matchedBigrams: number;
  heading: string;
}

export interface PhraseRerankDiagnostics {
  enabled: boolean;
  queryBigramCount: number;
  protectedIdentifierCount: number;
  candidateCount: number;
  rescoredCount: number;
  rankChanges: PhraseRankChange[];
}

const states = new Map<string, IndexState>();
const passageTokenCache = new WeakMap<WikiPageRecord, ReadonlyArray<ReadonlySet<string>>>();
const DEFAULT_REFRESH_MS = 2_000;
const DEFAULT_RECONCILIATION_MS = 60_000;
const DELTA_COMPACT_COUNT = 100;
const DELTA_COMPACT_BYTES = 4 * 1024 * 1024;
const PHRASE_POOL_MULTIPLIER = 4;
const MIN_PHRASE_POOL = 20;
const MAX_PHRASE_POOL = 400;
const MAX_PHRASE_REQUEST_RESULTS = MAX_PHRASE_POOL;
const MAX_PHRASE_IDENTIFIER_TOKENS = 2;

class RetrievalCheckpointConflictError extends Error {
  constructor() {
    super("Retrieval checkpoint changed in another process; reloading before persistence.");
    this.name = "RetrievalCheckpointConflictError";
  }
}

function snapshotFile(wikiRoot: string): string {
  return retrievalSnapshotFile(wikiRoot);
}

function deltaFile(wikiRoot: string): string {
  return retrievalDeltaFile(wikiRoot);
}

async function enqueuePersistence(
  wikiRoot: string,
  operation: () => Promise<void>,
  checkpointLock?: DerivedCheckpointLock
): Promise<void> {
  await usingDerivedCheckpointLock(wikiRoot, checkpointLock, operation);
}

function emptyState(): IndexState {
  return {
    ...emptyRetrievalCheckpointData(),
    lastScanMs: 0,
    loaded: false,
    dirty: true,
    persistenceDirty: false,
    persistenceStatus: "available",
    persistenceReason: null,
    watcherReliable: false,
    generation: 0,
    persistedRevision: null,
    persistedArtifactToken: null,
    revisionLedger: CorpusRevisionLedger.from(new Map()),
    deltaCount: 0,
    deltaBytes: 0,
    fallbackReason: "snapshot_missing",
    recovery: "pending",
    verificationMode: "metadata",
    reusedRecords: 0,
    changedRecords: 0,
    snapshotLoadMs: 0,
    verificationMs: 0,
  };
}

function stateFor(wikiRoot: string): IndexState {
  const root = nodePath.resolve(wikiRoot);
  let state = states.get(root);
  if (!state) {
    state = emptyState();
    states.set(root, state);
    try {
      // libuv's recursive Windows watcher can abort the process on valid
      // directory/case combinations instead of reporting an ordinary error.
      // Periodic reconciliation is already authoritative on this platform.
      if (process.platform === "win32") throw new Error("Use periodic reconciliation on Windows.");
      // `persistent: false` is stronger than relying only on `unref()` and ensures
      // the derived-index watcher cannot keep short-lived CLI/test processes alive.
      // In the MCP server the transport already keeps the event loop alive, so the
      // watcher continues to deliver invalidation events for the server lifetime.
      const watcher = watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
        const normalized = filename?.toString().replace(/\\/g, "/") ?? "";
        if (normalized.startsWith(".knowledge-rail/") || normalized.startsWith(".llm-wiki/")) return;
        state!.dirty = true;
        state!.lastScanMs = 0;
      });
      watcher.on("error", () => {
        watcher.close();
        if (state!.watcher === watcher) state!.watcher = undefined;
        state!.watcherReliable = false;
        state!.dirty = true;
        state!.lastScanMs = 0;
      });
      state.watcher = watcher;
      state.watcherReliable = true;
    } catch {
      // Recursive watch is platform-dependent; periodic metadata scans remain the fallback.
    }
    registerWorkspaceState(root, "retrieval", () => {
      state!.watcher?.close();
      states.delete(root);
    });
  } else {
    touchWorkspaceState(root);
  }
  return state;
}

function countTerms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const normalized = normalizeSearchText(text);
  for (const token of normalized.match(/\/?[\p{L}\p{N}][\p{L}\p{N}_./:#-]*/gu) ?? []) {
    result.set(token, (result.get(token) ?? 0) + 1);
    for (const part of token.split(/[_./:#-]+/).filter((value) => value.length >= 2)) {
      if (part !== token) result.set(part, (result.get(part) ?? 0) + 1);
    }
  }
  return result;
}

export function indexedTermsForRecord(record: WikiPageRecord): IndexedTermTuple[] {
  const title = countTerms(`${record.title} ${record.aliases.join(" ")}`);
  const metadata = countTerms([
    record.type,
    record.tags.join(" "),
    record.sources.join(" "),
    record.requestId ?? "",
    record.client ?? "",
    record.project ?? "",
    record.path,
    record.passages.map((passage) => passage.heading).join(" "),
  ].join(" "));
  const body = countTerms(record.body);
  return [...new Set([...title.keys(), ...metadata.keys(), ...body.keys()])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((term) => [term, body.get(term) ?? 0, title.get(term) ?? 0, metadata.get(term) ?? 0]);
}

function metadataFromStat(stat: Stats): RetrievalFileMetadata {
  return {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function metadataFromRecord(record: WikiPageRecord): RetrievalFileMetadata {
  return { mtimeMs: record.mtimeMs, size: record.size };
}

function indexRecord(
  state: RetrievalCheckpointData,
  record: WikiPageRecord,
  options: {
    fingerprint?: string;
    metadata?: RetrievalFileMetadata;
    indexedTerms?: readonly IndexedTermTuple[];
  } = {}
): void {
  addCheckpointRecord(state, {
    record,
    fingerprint: options.fingerprint ?? fingerprintWikiRaw(record.raw),
    metadata: options.metadata ?? metadataFromRecord(record),
    indexedTerms: options.indexedTerms ?? indexedTermsForRecord(record),
  });
}

function installData(state: IndexState, data: RetrievalCheckpointData): void {
  state.records = data.records;
  state.postings = data.postings;
  state.fingerprints = data.fingerprints;
  state.fileMetadata = data.fileMetadata;
  state.totalTokenCount = data.totalTokenCount;
  state.corpusRevision = data.corpusRevision;
  state.revisionLedger = CorpusRevisionLedger.from(data.fingerprints);
}

function cloneData(state: RetrievalCheckpointData): RetrievalCheckpointData {
  return {
    records: new Map(state.records),
    postings: new Map([...state.postings].map(([term, byPath]) => [term, new Map(byPath)])),
    fingerprints: new Map(state.fingerprints),
    fileMetadata: new Map(state.fileMetadata),
    totalTokenCount: state.totalTokenCount,
    corpusRevision: state.corpusRevision,
  };
}

async function readStableRetrievalCheckpoint(
  wikiRoot: string
): Promise<{ checkpoint: RetrievalCheckpointRead; artifactToken: string }> {
  let artifactToken = await retrievalArtifactToken(wikiRoot);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = artifactToken;
    const checkpoint = await readRetrievalCheckpoint(wikiRoot);
    artifactToken = await retrievalArtifactToken(wikiRoot);
    if (before === artifactToken) return { checkpoint, artifactToken };
  }
  // A continuously changing derived generation is not a safe warm candidate.
  // Reconciliation will build one isolated generation from canonical Markdown.
  return {
    checkpoint: { kind: "empty", fallbackReason: "snapshot_malformed" },
    artifactToken,
  };
}

async function loadSnapshot(wikiRoot: string, state: IndexState): Promise<void> {
  if (state.loaded) return;
  const startedAt = performance.now();
  const stable = await readStableRetrievalCheckpoint(wikiRoot);
  const loaded = stable.checkpoint;
  state.snapshotLoadMs = performance.now() - startedAt;
  state.persistedArtifactToken = stable.artifactToken;
  state.fallbackReason = loaded.fallbackReason;
  if (loaded.kind === "v2") {
    installData(state, loaded.data);
    state.persistedRevision = loaded.persistedRevision;
    state.deltaCount = loaded.deltaCount;
    state.deltaBytes = loaded.deltaBytes;
  } else if (loaded.kind === "v1") {
    const candidate = emptyRetrievalCheckpointData();
    for (const record of loaded.records) indexRecord(candidate, record);
    candidate.corpusRevision = computeCorpusRevision(candidate.fingerprints);
    installData(state, candidate);
    state.persistenceDirty = true;
  } else {
    installData(state, emptyRetrievalCheckpointData());
    state.persistenceDirty = true;
  }
  state.loaded = true;
}

async function persistSnapshot(
  wikiRoot: string,
  state: IndexState,
  checkpointLock?: DerivedCheckpointLock
): Promise<boolean> {
  let serialized: string;
  try {
    serialized = serializeRetrievalCheckpoint(state);
  } catch (error) {
    if (!(error instanceof RetrievalCheckpointBoundsError)) throw error;
    state.persistenceStatus = "skipped_oversized";
    state.persistenceReason = error.reason;
    return false;
  }
  await enqueuePersistence(wikiRoot, async () => {
    await ensureDir(wikiMetaDir(wikiRoot));
    const diskToken = await retrievalArtifactToken(wikiRoot);
    if (diskToken !== state.persistedArtifactToken) {
      throw new RetrievalCheckpointConflictError();
    }
    await atomicWriteText(snapshotFile(wikiRoot), serialized);
    await fs.rm(deltaFile(wikiRoot), { force: true });
    state.persistedRevision = state.corpusRevision;
    state.persistedArtifactToken = await retrievalArtifactToken(wikiRoot);
    state.deltaCount = 0;
    state.deltaBytes = 0;
  }, checkpointLock);
  state.persistenceStatus = "available";
  state.persistenceReason = null;
  return true;
}

function invalidateForCheckpointReload(state: IndexState): void {
  state.loaded = false;
  state.dirty = true;
  state.lastScanMs = 0;
  state.persistenceDirty = true;
}

async function ensureSnapshotPersistedWithRecovery(
  wikiRoot: string,
  state: IndexState,
  verificationMode?: RetrievalVerificationMode
): Promise<void> {
  try {
    await ensureSnapshotPersisted(wikiRoot, state);
  } catch (error) {
    if (!(error instanceof RetrievalCheckpointConflictError)) throw error;
    await withKeyedLock(`${nodePath.resolve(wikiRoot)}:retrieval-persistence-recovery`, async () => {
      if (!state.persistenceDirty) return;
      invalidateForCheckpointReload(state);
      await refreshRetrievalIndex(wikiRoot, {
        force: true,
        persist: false,
        verificationMode,
      });
      try {
        await ensureSnapshotPersisted(wikiRoot, state);
      } catch (retryError) {
        invalidateForCheckpointReload(state);
        throw retryError;
      }
    });
  }
}

async function ensureSnapshotPersisted(
  wikiRoot: string,
  state: IndexState,
  checkpointLock?: DerivedCheckpointLock
): Promise<void> {
  if (!state.persistenceDirty) return;
  if (!state.persistencePromise) {
    state.persistencePromise = (async () => {
      await persistSnapshot(wikiRoot, state, checkpointLock);
      state.persistenceDirty = false;
    })().finally(() => {
      state.persistencePromise = undefined;
    });
  }
  await state.persistencePromise;
}

function configuredVerificationMode(explicit?: RetrievalVerificationMode): RetrievalVerificationMode {
  if (explicit) return explicit;
  const configured = process.env["KNOWLEDGE_RAIL_INTEGRITY_MODE"]?.trim().toLowerCase() ?? "metadata";
  if (configured !== "metadata" && configured !== "content") {
    throw new Error("KNOWLEDGE_RAIL_INTEGRITY_MODE must be 'metadata' or 'content'.");
  }
  return configured;
}

function metadataMatches(stored: RetrievalFileMetadata | undefined, current: RetrievalFileMetadata): boolean {
  if (!stored || stored.size !== current.size || stored.mtimeMs !== current.mtimeMs) return false;
  for (const key of ["ctimeMs", "dev", "ino"] as const) {
    if (stored[key] !== undefined && current[key] !== undefined && stored[key] !== current[key]) return false;
  }
  return true;
}

async function reconcileRetrievalIndex(
  wikiRoot: string,
  state: IndexState,
  verificationMode: RetrievalVerificationMode
): Promise<void> {
  const startedAt = performance.now();
  const paths = await listWikiPagePaths(wikiRoot, { strict: true });
  const seen = new Set(paths);
  const removed = [...state.records.keys()].filter((existing) => !seen.has(existing));
  const stats = await Promise.all(paths.map(async (relPath) => {
    const stat = await fs.stat(await resolveRealWithin(wikiRoot, relPath));
    return { relPath, stat, metadata: metadataFromStat(stat) };
  }));
  const updates: Array<{
    relPath: string;
    record: WikiPageRecord;
    fingerprint: string;
    metadata: RetrievalFileMetadata;
    contentChanged: boolean;
  }> = [];
  let reusedRecords = 0;

  for (const { relPath, stat, metadata } of stats) {
    const cached = state.records.get(relPath);
    if (verificationMode === "metadata" && cached && metadataMatches(state.fileMetadata.get(relPath), metadata)) {
      reusedRecords++;
      continue;
    }
    const record = await readWikiPageRecord(wikiRoot, relPath, stat, { strict: true });
    if (!record) throw new Error(`Canonical wiki page disappeared during verification: ${relPath}.`);
    const fingerprint = fingerprintWikiRaw(record.raw);
    const contentChanged = state.fingerprints.get(relPath) !== fingerprint;
    if (!contentChanged && cached) reusedRecords++;
    updates.push({ relPath, record, fingerprint, metadata, contentChanged });
  }

  const contentChanges = removed.length + updates.filter((update) => update.contentChanged).length;
  if (removed.length > 0 || updates.length > 0) {
    const candidate = cloneData(state);
    for (const relPath of removed) removeCheckpointRecord(candidate, relPath);
    for (const update of updates) {
      if (update.contentChanged) {
        removeCheckpointRecord(candidate, update.relPath);
        indexRecord(candidate, update.record, {
          fingerprint: update.fingerprint,
          metadata: update.metadata,
        });
      } else {
        candidate.records.set(update.relPath, update.record);
        candidate.fingerprints.set(update.relPath, update.fingerprint);
        candidate.fileMetadata.set(update.relPath, update.metadata);
      }
    }
    candidate.corpusRevision = computeCorpusRevision(candidate.fingerprints);
    installData(state, candidate);
    state.persistenceDirty = true;
  }
  state.lastScanMs = Date.now();
  state.dirty = false;
  state.verificationMode = verificationMode;
  state.reusedRecords = reusedRecords;
  state.changedRecords = contentChanges;
  state.verificationMs = performance.now() - startedAt;
  if (contentChanges > 0) state.generation++;
  state.recovery = state.fallbackReason === "none"
    ? (contentChanges > 0 ? "patched" : "restored")
    : "rebuilt";
}

export async function refreshRetrievalIndex(
  wikiRoot: string,
  options: {
    force?: boolean;
    persist?: boolean;
    verificationMode?: RetrievalVerificationMode;
    rebuild?: boolean;
  } = {}
): Promise<IndexState> {
  const state = stateFor(wikiRoot);
  const activeRefresh = state.refreshPromise;
  if (activeRefresh) {
    await activeRefresh;
    const requestedMode = configuredVerificationMode(options.verificationMode);
    if (options.rebuild || options.force ||
        (requestedMode === "content" && state.verificationMode !== "content")) {
      return refreshRetrievalIndex(wikiRoot, { ...options, force: true });
    }
    if (options.persist !== false) {
      await ensureSnapshotPersistedWithRecovery(wikiRoot, state, options.verificationMode);
    }
    return state;
  }
  if (!state.refreshPromise) {
    state.refreshPromise = (async () => {
      if (options.rebuild) {
        const stable = await readStableRetrievalCheckpoint(wikiRoot);
        const disk = stable.checkpoint;
        installData(state, emptyRetrievalCheckpointData());
        state.loaded = true;
        state.dirty = true;
        state.persistenceDirty = true;
        state.persistedRevision = disk.kind === "v2" ? disk.persistedRevision : null;
        state.persistedArtifactToken = stable.artifactToken;
        state.deltaCount = 0;
        state.deltaBytes = 0;
        state.fallbackReason = "forced_rebuild";
      } else {
        await loadSnapshot(wikiRoot, state);
      }
      const refreshMs = Number(process.env["KNOWLEDGE_RAIL_REFRESH_MS"] ?? DEFAULT_REFRESH_MS);
      const reconciliationMs = Number(
        process.env["KNOWLEDGE_RAIL_RECONCILIATION_MS"] ?? DEFAULT_RECONCILIATION_MS
      );
      const scanInterval = state.watcherReliable ? Math.max(refreshMs, reconciliationMs) : refreshMs;
      const fallbackDue = Date.now() - state.lastScanMs >= Math.max(0, scanInterval);
      const verificationMode = configuredVerificationMode(options.verificationMode);
      const integrityUpgrade = verificationMode === "content" && state.verificationMode !== "content";
      if (options.force || state.dirty || fallbackDue || integrityUpgrade) {
        await reconcileRetrievalIndex(wikiRoot, state, verificationMode);
      }
      return state;
    })().finally(() => {
      state.refreshPromise = undefined;
    });
  }
  await state.refreshPromise;
  if (options.persist !== false) {
    await ensureSnapshotPersistedWithRecovery(wikiRoot, state, options.verificationMode);
  }
  return state;
}

export function getRetrievalIndexGeneration(wikiRoot: string): number {
  return stateFor(wikiRoot).generation;
}

export function getRetrievalCorpusRevision(wikiRoot: string): string | null {
  const state = stateFor(wikiRoot);
  return state.loaded ? state.corpusRevision : null;
}

export function getRetrievalPersistenceIdentity(wikiRoot: string): RetrievalPersistenceIdentity | null {
  const state = stateFor(wikiRoot);
  if (!state.loaded) return null;
  return {
    corpusRevision: state.corpusRevision,
    persistedRevision: state.persistedRevision,
    artifactToken: state.persistedArtifactToken,
    persistenceStatus: state.persistenceStatus,
    persistenceReason: state.persistenceReason,
  };
}

export function getRetrievalIndexDiagnostics(wikiRoot: string): RetrievalIndexDiagnostics {
  const state = stateFor(wikiRoot);
  return {
    snapshotLoaded: state.loaded && state.fallbackReason === "none",
    deltaCount: state.deltaCount,
    reusedRecords: state.reusedRecords,
    changedRecords: state.changedRecords,
    verificationMode: state.verificationMode,
    fallbackReason: state.fallbackReason,
    recovery: state.recovery,
    persistenceStatus: state.persistenceStatus,
    persistenceReason: state.persistenceReason,
    corpusRevision: state.corpusRevision,
    timingsMs: { snapshotLoad: state.snapshotLoadMs, verification: state.verificationMs },
  };
}

interface PreparedRetrievalDelta {
  path: string;
  record: WikiPageRecord | null;
  fingerprint?: string;
  metadata?: RetrievalFileMetadata;
  indexedTerms?: IndexedTermTuple[];
}

function applyPreparedDeltas(
  data: RetrievalCheckpointData,
  deltas: readonly PreparedRetrievalDelta[],
  newRevision: string
): void {
  for (const delta of deltas) {
    removeCheckpointRecord(data, delta.path);
    if (delta.record && delta.fingerprint && delta.metadata && delta.indexedTerms) {
      addCheckpointRecord(data, {
        record: delta.record,
        fingerprint: delta.fingerprint,
        metadata: delta.metadata,
        indexedTerms: delta.indexedTerms,
      });
    }
  }
  data.corpusRevision = newRevision;
}

async function updateRetrievalPathsLocked(
  wikiRoot: string,
  relPaths: readonly string[],
  checkpointLock?: DerivedCheckpointLock
): Promise<void> {
  const state = stateFor(wikiRoot);
  if (!state.loaded) await refreshRetrievalIndex(wikiRoot, { persist: false });
  else if (state.refreshPromise) await state.refreshPromise;
  const baseRevision = state.corpusRevision;
  const deltas: PreparedRetrievalDelta[] = [];
  const normalizedPaths = new Set(relPaths.map((inputPath) =>
    inputPath.replace(/\\/g, "/").normalize("NFC")
  ));
  for (const relPath of normalizedPaths) {
    if (!isCanonicalWikiPagePath(relPath)) {
      if (nestedWikiPageRepairTarget(relPath)) {
        deltas.push({ path: relPath, record: null });
        continue;
      }
      const normalized = normalizeWikiPagePath(relPath);
      throw new Error(`Wiki page path must be canonical: ${relPath}; use ${normalized}`);
    }
    const absPath = await resolveRealWithin(wikiRoot, relPath);
    const stat = await fs.stat(absPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const record = stat ? await readWikiPageRecord(wikiRoot, relPath, stat, { strict: true }) : null;
    if (record && stat) {
      const fingerprint = fingerprintWikiRaw(record.raw);
      const metadata = metadataFromStat(stat);
      const indexedTerms = indexedTermsForRecord(record);
      deltas.push({ path: relPath, record, fingerprint, metadata, indexedTerms });
    } else {
      deltas.push({ path: relPath, record: null });
    }
  }
  if (deltas.length === 0) return;
  let nextRevisionLedger = state.revisionLedger.clone();
  const onlyExistingEdits = deltas.every((delta) =>
    delta.record !== null && delta.fingerprint !== undefined && state.fingerprints.has(delta.path)
  );
  if (onlyExistingEdits) {
    for (const delta of deltas) nextRevisionLedger.updateExisting(delta.path, delta.fingerprint!);
  } else {
    const nextFingerprints = new Map(state.fingerprints);
    for (const delta of deltas) {
      nextFingerprints.delete(delta.path);
      if (delta.record && delta.fingerprint) nextFingerprints.set(delta.path, delta.fingerprint);
    }
    nextRevisionLedger = CorpusRevisionLedger.from(nextFingerprints);
  }
  const newRevision = nextRevisionLedger.revision;
  let previousData: RetrievalCheckpointData | undefined;
  try {
    if (state.persistenceDirty || state.persistenceStatus === "skipped_oversized") {
      // Slow recovery/migration boundary only: construct a rollback candidate
      // because this path replaces the complete snapshot.
      previousData = cloneData(state);
      applyPreparedDeltas(state, deltas, newRevision);
      state.revisionLedger = nextRevisionLedger;
      state.persistenceDirty = true;
      await ensureSnapshotPersisted(wikiRoot, state, checkpointLock);
    } else {
      let serialized: string;
      try {
        serialized = serializeRetrievalDelta(baseRevision, newRevision, deltas);
      } catch (error) {
        if (!(error instanceof RetrievalCheckpointBoundsError)) throw error;
        previousData = cloneData(state);
        applyPreparedDeltas(state, deltas, newRevision);
        state.revisionLedger = nextRevisionLedger;
        state.persistenceDirty = true;
        await ensureSnapshotPersisted(wikiRoot, state, checkpointLock);
        serialized = "";
      }
      if (serialized.length > 0) {
        await enqueuePersistence(wikiRoot, async () => {
          await ensureDir(wikiMetaDir(wikiRoot));
          const diskToken = await retrievalArtifactToken(wikiRoot);
          if (diskToken !== state.persistedArtifactToken || state.persistedRevision !== baseRevision) {
            throw new Error("Retrieval checkpoint changed in another process; refresh before appending a delta.");
          }
          await fs.appendFile(deltaFile(wikiRoot), serialized, "utf-8");
          state.persistedArtifactToken = await retrievalArtifactToken(wikiRoot);
        }, checkpointLock);
        // Publish only after the revision-bound journal append succeeds. Canonical
        // Markdown is already durable; a crash-lost derived tail is repaired by
        // reconciliation. The synchronous patch is atomic to the event loop.
        applyPreparedDeltas(state, deltas, newRevision);
        state.revisionLedger = nextRevisionLedger;
        state.persistedRevision = newRevision;
        state.deltaCount++;
        state.deltaBytes += Buffer.byteLength(serialized);
        if (state.deltaCount >= DELTA_COMPACT_COUNT || state.deltaBytes >= DELTA_COMPACT_BYTES) {
          state.persistenceDirty = true;
          await ensureSnapshotPersisted(wikiRoot, state, checkpointLock);
        }
      }
    }
  } catch (error) {
    if (previousData) installData(state, previousData);
    state.loaded = false;
    state.dirty = true;
    state.lastScanMs = 0;
    throw error;
  }
  state.lastScanMs = Date.now();
  state.dirty = false;
  if (newRevision !== baseRevision) state.generation++;
}

export async function updateRetrievalPaths(
  wikiRoot: string,
  relPaths: readonly string[],
  options: { checkpointLock?: DerivedCheckpointLock } = {}
): Promise<void> {
  await withKeyedLock(`${nodePath.resolve(wikiRoot)}:retrieval-update`, () =>
    updateRetrievalPathsLocked(wikiRoot, relPaths, options.checkpointLock)
  );
}

function passageTokens(record: WikiPageRecord): ReadonlyArray<ReadonlySet<string>> {
  const cached = passageTokenCache.get(record);
  if (cached) return cached;
  const tokens = record.passages.map((passage) =>
    new Set(tokenizeSearchText(`${passage.heading} ${passage.text}`))
  );
  passageTokenCache.set(record, tokens);
  return tokens;
}

function bestPassage(
  record: WikiPageRecord,
  terms: readonly string[],
  queryBigrams: readonly string[]
): { heading: string; text: string; matchedBigrams: number } {
  let best = record.passages[0] ?? { heading: "Introduzione", text: record.body };
  let bestUnigramScore = -1;
  let bestPhraseScore = -1;
  const cachedTokens = passageTokens(record);
  for (let index = 0; index < record.passages.length; index++) {
    const passage = record.passages[index]!;
    const tokens = cachedTokens[index] ?? new Set<string>();
    const unigramScore = terms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
    const phraseScore = scoreOrderedPhraseSegments(
      queryBigrams,
      [record.title, `${passage.heading} ${passage.text}`]
    ).matchedBigrams;
    if (phraseScore > bestPhraseScore ||
        (phraseScore === bestPhraseScore && unigramScore > bestUnigramScore)) {
      best = passage;
      bestUnigramScore = unigramScore;
      bestPhraseScore = phraseScore;
    }
  }
  return {
    heading: best.heading,
    text: best.text.replace(/\s+/g, " ").trim().slice(0, 420),
    matchedBigrams: Math.max(0, bestPhraseScore),
  };
}

function phraseRerankConfigured(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const configured = process.env["KNOWLEDGE_RAIL_PHRASE_RERANK"]?.trim().toLowerCase();
  return configured === undefined || !["0", "false", "off", "no", "disabled"].includes(configured);
}

export async function searchRetrievalIndex(params: {
  wikiRoot: string;
  query?: string;
  maxResults?: number;
  pageTypes?: readonly string[];
  profile?: RetrievalProfile;
  forceRefresh?: boolean;
  verificationMode?: RetrievalVerificationMode;
  /** Internal soak/benchmark switch. Production defaults to enabled. */
  phraseRerank?: boolean;
  /** Internal benchmark diagnostics; never added to MCP result payloads. */
  onPhraseDiagnostics?: (diagnostics: PhraseRerankDiagnostics) => void;
  /** Persist refreshed derived state. Read-only MCP operations set this to false. */
  persist?: boolean;
}): Promise<RetrievalHit[]> {
  const state = await refreshRetrievalIndex(params.wikiRoot, {
    force: params.forceRefresh,
    persist: params.persist,
    verificationMode: params.verificationMode,
  });
  const terms = tokenizeSearchText(params.query ?? "");
  const typeFilter = params.pageTypes ? new Set(params.pageTypes) : null;
  if (terms.length === 0) {
    return [...state.records.values()]
      .filter((record) => !typeFilter || typeFilter.has(record.type))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, params.maxResults ?? 50)
      .map((record) => ({
        path: record.path, title: record.title, type: record.type, tags: record.tags,
        sources: record.sources, requestId: record.requestId, score: 0, excerpt: "",
        lexicalBaselineScore: 0, lexicalBaselineRank: 0, heading: "", record,
      }));
  }

  const candidates = new Set<string>();
  for (const term of terms) for (const path of state.postings.get(term)?.keys() ?? []) candidates.add(path);
  const protectedIdentifiers = [...new Set(surfacePhraseTokens(params.query ?? ""))]
    .filter((token) => /[\p{N}_./:#-]/u.test(token));
  const protectExactIdentifiers = protectedIdentifiers.length >= 2;
  const documentCount = Math.max(state.records.size, 1);
  const averageLength = state.totalTokenCount / documentCount;
  const profile = params.profile ?? "balanced";
  const k1 = profile === "precision" ? 1.0 : 1.4;
  const b = profile === "coverage" ? 0.55 : 0.75;
  const candidatesByScore: Array<{
    path: string;
    record: WikiPageRecord;
    score: number;
    exactIdentifierMatch: boolean;
  }> = [];
  for (const path of candidates) {
    const record = state.records.get(path);
    if (!record || (typeFilter && !typeFilter.has(record.type))) continue;
    let score = 0;
    let matchedTerms = 0;
    const normalizedRequestId = normalizeSearchText(record.requestId ?? "");
    const normalizedTitle = normalizeSearchText(record.title);
    for (const term of terms) {
      const byPath = state.postings.get(term);
      const posting = byPath?.get(path);
      if (!posting) continue;
      matchedTerms++;
      const df = byPath?.size ?? 0;
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
      const tf = posting.body + posting.metadata * 2.5 + posting.title * 5;
      const normalizedTf = (tf * (k1 + 1)) /
        (tf + k1 * (1 - b + b * record.tokenCount / Math.max(averageLength, 1)));
      score += idf * normalizedTf;
      if (normalizedRequestId === term || normalizedTitle === term) score += 8;
    }
    score *= 1 + matchedTerms / terms.length;
    candidatesByScore.push({
      path,
      record,
      score,
      exactIdentifierMatch: protectExactIdentifiers &&
        protectedIdentifiers.every((identifier) => state.postings.get(identifier)?.has(path) === true),
    });
  }
  candidatesByScore.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const maxResults = Math.max(1, params.maxResults ?? 10);
  const queryBigrams = [...new Set(orderedWordBigrams(surfacePhraseTokens(params.query ?? "")))];
  const phraseEnabled = phraseRerankConfigured(params.phraseRerank) &&
    queryBigrams.length > 0 &&
    protectedIdentifiers.length <= MAX_PHRASE_IDENTIFIER_TOKENS &&
    maxResults <= MAX_PHRASE_REQUEST_RESULTS;
  const poolSize = phraseEnabled
    ? Math.min(
        candidatesByScore.length,
        MAX_PHRASE_POOL,
        Math.max(MIN_PHRASE_POOL, maxResults * PHRASE_POOL_MULTIPLIER)
      )
    : Math.min(candidatesByScore.length, maxResults);
  const pool = candidatesByScore.slice(0, poolSize).map((candidate, baselineRank) => {
    const passage = bestPassage(candidate.record, terms, phraseEnabled ? queryBigrams : []);
    return { ...candidate, baselineRank, passage, rankScore: candidate.score };
  });
  const maximumPhraseScore = Math.max(0, ...pool.map((candidate) => candidate.passage.matchedBigrams));
  if (phraseEnabled && maximumPhraseScore > 0) {
    const minimumBaseScore = Math.min(...pool.map((candidate) => candidate.score));
    const maximumBaseScore = Math.max(...pool.map((candidate) => candidate.score));
    for (const candidate of pool) {
      candidate.rankScore = scoreBigramRerankCandidate({
        baseScore: candidate.score,
        minimumBaseScore,
        maximumBaseScore,
        matchedBigrams: candidate.passage.matchedBigrams,
        queryBigramCount: queryBigrams.length,
        exactIdentifierMatch: candidate.exactIdentifierMatch,
      });
    }
    pool.sort((a, b) => b.rankScore - a.rankScore || a.path.localeCompare(b.path));
  }

  params.onPhraseDiagnostics?.({
    enabled: phraseEnabled && maximumPhraseScore > 0,
    queryBigramCount: queryBigrams.length,
    protectedIdentifierCount: protectExactIdentifiers ? protectedIdentifiers.length : 0,
    candidateCount: candidatesByScore.length,
    rescoredCount: phraseEnabled && maximumPhraseScore > 0 ? pool.length : 0,
    rankChanges: pool.flatMap((candidate, rerankedRank) =>
      candidate.baselineRank === rerankedRank ? [] : [{
        path: candidate.path,
        baselineRank: candidate.baselineRank + 1,
        rerankedRank: rerankedRank + 1,
        matchedBigrams: candidate.passage.matchedBigrams,
        heading: candidate.passage.heading,
      }]),
  });

  return pool.slice(0, maxResults).map((candidate) => ({
    path: candidate.path,
    title: candidate.record.title,
    type: candidate.record.type,
    tags: candidate.record.tags,
    sources: candidate.record.sources,
    requestId: candidate.record.requestId,
    score: candidate.rankScore,
    lexicalBaselineScore: candidate.score,
    lexicalBaselineRank: candidate.baselineRank + 1,
    excerpt: candidate.passage.text,
    heading: candidate.passage.heading,
    record: candidate.record,
  }));
}

export async function getWikiPageRecords(
  wikiRoot: string,
  forceRefresh = false,
  options: { persist?: boolean } = {}
): Promise<WikiPageRecord[]> {
  const state = await refreshRetrievalIndex(wikiRoot, {
    force: forceRefresh,
    persist: options.persist,
  });
  return [...state.records.values()];
}

export async function getVerifiedWikiCorpus(
  wikiRoot: string,
  forceRefresh = false,
  options: { persist?: boolean; verificationMode?: RetrievalVerificationMode } = {}
): Promise<{ records: WikiPageRecord[]; corpusRevision: string; generation: number }> {
  const state = await refreshRetrievalIndex(wikiRoot, {
    force: forceRefresh,
    persist: options.persist,
    verificationMode: options.verificationMode,
  });
  return {
    records: [...state.records.values()],
    corpusRevision: state.corpusRevision,
    generation: state.generation,
  };
}

export function clearRetrievalIndexes(): void {
  for (const root of [...states.keys()]) evictWorkspaceState(root);
  for (const state of states.values()) state.watcher?.close();
  states.clear();
}
