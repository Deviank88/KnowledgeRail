import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import * as nodePath from "node:path";
import { normalizeManifestPath, normalizeMarkdownBytes, wikiMetaDir } from "./manifest-service.js";
import type { WikiPageRecord, WikiPassage } from "./page-record.js";
import { derivedCheckpointDirectoryKind } from "./checkpoint-lock.js";

export const RETRIEVAL_CHECKPOINT_SCHEMA_VERSION = 2;
export const RETRIEVAL_BUILDER_VERSION = "global-flat-v2-merkle";
export const RETRIEVAL_CHECKPOINT_ENCODING = "global-flat-v1";

const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_TERMS = 2_000_000;
const MAX_POSTINGS = 20_000_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_ARRAY_ITEMS = 100_000;

export interface RetrievalCheckpointWriteLimits {
  maxSnapshotBytes?: number;
  maxJournalBytes?: number;
  maxRecords?: number;
  maxTerms?: number;
  maxPostings?: number;
}

export type RetrievalCheckpointWriteBoundsReason =
  | "snapshot_bytes"
  | "journal_bytes"
  | "record_limit"
  | "term_limit"
  | "posting_limit"
  | "payload_invalid";

/**
 * A normal capacity boundary, not checkpoint corruption. Callers may keep the
 * canonical Markdown generation live while reporting that warm persistence was
 * skipped. No artifact has been written when this error is raised.
 */
export class RetrievalCheckpointBoundsError extends Error {
  readonly code = "retrieval_checkpoint_bounds_exceeded";

  constructor(readonly reason: RetrievalCheckpointWriteBoundsReason) {
    super(`Retrieval checkpoint exceeds the reader-compatible ${reason} bound.`);
    this.name = "RetrievalCheckpointBoundsError";
  }
}

export interface RetrievalPosting {
  body: number;
  title: number;
  metadata: number;
}

export interface RetrievalFileMetadata {
  mtimeMs: number;
  ctimeMs?: number;
  size: number;
  dev?: number;
  ino?: number;
}

export interface RetrievalCheckpointData {
  records: Map<string, WikiPageRecord>;
  postings: Map<string, Map<string, RetrievalPosting>>;
  fingerprints: Map<string, string>;
  fileMetadata: Map<string, RetrievalFileMetadata>;
  totalTokenCount: number;
  corpusRevision: string;
}

export type IndexedTermTuple = readonly [term: string, body: number, title: number, metadata: number];

interface PersistedRecord {
  record: WikiPageRecord;
  fingerprint: string;
  metadata: RetrievalFileMetadata;
}

interface RetrievalPayloadV2 {
  schemaVersion: 2;
  builderVersion: typeof RETRIEVAL_BUILDER_VERSION;
  corpusRevision: string;
  records: PersistedRecord[];
  lexicalRuntime: {
    encoding: typeof RETRIEVAL_CHECKPOINT_ENCODING;
    terms: Array<readonly [term: string, flatPostings: number[]]>;
  };
  totalTokenCount: number;
}

interface CheckpointEnvelope {
  payload: RetrievalPayloadV2;
  payloadChecksum: string;
}

interface DeltaChange {
  path: string;
  entry: (PersistedRecord & { indexedTerms: IndexedTermTuple[] }) | null;
}

interface DeltaPayloadV2 {
  schemaVersion: 2;
  builderVersion: typeof RETRIEVAL_BUILDER_VERSION;
  baseRevision: string;
  newRevision: string;
  changes: DeltaChange[];
}

interface DeltaEnvelope {
  payload: DeltaPayloadV2;
  payloadChecksum: string;
}

export type RetrievalFallbackReason =
  | "none"
  | "forced_rebuild"
  | "snapshot_missing"
  | "snapshot_v1_migration"
  | "checkpoint_directory_symlink"
  | "checkpoint_directory_not_directory"
  | "snapshot_symlink"
  | "snapshot_not_regular"
  | "snapshot_oversized"
  | "snapshot_malformed"
  | "snapshot_schema_mismatch"
  | "snapshot_builder_mismatch"
  | "snapshot_checksum_mismatch"
  | "snapshot_bounds_invalid"
  | "snapshot_revision_mismatch"
  | "journal_without_snapshot"
  | "journal_symlink"
  | "journal_oversized"
  | "journal_malformed"
  | "journal_lineage_mismatch"
  | "journal_revision_mismatch";

