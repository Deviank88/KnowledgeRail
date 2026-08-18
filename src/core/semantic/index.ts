import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { wikiPassageId } from "../../context/passage-id.js";
import { wikiPageUri } from "../../context/resource-uri.js";
import { atomicWriteText } from "../fs-service.js";
import { registerWorkspaceState, touchWorkspaceState } from "../workspace-state.js";
import { wikiMetaDir } from "../manifest-service.js";
import type { WikiPassage, WikiPageRecord } from "../page-record.js";
import {
  getRetrievalIndexGeneration,
  getWikiPageRecords,
} from "../retrieval-index.js";
import { ensureDir, readFileSafe } from "../utils.js";
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

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude <= 0 || rightMagnitude <= 0) return -1;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function preparedPage(pagePath: string, passages: readonly WikiPassage[]): PreparedPage {
  const normalized = normalizedPagePath(pagePath);
  const seen = new Set<string>();
  return {
    path: normalized,
    fingerprint: pageFingerprint(normalized, passages),
    passages: passages.flatMap((passage) => {
      const passageId = wikiPassageId(passage);
      if (seen.has(passageId)) return [];
      seen.add(passageId);
      return [{
        id: entryId(normalized, passageId),
        pagePath: normalized,
        passageId,
        heading: passage.heading,
        text: passage.text,
      }];
    }),
  };
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
    !sameDescriptor(snapshot.provider, provider) || !sameDescriptor(snapshot.engine, engine) ||
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

async function assertSemanticPathSafe(wikiRoot: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(wikiRoot, { recursive: true });
  let rootReal: string;
  try {
    rootReal = await fs.realpath(wikiRoot);
  } catch (error: unknown) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const metaDir = wikiMetaDir(wikiRoot);
  try {
    const stat = await fs.lstat(metaDir);
    if (stat.isSymbolicLink()) throw new Error("Semantic index directory must not be a symbolic link.");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (create) await ensureDir(metaDir);
  try {
    const metaReal = await fs.realpath(metaDir);
    const relative = path.relative(rootReal, metaReal);
    if (relative !== ".knowledge-rail" || path.isAbsolute(relative)) {
      throw new Error("Semantic index directory resolves outside the wiki root.");
    }
  } catch (error: unknown) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const file = semanticIndexFile(wikiRoot);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error("Semantic index file must not be a symbolic link.");
    const fileReal = await fs.realpath(file);
    const relative = path.relative(rootReal, fileReal).replace(/\\/g, "/");
    if (relative !== ".knowledge-rail/semantic-index.json") {
      throw new Error("Semantic index file resolves outside the wiki root.");
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function semanticIndexFile(wikiRoot: string): string {
  return path.join(wikiMetaDir(wikiRoot), "semantic-index.json");
}

export class PersistentSemanticIndex implements SynchronizableSemanticIndex {
  private readonly pages = new Map<string, PersistedSemanticPage>();
  private readonly passages = new Map<string, PersistedSemanticPassage>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private generatedAt: string | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly coverageVectorCache = new Map<string, Promise<readonly (readonly number[])[]>>();

  constructor(
    private readonly wikiRoot: string,
    private readonly provider: EmbeddingProvider,
    private readonly engine: AnnEngine = new LshAnnEngine({
      dimensions: provider.descriptor.dimensions,
    }),
    private readonly persistChanges = true
  ) {
    if (engine.descriptor.dimensions !== provider.descriptor.dimensions) {
      throw new Error("Semantic provider and ANN engine dimensions do not match.");
    }
  }

  get descriptor(): SemanticIndexDescriptor {
    return {
      provider: { ...this.provider.descriptor },
      engine: { ...this.engine.descriptor },
      passageCount: this.passages.size,
      pageCount: this.pages.size,
      ...(this.generatedAt ? { generatedAt: this.generatedAt } : {}),
    };
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        await assertSemanticPathSafe(this.wikiRoot, false);
        const raw = await readFileSafe(semanticIndexFile(this.wikiRoot));
        if (raw) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          if (validSnapshot(parsed, this.provider.descriptor, this.engine.descriptor)) {
            this.generatedAt = parsed.generatedAt;
            for (const page of parsed.pages) this.pages.set(page.path, page);
            for (const passage of parsed.passages) this.passages.set(passage.id, passage);
            this.engine.rebuild(parsed.passages.map((passage) => ({
              id: passage.id,
              vector: passage.vector,
            })));
          }
        }
        this.loaded = true;
      })();
    }
    try {
      await this.loadPromise;
    } catch (error: unknown) {
      this.loadPromise = undefined;
      throw error;
    } finally {
      if (this.loaded) this.loadPromise = undefined;
    }
  }

  private removePageInMemory(pagePath: string): boolean {
    const existing = this.pages.get(pagePath);
    if (!existing) return false;
    for (const id of existing.passageEntryIds) {
      this.engine.remove(id);
      this.passages.delete(id);
    }
    this.pages.delete(pagePath);
    return true;
  }

  private applyPreparedPage(page: PreparedPage, vectors: readonly (readonly number[])[]): void {
    if (vectors.length !== page.passages.length) {
      throw new Error(`Embedding result count mismatch for ${page.path}.`);
    }
    const normalizedVectors = vectors.map((vector) => {
      if (!validVector(vector, this.provider.descriptor.dimensions)) {
        throw new Error(`Invalid embedding vector for ${page.path}.`);
      }
      return [...vector];
    });
    this.removePageInMemory(page.path);
    const passageEntryIds: string[] = [];
    for (let index = 0; index < page.passages.length; index++) {
      const prepared = page.passages[index]!;
      const passage: PersistedSemanticPassage = {
        ...prepared,
        vector: normalizedVectors[index]!,
      };
      this.passages.set(passage.id, passage);
      this.engine.upsert({ id: passage.id, vector: passage.vector });
      passageEntryIds.push(passage.id);
    }
    this.pages.set(page.path, {
      path: page.path,
      fingerprint: page.fingerprint,
      passageEntryIds,
    });
  }

  private async persist(): Promise<void> {
    this.generatedAt = new Date().toISOString();
    if (!this.persistChanges) return;
    const snapshot: PersistedSemanticIndex = {
      version: 1,
      generatedAt: this.generatedAt,
      provider: { ...this.provider.descriptor },
      engine: { ...this.engine.descriptor },
      pages: [...this.pages.values()].sort((left, right) => left.path.localeCompare(right.path)),
      passages: [...this.passages.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    await assertSemanticPathSafe(this.wikiRoot, true);
    await atomicWriteText(semanticIndexFile(this.wikiRoot), `${JSON.stringify(snapshot)}\n`);
  }

  private async embedPreparedPages(pages: readonly PreparedPage[]): Promise<Map<string, readonly (readonly number[])[]>> {
    const result = new Map<string, readonly (readonly number[])[]>();
    const flattened = pages.flatMap((page) =>
      page.passages.map((passage) => ({ pagePath: page.path, text: passageInput(passage) }))
    );
    const vectors: Array<readonly number[]> = [];
    for (let offset = 0; offset < flattened.length; offset += 64) {
      const batch = flattened.slice(offset, offset + 64);
      vectors.push(...await this.provider.embedDocuments(batch.map((item) => item.text)));
    }
    if (vectors.length !== flattened.length) throw new Error("Embedding provider returned an invalid result count.");
    let cursor = 0;
    for (const page of pages) {
      result.set(page.path, vectors.slice(cursor, cursor + page.passages.length));
      cursor += page.passages.length;
    }
    return result;
  }

  async upsertPassages(pagePath: string, passages: WikiPassage[]): Promise<void> {
    await this.withMutation(async () => {
      await this.load();
      const page = preparedPage(pagePath, passages);
      if (this.pages.get(page.path)?.fingerprint === page.fingerprint) return;
      const vectors = await this.embedPreparedPages([page]);
      this.applyPreparedPage(page, vectors.get(page.path) ?? []);
      await this.persist();
    });
  }

  async removePage(pagePath: string): Promise<void> {
    await this.withMutation(async () => {
      await this.load();
      const normalized = normalizedPagePath(pagePath);
      if (!this.removePageInMemory(normalized)) return;
      await this.persist();
    });
  }

  async synchronize(records: readonly WikiPageRecord[]): Promise<{
    reusedPages: number;
    embeddedPages: number;
    removedPages: number;
    embeddedPassages: number;
  }> {
    return this.withMutation(async () => {
      await this.load();
      const prepared = records.map((record) => preparedPage(record.path, record.passages));
      const wanted = new Set(prepared.map((page) => page.path));
      const changed = prepared.filter((page) => this.pages.get(page.path)?.fingerprint !== page.fingerprint);
      const removed = [...this.pages.keys()].filter((pagePath) => !wanted.has(pagePath));
      const embedded = await this.embedPreparedPages(changed);
      for (const pagePath of removed) this.removePageInMemory(pagePath);
      for (const page of changed) this.applyPreparedPage(page, embedded.get(page.path) ?? []);
      if (changed.length > 0 || removed.length > 0) await this.persist();
      return {
        reusedPages: prepared.length - changed.length,
        embeddedPages: changed.length,
        removedPages: removed.length,
        embeddedPassages: changed.reduce((sum, page) => sum + page.passages.length, 0),
      };
    });
  }

  async searchWithDiagnostics(query: string, k: number): Promise<SemanticSearchResult> {
    await this.load();
    await this.mutationQueue.catch(() => undefined);
    const normalizedQuery = query.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!normalizedQuery || normalizedQuery.length > 4_096 || normalizedQuery.includes("\0")) {
      throw new Error("Semantic query must contain 1-4,096 characters.");
    }
    if (!Number.isInteger(k) || k < 1 || k > 1_000) {
      throw new Error("Semantic result limit must be an integer between 1 and 1,000.");
    }
    const vector = await this.provider.embedQuery(normalizedQuery);
    const result = this.engine.search(vector, k);
    const hits: SemanticHit[] = result.hits.map((hit) => {
      const passage = this.passages.get(hit.id);
      if (!passage) throw new Error(`ANN result references an unknown semantic passage: ${hit.id}.`);
      return {
        pagePath: passage.pagePath,
        passageId: passage.passageId,
        heading: passage.heading,
        text: passage.text,
        score: hit.score,
        provider: { ...this.provider.descriptor },
      };
    });
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
    await this.mutationQueue.catch(() => undefined);
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
      .filter((passage) => wantedPaths.has(passage.pagePath))
      .sort((left, right) => left.pagePath.localeCompare(right.pagePath) || left.id.localeCompare(right.id));
    const cacheKey = JSON.stringify(normalizedQueries.map((query) => query.text));
    let vectorPromise = this.coverageVectorCache.get(cacheKey);
    if (!vectorPromise) {
      vectorPromise = this.provider.embedQueries
        ? this.provider.embedQueries(normalizedQueries.map((query) => query.text))
        : Promise.all(normalizedQueries.map((query) => this.provider.embedQuery(query.text)));
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
      const passagesByPage = new Map<string, Array<{ passageId: string; score: number }>>();
      for (const passage of passages) {
        const score = cosineSimilarity(vector, passage.vector);
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
  options: { persist?: boolean } = {}
): Promise<SynchronizableSemanticIndex | null> {
  const provider = configuredEmbeddingProvider();
  if (!provider) return null;
  const root = path.resolve(wikiRoot);
  touchWorkspaceState(root);
  const persist = options.persist !== false;
  const key = `${root}\0${descriptorKey(provider)}\0${persist ? "persistent" : "memory"}`;
  let cached = indexCache.get(key);
  if (!cached) {
    cached = {
      index: new PersistentSemanticIndex(root, provider, undefined, persist),
      retrievalGeneration: -1,
    };
    indexCache.set(key, cached);
    registerWorkspaceState(root, `semantic:${key}`, () => indexCache.delete(key));
  }
  const generation = getRetrievalIndexGeneration(root);
  if (cached.retrievalGeneration !== generation) {
    await cached.index.synchronize(await getWikiPageRecords(root, false, { persist }));
    cached.retrievalGeneration = getRetrievalIndexGeneration(root);
  }
  return cached.index;
}

export function clearSemanticIndexes(): void {
  indexCache.clear();
}
