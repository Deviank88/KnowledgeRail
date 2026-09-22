import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { logger } from "../logger.js";
import { wikiPassageId } from "../../context/passage-id.js";
import { wikiPageUri } from "../../context/resource-uri.js";
import { withDerivedCheckpointLock } from "../checkpoint-lock.js";
import { SemanticStorage, type StoredPage, type StoredPassage, type SemanticBatch, type StoredState } from "./storage.js";
import { storeVector, cosine, DEFAULT_VECTOR_DTYPE, type VectorDtype } from "./vector.js";
import { EmbeddingRequestQueue, SemanticBuildQueue } from "./build-queue.js";
import { registerWorkspaceState, touchWorkspaceState } from "../workspace-state.js";
import { wikiMetaDir } from "../manifest-service.js";
import { readWikiPageRecord, type WikiPassage, type WikiPageRecord } from "../page-record.js";
import {
  getRetrievalIndexGeneration,
  getRetrievalCorpusRevision,
  getWikiPageRecords,
} from "../retrieval-index.js";
import { readFileSafe } from "../utils.js";
import { LshAnnEngine } from "./lsh-engine.js";
import { configuredEmbeddingProvider } from "./provider.js";
import type {
  AnnEngine,
  EmbeddingProvider,
  SemanticCoverageQuery,
  SemanticCoverageScore,
  SemanticHit,
  SemanticIndexDescriptor,
  SemanticSearchResult,
  SynchronizableSemanticIndex,
} from "./types.js";

interface PersistedSemanticPassage {
  id: string;
  pagePath: string;
  passageId: string;
  heading: string;
  text: string;
  vector: number[];
}

interface PersistedSemanticPage {
  path: string;
  fingerprint: string;
  passageEntryIds: string[];
}

interface PersistedSemanticIndex {
  version: 1;
  generatedAt: string;
  provider: SemanticIndexDescriptor["provider"];
  engine: SemanticIndexDescriptor["engine"];
  pages: PersistedSemanticPage[];
  passages: PersistedSemanticPassage[];
}

interface PreparedPage {
  path: string;
  fingerprint: string;
  sourceFingerprint?: string;
  passages: Array<{
    id: string;
    pagePath: string;
    passageId: string;
    heading: string;
    text: string;
  }>;
}

const indexCache = new Map<string, {
  index: PersistentSemanticIndex;
  retrievalGeneration: number;
}>();

function descriptorKey(provider: EmbeddingProvider): string {
  const value = provider.descriptor;
  return `${value.id}\0${value.model}\0${value.version}\0${value.dimensions}`;
}

function normalizedPagePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Semantic page paths must be relative to the wiki root.");
  }
  wikiPageUri(normalized);
  return normalized;
}

function entryId(pagePath: string, passageId: string): string {
  return `semantic-${createHash("sha256")
    .update("knowledge-rail-semantic-passage-v1\0")
    .update(pagePath)
    .update("\0")
    .update(passageId)
    .digest("hex")
    .slice(0, 32)}`;
}

function pageFingerprint(pagePath: string, passages: readonly WikiPassage[]): string {
  const hash = createHash("sha256").update("knowledge-rail-semantic-page-v1\0").update(pagePath);
  for (const passage of passages) {
    hash.update("\0").update(wikiPassageId(passage));
    hash.update("\0").update(passage.heading.normalize("NFC"));
    hash.update("\0").update(passage.text.normalize("NFC"));
  }
  return hash.digest("hex");
}

function passageInput(passage: { heading: string; text: string }): string {
  return `${passage.heading}\n${passage.text}`.normalize("NFC").trim();
}

function coverageQueryInput(query: SemanticCoverageQuery): SemanticCoverageQuery {
  const id = query.id.normalize("NFKC").trim();
  const text = query.text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (
    !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id) ||
    !text || text.length > 4_096 || text.includes("\0")
  ) {
    throw new Error("Semantic coverage queries require a printable id and 1-4,096 characters of text.");
  }
  return { id, text };
}