export type RetrievalCheckpointRead =
  | {
    kind: "v2";
    data: RetrievalCheckpointData;
    persistedRevision: string;
    deltaCount: number;
    deltaBytes: number;
    fallbackReason: "none";
  }
  | {
    kind: "v1";
    records: WikiPageRecord[];
    fallbackReason: "snapshot_v1_migration";
  }
  | {
    kind: "empty";
    fallbackReason: RetrievalFallbackReason;
  };

export interface RetrievalDeltaInput {
  path: string;
  record: WikiPageRecord | null;
  fingerprint?: string;
  metadata?: RetrievalFileMetadata;
  indexedTerms?: IndexedTermTuple[];
}

interface ArtifactIdentity {
  kind: "missing" | "file" | "symlink" | "other";
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
}

class CheckpointReadError extends Error {
  constructor(readonly reason: RetrievalFallbackReason) {
    super(reason);
  }
}

export function retrievalSnapshotFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "retrieval-index.json");
}

export function retrievalDeltaFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "retrieval-delta.jsonl");
}

async function artifactIdentity(filePath: string): Promise<ArtifactIdentity> {
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

/**
 * Cheap compare-and-swap token for a generation already validated by the full
 * checkpoint reader. Atomic replacement changes inode/ctime, while a journal
 * append changes size/ctime, so stale processes are detected without parsing
 * a multi-megabyte snapshot for every single-page update.
 */
export async function retrievalArtifactToken(wikiRoot: string): Promise<string> {
  const directoryKind = await derivedCheckpointDirectoryKind(wikiRoot);
  if (directoryKind === "symlink" || directoryKind === "other") {
    return JSON.stringify({ checkpointDirectory: directoryKind });
  }
  const [snapshot, journal] = await Promise.all([
    artifactIdentity(retrievalSnapshotFile(wikiRoot)),
    artifactIdentity(retrievalDeltaFile(wikiRoot)),
  ]);
  return JSON.stringify({ snapshot, journal });
}

export function emptyRetrievalCheckpointData(): RetrievalCheckpointData {
  return {
    records: new Map(),
    postings: new Map(),
    fingerprints: new Map(),
    fileMetadata: new Map(),
    totalTokenCount: 0,
    corpusRevision: emptyCorpusRevision(),
  };
}

function emptyCorpusRevision(): string {
  return hashHex(Buffer.from([2]));
}

function hashHex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checksumMatches(payload: unknown, checksum: unknown): boolean {
  if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return false;
  const actual = Buffer.from(hashHex(JSON.stringify(payload)), "hex");
  const expected = Buffer.from(checksum, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function fingerprintWikiRaw(raw: string): string {
  return hashHex(normalizeMarkdownBytes(Buffer.from(raw, "utf8")));
}

function writeLength(hash: ReturnType<typeof createHash>, length: number): void {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(length);
  hash.update(buffer);
}

function corpusLeaf(pathValue: string, fingerprint: string): Buffer {
  const hash = createHash("sha256");
  hash.update(Buffer.from([0]));
  const normalizedPath = Buffer.from(normalizeManifestPath(pathValue), "utf8");
  const digest = Buffer.from(fingerprint, "hex");
  writeLength(hash, normalizedPath.length);
  hash.update(normalizedPath);
  writeLength(hash, digest.length);
  hash.update(digest);
  return hash.digest();
}

function corpusParent(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256").update(Buffer.from([1])).update(left).update(right).digest();
}

/**
 * Deterministic Merkle revision ledger. Existing-path edits update O(log n)
 * nodes; add/delete/rename rebuilds the sorted tree because its path roster
 * changes. Domain bytes distinguish leaves, parents, and the empty corpus.
 */
export class CorpusRevisionLedger {
  private constructor(
    private readonly paths: readonly string[],
    private readonly indexes: ReadonlyMap<string, number>,
    private readonly capacity: number,
    private readonly nodes: Buffer[]
  ) {}

  static from(fingerprints: ReadonlyMap<string, string>): CorpusRevisionLedger {
    const entries = [...fingerprints.entries()].sort(([left], [right]) => compareText(left, right));
    if (entries.length === 0) {
      const empty = Buffer.from(emptyCorpusRevision(), "hex");
      return new CorpusRevisionLedger([], new Map(), 1, [empty, empty]);
    }
    let capacity = 1;
    while (capacity < entries.length) capacity *= 2;
    const empty = Buffer.from(emptyCorpusRevision(), "hex");
    const nodes: Buffer[] = Array.from({ length: capacity * 2 }, () => empty);
    const paths = entries.map(([pathValue]) => pathValue);
    const indexes = new Map(paths.map((pathValue, index) => [pathValue, index]));
    entries.forEach(([pathValue, fingerprint], index) => {
      nodes[capacity + index] = corpusLeaf(pathValue, fingerprint);
    });
    for (let index = capacity - 1; index >= 1; index--) {
      nodes[index] = corpusParent(nodes[index * 2]!, nodes[index * 2 + 1]!);
    }
    return new CorpusRevisionLedger(paths, indexes, capacity, nodes);
  }

  clone(): CorpusRevisionLedger {
    return new CorpusRevisionLedger(this.paths, this.indexes, this.capacity, this.nodes.slice());
  }

  updateExisting(pathValue: string, fingerprint: string): boolean {
    const recordIndex = this.indexes.get(pathValue);
    if (recordIndex === undefined) return false;
    let nodeIndex = this.capacity + recordIndex;
    this.nodes[nodeIndex] = corpusLeaf(pathValue, fingerprint);
    while (nodeIndex > 1) {
      nodeIndex = Math.floor(nodeIndex / 2);
      this.nodes[nodeIndex] = corpusParent(this.nodes[nodeIndex * 2]!, this.nodes[nodeIndex * 2 + 1]!);
    }
    return true;
  }

  get revision(): string {
    return this.nodes[1]!.toString("hex");
  }
}

export function computeCorpusRevision(fingerprints: ReadonlyMap<string, string>): string {
  return CorpusRevisionLedger.from(fingerprints).revision;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, maxBytes = MAX_STRING_BYTES): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maxBytes;
}

function safeStringArray(value: unknown, maxItems = MAX_RECORD_ARRAY_ITEMS): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => safeString(item, 64 * 1024));
}

function safeNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validRelativeMarkdownPath(value: unknown): value is string {
  if (!safeString(value, 16 * 1024) || value !== normalizeManifestPath(value)) return false;
  return !nodePath.posix.isAbsolute(value) && value.toLowerCase().endsWith(".md") &&
    value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function validPassage(value: unknown): value is WikiPassage {
  if (!isObject(value)) return false;
  return safeString(value.id, 16 * 1024) && safeString(value.heading, 256 * 1024) &&
    safeString(value.text) && safeCount(value.charStart);
}

function validRecord(value: unknown): value is WikiPageRecord {
  if (!isObject(value)) return false;
  if (
    !validRelativeMarkdownPath(value.path) ||
    !safeNonNegativeNumber(value.mtimeMs) ||
    !safeCount(value.size) ||
    !safeString(value.title, 256 * 1024) ||
    !safeString(value.type, 64 * 1024) ||
    !safeStringArray(value.tags) ||
    !safeStringArray(value.aliases) ||
    !safeStringArray(value.sources) ||
    !safeString(value.body) ||
    !safeString(value.raw) ||
    !Array.isArray(value.passages) || value.passages.length > MAX_RECORD_ARRAY_ITEMS ||
    !value.passages.every(validPassage) ||
    !safeCount(value.tokenCount) || value.tokenCount < 1
  ) return false;
  for (const optional of ["requestId", "client", "project", "updated"] as const) {
    if (value[optional] !== undefined && !safeString(value[optional], 256 * 1024)) return false;
  }
  return true;
}

function validMetadata(value: unknown): value is RetrievalFileMetadata {
  if (!isObject(value)) return false;
  if (!safeNonNegativeNumber(value.mtimeMs) || !safeNonNegativeNumber(value.ctimeMs ?? 0) || !safeCount(value.size)) {
    return false;
  }
  return [value.dev, value.ino].every((item) => item === undefined || safeNonNegativeNumber(item));
}

function validPersistedRecord(value: unknown): value is PersistedRecord {
  if (!isObject(value) || !validRecord(value.record) || !validMetadata(value.metadata)) return false;
  return typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    value.record.path === normalizeManifestPath(value.record.path) &&
    value.record.mtimeMs === value.metadata.mtimeMs && value.record.size === value.metadata.size &&
    fingerprintWikiRaw(value.record.raw) === value.fingerprint;
}

function validIndexedTerms(value: unknown): value is IndexedTermTuple[] {
  if (!Array.isArray(value) || value.length > MAX_TERMS) return false;
  let previous = "";
  for (const tuple of value) {
    if (!Array.isArray(tuple) || tuple.length !== 4 || !safeString(tuple[0], 4096) || tuple[0] <= previous) return false;
    if (![tuple[1], tuple[2], tuple[3]].every(safeCount) || tuple[1] + tuple[2] + tuple[3] <= 0) return false;
    previous = tuple[0];
  }
  return true;
}

function addPosting(
  data: RetrievalCheckpointData,
  record: WikiPageRecord,
  term: string,
  body: number,
  title: number,
  metadata: number
): void {
  let byPath = data.postings.get(term);
  if (!byPath) {
    byPath = new Map();
    data.postings.set(term, byPath);
  }
  byPath.set(record.path, { body, title, metadata });
}

export function removeCheckpointRecord(data: RetrievalCheckpointData, relPath: string): void {
  const existing = data.records.get(relPath);
  if (!existing) return;
  data.records.delete(relPath);
  data.fingerprints.delete(relPath);
  data.fileMetadata.delete(relPath);
  data.totalTokenCount = Math.max(0, data.totalTokenCount - existing.tokenCount);
  for (const [term, byPath] of data.postings) {
    byPath.delete(relPath);
    if (byPath.size === 0) data.postings.delete(term);
  }
}

export function addCheckpointRecord(
  data: RetrievalCheckpointData,
  input: {
    record: WikiPageRecord;
    fingerprint: string;
    metadata: RetrievalFileMetadata;
    indexedTerms: readonly IndexedTermTuple[];
  }
): void {
  data.records.set(input.record.path, input.record);
  data.fingerprints.set(input.record.path, input.fingerprint);
  data.fileMetadata.set(input.record.path, input.metadata);
  data.totalTokenCount += input.record.tokenCount;
  for (const [term, body, title, metadata] of input.indexedTerms) {
    addPosting(data, input.record, term, body, title, metadata);
  }
}

function parsePayload(payload: unknown): RetrievalCheckpointData {
  if (!isObject(payload) || payload.schemaVersion !== RETRIEVAL_CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointReadError("snapshot_schema_mismatch");
  }
  if (payload.builderVersion !== RETRIEVAL_BUILDER_VERSION) {
    throw new CheckpointReadError("snapshot_builder_mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(String(payload.corpusRevision ?? "")) || !safeCount(payload.totalTokenCount)) {
    throw new CheckpointReadError("snapshot_bounds_invalid");
  }
  if (!Array.isArray(payload.records) || payload.records.length > MAX_RECORDS ||
      !isObject(payload.lexicalRuntime) || payload.lexicalRuntime.encoding !== RETRIEVAL_CHECKPOINT_ENCODING ||
      !Array.isArray(payload.lexicalRuntime.terms) || payload.lexicalRuntime.terms.length > MAX_TERMS) {
    throw new CheckpointReadError("snapshot_bounds_invalid");
  }
  const records = payload.records as unknown[];
  const data = emptyRetrievalCheckpointData();
  let previousPath = "";
  for (const value of records) {
    if (!validPersistedRecord(value)) throw new CheckpointReadError("snapshot_bounds_invalid");
    const entry = value as PersistedRecord;
    if (entry.record.path <= previousPath) throw new CheckpointReadError("snapshot_bounds_invalid");
    previousPath = entry.record.path;
    data.records.set(entry.record.path, entry.record);
    data.fingerprints.set(entry.record.path, entry.fingerprint);
    data.fileMetadata.set(entry.record.path, entry.metadata);
    data.totalTokenCount += entry.record.tokenCount;
  }
  if (data.totalTokenCount !== payload.totalTokenCount) throw new CheckpointReadError("snapshot_bounds_invalid");

  let previousTerm = "";
  let postingCount = 0;
  for (const value of payload.lexicalRuntime.terms as unknown[]) {
    if (!Array.isArray(value) || value.length !== 2 || !safeString(value[0], 4096) || value[0] <= previousTerm ||
        !Array.isArray(value[1]) || value[1].length % 4 !== 0) {
      throw new CheckpointReadError("snapshot_bounds_invalid");
    }
    const term = value[0];
    const flat = value[1] as unknown[];
    previousTerm = term;
    postingCount += flat.length / 4;
    if (postingCount > MAX_POSTINGS) throw new CheckpointReadError("snapshot_bounds_invalid");
    let previousRecordIndex = -1;
    for (let offset = 0; offset < flat.length; offset += 4) {
      const recordIndex = flat[offset];
      const body = flat[offset + 1];
      const title = flat[offset + 2];
      const metadata = flat[offset + 3];
      if (!safeCount(recordIndex) || recordIndex >= records.length || recordIndex <= previousRecordIndex ||
          !safeCount(body) || !safeCount(title) || !safeCount(metadata) || body + title + metadata <= 0) {
        throw new CheckpointReadError("snapshot_bounds_invalid");
      }
      previousRecordIndex = recordIndex;
      addPosting(data, (records[recordIndex] as PersistedRecord).record, term, body, title, metadata);
    }
  }
  data.corpusRevision = computeCorpusRevision(data.fingerprints);
  if (data.corpusRevision !== payload.corpusRevision) {
    throw new CheckpointReadError("snapshot_revision_mismatch");
  }
  return data;
}

async function readRegularBounded(
  filePath: string,
  maxBytes: number,
  reasons: { symlink: RetrievalFallbackReason; notRegular: RetrievalFallbackReason; oversized: RetrievalFallbackReason }
): Promise<string | null> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new CheckpointReadError(reasons.symlink);
  if (!stat.isFile()) throw new CheckpointReadError(reasons.notRegular);
  if (stat.size > maxBytes) throw new CheckpointReadError(reasons.oversized);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new CheckpointReadError(reasons.notRegular);
    if (openedStat.size > maxBytes) throw new CheckpointReadError(reasons.oversized);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseDeltaLine(line: string): DeltaPayloadV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CheckpointReadError("journal_malformed");
  }
  if (!isObject(parsed) || !checksumMatches(parsed.payload, parsed.payloadChecksum) || !isObject(parsed.payload)) {
    throw new CheckpointReadError("journal_malformed");
  }
  const payload = parsed.payload;
  if (payload.schemaVersion !== 2 || payload.builderVersion !== RETRIEVAL_BUILDER_VERSION ||
      typeof payload.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(payload.baseRevision) ||
      typeof payload.newRevision !== "string" || !/^[a-f0-9]{64}$/.test(payload.newRevision) ||
      !Array.isArray(payload.changes) || payload.changes.length === 0 || payload.changes.length > MAX_RECORDS) {
    throw new CheckpointReadError("journal_malformed");
  }
  let previousPath = "";
  for (const value of payload.changes) {
    if (!isObject(value) || !validRelativeMarkdownPath(value.path) || value.path <= previousPath) {
      throw new CheckpointReadError("journal_malformed");
    }
    previousPath = value.path;
    if (value.entry === null) continue;
    if (!isObject(value.entry) || !validPersistedRecord(value.entry) ||
        value.entry.record.path !== value.path || !validIndexedTerms(value.entry.indexedTerms)) {
      throw new CheckpointReadError("journal_malformed");
    }
  }
  return payload as unknown as DeltaPayloadV2;
}

