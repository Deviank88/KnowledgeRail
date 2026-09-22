import { createHash } from "node:crypto";
import type {
  AnnEngine,
  AnnEngineDescriptor,
  AnnSearchResult,
  AnnVectorEntry,
} from "./types.js";
import type { SemanticVector, AnnSignatures } from "./types.js";
import { cosine, normalizeVector, storeVector } from "./vector.js";

export interface LshAnnEngineOptions {
  dimensions: number;
  tables?: number;
  bitsPerTable?: number;
  probes?: number;
  minimumScore?: number;
  seed?: string;
}

export interface LshAnnEngineDescriptor extends AnnEngineDescriptor {
  tables: number;
  bitsPerTable: number;
  probes: number;
  minimumScore: number;
}

interface Signature {
  value: number;
  margins: Array<{ bit: number; margin: number }>;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`ANN configuration must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

function normalizedVector(value: readonly number[] | Float32Array, dimensions: number): Float32Array {
  if (value.length !== dimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${dimensions}, received ${value.length}.`);
  }
  let magnitudeSquared = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) throw new Error("Embedding vectors must contain only finite values.");
    magnitudeSquared += component * component;
  }
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) {
    throw new Error("Embedding vectors must have a finite, non-zero magnitude.");
  }
  const magnitude = Math.sqrt(magnitudeSquared);
  return Float32Array.from(value, (component) => component / magnitude);
}

