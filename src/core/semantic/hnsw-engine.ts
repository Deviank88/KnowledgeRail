import { createHash } from "node:crypto";
import type { AnnSearchHit, AnnSearchOptions, AnnSearchResult, AnnVectorEntry } from "./types.js";
import { ExactAnnEngine, boundedInteger, candidateThreshold, compareNeighbors, rowScore, vectorRow, type VectorRow } from "./exact-engine.js";

/** Bounded priority queue; comparator < 0 means higher priority. */
class Heap {
  private values: AnnSearchHit[] = [];
  constructor(private readonly compare: typeof compareNeighbors) {}
  get size(): number { return this.values.length; }
  peek(): AnnSearchHit | undefined { return this.values[0]; }
  push(value: AnnSearchHit): void {
    const a = this.values; a.push(value); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >>> 1; if (this.compare(a[p]!, value) <= 0) break; a[i] = a[p]!; i = p; } a[i] = value;
  }
  pop(): AnnSearchHit | undefined {
    const a = this.values, first = a[0], last = a.pop(); if (!a.length || !last) return first;
    let i = 0;
    while (i * 2 + 1 < a.length) { let child = i * 2 + 1;
      if (child + 1 < a.length && this.compare(a[child + 1]!, a[child]!) < 0) child++;
      if (this.compare(last, a[child]!) <= 0) break; a[i] = a[child]!; i = child;
    } a[i] = last; return first;
  }
  sorted(): AnnSearchHit[] { return [...this.values].sort(compareNeighbors); }
}
interface GraphNode { links: string[][] }
export interface HnswOptions { dimensions: number; minimumScore?: number; m?: number; efConstruction?: number; efSearch?: number; seed?: string }

/** Hierarchical graph with heuristic neighbor diversification (Malkov/Yashunin).
 * Graph is derived from persisted vectors. Changes repair local neighborhoods;
 * concurrent queries use exact search over the current vectors until ready.
 */
