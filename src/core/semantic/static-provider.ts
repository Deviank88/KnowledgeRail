import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EmbeddingProvider, EmbeddingProviderDescriptor } from "./types.js";
import { STATIC_MODELS, type StaticModelName } from "./static-models.js";
import { withDerivedCheckpointLock } from "../checkpoint-lock.js";
import { resolveRealWithin } from "../paths.js";

type FileName = "model.safetensors" | "config.json" | "tokenizer.json" | "tokenizer_config.json";
export interface StaticModelSpec { dimensions: number; revision: string; files: Record<FileName, string> }
interface LoadedModel {
  tokenizer: import("@huggingface/tokenizers").Tokenizer;
  unknown?: number;
  rows: number;
  offset: number;
  table?: Buffer;
}
async function checkedFile(directory: string, filename: FileName): Promise<string> {
  const root = await fs.realpath(directory);
  const file = path.join(directory, filename);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(await fs.realpath(file)) !== root) throw new Error("Static model assets must be regular local files.");
  return file;
}
async function hashFile(filename: string): Promise<string> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), block = Buffer.allocUnsafe(1024 * 1024);
    let read: number;
    while ((read = (await handle.read(block)).bytesRead) > 0) hash.update(block.subarray(0, read));
    return hash.digest("hex");
  } finally { await handle.close(); }
}

export class StaticEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingProviderDescriptor;
  private loaded?: Promise<LoadedModel>;
  constructor(readonly directory: string, readonly model: string, readonly spec: StaticModelSpec, readonly memoryBudgetBytes = 256 * 1024 * 1024) {
    if (!Number.isInteger(memoryBudgetBytes) || memoryBudgetBytes < 0 || !Number.isInteger(spec.dimensions) || spec.dimensions < 1 || spec.dimensions > 8192 ||
      Object.values(spec.files).some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) throw new Error("Invalid static model configuration.");
    this.descriptor = { id: "model2vec-local-v1", model, dimensions: spec.dimensions,
      version: createHash("sha256").update(JSON.stringify(spec)).digest("hex") };
  }
  private load(): Promise<LoadedModel> {
    return this.loaded ??= this.initialize().catch((error: unknown) => { this.loaded = undefined; throw error; });
  }
  private async initialize(): Promise<LoadedModel> {
    for (const [name, hash] of Object.entries(this.spec.files)) {
      const file = await checkedFile(this.directory, name as FileName);
      if (await hashFile(file) !== hash) throw new Error(`Static model integrity mismatch: ${name}. Run explicit semantic_setup or restore pinned assets.`);
    }
    const config = JSON.parse(await fs.readFile(path.join(this.directory, "config.json"), "utf8"));
    if (config.model_type !== "model2vec" || config.hidden_dim !== this.spec.dimensions) throw new Error("Unsupported static model config.");
    const tokenizerJson = JSON.parse(await fs.readFile(path.join(this.directory, "tokenizer.json"), "utf8"));
    const tokenizerConfig = JSON.parse(await fs.readFile(path.join(this.directory, "tokenizer_config.json"), "utf8"));
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const unknown = tokenizerJson.model?.unk_id ?? tokenizerJson.model?.vocab?.[tokenizerJson.model?.unk_token];
    const filename = await checkedFile(this.directory, "model.safetensors");
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const prefix = Buffer.alloc(8);
      if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error("Truncated safetensors header.");
      const length = Number(prefix.readBigUInt64LE());
      if (!Number.isSafeInteger(length) || length < 2 || length > 1024 * 1024) throw new Error("Invalid safetensors header length.");
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, 8)).bytesRead !== length) throw new Error("Truncated safetensors metadata.");
      const metadata = JSON.parse(bytes.toString("utf8"));
      const tensors = Object.entries(metadata).filter(([name]) => name !== "__metadata__");
      if (tensors.length !== 1) throw new Error("Only one unquantized model2vec embedding matrix is supported.");
      const tensor = tensors[0]![1] as { dtype: string; shape: number[]; data_offsets: number[] };
      const rows = tensor.shape?.[0] ?? 0, size = rows * this.spec.dimensions * 4;
      if (tensor.dtype !== "F32" || tensor.shape.length !== 2 || !Number.isInteger(rows) || rows < 1 || rows > 2_000_000 ||
        tensor.shape[1] !== this.spec.dimensions || tensor.data_offsets?.[0] !== 0 || tensor.data_offsets[1] !== size ||
        (await handle.stat()).size !== 8 + length + size) throw new Error("Invalid model2vec matrix shape or size.");
      // The budget covers the matrix; tokenizer metadata is reported separately.
      const table = size <= this.memoryBudgetBytes ? Buffer.allocUnsafe(size) : undefined;
      if (table && (await handle.read(table, 0, size, 8 + length)).bytesRead !== size) throw new Error("Truncated embedding matrix.");
      return { tokenizer, unknown, rows, offset: 8 + length, ...(table ? { table } : {}) };
    } finally { await handle.close(); }
  }
  async embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (!texts.length) return [];
    if (texts.length > 256) throw new Error("Static embedding batches are limited to 256 inputs.");
    const model = await this.load(), dimensions = this.spec.dimensions;
    const handle = model.table ? undefined : await fs.open(await checkedFile(this.directory, "model.safetensors"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const row = Buffer.allocUnsafe(dimensions * 4);
    try {
      const output: number[][] = [];
      for (const text of texts) {
        if (!text.trim() || text.length > 64_000 || text.includes("\0")) throw new Error("Embedding input must contain 1-64,000 characters.");
        const ids = model.tokenizer.encode(text, { add_special_tokens: false }).ids.filter((id) => id !== model.unknown);
        const weights = new Map<number, number>();
        for (const id of ids) weights.set(id, (weights.get(id) ?? 0) + 1);
        const vector = new Array<number>(dimensions).fill(0);
        for (const [id, count] of weights) {
          if (!Number.isInteger(id) || id < 0 || id >= model.rows) throw new Error("Tokenizer ID is outside the embedding matrix.");
          const buffer = model.table ?? row, offset = model.table ? id * dimensions * 4 : 0;
          if (handle && (await handle.read(row, 0, row.length, model.offset + id * row.length)).bytesRead !== row.length) throw new Error("Truncated embedding row.");
          for (let i = 0; i < dimensions; i++) vector[i] = vector[i]! + buffer.readFloatLE(offset + i * 4) * count;
        }
        const norm = Math.hypot(...vector);
        if (!norm || !Number.isFinite(norm)) throw new Error("Static embedding contains no known tokens or a non-finite vector.");
        output.push(vector.map((value) => value / norm));
      }
      return output;
    } finally { await handle?.close(); }
  }
  embedQueries(texts: readonly string[]) { return this.embedDocuments(texts); }
  async embedQuery(text: string) { return (await this.embedDocuments([text]))[0]!; }
}