function preparedPage(pagePath: string, passages: readonly WikiPassage[]): PreparedPage {
  const normalized = normalizedPagePath(pagePath);
  const seen = new Set<string>();
  const hash = createHash("sha256").update("knowledge-rail-semantic-page-v1\0").update(normalized);
  const prepared: PreparedPage["passages"] = [];
  for (const passage of passages) {
    const passageId = wikiPassageId(passage);
    hash.update("\0").update(passageId);
    hash.update("\0").update(passage.heading.normalize("NFC"));
    hash.update("\0").update(passage.text.normalize("NFC"));
    if (seen.has(passageId)) continue;
    seen.add(passageId);
    prepared.push({ id: entryId(normalized, passageId), pagePath: normalized, passageId,
      heading: passage.heading, text: passage.text });
  }
  return { path: normalized, fingerprint: hash.digest("hex"), passages: prepared };
}

function sameDescriptor(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validVector(value: unknown, dimensions: number): value is number[] {
  if (
    !Array.isArray(value) || value.length !== dimensions ||
    !value.every((component) => typeof component === "number" && Number.isFinite(component))
  ) return false;
  const magnitudeSquared = value.reduce((sum, component) => sum + component * component, 0);
  return Number.isFinite(magnitudeSquared) && magnitudeSquared > 0;
}

function validSnapshot(
  value: unknown,
  provider: SemanticIndexDescriptor["provider"],
  engine: SemanticIndexDescriptor["engine"]
): value is PersistedSemanticIndex {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PersistedSemanticIndex>;
  if (
    snapshot.version !== 1 || typeof snapshot.generatedAt !== "string" ||
    !sameDescriptor(snapshot.provider, provider) ||
    !Array.isArray(snapshot.pages) || !Array.isArray(snapshot.passages)
  ) return false;
  const passageIds = new Set<string>();
  for (const passage of snapshot.passages) {
    if (
      !passage || typeof passage.id !== "string" || !/^semantic-[a-f0-9]{32}$/.test(passage.id) ||
      passageIds.has(passage.id) || typeof passage.pagePath !== "string" ||
      typeof passage.passageId !== "string" || !/^p-[a-f0-9]{16}$/.test(passage.passageId) ||
      typeof passage.heading !== "string" || typeof passage.text !== "string" ||
      !validVector(passage.vector, provider.dimensions)
    ) return false;
    try {
      if (normalizedPagePath(passage.pagePath) !== passage.pagePath) return false;
    } catch {
      return false;
    }
    if (entryId(passage.pagePath, passage.passageId) !== passage.id) return false;
    passageIds.add(passage.id);
  }
  const pagePaths = new Set<string>();
  const assignedPassages = new Set<string>();
  const passagesById = new Map(snapshot.passages.map((passage) => [passage.id, passage] as const));
  for (const page of snapshot.pages) {
    if (
      !page || typeof page.path !== "string" || pagePaths.has(page.path) ||
      typeof page.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(page.fingerprint) ||
      !Array.isArray(page.passageEntryIds) ||
      new Set(page.passageEntryIds).size !== page.passageEntryIds.length ||
      page.passageEntryIds.some((id) =>
        typeof id !== "string" || !passageIds.has(id) || assignedPassages.has(id) ||
        passagesById.get(id)?.pagePath !== page.path
      )
    ) return false;
    try {
      if (normalizedPagePath(page.path) !== page.path) return false;
    } catch {
      return false;
    }
    for (const id of page.passageEntryIds) assignedPassages.add(id);
    pagePaths.add(page.path);
  }
  return assignedPassages.size === snapshot.passages.length &&
    snapshot.passages.every((passage) => pagePaths.has(passage.pagePath));
}

export function semanticIndexFile(wikiRoot: string): string {
  return path.join(wikiMetaDir(wikiRoot), "semantic-index.json");
}

export class PersistentSemanticIndex implements SynchronizableSemanticIndex {
  readonly loadTimings = { snapshotMs: 0, journalMs: 0, restoreMs: 0, totalMs: 0 };
  private readonly pages = new Map<string, StoredPage>();
  private readonly passages = new Map<string, StoredPassage>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private generatedAt: string | undefined;
  private diskStamp = "";
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly coverageVectorCache = new Map<string, Promise<readonly (readonly number[])[]>>();
  private readonly storage: SemanticStorage;
  private readonly dtype: VectorDtype;
  private desired: Map<string, PreparedPage> | undefined;
  private state: "building" | "ready" | "degraded" = "building";
  private reason: string | undefined;
  private disposed = false;
  private needsCompaction = false;
  private readonly buildQueue: SemanticBuildQueue;
  private readonly embeddingRequests = new EmbeddingRequestQueue();

  constructor(
    private readonly wikiRoot: string,
    private readonly provider: EmbeddingProvider,
    private readonly engine: AnnEngine = new LshAnnEngine({ dimensions: provider.descriptor.dimensions }),
    options: { dtype?: VectorDtype } = {}
  ) {
    if (engine.descriptor.dimensions !== provider.descriptor.dimensions) {
      throw new Error("Semantic provider and ANN engine dimensions do not match.");
    }
    const dtype = options.dtype ?? process.env["KNOWLEDGE_RAIL_SEMANTIC_DTYPE"] ?? DEFAULT_VECTOR_DTYPE;
    if (dtype !== "f32" && dtype !== "i8") throw new Error("Semantic dtype must be f32 or i8.");
    this.dtype = dtype;
    this.storage = new SemanticStorage(wikiRoot, provider.descriptor, dtype);
    this.buildQueue = new SemanticBuildQueue(async (pagePaths) => {
      if (this.disposed) return pagePaths;
      try {
        await this.withMutation(() => this.embedBatch(pagePaths));
        return pagePaths.filter((pagePath) => !this.desired?.has(pagePath) || this.pageReady(pagePath));
      } catch (error) { this.state = "degraded"; this.reason = "embedding_or_persistence_failed"; throw error; }
    }, async () => {
      if (!this.disposed) await this.checkpoint();
    });
  }

  private pageReady(pagePath: string): boolean {
    const page = this.pages.get(pagePath);
    return !!page?.complete && (!this.desired || page.fingerprint === this.desired.get(pagePath)?.fingerprint);
  }
  get descriptor(): SemanticIndexDescriptor {
    const ready = [...this.pages.keys()].filter((pagePath) => this.pageReady(pagePath)).length;
    return {
      provider: { ...this.provider.descriptor }, engine: { ...this.engine.descriptor },
      passageCount: this.passages.size, pageCount: ready,
      totalPages: this.desired?.size ?? this.pages.size,
      pendingPages: Math.max(0, (this.desired?.size ?? this.pages.size) - ready),
      state: this.buildQueue.error ? "degraded" : this.state, dtype: this.dtype,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.generatedAt ? { generatedAt: this.generatedAt } : {}),
    };
  }
  dispose(): void { this.disposed = true; this.buildQueue.stop(); this.engine.dispose?.(); }
  async idle(): Promise<void> { await this.buildQueue.idle(); }

  private async stamp(): Promise<string> {
    return (await Promise.all(["semantic-index.json", "semantic-vectors.bin", "semantic-journal.bin"].map(async (name) => {
      const stat = await fs.stat(path.join(wikiMetaDir(this.wikiRoot), name), { bigint: true }).catch(() => null);
      return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "absent";
    }))).join("|");
  }
  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      await this.storage.assertSafe(true);
      return await withDerivedCheckpointLock(this.wikiRoot, async () => {
        if (this.disposed) throw new Error("Semantic index was evicted or its provider changed.");
        if (this.loaded && this.diskStamp !== await this.stamp()) this.loaded = false;
        await this.load();
        try { return await operation(); }
        finally { this.diskStamp = await this.stamp(); }
      });
    } finally { release(); }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      const started = performance.now();
      const state = await this.storage.load();
      Object.assign(this.loadTimings, this.storage.loadTimings);
      if (!state.pages.size) {
        const raw = await readFileSafe(semanticIndexFile(this.wikiRoot));
        let legacy: unknown;
        try { legacy = raw ? JSON.parse(raw) : null; } catch { legacy = null; }
        if (validSnapshot(legacy, this.provider.descriptor, this.engine.descriptor)) {
          this.needsCompaction = true;
          for (const page of legacy.pages) state.pages.set(page.path, { ...page, complete: true });
          for (const passage of legacy.passages) state.passages.set(passage.id, {
            id: passage.id, pagePath: passage.pagePath, passageId: passage.passageId, heading: passage.heading,
            ...storeVector(passage.vector, this.provider.descriptor.dimensions, this.dtype),
          });
          state.generatedAt = legacy.generatedAt;
        }
      }
      this.pages.clear(); this.passages.clear();
      for (const [key, value] of state.pages) this.pages.set(key, value);
      const restoreSignatures = sameDescriptor(state.engine, this.engine.descriptor);
      for (const [key, value] of state.passages) {
        if (!restoreSignatures) value.signatures = undefined;
        this.passages.set(key, value);
      }
      const restoreStarted = performance.now();
      const entries = [...this.passages.values()].filter((p) => !this.desired ||
        this.desired.get(p.pagePath)?.fingerprint === this.pages.get(p.pagePath)?.fingerprint);
      if (this.engine.restore) this.engine.restore(entries, true);
      else this.engine.rebuild(entries.map((p) => ({ ...p, normalized: true })));
      this.loadTimings.restoreMs = performance.now() - restoreStarted;
      this.generatedAt = state.generatedAt;
      this.diskStamp = await this.stamp();
      this.loaded = true;
      this.loadTimings.totalMs = performance.now() - started;
    })();
    try { await this.loadPromise; }
    finally { this.loadPromise = undefined; }
  }

  private applyBatch(batch: SemanticBatch): void {
    for (const pagePath of batch.removed) {
      for (const id of this.pages.get(pagePath)?.passageEntryIds ?? []) { this.engine.remove(id); this.passages.delete(id); }
      this.pages.delete(pagePath);
    }
    for (const page of batch.pages) {
      const previous = this.pages.get(page.path);
      const wanted = new Set(page.passageEntryIds);
      for (const id of previous?.passageEntryIds ?? []) {
        if (previous?.fingerprint !== page.fingerprint || !wanted.has(id)) { this.engine.remove(id); this.passages.delete(id); }
      }
      this.pages.set(page.path, page);
      const desired = this.desired?.get(page.path);
      if (page.complete && desired?.fingerprint === page.fingerprint) desired.passages = [];
    }
    for (const passage of batch.passages) {
      this.passages.set(passage.id, passage);
      if (!this.desired || this.desired.get(passage.pagePath)?.fingerprint === this.pages.get(passage.pagePath)?.fingerprint) {
        this.engine.upsert({ ...passage, normalized: true });
      }
    }
  }
  private async commitBatch(batch: SemanticBatch): Promise<void> {
    await this.storage.append(batch);
    this.applyBatch(batch);
    if (await this.storage.needsCompaction()) {
      await this.engine.ready?.();
      for (const passage of this.passages.values()) passage.signatures = this.engine.signatures?.(passage.id);
      this.generatedAt = await this.storage.compact({ pages: this.pages, passages: this.passages }, this.engine.descriptor,
        getRetrievalCorpusRevision(this.wikiRoot) ?? undefined);
    }
  }

  /** At most 64 passages; unfinished pages retain their fingerprint and completed IDs. */
  private async embedBatch(paths: readonly string[], signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const selected: Array<{ page: PreparedPage; passages: PreparedPage["passages"]; previousIds: string[] }> = [];
    let remaining = 64;
    for (const pagePath of paths) {
      const page = this.desired?.get(pagePath);
      if (!page || this.pageReady(pagePath)) continue;
      const previous = this.pages.get(pagePath);
      const previousIds = previous?.fingerprint === page.fingerprint ? previous.passageEntryIds : [];
      const existing = new Set(previousIds);
      const passages = page.passages.filter((p) => !existing.has(p.id)).slice(0, remaining);
      selected.push({ page, passages, previousIds });
      remaining -= passages.length;
      if (remaining === 0) break;
    }
    if (!selected.length) return 0;
    const inputs = selected.flatMap((item) => item.passages);
    const vectors = inputs.length ? await this.embeddingRequests.run(() => this.provider.embedDocuments(inputs.map(passageInput))) : [];
    if (vectors.length !== inputs.length) throw new Error("Embedding provider returned an invalid result count.");
    const stored = vectors.map((v) => storeVector(v, this.provider.descriptor.dimensions, this.dtype));
    const batch: SemanticBatch = { pages: [], passages: [], removed: [] };
    let cursor = 0;
    for (const item of selected) {
      const pagePassages = item.passages.map(({ text: _text, ...p }) => ({ ...p, ...stored[cursor++]! }));
      // A concurrent query can observe a newer canonical page while the provider is busy.
      if (this.desired?.get(item.page.path)?.fingerprint !== item.page.fingerprint || this.disposed) continue;
      const ids = [...item.previousIds, ...pagePassages.map((p) => p.id)];
      batch.pages.push({ path: item.page.path, fingerprint: item.page.fingerprint,
        ...(item.page.sourceFingerprint ? { sourceFingerprint: item.page.sourceFingerprint } : {}),
        passageEntryIds: ids, complete: ids.length === item.page.passages.length });
      batch.passages.push(...pagePassages);
    }
    if (batch.pages.length) await this.commitBatch(batch);
    return batch.passages.length;
  }

  private setDesired(records: readonly WikiPageRecord[]): void {
    this.desired = new Map(records.map((record) => {
      const sourceFingerprint = createHash("sha256").update(record.raw).digest("hex");
      const existing = this.pages.get(record.path);
      // Canonical bytes are checked once per page. A matching fingerprint lets
      // restart reuse passage IDs without hashing every passage twice again.
      if (existing?.complete && existing.sourceFingerprint === sourceFingerprint) {
        return [record.path, { path: record.path, fingerprint: existing.fingerprint, sourceFingerprint,
          passages: [] }];
      }
      const page = { ...preparedPage(record.path, record.passages), sourceFingerprint };
      if (existing?.sourceFingerprint === sourceFingerprint) {
        // A partial journal page keeps the same identity when resuming.
        page.fingerprint = existing.fingerprint;
      } else if (existing && existing.fingerprint === page.fingerprint && !existing.sourceFingerprint) {
        // One-time migration of legacy/passages-only state with matching content.
        existing.sourceFingerprint = sourceFingerprint;
        this.needsCompaction = true;
      } else {
        // Include canonical bytes: metadata-only edits also regenerate the page.
        page.fingerprint = createHash("sha256").update("semantic-page-source-v2\0")
          .update(sourceFingerprint).update(page.fingerprint).digest("hex");
      }
      return [page.path, page];
    }));
    for (const page of this.desired.values()) if (this.pageReady(page.path)) page.passages = [];
    // Never serve stale vectors while changed pages are rebuilding, including deletions.
    for (const [pagePath, page] of this.pages) {
      if (this.desired.get(pagePath)?.fingerprint !== page.fingerprint) {
        for (const id of page.passageEntryIds) this.engine.remove(id);
      }
    }
    this.state = [...this.desired.keys()].every((p) => this.pageReady(p)) ? "ready" : "building";
    this.reason = undefined;
  }
  async startBackground(records: readonly WikiPageRecord[]): Promise<void> {
    await this.load();
    this.setDesired(records);
    const pending = records.filter((r) => !this.pageReady(r.path));
    if (pending.length) {
      const graph = await import("../graph-runtime.js").then(({ getRuntimeWikiGraph }) =>
        getRuntimeWikiGraph(this.wikiRoot, false, { persist: false })).catch(() => undefined);
      for (const record of pending) {
        const node = graph?.pageNodeByPath.get(record.path);
        const degree = node ? graph?.incoming.get(node)?.length ?? 0 : 0;
        this.buildQueue.enqueue([record.path], (/decision|rule/.test(record.type) ? 1 : 0) + degree / (1 + degree));
      }
    }
    if (!pending.length && [...this.pages.keys()].some((p) => !this.desired!.has(p))) await this.checkpoint();
  }
  async prioritize(pagePaths: readonly string[], budgetMs = 1_000): Promise<void> {
    const wanted = pagePaths.filter((p) => this.desired?.has(p) && !this.pageReady(p));
    this.buildQueue.enqueue(wanted, 2);
    await this.buildQueue.waitUntil(() => wanted.every((p) => this.pageReady(p)), budgetMs);
  }
  async checkpoint(force = false): Promise<SemanticIndexDescriptor> {
    await this.withMutation(async () => {
      if (force) {
        await this.commitBatch({ pages: [], passages: [], removed: [...this.pages.keys()] });
        this.coverageVectorCache.clear();
      } else {
        const removed = this.desired ? [...this.pages.keys()].filter((p) => !this.desired!.has(p)) : [];
        if (removed.length) await this.commitBatch({ pages: [], passages: [], removed });
      }
      await this.engine.ready?.();
      for (const passage of this.passages.values()) passage.signatures = this.engine.signatures?.(passage.id);
      this.generatedAt = await this.storage.compact({ pages: this.pages, passages: this.passages }, this.engine.descriptor,
        getRetrievalCorpusRevision(this.wikiRoot) ?? undefined);
      this.state = !this.desired || [...this.desired.keys()].every((p) => this.pageReady(p)) ? "ready" : "building";
    });
    if (force && this.desired) this.buildQueue.enqueue([...this.desired.keys()]);
    return this.descriptor;
  }
  async upsertPassages(pagePath: string, passages: WikiPassage[]): Promise<void> {
    await this.load();
    const page = preparedPage(pagePath, passages);
    if (!this.desired) this.setDesired(await getWikiPageRecords(this.wikiRoot, false, { persist: false }));
    this.desired!.set(page.path, page);
    await this.withMutation(async () => {
      while (!this.pageReady(page.path)) await this.embedBatch([page.path]);
    });
  }
  async removePage(pagePath: string): Promise<void> {
    const normalized = normalizedPagePath(pagePath);
    this.desired?.delete(normalized);
    await this.withMutation(() => this.commitBatch({ pages: [], passages: [], removed: [normalized] }));
  }
  async synchronize(records: readonly WikiPageRecord[], options: { signal?: AbortSignal } = {}): Promise<{
    reusedPages: number; embeddedPages: number; removedPages: number; embeddedPassages: number;
  }> {
    await this.load();
    this.setDesired(records);
    return this.withMutation(async () => {
      const paths = [...this.desired!.keys()].sort((a, b) => a.localeCompare(b));
      const changed = paths.filter((p) => !this.pageReady(p));
      const removed = [...this.pages.keys()].filter((p) => !this.desired!.has(p));
      if (removed.length) await this.commitBatch({ pages: [], passages: [], removed });
      let embeddedPassages = 0;
      try {
        while (paths.some((p) => !this.pageReady(p))) embeddedPassages += await this.embedBatch(paths, options.signal);
        if (changed.length || removed.length || this.needsCompaction) {
          await this.engine.ready?.();
          for (const passage of this.passages.values()) passage.signatures = this.engine.signatures?.(passage.id);
          this.generatedAt = await this.storage.compact({ pages: this.pages, passages: this.passages }, this.engine.descriptor,
            getRetrievalCorpusRevision(this.wikiRoot) ?? undefined);
          this.needsCompaction = false;
        }
        this.state = "ready";
      } catch (error) { this.state = "degraded"; this.reason = options.signal?.aborted ? "interrupted" : "embedding_or_persistence_failed"; throw error; }
      return { reusedPages: paths.length - changed.length, embeddedPages: changed.length, removedPages: removed.length, embeddedPassages };
    });
  }

  async searchWithDiagnostics(query: string, k: number): Promise<SemanticSearchResult> {
    await this.load();
    const normalizedQuery = query.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!normalizedQuery || normalizedQuery.length > 4_096 || normalizedQuery.includes("\0")) {
      throw new Error("Semantic query must contain 1-4,096 characters.");
    }
    if (!Number.isInteger(k) || k < 1 || k > 1_000) {
      throw new Error("Semantic result limit must be an integer between 1 and 1,000.");
    }
    const vector = await this.embeddingRequests.run(() => this.provider.embedQuery(normalizedQuery), true);
    const result = this.engine.search(vector, k);
    // Hydrate only selected pages and retain no canonical text in the vector index.
    // Check the page fingerprint so edits made during a query cannot acquire an old score.
    const selectedPages = new Map<string, Promise<WikiPageRecord | null>>();
    const hydrated = await Promise.all(result.hits.map(async (hit): Promise<SemanticHit | null> => {
      const passage = this.passages.get(hit.id);
      if (!passage) return null;
      const page = this.pages.get(passage.pagePath);
      if (!page) return null;
      if (!selectedPages.has(passage.pagePath)) selectedPages.set(passage.pagePath,
        readWikiPageRecord(this.wikiRoot, passage.pagePath).catch(() => null));
      const record = await selectedPages.get(passage.pagePath)!;
      if (!record || this.passages.get(hit.id) !== passage || this.pages.get(page.path)?.fingerprint !== page.fingerprint) return null;
      if (page.sourceFingerprint
        ? createHash("sha256").update(record.raw).digest("hex") !== page.sourceFingerprint
        : pageFingerprint(record.path, record.passages) !== page.fingerprint) return null;
      const canonical = record.passages.find((p) => wikiPassageId(p) === passage.passageId);
      if (!canonical) return null;
      return { pagePath: passage.pagePath, passageId: passage.passageId,
        heading: canonical.heading, text: canonical.text, score: hit.score,
        provider: { ...this.provider.descriptor } };
    }));
    const hits = hydrated.filter((hit): hit is SemanticHit => hit !== null);
    return { hits, diagnostics: result.diagnostics };
  }

  async search(query: string, k: number): Promise<SemanticHit[]> {
    return (await this.searchWithDiagnostics(query, k)).hits;
  }

  async assessCoverage(
    queries: readonly SemanticCoverageQuery[],
    pagePaths: readonly string[]
  ): Promise<SemanticCoverageScore[]> {
    await this.load();
    if (queries.length === 0) return [];
    if (queries.length > 256) throw new Error("Semantic coverage is limited to 256 concepts per request.");
    const normalizedQueries = queries.map(coverageQueryInput);
    if (new Set(normalizedQueries.map((query) => query.id)).size !== normalizedQueries.length) {
      throw new Error("Semantic coverage query ids must be unique.");
    }
    const normalizedPaths = [...new Set(pagePaths.map(normalizedPagePath))].sort((left, right) =>
      left.localeCompare(right)
    );
    const wantedPaths = new Set(normalizedPaths);
    const passages = [...this.passages.values()]
      .filter((passage) => wantedPaths.has(passage.pagePath) && this.pageReady(passage.pagePath))
      .sort((left, right) => left.pagePath.localeCompare(right.pagePath) || left.id.localeCompare(right.id));
    const cacheKey = JSON.stringify(normalizedQueries.map((query) => query.text));
    let vectorPromise = this.coverageVectorCache.get(cacheKey);
    if (!vectorPromise) {
      vectorPromise = this.embeddingRequests.run(async () => {
        if (this.provider.embedQueries) return this.provider.embedQueries(normalizedQueries.map((query) => query.text));
        const vectors: Array<readonly number[]> = [];
        for (const query of normalizedQueries) vectors.push(await this.provider.embedQuery(query.text));
        return vectors;
      }, true);
      this.coverageVectorCache.set(cacheKey, vectorPromise);
      if (this.coverageVectorCache.size > 32) {
        const oldest = this.coverageVectorCache.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== cacheKey) this.coverageVectorCache.delete(oldest);
      }
      vectorPromise.catch(() => this.coverageVectorCache.delete(cacheKey));
    }
    const vectors = await vectorPromise;
    if (vectors.length !== normalizedQueries.length) {
      throw new Error("Embedding provider returned an invalid semantic coverage result count.");
    }
    return normalizedQueries.map((query, queryIndex) => {
      const vector = vectors[queryIndex]!;
      if (!validVector(vector, this.provider.descriptor.dimensions)) {
        throw new Error("Embedding provider returned an invalid semantic coverage vector.");
      }
      const byPage = new Map<string, number>();
      const coverageVector = this.dtype === "i8" ? storeVector(vector, this.provider.descriptor.dimensions, "i8").vector : vector;
      const passagesByPage = new Map<string, Array<{ passageId: string; score: number }>>();
      for (const passage of passages) {
        const score = cosine(coverageVector, passage.vector);
        const current = byPage.get(passage.pagePath);
        if (current === undefined || score > current) byPage.set(passage.pagePath, score);
        const pagePassages = passagesByPage.get(passage.pagePath) ?? [];
        pagePassages.push({ passageId: passage.passageId, score });
        passagesByPage.set(passage.pagePath, pagePassages);
      }
      return {
        id: query.id,
        pages: [...byPage.entries()]
          .map(([pagePath, score]) => ({
            pagePath,
            score,
            passages: (passagesByPage.get(pagePath) ?? []).sort((left, right) =>
              right.score - left.score || left.passageId.localeCompare(right.passageId)
            ),
          }))
          .sort((left, right) => right.score - left.score || left.pagePath.localeCompare(right.pagePath)),
      };
    });
  }
}

