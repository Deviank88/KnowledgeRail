import type { AnnEngine, AnnEngineDescriptor, AnnSearchHit, AnnSearchOptions, AnnSearchResult, AnnVectorEntry, SemanticVector } from "./types.js";
import { normalizeVector, storeVector } from "./vector.js";

export const compareNeighbors = (a: AnnSearchHit, b: AnnSearchHit): number => b.score - a.score || a.id.localeCompare(b.id);
export function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
export function candidateThreshold(value: number | undefined): number {
  const score = value ?? 0.55;
  if (!Number.isFinite(score) || score < -1 || score > 1) throw new Error("Invalid candidate threshold.");
  return score;
}
export interface VectorRow { vector: SemanticVector; norm: number }
export function vectorRow(entry: AnnVectorEntry, dimensions: number): VectorRow {
  if (!entry.id || entry.id.includes("\0")) throw new Error("Invalid vector id.");
  const vector = entry.normalized && (entry.vector instanceof Float32Array || entry.vector instanceof Int8Array)
    ? entry.vector : normalizeVector(entry.vector, dimensions);
  if (vector.length !== dimensions) throw new Error("Embedding dimension mismatch.");
  let squared = 0;
  for (const value of vector) { if (!Number.isFinite(value)) throw new Error("Invalid vector."); squared += value * value; }
  if (!Number.isFinite(squared) || squared <= 0) throw new Error("Invalid vector norm.");
  return { vector, norm: Math.sqrt(squared) };
}
export function rowScore(a: VectorRow, b: VectorRow): number {
  let dot = 0;
  for (let i = 0; i < a.vector.length; i++) dot += a.vector[i]! * b.vector[i]!;
  return dot / (a.norm * b.norm);
}
export class ExactAnnEngine implements AnnEngine {
  readonly descriptor: AnnEngineDescriptor;
  protected readonly vectors = new Map<string, VectorRow>();
  constructor(options: { dimensions: number; minimumScore?: number }) {
    this.descriptor = { id: "exact-cosine", version: "1", dimensions: boundedInteger(options.dimensions, "dimensions", 1, 8192), minimumScore: candidateThreshold(options.minimumScore) };
  }
  protected query(value: readonly number[]): VectorRow {
    const dtype = this.vectors.values().next().value?.vector instanceof Int8Array ? "i8" : "f32";
    return vectorRow({ id: "query", ...storeVector(value, this.descriptor.dimensions, dtype), normalized: true }, this.descriptor.dimensions);
  }
  rebuild(entries: readonly AnnVectorEntry[]): void { this.vectors.clear(); for (const entry of entries) this.upsert(entry); }
  restore(entries: readonly AnnVectorEntry[], normalized = false): void { this.rebuild(entries.map((entry) => ({ ...entry, normalized: normalized || entry.normalized }))); }
  upsert(entry: AnnVectorEntry): void { this.vectors.set(entry.id, vectorRow(entry, this.descriptor.dimensions)); }
  remove(id: string): void { this.vectors.delete(id); }
  search(value: readonly number[], k: number, options: AnnSearchOptions = {}): AnnSearchResult {
    boundedInteger(k, "k", 1, 1000); options.signal?.throwIfAborted();
    const query = this.query(value), threshold = candidateThreshold(options.minimumScore ?? this.descriptor.minimumScore);
    const eligible: AnnSearchHit[] = [];
    for (const [id, row] of this.vectors) {
      options.signal?.throwIfAborted();
      const score = rowScore(query, row);
      if (score >= threshold) eligible.push({ id, score });
    }
    eligible.sort(compareNeighbors);
    return { hits: eligible.slice(0, k), diagnostics: { candidateCount: this.vectors.size, visitedBuckets: 0, vectorCount: this.vectors.size,
      indexMode: "exact", distanceComputations: this.vectors.size, thresholdRejected: this.vectors.size - eligible.length, poolTruncated: Math.max(0, eligible.length - k) } };
  }
  dispose(): void { this.vectors.clear(); }
}