export async function setupStaticModel(wikiRoot: string, model: StaticModelName, download = false) {
  const spec = STATIC_MODELS[model];
  if (!spec) throw new Error("Unsupported static embedding model.");
  const directory = await resolveRealWithin(wikiRoot, `.knowledge-rail/models/${model}`);
  const files = Object.entries(spec.files).map(([name, sha256]) => ({ name, sha256,
    url: `https://huggingface.co/minishlab/${model}/resolve/${spec.revision}/${name}` }));
  if (download) await withDerivedCheckpointLock(wikiRoot, async () => {
    await fs.mkdir(directory, { recursive: true });
    for (const file of files) {
      const destination = path.join(directory, file.name);
      const existing = await checkedFile(directory, file.name as FileName).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && await hashFile(existing) === file.sha256) continue;
      const response = await fetch(file.url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`Static model download failed: HTTP ${response.status}.`);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 600 * 1024 * 1024) throw new Error("Static asset exceeds download limit.");
          hash.update(chunk); await handle.writeFile(chunk);
        }
        if (hash.digest("hex") !== file.sha256) throw new Error(`Static asset hash mismatch: ${file.name}.`);
        await handle.sync(); await handle.close(); await fs.rename(temporary, destination);
      } finally { await handle.close().catch(() => undefined); await fs.unlink(temporary).catch(() => undefined); }
    }
  });
  return { model, directory, revision: spec.revision, dimensions: spec.dimensions, downloaded: download, files,
    environment: { KNOWLEDGE_RAIL_EMBEDDING_PROVIDER: "static", KNOWLEDGE_RAIL_EMBEDDING_MODEL: model,
      KNOWLEDGE_RAIL_STATIC_MODEL_DIR: directory },
    note: "Optional provider. Setup does not change server configuration. Matrix cache defaults to 256 MiB; larger models read rows from disk. Tokenizer memory is additional." };
}