export async function configuredSemanticIndex(
  wikiRoot: string,
  options: { background?: boolean } = {}
): Promise<PersistentSemanticIndex | null> {
  const provider = configuredEmbeddingProvider();
  const root = path.resolve(wikiRoot);
  const dtype = process.env["KNOWLEDGE_RAIL_SEMANTIC_DTYPE"] ?? DEFAULT_VECTOR_DTYPE;
  const key = provider ? `${root}\0${descriptorKey(provider)}\0${dtype}` : "";
  for (const [oldKey, cached] of indexCache) {
    if (oldKey.startsWith(`${root}\0`) && oldKey !== key) { cached.index.dispose(); indexCache.delete(oldKey); }
  }
  if (!provider) return null;
  touchWorkspaceState(root);
  let cached = indexCache.get(key);
  if (!cached) {
    cached = { index: new PersistentSemanticIndex(root, provider), retrievalGeneration: -1 };
    indexCache.set(key, cached);
    const instance = cached.index;
    registerWorkspaceState(root, "semantic", () => { instance.dispose(); indexCache.delete(key); });
  }
  const generation = getRetrievalIndexGeneration(root);
  if (cached.retrievalGeneration !== generation || cached.index.descriptor.state === "degraded") {
    const records = await getWikiPageRecords(root, false, { persist: false });
    if (options.background) await cached.index.startBackground(records);
    else await cached.index.synchronize(records);
    cached.retrievalGeneration = getRetrievalIndexGeneration(root);
  }
  return cached.index;
}

export function semanticIndexStatus(wikiRoot: string): SemanticIndexDescriptor | { state: "absent" } {
  const root = path.resolve(wikiRoot);
  for (const [key, cached] of indexCache) if (key.startsWith(`${root}\0`)) return cached.index.descriptor;
  return { state: "absent" };
}

export function clearSemanticIndexes(): void {
  for (const cached of indexCache.values()) cached.index.dispose();
  indexCache.clear();
}

export function warmSemanticIndex(wikiRoot: string): void {
  void configuredSemanticIndex(wikiRoot, { background: true }).catch(() => {
    logger.warn("semantic-index", "warmup_unavailable", { retryOnQuery: true });
  });
}
