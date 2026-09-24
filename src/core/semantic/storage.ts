import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { performance } from "node:perf_hooks";
import { atomicWriteBuffer } from "../fs-service.js";
import { wikiMetaDir } from "../manifest-service.js";
import type { EmbeddingProviderDescriptor, AnnEngineDescriptor, SemanticVector, AnnSignatures } from "./types.js";
import type { VectorDtype } from "./vector.js";

export interface StoredPage {
  path: string;
  fingerprint: string;
  passageEntryIds: string[];
  complete: boolean;
  sourceFingerprint?: string;
}
export interface StoredPassage {
  id: string;
  pagePath: string;
  passageId: string;
  heading: string;
  vector: SemanticVector;
  scale: number;
  signatures?: AnnSignatures;
}
export interface SemanticBatch { pages: StoredPage[]; passages: StoredPassage[]; removed: string[] }
export interface StoredState {
  pages: Map<string, StoredPage>;
  passages: Map<string, StoredPassage>;
  generatedAt?: string;
  engine?: AnnEngineDescriptor;
  graphSnapshot?: Uint8Array;
  /** Snapshot vector references before valid journal replay, only when a graph exists.
   * Transient ownership; no second vector encoding or extra persisted matrix. */
  graphBasePassages?: ReadonlyMap<string, StoredPassage>;
  /** Compatible pre-release metadata should be rewritten without retired fields. */
  needsCompaction?: boolean;
}
interface VectorMetadata extends Omit<StoredPassage, "vector" | "scale" | "signatures"> {}
interface Snapshot {
  version: 2;
  provider: EmbeddingProviderDescriptor;
  engine: AnnEngineDescriptor;
  dtype: VectorDtype;
  generatedAt: string;
  vectorsHash: string;
  graphHash?: string;
  pages: StoredPage[];
  passages: VectorMetadata[];
  journalId?: string;
  journalThrough?: number;
  corpusRevision?: string;
}
const MAGIC = Buffer.from("KRSEM002");
const HEADER_SIZE = 64;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const MAX_FRAME = 32 * 1024 * 1024;
const FILES = ["semantic-index.json", "semantic-vectors.bin", "semantic-journal.bin", "semantic-graph.bin"] as const;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function metadata(passage: StoredPassage): VectorMetadata {
  // Discard text and retired float32-original references from compatible snapshots.
  return { id: passage.id, pagePath: passage.pagePath, passageId: passage.passageId, heading: passage.heading };
}
function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") &&
    !value.startsWith("/") && !/[:\u0000-\u001f]/.test(value) &&
    value.split("/").every((part) => part !== ".." && part !== "." && part !== "");
}
function validPassage(value: VectorMetadata): boolean {
  return !!value && /^semantic-[a-f0-9]{32}$/.test(value.id) && validPath(value.pagePath) &&
    /^p-[a-f0-9]{16}$/.test(value.passageId) && typeof value.heading === "string" &&
    value.id === `semantic-${createHash("sha256").update("knowledge-rail-semantic-passage-v1\0")
      .update(value.pagePath).update("\0").update(value.passageId).digest("hex").slice(0, 32)}`;
}
function validPage(page: StoredPage): boolean {
  return !!page && validPath(page.path) && /^[a-f0-9]{64}$/.test(page.fingerprint) &&
    typeof page.complete === "boolean" && Array.isArray(page.passageEntryIds) &&
    (page.sourceFingerprint === undefined || /^[a-f0-9]{64}$/.test(page.sourceFingerprint)) &&
    new Set(page.passageEntryIds).size === page.passageEntryIds.length &&
    page.passageEntryIds.every((id) => typeof id === "string" && /^semantic-[a-f0-9]{32}$/.test(id));
}

export function applySemanticBatch(state: StoredState, batch: SemanticBatch): void {
  for (const pagePath of batch.removed) {
    for (const id of state.pages.get(pagePath)?.passageEntryIds ?? []) state.passages.delete(id);
    state.pages.delete(pagePath);
  }
  for (const page of batch.pages) {
    const previous = state.pages.get(page.path);
    const wanted = new Set(page.passageEntryIds);
    for (const id of previous?.passageEntryIds ?? []) {
      if (previous?.fingerprint !== page.fingerprint || !wanted.has(id)) state.passages.delete(id);
    }
    state.pages.set(page.path, page);
  }
  for (const passage of batch.passages) state.passages.set(passage.id, passage);
}

