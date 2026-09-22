import { createHash } from "node:crypto";
import type { EmbeddingProvider, EmbeddingProviderDescriptor } from "./types.js";
import { StaticEmbeddingProvider } from "./static-provider.js";
import { STATIC_MODELS, type StaticModelName } from "./static-models.js";

export interface OpenAiCompatibleEmbeddingOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  modelVersion?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Optional asymmetric query format required by some embedding models. */
  queryPrefix?: string;
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function embeddingEndpoint(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("KNOWLEDGE_RAIL_EMBEDDING_BASE_URL must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("Embedding base URL must use HTTP(S) without credentials, query or fragment.");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/embeddings`;
  return parsed;
}

function inputText(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 64_000 || normalized.includes("\0")) {
    throw new Error("Embedding input must contain 1-64,000 characters.");
  }
  return normalized;
}

function validatedVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new Error(`Embedding response dimension mismatch: expected ${dimensions}.`);
  }
  const vector = value.map((component) => Number(component));
  if (vector.some((component) => !Number.isFinite(component))) {
    throw new Error("Embedding response contains a non-finite component.");
  }
  const magnitudeSquared = vector.reduce((sum, component) => sum + component * component, 0);
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) {
    throw new Error("Embedding response contains a non-finite or zero-magnitude vector.");
  }
  return vector;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingProviderDescriptor;
  private readonly endpoint: URL;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly queryPrefix: string;

  constructor(options: OpenAiCompatibleEmbeddingOptions) {
    const model = options.model.normalize("NFKC").trim();
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) {
      throw new Error("Embedding model must contain 1-256 printable characters.");
    }
    const modelVersion = (options.modelVersion ?? "unversioned").normalize("NFKC").trim();
    if (!modelVersion || modelVersion.length > 256 || /[\u0000-\u001f\u007f]/.test(modelVersion)) {
      throw new Error("Embedding model version must contain 1-256 printable characters.");
    }
    this.endpoint = embeddingEndpoint(options.baseUrl);
    this.queryPrefix = options.queryPrefix ?? "";
    if (this.queryPrefix.length > 1_024 || this.queryPrefix.includes("\0")) throw new Error("Embedding query prefix must contain at most 1,024 characters without NUL.");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "Embedding timeout", 120_000);
    const dimensions = positiveInteger(options.dimensions, "Embedding dimensions", 8_192);
    const endpointFingerprint = createHash("sha256")
      .update(this.endpoint.origin)
      .update(this.endpoint.pathname)
      .update(this.queryPrefix ? `\0query-prefix:${this.queryPrefix}` : "")
      .digest("hex")
      .slice(0, 12);
    this.descriptor = {
      id: `openai-compatible-${endpointFingerprint}`,
      model,
      version: modelVersion,
      dimensions,
    };
  }

  private async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    if (texts.length > 256) throw new Error("Embedding requests are limited to 256 inputs per batch.");
    const input = texts.map(inputText);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.descriptor.model,
        input,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as EmbeddingResponse;
    if (!Array.isArray(payload.data) || payload.data.length !== input.length) {
      throw new Error("Embedding provider returned an invalid result count.");
    }
    const ordered = [...payload.data].sort((left, right) =>
      (left.index ?? 0) - (right.index ?? 0)
    );
    return ordered.map((item) => validatedVector(item.embedding, this.descriptor.dimensions));
  }

  embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return this.embed(texts);
  }

  embedQueries(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return this.embed(this.queryPrefix ? texts.map((text) => this.queryPrefix + inputText(text)) : texts);
  }

  async embedQuery(text: string): Promise<readonly number[]> {
    return (await this.embedQueries([text]))[0]!;
  }
}

function envInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

export function configuredEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env["KNOWLEDGE_RAIL_EMBEDDING_PROVIDER"] === "static") {
    const model = process.env["KNOWLEDGE_RAIL_EMBEDDING_MODEL"] as StaticModelName;
    const spec = STATIC_MODELS[model];
    const directory = process.env["KNOWLEDGE_RAIL_STATIC_MODEL_DIR"];
    if (!spec || !directory) throw new Error("Static embeddings require a supported model and KNOWLEDGE_RAIL_STATIC_MODEL_DIR; run explicit semantic_setup first.");
    return new StaticEmbeddingProvider(directory, model, spec, (envInteger("KNOWLEDGE_RAIL_STATIC_MEMORY_MB") ?? 256) * 1024 * 1024);
  }
  const baseUrl = process.env["KNOWLEDGE_RAIL_EMBEDDING_BASE_URL"]?.trim();
  const model = process.env["KNOWLEDGE_RAIL_EMBEDDING_MODEL"]?.trim();
  const dimensions = envInteger("KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS");
  if (!baseUrl && !model && dimensions === undefined) return null;
  if (!baseUrl || !model || dimensions === undefined) {
    throw new Error(
      "Semantic retrieval requires KNOWLEDGE_RAIL_EMBEDDING_BASE_URL, KNOWLEDGE_RAIL_EMBEDDING_MODEL and KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS."
    );
  }
  return new OpenAiCompatibleEmbeddingProvider({
    baseUrl,
    model,
    dimensions,
    modelVersion: process.env["KNOWLEDGE_RAIL_EMBEDDING_MODEL_VERSION"],
    apiKey: process.env["KNOWLEDGE_RAIL_EMBEDDING_API_KEY"],
    timeoutMs: envInteger("KNOWLEDGE_RAIL_EMBEDDING_TIMEOUT_MS"),
    queryPrefix: process.env["KNOWLEDGE_RAIL_EMBEDDING_QUERY_PREFIX"],
  });
}