function seedNumber(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32LE(0);
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let current = value;
    current = Math.imul(current ^ (current >>> 15), current | 1);
    current ^= current + Math.imul(current ^ (current >>> 7), current | 61);
    return ((current ^ (current >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let value = 0;
  for (let index = 0; index < left.length; index++) value += left[index]! * right[index]!;
  return value;
}

export class LshAnnEngine implements AnnEngine {
  readonly descriptor: LshAnnEngineDescriptor;
  private readonly vectors = new Map<string, SemanticVector>();
  private readonly savedSignatures = new Map<string, AnnSignatures>();
  private restoring: Promise<void> | undefined;
  private restoreGeneration = 0;
  private readonly hyperplanes: Float32Array[][];
  private readonly buckets: Array<Map<number, Set<string>>>;

  constructor(options: LshAnnEngineOptions) {
    const dimensions = positiveInteger(options.dimensions, options.dimensions, 8_192);
    const tables = positiveInteger(options.tables, 10, 32);
    const bitsPerTable = positiveInteger(options.bitsPerTable, 10, 24);
    const probes = positiveInteger(options.probes, 4, bitsPerTable + 1);
    const minimumScore = options.minimumScore ?? 0.55;
    if (!Number.isFinite(minimumScore) || minimumScore < -1 || minimumScore > 1) {
      throw new Error("ANN minimumScore must be between -1 and 1.");
    }
    const seed = options.seed ?? "knowledge-rail-semantic-lsh-v1";
    this.descriptor = {
      id: "lsh-cosine",
      version: "1",
      dimensions,
      tables,
      bitsPerTable,
      probes,
      minimumScore,
      seed,
    };
    this.hyperplanes = Array.from({ length: tables }, (_, table) => {
      const random = mulberry32(seedNumber(`${seed}\0${table}`));
      return Array.from({ length: bitsPerTable }, () => {
        const plane = Float32Array.from({ length: dimensions }, () => random() * 2 - 1);
        return normalizedVector(plane, dimensions);
      });
    });
    this.buckets = Array.from({ length: tables }, () => new Map());
  }

  private signature(vector: ArrayLike<number>, table: number): Signature {
    let value = 0;
    const margins: Array<{ bit: number; margin: number }> = [];
    for (let bit = 0; bit < this.descriptor.bitsPerTable; bit++) {
      const projection = dot(vector, this.hyperplanes[table]![bit]!);
      if (projection >= 0) value |= 1 << bit;
      margins.push({ bit, margin: Math.abs(projection) });
    }
    margins.sort((left, right) => left.margin - right.margin || left.bit - right.bit);
    return { value, margins };
  }

  private addToBuckets(id: string, vector: SemanticVector, restored?: AnnSignatures): void {
    const signatures: number[] = [];
    for (let table = 0; table < this.descriptor.tables; table++) {
      const signature = restored?.[table] ?? this.signature(vector, table).value;
      if (!restored) signatures.push(signature);
      const bucket = this.buckets[table]!.get(signature) ?? new Set<string>();
      bucket.add(id);
      this.buckets[table]!.set(signature, bucket);
    }
    this.savedSignatures.set(id, restored ?? signatures);
  }

  private removeFromBuckets(id: string): void {
    if (!this.savedSignatures.has(id)) return;
    for (let table = 0; table < this.descriptor.tables; table++) {
      const signature = this.savedSignatures.get(id)![table]!;
      const bucket = this.buckets[table]!.get(signature);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.buckets[table]!.delete(signature);
    }
    this.savedSignatures.delete(id);
  }

  rebuild(entries: readonly AnnVectorEntry[]): void {
    this.restoreGeneration++;
    this.restoring = undefined;
    this.vectors.clear();
    this.savedSignatures.clear();
    for (const buckets of this.buckets) buckets.clear();
    for (const entry of entries) this.upsert(entry);
  }

  restore(entries: readonly AnnVectorEntry[], normalized = false): void {
    this.rebuild([]);
    const pending: string[] = [];
    for (const entry of entries) {
      const validSignatures = entry.signatures?.length === this.descriptor.tables &&
        entry.signatures.every((value) => Number.isInteger(value) && value >= 0 && value < 2 ** this.descriptor.bitsPerTable);
      if (validSignatures) this.upsert(normalized ? { ...entry, normalized } : entry);
      else {
        const vector = (normalized || entry.normalized) && (entry.vector instanceof Float32Array || entry.vector instanceof Int8Array)
          ? entry.vector : normalizeVector(entry.vector, this.descriptor.dimensions);
        this.vectors.set(entry.id, vector);
        pending.push(entry.id);
      }
    }
    if (!pending.length) return;
    const generation = this.restoreGeneration;
    this.restoring = (async () => {
      for (let offset = 0; offset < pending.length; offset += 64) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (generation !== this.restoreGeneration) return;
        for (const id of pending.slice(offset, offset + 64)) {
          const vector = this.vectors.get(id);
          if (vector && !this.savedSignatures.has(id)) this.addToBuckets(id, vector);
        }
      }
    })().finally(() => { if (generation === this.restoreGeneration) this.restoring = undefined; });
  }
  async ready(): Promise<void> { await this.restoring; }
  dispose(): void { this.restoreGeneration++; this.restoring = undefined; }

  upsert(entry: AnnVectorEntry): void {
    if (!entry.id.trim() || entry.id.includes("\0")) throw new Error("ANN entry ID is invalid.");
    const vector = entry.normalized && (entry.vector instanceof Float32Array || entry.vector instanceof Int8Array)
      ? entry.vector : normalizeVector(entry.vector, this.descriptor.dimensions);
    if (vector.length !== this.descriptor.dimensions) throw new Error("Embedding dimension mismatch.");
    if (entry.signatures && (entry.signatures.length !== this.descriptor.tables ||
        entry.signatures.some((value) => !Number.isInteger(value) || value < 0 || value >= 2 ** this.descriptor.bitsPerTable))) {
      throw new Error("Invalid persisted ANN signatures.");
    }
    const previous = this.vectors.get(entry.id);
    if (previous) this.removeFromBuckets(entry.id);
    this.vectors.set(entry.id, vector);
    this.addToBuckets(entry.id, vector, entry.signatures);
  }

  remove(id: string): void {
    const vector = this.vectors.get(id);
    if (!vector) return;
    this.removeFromBuckets(id);
    this.vectors.delete(id);
  }

  signatures(id: string): AnnSignatures | undefined {
    return this.savedSignatures.get(id);
  }

  search(value: readonly number[], k: number): AnnSearchResult {
    if (!Number.isInteger(k) || k < 1 || k > 1_000) {
      throw new Error("ANN result limit must be an integer between 1 and 1,000.");
    }
    const limit = k;
    const quantized = this.vectors.values().next().value instanceof Int8Array;
    const vector = quantized ? storeVector(value, this.descriptor.dimensions, "i8").vector
      : normalizedVector(value, this.descriptor.dimensions);
    const candidates = new Set<string>();
    let visitedBuckets = 0;
    if (this.restoring) for (const id of this.vectors.keys()) candidates.add(id);
    for (let table = 0; !this.restoring && table < this.descriptor.tables; table++) {
      const signature = this.signature(vector, table);
      const signatures = [signature.value];
      for (const candidate of signature.margins.slice(0, this.descriptor.probes - 1)) {
        signatures.push(signature.value ^ (1 << candidate.bit));
      }
      for (const probe of signatures) {
        visitedBuckets++;
        for (const id of this.buckets[table]!.get(probe) ?? []) candidates.add(id);
      }
    }
    const hits = [...candidates]
      .map((id) => ({ id, score: quantized ? cosine(vector, this.vectors.get(id)!) : dot(vector, this.vectors.get(id)!) }))
      .filter((hit) => hit.score >= this.descriptor.minimumScore)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
    return {
      hits,
      diagnostics: {
        candidateCount: candidates.size,
        visitedBuckets,
        vectorCount: this.vectors.size,
        ...(this.restoring ? { indexMode: "exact" as const } : {}),
      },
    };
  }
}