/** Binary derived data only. All writers hold the shared derived-checkpoint lock. */
export class SemanticStorage {
  /** Logical payload I/O; filesystem metadata, locks and OS cache misses are excluded. */
  readonly io = { reads: 0, bytesRead: 0, writes: 0, bytesWritten: 0 };
  readonly loadTimings = { snapshotMs: 0, journalMs: 0 };
  private journalValidBytes = 0;
  private journalHeaderValid = false;
  private journalId = "";
  private readonly directory: string;
  constructor(private readonly wikiRoot: string, readonly provider: EmbeddingProviderDescriptor, readonly dtype: VectorDtype) {
    this.directory = wikiMetaDir(wikiRoot);
  }
  file(name: typeof FILES[number]): string { return path.join(this.directory, name); }

  async assertSafe(create: boolean): Promise<void> {
    if (create) await fs.mkdir(this.wikiRoot, { recursive: true });
    for (const filename of [this.directory, ...FILES.map((name) => this.file(name))]) {
      const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error("Semantic index path must not be a symbolic link.");
      if (stat && !(filename === this.directory ? stat.isDirectory() : stat.isFile())) {
        throw new Error("Semantic index path has an invalid file type.");
      }
    }
    if (create) await fs.mkdir(this.directory, { recursive: true });
  }