function applyDelta(data: RetrievalCheckpointData, delta: DeltaPayloadV2): void {
  for (const change of delta.changes) {
    removeCheckpointRecord(data, change.path);
    if (change.entry) addCheckpointRecord(data, change.entry);
  }
  data.corpusRevision = computeCorpusRevision(data.fingerprints);
  if (data.corpusRevision !== delta.newRevision) {
    throw new CheckpointReadError("journal_revision_mismatch");
  }
}

async function readJournalLines(wikiRoot: string): Promise<{ payloads: DeltaPayloadV2[]; bytes: number }> {
  const raw = await readRegularBounded(retrievalDeltaFile(wikiRoot), MAX_JOURNAL_BYTES, {
    symlink: "journal_symlink",
    notRegular: "journal_malformed",
    oversized: "journal_oversized",
  });
  if (raw === null || raw.length === 0) return { payloads: [], bytes: 0 };
  const rawLines = raw.split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();
  const payloads: DeltaPayloadV2[] = [];
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index]!;
    if (!line) continue;
    try {
      payloads.push(parseDeltaLine(line));
    } catch (error) {
      // A process can be killed during append; only the incomplete final line
      // is disposable. A newline-terminated or interior malformed line is not.
      const isIncompleteTail = index === rawLines.length - 1 && !raw.endsWith("\n");
      if (!isIncompleteTail) throw error;
    }
  }
  return { payloads, bytes: Buffer.byteLength(raw) };
}

