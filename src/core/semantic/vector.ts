import type { SemanticVector } from "./types.js";

export type VectorDtype = "f32" | "i8";
export const DEFAULT_VECTOR_DTYPE: VectorDtype = "i8";
export interface StoredVector { vector: SemanticVector; scale: number }

export function normalizeVector(value: ArrayLike<number>, dimensions: number): Float32Array {
  if (value.length !== dimensions) throw new Error("Embedding dimension mismatch.");
  let magnitude = 0;
  for (let i = 0; i < value.length; i++) {
    if (!Number.isFinite(value[i])) throw new Error("Embedding vector contains non-finite values.");
    magnitude += value[i]! * value[i]!;
  }
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error("Embedding vector has invalid magnitude.");
  magnitude = Math.sqrt(magnitude);
  return Float32Array.from(value, (component) => component / magnitude);
}

export function storeVector(value: ArrayLike<number>, dimensions: number, dtype: VectorDtype): StoredVector {
  const normalized = normalizeVector(value, dimensions);
  if (dtype === "f32") return { vector: normalized, scale: 1 };
  let maximum = 0;
  for (const component of normalized) maximum = Math.max(maximum, Math.abs(component));
  const scale = Math.fround(maximum / 127);
  return { vector: Int8Array.from(normalized, (component) => Math.round(component / scale)), scale };
}

export function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i]! * right[i]!;
    a += left[i]! ** 2;
    b += right[i]! ** 2;
  }
  return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : -1;
}