  private stride(signatures = 0): number { return 4 + this.provider.dimensions * (this.dtype === "f32" ? 4 : 1) + signatures * 4; }
  private encodeVector(passage: StoredPassage, signatures = 0): Buffer {
    const result = Buffer.alloc(this.stride(signatures));
    result.writeFloatLE(passage.scale, 0);
    for (let i = 0; i < this.provider.dimensions; i++) {
      if (this.dtype === "f32") result.writeFloatLE(passage.vector[i]!, 4 + i * 4);
      else result.writeInt8(passage.vector[i]!, 4 + i);
    }
    const start = this.stride();
    for (let i = 0; i < signatures; i++) result.writeUInt32LE(passage.signatures?.[i] ?? 0, start + i * 4);
    return result;
  }
  private decodeVector(bytes: Buffer, offset: number, signatures = 0): Pick<StoredPassage, "vector" | "scale" | "signatures"> {
    const scale = bytes.readFloatLE(offset);
    if (!Number.isFinite(scale) || scale <= 0 || (this.dtype === "f32" && scale !== 1)) throw new Error("Invalid vector scale.");
    // Snapshot buffers are immutable and shared with the ANN engine. Journal JSON
    // lengths may be unaligned, so only those vectors need an aligned copy.
    const byteOffset = bytes.byteOffset + offset + 4;
    const direct = this.dtype === "i8" || (LITTLE_ENDIAN && byteOffset % 4 === 0);
    const vector = this.dtype === "f32"
      ? direct ? new Float32Array(bytes.buffer, byteOffset, this.provider.dimensions) : new Float32Array(this.provider.dimensions)
      : new Int8Array(bytes.buffer, byteOffset, this.provider.dimensions);
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      const value = direct ? vector[i]! : bytes.readFloatLE(offset + 4 + i * 4);
      if (!Number.isFinite(value)) throw new Error("Invalid persisted vector.");
      if (!direct) vector[i] = value;
      norm += value * value;
    }
    if (!(norm > 0)) throw new Error("Invalid persisted vector magnitude.");
    const signatureOffset = bytes.byteOffset + offset + this.stride();
    return { vector, scale, ...(signatures ? { signatures: LITTLE_ENDIAN && signatureOffset % 4 === 0
      ? new Uint32Array(bytes.buffer, signatureOffset, signatures)
      : Array.from({ length: signatures }, (_, i) => bytes.readUInt32LE(offset + this.stride() + i * 4)) } : {}) };
  }

  async load(): Promise<StoredState> {
    const started = performance.now();
    await this.assertSafe(false);
    const state: StoredState = { pages: new Map(), passages: new Map() };
    let snapshotJournalId = "";
    let snapshotJournalThrough = 0;
    let graphHash: string | undefined;
    try {
      const metadataBytes = await fs.readFile(this.file("semantic-index.json"));
      this.io.reads++; this.io.bytesRead += metadataBytes.length;
      const meta = JSON.parse(metadataBytes.toString("utf8")) as Snapshot;
      if (meta.version !== 2 || !equal(meta.provider, this.provider) || meta.dtype !== this.dtype ||
          !Array.isArray(meta.pages) || !Array.isArray(meta.passages) || !meta.pages.every(validPage) ||
          !meta.passages.every(validPassage)) throw new Error("Incompatible semantic snapshot.");
      state.needsCompaction = meta.passages.some((p) => "original" in p);
      const handle = await fs.open(this.file("semantic-vectors.bin"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const header = Buffer.alloc(HEADER_SIZE);
        if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length ||
            !header.subarray(0, 8).equals(MAGIC) || header.readUInt32LE(8) !== this.provider.dimensions ||
            header.readUInt32LE(12) !== (this.dtype === "f32" ? 4 : 1) || header.readUInt32LE(16) !== meta.passages.length) {
          throw new Error("Invalid semantic vector header.");
        }
        this.io.reads++; this.io.bytesRead += HEADER_SIZE;
        const signatures = header.readUInt32LE(20);
        if (signatures > 32) throw new Error("Invalid signature count.");
        const stride = this.stride(signatures);
        if ((await handle.stat()).size !== HEADER_SIZE + stride * meta.passages.length) throw new Error("Truncated vectors.");
        const hash = createHash("sha256");
        const loadBatchSize = Math.max(64, Math.floor(1024 * 1024 / stride));
        for (let start = 0; start < meta.passages.length; start += loadBatchSize) {
          const count = Math.min(loadBatchSize, meta.passages.length - start);
          const buffer = Buffer.alloc(count * stride);
          if ((await handle.read(buffer, 0, buffer.length, HEADER_SIZE + start * stride)).bytesRead !== buffer.length) throw new Error("Truncated vectors.");
          this.io.reads++; this.io.bytesRead += buffer.length;
          hash.update(buffer);
          for (let i = 0; i < count; i++) {
            const passage = { ...metadata(meta.passages[start + i]! as StoredPassage), ...this.decodeVector(buffer, i * stride, signatures) };
            if (state.passages.has(passage.id)) throw new Error("Duplicate semantic passage.");
            state.passages.set(passage.id, passage);
          }
        }
        const digest = hash.digest("hex");
        if (digest !== meta.vectorsHash || digest !== header.subarray(32, 64).toString("hex")) throw new Error("Corrupt vectors.");
        const assigned = new Set<string>();
        for (const page of meta.pages) {
          if (state.pages.has(page.path)) throw new Error("Duplicate semantic page.");
          for (const id of page.passageEntryIds) {
            if (assigned.has(id) || state.passages.get(id)?.pagePath !== page.path) throw new Error("Invalid passage ownership.");
            assigned.add(id);
          }
          state.pages.set(page.path, page);
        }
        if (assigned.size !== state.passages.size) throw new Error("Unassigned semantic passages.");
        state.generatedAt = meta.generatedAt;
        state.engine = meta.engine;
        graphHash = typeof meta.graphHash === "string" && /^[a-f0-9]{64}$/u.test(meta.graphHash) ? meta.graphHash : undefined;
        snapshotJournalId = meta.journalId ?? "";
        snapshotJournalThrough = meta.journalThrough ?? 0;
      } finally { await handle.close(); }
    } catch {
      // Canonical Markdown is authoritative. Invalid derived state is rebuilt.
      state.pages.clear(); state.passages.clear();
    }
    if (graphHash) {
      // An optional graph can be discarded without discarding authentic vectors.
      // Engine restore verifies the exact checkpoint vectors before delta replay.
      try {
        const graph = await fs.open(this.file("semantic-graph.bin"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const size = (await graph.stat()).size;
          if (size >= 128 && size <= 256 * 1024 * 1024) {
            const bytes = await graph.readFile(); this.io.reads++; this.io.bytesRead += bytes.length;
            if (createHash("sha256").update(bytes).digest("hex") === graphHash) state.graphSnapshot = bytes;
          }
        } finally { await graph.close(); }
      } catch { /* Missing/corrupt derived graph: restore from vectors. */ }
    }
    this.journalValidBytes = 0;
    this.journalHeaderValid = false;
    this.loadTimings.snapshotMs = performance.now() - started;
    const journalStarted = performance.now();
    const handle = await fs.open(this.file("semantic-journal.bin"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!handle) { this.loadTimings.journalMs = performance.now() - journalStarted; return state; }
    try {
      const size = (await handle.stat()).size;
      while (this.journalValidBytes + 8 <= size) {
        const header = Buffer.alloc(8);
        if ((await handle.read(header, 0, 8, this.journalValidBytes)).bytesRead !== 8) break;
        this.io.reads++; this.io.bytesRead += 8;
        const length = header.readUInt32LE(0);
        if (length > MAX_FRAME || length < 4 || this.journalValidBytes + 8 + length > size) break;
        const body = Buffer.alloc(length);
        if ((await handle.read(body, 0, length, this.journalValidBytes + 8)).bytesRead !== length || crc32(body) !== header.readUInt32LE(4)) break;
        this.io.reads++; this.io.bytesRead += body.length;
        try {
          const jsonLength = body.readUInt32LE(0);
          if (jsonLength > length - 4) break;
          const record = JSON.parse(body.subarray(4, 4 + jsonLength).toString("utf8"));
          if (!this.journalHeaderValid) {
            if (record.version !== 2 || !equal(record.provider, this.provider) || record.dtype !== this.dtype || length !== 4 + jsonLength) {
              state.pages.clear(); state.passages.clear();
              break;
            }
            if (typeof record.journalId !== "string") break;
            this.journalId = record.journalId;
            this.journalHeaderValid = true;
          } else {
            if (this.journalId === snapshotJournalId && this.journalValidBytes + 8 + length <= snapshotJournalThrough) {
              this.journalValidBytes += 8 + length;
              continue;
            }
            const { pages, passages, removed } = record as { pages: StoredPage[]; passages: VectorMetadata[]; removed: string[] };
            if (!Array.isArray(pages) || !pages.every(validPage) || !Array.isArray(passages) || !passages.every(validPassage) ||
                !Array.isArray(removed) || !removed.every(validPath) || length !== 4 + jsonLength + passages.length * this.stride()) break;
            state.needsCompaction ||= passages.some((p) => "original" in p);
            const decoded = passages.map((p, i) => ({ ...metadata(p as StoredPassage), ...this.decodeVector(body, 4 + jsonLength + i * this.stride()) }));
            const current = new Map(decoded.map((p) => [p.id, p]));
            if (current.size !== decoded.length || new Set(pages.map((p) => p.path)).size !== pages.length ||
                decoded.some((p) => !pages.some((page) => page.path === p.pagePath && page.passageEntryIds.includes(p.id))) ||
                pages.some((page) => page.passageEntryIds.some((id) => (current.get(id) ??
                  (state.pages.get(page.path)?.fingerprint === page.fingerprint ? state.passages.get(id) : undefined))?.pagePath !== page.path))) break;
            if (state.graphSnapshot && !state.graphBasePassages) state.graphBasePassages = new Map(state.passages);
            applySemanticBatch(state, { pages, passages: decoded, removed });
          }
        } catch { break; }
        this.journalValidBytes += 8 + length;
      }
    } finally { await handle.close(); }
    this.loadTimings.journalMs = performance.now() - journalStarted;
    return state;
  }

  private frame(record: unknown, passages: readonly StoredPassage[] = []): Buffer {
    const json = Buffer.from(JSON.stringify(record));
    const body = Buffer.alloc(4 + json.length + passages.length * this.stride());
    if (body.length > MAX_FRAME) throw new Error("Semantic journal batch exceeds its bounded record size.");
    body.writeUInt32LE(json.length, 0); json.copy(body, 4);
    passages.forEach((p, i) => this.encodeVector(p).copy(body, 4 + json.length + i * this.stride()));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(body.length, 0); header.writeUInt32LE(crc32(body), 4);
    return Buffer.concat([header, body]);
  }
  async append(batch: SemanticBatch): Promise<void> {
    await this.assertSafe(true);
    if (!this.journalHeaderValid) {
      this.journalId = randomUUID();
      const header = this.frame({ version: 2, provider: this.provider, dtype: this.dtype, journalId: this.journalId });
      await atomicWriteBuffer(this.file("semantic-journal.bin"), header);
      this.io.writes++; this.io.bytesWritten += header.length;
      this.journalValidBytes = header.length;
      this.journalHeaderValid = true;
    }
    const bytes = this.frame({ pages: batch.pages, passages: batch.passages.map(metadata), removed: batch.removed }, batch.passages);
    const handle = await fs.open(this.file("semantic-journal.bin"), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.truncate(this.journalValidBytes);
      let written = 0;
      while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, this.journalValidBytes + written)).bytesWritten;
      await handle.sync();
      this.journalValidBytes += bytes.length;
      this.io.writes++; this.io.bytesWritten += bytes.length;
    } finally { await handle.close(); }
  }

  async needsCompaction(): Promise<boolean> {
    if (this.journalValidBytes < 16 * 1024 * 1024) return false;
    const snapshotBytes = (await fs.stat(this.file("semantic-vectors.bin")).catch(() => null))?.size ?? 0;
    return this.journalValidBytes >= Math.max(16 * 1024 * 1024, snapshotBytes / 4);
  }

  async compact(state: StoredState, engine: AnnEngineDescriptor, corpusRevision?: string, graphSnapshot?: Uint8Array): Promise<string> {
    await this.assertSafe(true);
    const generatedAt = new Date().toISOString();
    const passages = [...state.passages.values()].sort((a, b) => a.id.localeCompare(b.id));
    const signatures = passages.length && passages.every((p) => p.signatures?.length === engine.tables) ? engine.tables ?? 0 : 0;
    const temp = path.join(this.directory, `.semantic-vectors-${randomUUID()}.tmp`);
    const handle = await fs.open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let digest: string;
    try {
      await handle.writeFile(Buffer.alloc(HEADER_SIZE));
      this.io.writes++; this.io.bytesWritten += HEADER_SIZE;
      for (let start = 0; start < passages.length; start += 64) {
        const batch = Buffer.concat(passages.slice(start, start + 64).map((p) => this.encodeVector(p, signatures)));
        hash.update(batch);
        await handle.writeFile(batch);
        this.io.writes++; this.io.bytesWritten += batch.length;
      }
      digest = hash.digest("hex");
      const header = Buffer.alloc(HEADER_SIZE);
      MAGIC.copy(header); header.writeUInt32LE(this.provider.dimensions, 8);
      header.writeUInt32LE(this.dtype === "f32" ? 4 : 1, 12); header.writeUInt32LE(passages.length, 16);
      header.writeUInt32LE(signatures, 20); Buffer.from(digest, "hex").copy(header, 32);
      await handle.write(header, 0, header.length, 0);
      this.io.writes++; this.io.bytesWritten += header.length;
      await handle.sync();
    } catch (error) { await fs.unlink(temp).catch(() => undefined); throw error; }
    finally { await handle.close(); }
    await fs.rename(temp, this.file("semantic-vectors.bin"));
    let graphHash: string | undefined;
    if (graphSnapshot) {
      if (graphSnapshot.byteLength > 256 * 1024 * 1024) throw new Error("Semantic graph snapshot exceeds its resource limit.");
      graphHash = createHash("sha256").update(graphSnapshot).digest("hex");
      await atomicWriteBuffer(this.file("semantic-graph.bin"), Buffer.from(graphSnapshot.buffer, graphSnapshot.byteOffset, graphSnapshot.byteLength));
      this.io.writes++; this.io.bytesWritten += graphSnapshot.byteLength;
    } else await fs.rm(this.file("semantic-graph.bin"), { force: true });
    const metadataTemp = path.join(this.directory, `.semantic-index-${randomUUID()}.tmp`);
    const metaHandle = await fs.open(metadataTemp, "wx", 0o600);
    try {
      const prefix = JSON.stringify({ version: 2, provider: this.provider, engine, dtype: this.dtype,
        generatedAt, vectorsHash: digest!, journalId: this.journalId, journalThrough: this.journalValidBytes,
        ...(graphHash ? { graphHash } : {}),
        ...(corpusRevision ? { corpusRevision } : {}) });
      await metaHandle.writeFile(prefix.slice(0, -1) + ',"pages":[');
      const pages = [...state.pages.values()].sort((a, b) => a.path.localeCompare(b.path));
      for (let start = 0; start < pages.length; start += 64) {
        await metaHandle.writeFile((start ? "," : "") + pages.slice(start, start + 64).map((p) => JSON.stringify(p)).join(","));
      }
      await metaHandle.writeFile('],"passages":[');
      for (let start = 0; start < passages.length; start += 64) {
        await metaHandle.writeFile((start ? "," : "") + passages.slice(start, start + 64).map((p) => JSON.stringify(metadata(p))).join(","));
      }
      await metaHandle.writeFile("]}");
      await metaHandle.sync();
    } catch (error) { await fs.unlink(metadataTemp).catch(() => undefined); throw error; }
    finally { await metaHandle.close(); }
    const metadataSize = (await fs.stat(metadataTemp)).size;
    await fs.rename(metadataTemp, this.file("semantic-index.json"));
    this.io.writes++; this.io.bytesWritten += metadataSize;
    // Snapshot is committed before dropping the replay log. Replay is idempotent.
    this.journalId = randomUUID();
    const header = this.frame({ version: 2, provider: this.provider, dtype: this.dtype, journalId: this.journalId });
    await atomicWriteBuffer(this.file("semantic-journal.bin"), header);
    this.io.writes++; this.io.bytesWritten += header.length;
    this.journalValidBytes = header.length; this.journalHeaderValid = true;
    // The new snapshot and replay boundary are durable before retiring the sidecar.
    // unlink never follows a symlink and never recursively removes a directory.
    await fs.unlink(path.join(this.directory, "semantic-originals.bin")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return generatedAt;
  }
}