export class HnswAnnEngine extends ExactAnnEngine {
  private readonly nodes = new Map<string, GraphNode>();
  private entry?: string;
  private generation = 0;
  private restoring?: Promise<void>;
  private pending = new Set<string>();
  private readonly dirty = new Set<string>();
  private maintenanceError?: unknown;
  private readonly work = { fullBuilds: 0, repairBatches: 0, repairedNodes: 0, scannedNodes: 0, insertedNodes: 0 };
  get maintenanceStats() { return { ...this.work, pendingChanges: this.dirty.size + this.pending.size }; }
  private active(id: string): boolean { return this.nodes.has(id) && this.vectors.has(id) && !this.dirty.has(id); }
  private graphRestored = false;
  constructor(options: HnswOptions) {
    super(options);
    Object.assign(this.descriptor, { id: "hnsw-cosine", m: boundedInteger(options.m ?? 16, "M", 2, 64),
      efConstruction: boundedInteger(options.efConstruction ?? 100, "efConstruction", 16, 1000),
      efSearch: boundedInteger(options.efSearch ?? 64, "efSearch", 1, 4096), seed: options.seed ?? "knowledge-rail-hnsw-v1" });
    if (this.descriptor.efConstruction! < this.descriptor.m!) throw new Error("efConstruction must be at least M.");
  }
  private level(id: string): number {
    const integer = createHash("sha256").update(this.descriptor.seed!).update("\0").update(id).digest().readUInt32LE(0);
    return Math.min(16, Math.floor(-Math.log((integer + 1) / (2 ** 32 + 1)) / Math.log(this.descriptor.m!)));
  }
  private nearest(row: VectorRow, entry: string, level: number, score: (id: string) => number): string {
    let best = entry, improved = true;
    while (improved) { improved = false;
      for (const id of this.nodes.get(best)?.links[level] ?? []) if (compareNeighbors({ id, score: score(id) }, { id: best, score: score(best) }) < 0) { best = id; improved = true; }
    } return best;
  }
  private layer(entries: string[], ef: number, level: number, score: (id: string) => number, signal?: AbortSignal): AnnSearchHit[] {
    const candidates = new Heap(compareNeighbors), nearest = new Heap((a, b) => compareNeighbors(b, a));
    const seen = new Set<string>();
    for (const id of entries) { const hit = { id, score: score(id) }; candidates.push(hit); nearest.push(hit); seen.add(id); }
    while (candidates.size) {
      signal?.throwIfAborted(); const candidate = candidates.pop()!;
      if (nearest.size >= ef && compareNeighbors(candidate, nearest.peek()!) > 0) break;
      for (const id of this.nodes.get(candidate.id)?.links[level] ?? []) {
        if (seen.has(id)) continue; seen.add(id);
        const hit = { id, score: score(id) };
        if (nearest.size < ef || compareNeighbors(hit, nearest.peek()!) < 0) {
          candidates.push(hit); nearest.push(hit); if (nearest.size > ef) nearest.pop();
        }
      }
    } return nearest.sorted();
  }
  private diversified(row: VectorRow, candidates: AnnSearchHit[], maximum: number): string[] {
    const selected: string[] = [];
    for (const candidate of candidates) {
      if (selected.length === maximum) break;
      if (selected.every((id) => rowScore(this.vectors.get(candidate.id)!, this.vectors.get(id)!) < candidate.score)) selected.push(candidate.id);
    }
    return selected;
  }
  private insert(id: string): void {
    if (this.nodes.has(id) || !this.vectors.has(id)) return;
    const row = this.vectors.get(id)!, level = this.level(id), cache = new Map<string, number>();
    const score = (other: string) => { let value = cache.get(other); if (value === undefined) { value = rowScore(row, this.vectors.get(other)!); cache.set(other, value); } return value; };
    const node: GraphNode = { links: Array.from({ length: level + 1 }, () => []) };
    this.work.insertedNodes++;
    if (!this.entry) { this.nodes.set(id, node); this.entry = id; return; }
    let entry = this.entry;
    const top = this.nodes.get(entry)!.links.length - 1;
    for (let layer = top; layer > level; layer--) entry = this.nearest(row, entry, layer, score);
    this.nodes.set(id, node);
    for (let layer = Math.min(level, top); layer >= 0; layer--) {
      const candidates = this.layer([entry], this.descriptor.efConstruction!, layer, score);
      const links = this.diversified(row, candidates, this.descriptor.m!);
      node.links[layer] = links;
      for (const neighbor of links) {
        const other = this.nodes.get(neighbor)!, maximum = this.descriptor.m! * (layer === 0 ? 2 : 1);
        const connected = [...other.links[layer]!, id];
        other.links[layer] = connected.length <= maximum ? connected : this.diversified(this.vectors.get(neighbor)!, connected.map((key) => ({ id: key,
          score: rowScore(this.vectors.get(neighbor)!, this.vectors.get(key)!) })).sort(compareNeighbors), maximum);
      }
      if (candidates[0]) entry = candidates[0].id;
    }
    if (level > top) this.entry = id;
  }
  /** Scan adjacency once per coalesced batch, without a resident reverse graph or
   * deleted-vector copy. Repair in-neighbors through the removed nodes' outgoing
   * paths, then reinsert changed vectors using the usual HNSW insertion.
   * The full adjacency scan is O(E); expensive vector scoring is local.
   */
  private *repairBatch(): Generator<void> {
    const removed = new Map<string, GraphNode>();
    for (const id of this.dirty) {
      const node = this.nodes.get(id);
      if (node) { removed.set(id, node); this.nodes.delete(id); }
      if (this.vectors.has(id)) this.pending.add(id);
    }
    this.dirty.clear(); this.work.repairBatches++;
    for (const [id, node] of this.nodes) {
      this.work.scannedNodes++;
      let repaired = false;
      for (let level = 0; level < node.links.length; level++) {
        const links = node.links[level]!;
        if (!links.some((target) => removed.has(target))) continue;
        const candidates = new Set<string>(), seen = new Set<string>();
        const visit = [...links];
        // Follow chains/cycles of nodes removed in the same batch. Only their
        // adjacency is retained temporarily; removed vectors are gone already.
        while (visit.length) {
          const target = visit.pop()!;
          if (target === id || seen.has(target)) continue;
          seen.add(target);
          const detached = removed.get(target);
          if (detached) { for (const next of detached.links[level] ?? []) visit.push(next); }
          else if (this.nodes.has(target)) candidates.add(target);
        }
        const row = this.vectors.get(id);
        // A later mutation may arrive between cooperative slices. Preserve its
        // incoming references for the next repair batch instead of losing paths.
        if (!row || this.dirty.has(id) || [...candidates].some((target) => !this.active(target))) {
          node.links[level] = [...candidates];
        } else {
          const scored = [...candidates].map((target) => ({ id: target, score: rowScore(row, this.vectors.get(target)!) })).sort(compareNeighbors);
          node.links[level] = this.diversified(row, scored, this.descriptor.m! * (level === 0 ? 2 : 1));
        }
        repaired = true;
      }
      if (repaired) this.work.repairedNodes++;
      yield;
    }
    this.chooseEntry();
  }
  private chooseEntry(): void {
    this.entry = undefined;
    let maximum = 0;
    for (const [id, node] of this.nodes) if (this.active(id) && (node.links.length > maximum
      || (node.links.length === maximum && id < this.entry!))) {
      this.entry = id; maximum = node.links.length;
    }
  }
  private scheduleMaintenance(): void {
    if (this.restoring) return;
    const generation = this.generation;
    this.restoring = (async () => {
      try {
        for (;;) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (generation !== this.generation) return;
          if (this.dirty.size) {
            const repair = this.repairBatch();
            let done = false;
            while (!done) {
              const until = performance.now() + 8;
              do { done = repair.next().done === true; } while (!done && performance.now() < until);
              if (!done) await new Promise<void>((resolve) => setImmediate(resolve));
              if (generation !== this.generation) return;
            }
            // Mutations arriving during repair are handled before insertion.
            if (this.dirty.size) continue;
          }
          const until = performance.now() + 8;
          for (const id of this.pending) {
            this.pending.delete(id); this.insert(id);
            if (performance.now() >= until) break;
          }
          if (!this.dirty.size && !this.pending.size) break;
        }
      } catch (error) {
        // Background failures must not become unhandled rejections or persist a
        // partial graph. Queries retain exact fallback; ready() reports failure.
        if (generation === this.generation) this.maintenanceError = error;
      } finally { if (generation === this.generation) this.restoring = undefined; }
    })();
  }
  private resetGraph(): void {
    this.generation++; this.restoring = undefined; this.maintenanceError = undefined;
    this.nodes.clear(); this.dirty.clear(); this.pending.clear(); this.entry = undefined; this.graphRestored = false;
  }
  override rebuild(entries: readonly AnnVectorEntry[]): void {
    const rows = entries.map((entry) => [entry.id, vectorRow(entry, this.descriptor.dimensions)] as const);
    this.resetGraph(); this.vectors.clear(); this.work.fullBuilds++;
    for (const [id, row] of rows) this.vectors.set(id, row);
    for (const id of [...this.vectors.keys()].sort()) this.insert(id);
  }
  override restore(entries: readonly AnnVectorEntry[], normalized = false): void {
    const rows = entries.map((entry) => [entry.id, vectorRow({ ...entry, normalized: normalized || entry.normalized }, this.descriptor.dimensions)] as const);
    this.resetGraph(); this.vectors.clear(); this.work.fullBuilds++;
    for (const [id, row] of rows) this.vectors.set(id, row);
    this.pending = new Set([...this.vectors.keys()].sort());
    this.scheduleMaintenance();
  }
  override upsert(entry: AnnVectorEntry): void {
    const row = vectorRow(entry, this.descriptor.dimensions), old = this.vectors.get(entry.id);
    if (old && old.vector.constructor === row.vector.constructor && old.vector.every((value, index) => value === row.vector[index])) return;
    this.vectors.set(entry.id, row); this.graphRestored = false;
    if (this.nodes.has(entry.id)) this.dirty.add(entry.id);
    else this.pending.add(entry.id);
    if (this.restoring || this.dirty.size || this.maintenanceError) this.scheduleMaintenance();
    else { this.pending.delete(entry.id); this.insert(entry.id); }
  }
  override remove(id: string): void {
    if (!this.vectors.delete(id)) return;
    this.graphRestored = false; this.pending.delete(id);
    if (this.nodes.has(id)) this.dirty.add(id);
    if (this.dirty.size) this.scheduleMaintenance();
  }
  async ready(): Promise<void> {
    while (this.restoring) await this.restoring;
    if (this.maintenanceError) throw this.maintenanceError;
  }
  private vectorDigest(rows: Map<string, VectorRow>, ids: readonly string[]): Buffer {
    const hash = createHash("sha256");
    for (const id of ids) {
      const vector = rows.get(id)!.vector;
      hash.update(id).update("\0").update(vector instanceof Int8Array ? "i8" : "f32")
        .update(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
    }
    return hash.digest();
  }
  snapshot(): Uint8Array | undefined {
    if (this.restoring || this.maintenanceError || this.nodes.size !== this.vectors.size) return undefined;
    const ids = [...this.vectors.keys()].sort(), indexes = new Map(ids.map((id, i) => [id, i]));
    let size = 128;
    for (const id of ids) { size += 4; for (const links of this.nodes.get(id)!.links) size += 4 + links.length * 4; }
    const bytes = Buffer.alloc(size); bytes.write("KRHNS001"); bytes.writeUInt32LE(ids.length, 8);
    bytes.writeUInt32LE(this.entry ? indexes.get(this.entry)! : 0xffffffff, 12);
    createHash("sha256").update(JSON.stringify(this.descriptor)).digest().copy(bytes, 16);
    this.vectorDigest(this.vectors, ids).copy(bytes, 48);
    let offset = 128;
    for (const id of ids) {
      const node = this.nodes.get(id)!; bytes.writeUInt32LE(node.links.length, offset); offset += 4;
      for (const links of node.links) {
        bytes.writeUInt32LE(links.length, offset); offset += 4;
        for (const target of links) { bytes.writeUInt32LE(indexes.get(target)!, offset); offset += 4; }
      }
    }
    createHash("sha256").update(bytes.subarray(128)).digest().copy(bytes, 80);
    return bytes;
  }
  restoreSnapshot(entries: readonly AnnVectorEntry[], input: Uint8Array): boolean {
    try {
      const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
      if (bytes.length < 128 || bytes.length > 256 * 1024 * 1024 || bytes.subarray(0, 8).toString() !== "KRHNS001" || bytes.readUInt32LE(8) !== entries.length ||
        !createHash("sha256").update(JSON.stringify(this.descriptor)).digest().equals(bytes.subarray(16, 48)) ||
        !createHash("sha256").update(bytes.subarray(128)).digest().equals(bytes.subarray(80, 112))) return false;
      const rows = new Map(entries.map((entry) => [entry.id, vectorRow(entry, this.descriptor.dimensions)]));
      const ids = [...rows.keys()].sort();
      if (ids.length !== entries.length || !this.vectorDigest(rows, ids).equals(bytes.subarray(48, 80))) return false;
      const entry = bytes.readUInt32LE(12);
      if (ids.length ? entry >= ids.length : entry !== 0xffffffff) return false;
      let offset = 128, maximumLevel = 0;
      const nodes = new Map<string, GraphNode>();
      for (const id of ids) {
        const levels = bytes.readUInt32LE(offset); offset += 4;
        if (levels < 1 || levels > 17) return false;
        maximumLevel = Math.max(maximumLevel, levels);
        const links: string[][] = [];
        for (let layer = 0; layer < levels; layer++) {
          const count = bytes.readUInt32LE(offset); offset += 4;
          if (count > this.descriptor.m! * (layer === 0 ? 2 : 1)) return false;
          const values: string[] = [];
          for (let i = 0; i < count; i++) { const index = bytes.readUInt32LE(offset); offset += 4;
            if (index >= ids.length || ids[index] === id) return false; values.push(ids[index]!); }
          if (new Set(values).size !== values.length) return false; links.push(values);
        }
        nodes.set(id, { links });
      }
      if (offset !== bytes.length || (ids.length && nodes.get(ids[entry]!)!.links.length !== maximumLevel)) return false;
      for (const node of nodes.values()) for (let layer = 0; layer < node.links.length; layer++) {
        if (node.links[layer]!.some((id) => nodes.get(id)!.links.length <= layer)) return false;
      }
      // Commit only after validating the complete artifact. Rejected snapshots
      // leave the current engine untouched so the caller can rebuild safely.
      this.resetGraph(); this.vectors.clear();
      for (const [id, row] of rows) this.vectors.set(id, row);
      for (const [id, node] of nodes) this.nodes.set(id, node);
      this.entry = ids[entry]; this.graphRestored = true;
      return true;
    } catch { return false; }
  }
  override search(value: readonly number[], k: number, options: AnnSearchOptions = {}): AnnSearchResult {
    boundedInteger(k, "k", 1, 1000); options.signal?.throwIfAborted();
    if (this.restoring || this.maintenanceError || !this.entry) { const result = super.search(value, k, options); result.diagnostics.graphReady = !this.restoring && !this.maintenanceError; return result; }
    const row = this.query(value), cache = new Map<string, number>();
    const score = (id: string) => { let value = cache.get(id); if (value === undefined) { value = rowScore(row, this.vectors.get(id)!); cache.set(id, value); } return value; };
    let entry = this.entry;
    for (let level = this.nodes.get(entry)!.links.length - 1; level > 0; level--) entry = this.nearest(row, entry, level, score);
    const candidates = this.layer([entry], Math.max(k, this.descriptor.efSearch!), 0, score, options.signal);
    const threshold = candidateThreshold(options.minimumScore ?? this.descriptor.minimumScore);
    const eligible = candidates.filter((hit) => hit.score >= threshold);
    return { hits: eligible.slice(0, k), diagnostics: { candidateCount: candidates.length, visitedBuckets: 0, vectorCount: this.vectors.size,
      indexMode: "ann", graphReady: true, graphRestored: this.graphRestored, distanceComputations: cache.size, thresholdRejected: candidates.length - eligible.length, poolTruncated: Math.max(0, eligible.length - k) } };
  }
  override dispose(): void { this.resetGraph(); super.dispose(); }
}
