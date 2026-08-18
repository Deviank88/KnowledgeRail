import type { WikiPassage, WikiPageRecord } from "../page-record.js";

export interface EmbeddingProviderDescriptor {
  id: string;
  model: string;
  version: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingProviderDescriptor;
  embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  embedQuery(text: string): Promise<readonly number[]>;
  /** Optional batch form used to keep semantic coverage to one provider round trip. */
  embedQueries?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
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
}

export interface AnnVectorEntry {
  id: string;
  vector: readonly number[];
}

export interface AnnSearchHit {
  id: string;
  score: number;
}

export interface AnnSearchDiagnostics {
  candidateCount: number;
  visitedBuckets: number;
  vectorCount: number;
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
  search(vector: readonly number[], k: number): AnnSearchResult;
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
}

export interface SemanticSearchDiagnostics {
  candidateCount: number;
  visitedBuckets: number;
  vectorCount: number;
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
  search(query: string, k: number): Promise<SemanticHit[]>;
  /**
   * Scores coverage concepts against indexed passages on the requested pages.
   * Implementations that cannot expose this operation still support semantic
   * retrieval; callers gracefully retain lexical coverage in that case.
   */
  assessCoverage?(
    queries: readonly SemanticCoverageQuery[],
    pagePaths: readonly string[]
  ): Promise<SemanticCoverageScore[]>;
}

export interface SynchronizableSemanticIndex extends SemanticIndex {
  synchronize(records: readonly WikiPageRecord[]): Promise<{
    reusedPages: number;
    embeddedPages: number;
    removedPages: number;
    embeddedPassages: number;
  }>;
  searchWithDiagnostics(query: string, k: number): Promise<SemanticSearchResult>;
}