function parseLegacy(raw: string, legacyDeltas: string | null): WikiPageRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records) ||
      parsed.records.length > MAX_RECORDS || !parsed.records.every(validRecord)) return null;
  const records = new Map((parsed.records as WikiPageRecord[]).map((record) => [record.path, record]));
  if (legacyDeltas) {
    const lines = legacyDeltas.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line) continue;
      try {
        const delta = JSON.parse(line) as { path?: unknown; record?: unknown };
        if (!validRelativeMarkdownPath(delta.path) || (delta.record !== null && !validRecord(delta.record))) return null;
        records.delete(delta.path);
        if (delta.record) records.set(delta.path, delta.record);
      } catch {
        if (index !== lines.length - 1 || legacyDeltas.endsWith("\n")) return null;
      }
    }
  }
  return [...records.values()].sort((left, right) => compareText(left.path, right.path));
}

export async function readRetrievalCheckpoint(wikiRoot: string): Promise<RetrievalCheckpointRead> {
  try {
    const directoryKind = await derivedCheckpointDirectoryKind(wikiRoot);
    if (directoryKind === "symlink") {
      return { kind: "empty", fallbackReason: "checkpoint_directory_symlink" };
    }
    if (directoryKind === "other") {
      return { kind: "empty", fallbackReason: "checkpoint_directory_not_directory" };
    }
    const raw = await readRegularBounded(retrievalSnapshotFile(wikiRoot), MAX_SNAPSHOT_BYTES, {
      symlink: "snapshot_symlink",
      notRegular: "snapshot_not_regular",
      oversized: "snapshot_oversized",
    });
    if (raw === null) {
      const journal = await readRegularBounded(retrievalDeltaFile(wikiRoot), MAX_JOURNAL_BYTES, {
        symlink: "journal_symlink",
        notRegular: "journal_malformed",
        oversized: "journal_oversized",
      });
      return { kind: "empty", fallbackReason: journal ? "journal_without_snapshot" : "snapshot_missing" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "empty", fallbackReason: "snapshot_malformed" };
    }
    if (isObject(parsed) && parsed.version === 1) {
      const legacyDelta = await readRegularBounded(retrievalDeltaFile(wikiRoot), MAX_JOURNAL_BYTES, {
        symlink: "journal_symlink",
        notRegular: "journal_malformed",
        oversized: "journal_oversized",
      });
      const records = parseLegacy(raw, legacyDelta);
      return records
        ? { kind: "v1", records, fallbackReason: "snapshot_v1_migration" }
        : { kind: "empty", fallbackReason: "snapshot_malformed" };
    }
    if (!isObject(parsed) || !isObject(parsed.payload)) {
      return { kind: "empty", fallbackReason: "snapshot_schema_mismatch" };
    }
    if (!checksumMatches(parsed.payload, parsed.payloadChecksum)) {
      return { kind: "empty", fallbackReason: "snapshot_checksum_mismatch" };
    }
    const data = parsePayload(parsed.payload);
    const snapshotRevision = data.corpusRevision;
    const journal = await readJournalLines(wikiRoot);
    let startIndex = 0;
    if (journal.payloads.length > 0 && journal.payloads[0]!.baseRevision !== snapshotRevision) {
      const includedIndex = journal.payloads.findIndex((delta) => delta.newRevision === snapshotRevision);
      if (includedIndex < 0) throw new CheckpointReadError("journal_lineage_mismatch");
      startIndex = includedIndex + 1;
    }
    for (const delta of journal.payloads.slice(startIndex)) {
      if (delta.baseRevision !== data.corpusRevision) {
        throw new CheckpointReadError("journal_lineage_mismatch");
      }
      applyDelta(data, delta);
    }
    return {
      kind: "v2",
      data,
      persistedRevision: data.corpusRevision,
      deltaCount: journal.payloads.length,
      deltaBytes: journal.bytes,
      fallbackReason: "none",
    };
  } catch (error) {
    if (error instanceof CheckpointReadError) return { kind: "empty", fallbackReason: error.reason };
    return { kind: "empty", fallbackReason: "snapshot_malformed" };
  }
}

