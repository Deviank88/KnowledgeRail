import type { WikiPassage, WikiPageRecord } from "../page-record.js";

export interface EmbeddingProviderDescriptor {
  id: string;
  model: string;
  version: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingProviderDescriptor;
  /** Background request ceiling; foreground requests also carry their shared deadline. */
  readonly timeoutMs?: number;
  embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<readonly number[]>;
  /** Optional batch form used to keep semantic coverage to one provider round trip. */
  embedQueries?(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export interface AnnEngineDescriptor {
  id: string;
  version: string;
  dimensions: number;
  /** Optional LSH diagnostics; alternative ANN engines need not expose them. */
  tables?: number;
  bitsPerTable?: number;
  probes?: number;
  minimumScore?: number;
  seed?: string;
  m?: number;
  efConstruction?: number;
  efSearch?: number;
}

export type SemanticVector = Float32Array | Int8Array;
export type AnnSignatures = readonly number[] | Uint32Array;

export interface AnnVectorEntry {
  id: string;
  vector: readonly number[] | SemanticVector;
  /** Normalized, owned by the index; the engine shares this immutable storage. */
  normalized?: boolean;
  scale?: number;
  signatures?: AnnSignatures;
}

export interface AnnSearchHit {
  id: string;
  score: number;
}

export interface AnnSearchDiagnostics {
  candidateCount: number;
  visitedBuckets: number;
  vectorCount: number;
  indexMode?: "ann" | "exact";
  thresholdRejected?: number;
  poolTruncated?: number;
  distanceComputations?: number;
  graphReady?: boolean;
  graphRestored?: boolean;
}

export interface AnnSearchOptions {
  /** Candidate admission only; never a coverage threshold. */
  minimumScore?: number;
  signal?: AbortSignal;
}

export interface AnnSearchResult {
  hits: AnnSearchHit[];
  diagnostics: AnnSearchDiagnostics;
}

export interface AnnEngine {
  readonly descriptor: AnnEngineDescriptor;
  rebuild(entries: readonly AnnVectorEntry[]): void;
  upsert(entry: AnnVectorEntry): void;
  remove(id: string): void;
  search(vector: readonly number[], k: number, options?: AnnSearchOptions): AnnSearchResult;
  signatures?(id: string): AnnSignatures | undefined;
  restore?(entries: readonly AnnVectorEntry[], normalized?: boolean): void;
  ready?(): Promise<void>;
  /** Optional derived graph, bound to the exact owned vectors and engine descriptor. */
  snapshot?(): Uint8Array | undefined;
  restoreSnapshot?(entries: readonly AnnVectorEntry[], bytes: Uint8Array): boolean;
  dispose?(): void;
}

export interface SemanticHit {
  pagePath: string;
  passageId: string;
  heading: string;
  text: string;
  score: number;
  provider: EmbeddingProviderDescriptor;
}

export interface SemanticIndexDescriptor {
  provider: EmbeddingProviderDescriptor;
  engine: AnnEngineDescriptor;
  passageCount: number;
  pageCount: number;
  generatedAt?: string;
  state?: "absent" | "building" | "ready" | "degraded";
  totalPages?: number;
  pendingPages?: number;
  reason?: string;
  dtype?: "f32" | "i8";
  candidatePolicy?: "threshold" | "top-k";
}

export interface SemanticSearchDiagnostics extends AnnSearchDiagnostics {
  candidatePolicy?: "threshold" | "top-k";
  requestedPool?: number;
  searchedPool?: number;
  searchPasses?: number;
  candidateLimitReached?: boolean;
  approximate?: boolean;
  returnedPassages?: number;
  distinctPages?: number;
  filteredPassages?: number;
  stalePassages?: number;
  deduplicatedPassages?: number;
}

export interface SemanticSearchOptions {
  candidatePolicy?: "threshold" | "top-k";
  /** k is an initial batch, not a final evidence quota. */
  expandCandidates?: boolean;
  maximumCandidates?: number;
  signal?: AbortSignal;
  distinctPages?: boolean;
  pagePaths?: ReadonlySet<string>;
}

export interface SemanticSearchResult {
  hits: SemanticHit[];
  diagnostics: SemanticSearchDiagnostics;
}

export interface SemanticCoverageQuery {
  id: string;
  text: string;
}

export interface SemanticCoveragePageScore {
  pagePath: string;
  score: number;
  /** Scores for the individual passages used to compute the page maximum. */
  passages?: Array<{
    passageId: string;
    score: number;
  }>;
}

export interface SemanticCoverageScore {
  id: string;
  pages: SemanticCoveragePageScore[];
}

export interface SemanticIndex {
  readonly descriptor: SemanticIndexDescriptor;
  upsertPassages(pagePath: string, passages: WikiPassage[]): Promise<void>;
  removePage(pagePath: string): Promise<void>;
  search(query: string, k: number, options?: SemanticSearchOptions): Promise<SemanticHit[]>;
  prioritize?(pagePaths: readonly string[], budgetMs?: number): Promise<void>;
  /**
   * Scores coverage concepts against indexed passages on the requested pages.
   * Implementations that cannot expose this operation still support semantic
   * retrieval; callers gracefully retain lexical coverage in that case.
   */
  assessCoverage?(
    queries: readonly SemanticCoverageQuery[],
    pagePaths: readonly string[],
    signal?: AbortSignal
  ): Promise<SemanticCoverageScore[]>;
}

export interface SynchronizableSemanticIndex extends SemanticIndex {
  synchronize(records: readonly WikiPageRecord[], options?: { signal?: AbortSignal }): Promise<{
    reusedPages: number;
    embeddedPages: number;
    removedPages: number;
    embeddedPassages: number;
  }>;
  searchWithDiagnostics(query: string, k: number, options?: SemanticSearchOptions): Promise<SemanticSearchResult>;
}