function resolvedWriteLimits(limits: RetrievalCheckpointWriteLimits): Required<RetrievalCheckpointWriteLimits> {
  return {
    maxSnapshotBytes: Math.min(MAX_SNAPSHOT_BYTES, limits.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES),
    maxJournalBytes: Math.min(MAX_JOURNAL_BYTES, limits.maxJournalBytes ?? MAX_JOURNAL_BYTES),
    maxRecords: Math.min(MAX_RECORDS, limits.maxRecords ?? MAX_RECORDS),
    maxTerms: Math.min(MAX_TERMS, limits.maxTerms ?? MAX_TERMS),
    maxPostings: Math.min(MAX_POSTINGS, limits.maxPostings ?? MAX_POSTINGS),
  };
}

function payloadFor(
  data: RetrievalCheckpointData,
  limits: Required<RetrievalCheckpointWriteLimits>
): RetrievalPayloadV2 {
  const recordEntries = [...data.records.entries()].sort(([, left], [, right]) => compareText(left.path, right.path));
  let previousRecordPath = "";
  for (const [mapPath, record] of recordEntries) {
    if (mapPath !== record.path || record.path <= previousRecordPath) {
      throw new RetrievalCheckpointBoundsError("payload_invalid");
    }
    previousRecordPath = record.path;
  }
  const records = recordEntries.map(([, record]) => record);
  if (records.length > limits.maxRecords) throw new RetrievalCheckpointBoundsError("record_limit");
  if (data.postings.size > limits.maxTerms) throw new RetrievalCheckpointBoundsError("term_limit");
  const recordIndexes = new Map(records.map((record, index) => [record.path, index]));
  const terms: RetrievalPayloadV2["lexicalRuntime"]["terms"] = [];
  let postingCount = 0;
  for (const [term, byPath] of [...data.postings.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (!safeString(term, 4096)) throw new RetrievalCheckpointBoundsError("payload_invalid");
    postingCount += byPath.size;
    if (postingCount > limits.maxPostings) throw new RetrievalCheckpointBoundsError("posting_limit");
    const flat: number[] = [];
    for (const [recordPath, posting] of [...byPath.entries()].sort(([left], [right]) => compareText(left, right))) {
      const recordIndex = recordIndexes.get(recordPath);
      if (recordIndex === undefined) throw new Error("Retrieval postings reference an unknown record.");
      if (![posting.body, posting.title, posting.metadata].every(safeCount) ||
          posting.body + posting.title + posting.metadata <= 0) {
        throw new RetrievalCheckpointBoundsError("payload_invalid");
      }
      flat.push(recordIndex, posting.body, posting.title, posting.metadata);
    }
    terms.push([term, flat]);
  }
  const revision = computeCorpusRevision(data.fingerprints);
  if (revision !== data.corpusRevision) throw new Error("Retrieval corpus revision is not synchronized.");
  const payload: RetrievalPayloadV2 = {
    schemaVersion: 2,
    builderVersion: RETRIEVAL_BUILDER_VERSION,
    corpusRevision: revision,
    records: records.map((record) => {
      const fingerprint = data.fingerprints.get(record.path);
      const metadata = data.fileMetadata.get(record.path);
      if (!fingerprint || !metadata) throw new Error("Retrieval checkpoint metadata is incomplete.");
      return { record, fingerprint, metadata };
    }),
    lexicalRuntime: { encoding: RETRIEVAL_CHECKPOINT_ENCODING, terms },
    totalTokenCount: data.totalTokenCount,
  };
  // The writer must never emit a generation the same build would reject. This
  // deliberately validates before serialization and before any atomic replace.
  if (!Array.isArray(payload.records) || !payload.records.every(validPersistedRecord) ||
      payload.records.reduce((sum, entry) => sum + entry.record.tokenCount, 0) !== payload.totalTokenCount ||
      !payload.lexicalRuntime.terms.every(([term, flat]) =>
        safeString(term, 4096) && flat.length % 4 === 0 && flat.every(safeCount))) {
    throw new RetrievalCheckpointBoundsError("payload_invalid");
  }
  return payload;
}

export function serializeRetrievalCheckpoint(
  data: RetrievalCheckpointData,
  writeLimits: RetrievalCheckpointWriteLimits = {}
): string {
  const limits = resolvedWriteLimits(writeLimits);
  const payload = payloadFor(data, limits);
  const envelope: CheckpointEnvelope = { payload, payloadChecksum: hashHex(JSON.stringify(payload)) };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized) > limits.maxSnapshotBytes) {
    throw new RetrievalCheckpointBoundsError("snapshot_bytes");
  }
  return serialized;
}

export function serializeRetrievalDelta(
  baseRevision: string,
  newRevision: string,
  changes: readonly RetrievalDeltaInput[],
  writeLimits: RetrievalCheckpointWriteLimits = {}
): string {
  const limits = resolvedWriteLimits(writeLimits);
  if (!/^[a-f0-9]{64}$/.test(baseRevision) || !/^[a-f0-9]{64}$/.test(newRevision)) {
    throw new RetrievalCheckpointBoundsError("payload_invalid");
  }
  if (changes.length === 0 || changes.length > limits.maxRecords) {
    throw new RetrievalCheckpointBoundsError("record_limit");
  }
  const payload: DeltaPayloadV2 = {
    schemaVersion: 2,
    builderVersion: RETRIEVAL_BUILDER_VERSION,
    baseRevision,
    newRevision,
    changes: [...changes]
      .sort((left, right) => compareText(left.path, right.path))
      .map((change) => {
        if (!change.record) return { path: change.path, entry: null };
        if (!change.fingerprint || !change.metadata || !change.indexedTerms) {
          throw new Error("Retrieval delta metadata is incomplete.");
        }
        return {
          path: change.path,
          entry: {
            record: change.record,
            fingerprint: change.fingerprint,
            metadata: change.metadata,
            indexedTerms: [...change.indexedTerms],
          },
        };
      }),
  };
  let totalTerms = 0;
  let previousPath = "";
  for (const change of payload.changes) {
    if (!validRelativeMarkdownPath(change.path) || change.path <= previousPath ||
        (change.entry !== null && (!validPersistedRecord(change.entry) ||
          change.entry.record.path !== change.path ||
          !validIndexedTerms(change.entry.indexedTerms)))) {
      throw new RetrievalCheckpointBoundsError("payload_invalid");
    }
    previousPath = change.path;
    totalTerms += change.entry?.indexedTerms.length ?? 0;
    if (totalTerms > limits.maxTerms) throw new RetrievalCheckpointBoundsError("term_limit");
  }
  const envelope: DeltaEnvelope = { payload, payloadChecksum: hashHex(JSON.stringify(payload)) };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized) > limits.maxJournalBytes) {
    throw new RetrievalCheckpointBoundsError("journal_bytes");
  }
  return serialized;
}
