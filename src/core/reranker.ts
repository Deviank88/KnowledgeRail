import { createHash } from "node:crypto";
import { SemanticBudget } from "./semantic/budget.js";
import { EmbeddingRequestQueue } from "./semantic/build-queue.js";
import { OllamaRerankProvider } from "./ollama-reranker.js";
import { logger } from "./logger.js";

export interface RerankProvider {
  readonly descriptor: { id: string; model: string; version: string };
  readonly defaultBudgetMs?: number;
  /** Return one finite score per document, in input order. */
  rerank(query: string, documents: readonly string[], signal: AbortSignal): Promise<readonly number[]>;
}
export interface RerankDiagnostics {
  enabled: boolean;
  applied: boolean;
  candidateCount: number;
  calls: number;
  /** Query/document pairs sent to the provider, and pairs answered from this session's cache. */
  pairs: number;
  cachedPairs: number;
  budgetMs: number;
  elapsedMs: number;
  reason?: "unconfigured" | "invalid_configuration" | "budget_exceeded" | "provider_failed" | "unsupported_runtime" | "invalid_response" | "stale_candidates";
  /** Operator-facing explanation of an unsupported runtime; never contains provider output. */
  detail?: string;
  provider?: RerankProvider["descriptor"];
}
/** The provider is reachable but its runtime or weights cannot produce verified scores. */
export class RerankRuntimeUnsupportedError extends Error {
  override readonly name = "RerankRuntimeUnsupportedError";
}
const reported = new Set<string>();
/** Coverage warning for a configured reranker that did not reorder the results. */
export function rerankWarning(diagnostics: RerankDiagnostics): string | undefined {
  if (!diagnostics.enabled || diagnostics.applied || !diagnostics.reason || diagnostics.reason === "stale_candidates") return undefined;
  return `Reranker unavailable (${diagnostics.reason}); results use the base hybrid ranking.${diagnostics.detail ? ` ${diagnostics.detail}` : ""}`;
}
const queues = new WeakMap<RerankProvider, EmbeddingRequestQueue>();
/** Widening can score at most four pools of at most 64 documents each. */
const MAX_CACHED_PAIRS = 256;
export class RerankSession {
  readonly diagnostics: RerankDiagnostics;
  private budget?: SemanticBudget;
  private readonly controller = new AbortController();
  private started?: number;
  /** Scores per query/document pair, so a widened pool only sends its new documents. */
  private readonly cached = new Map<string, number>();
  /** Zero means no deadline; a positive budget is an explicit operational override. */
  constructor(private readonly provider: RerankProvider | null, private readonly milliseconds = provider?.defaultBudgetMs ?? 0) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 30_000) throw new Error("Invalid reranker budget.");
    this.diagnostics = { enabled: provider !== null, applied: false, candidateCount: 0, calls: 0, pairs: 0, cachedPairs: 0, budgetMs: milliseconds, elapsedMs: 0,
      ...(provider ? { provider: provider.descriptor } : { reason: "unconfigured" as const }) };
  }
  async score(query: string, documents: readonly string[]): Promise<readonly number[] | null> {
    this.diagnostics.applied = false;
    if (!this.provider || !documents.length || this.diagnostics.reason) return null;
    this.started ??= performance.now();
    if (this.milliseconds) this.budget ??= new SemanticBudget(this.milliseconds);
    this.diagnostics.candidateCount = documents.length;
    const { id, model, version } = this.provider.descriptor;
    const keys = documents.map((document) => createHash("sha256").update(JSON.stringify([id, model, version, query, document])).digest("hex"));
    const missing = [...new Set(keys.filter((key) => !this.cached.has(key)))];
    const scores = (fresh: ReadonlyMap<string, number>) => keys.map((key) => fresh.get(key) ?? this.cached.get(key)!);
    this.diagnostics.cachedPairs += documents.length - missing.length;
    if (!missing.length) { this.diagnostics.applied = true; this.diagnostics.elapsedMs = performance.now() - this.started; return scores(new Map()); }
    const pending = missing.map((key) => documents[keys.indexOf(key)]!);
    const provider = this.provider;
    let queue = queues.get(provider); if (!queue) { queue = new EmbeddingRequestQueue(); queues.set(provider, queue); }
    try {
      const signal = this.budget?.signal ?? this.controller.signal;
      const operation = () => queue!.run(() => {
        this.diagnostics.calls++; this.diagnostics.pairs += pending.length;
        return provider.rerank(query, pending, signal);
      }, true, signal);
      const received = await (this.budget ? this.budget.run(operation) : operation());
      if (received.length !== pending.length || received.some((s) => typeof s !== "number" || !Number.isFinite(s))) {
        this.diagnostics.reason = "invalid_response"; return null;
      }
      reported.clear();
      const fresh = new Map(missing.map((key, i) => [key, received[i]!]));
      for (const [key, score] of fresh) if (this.cached.size < MAX_CACHED_PAIRS) this.cached.set(key, score);
      this.diagnostics.applied = true; return scores(fresh);
    } catch (error) {
      if (error instanceof RerankRuntimeUnsupportedError && !this.budget?.expired) {
        this.diagnostics.reason = "unsupported_runtime"; this.diagnostics.detail = error.message;
      } else this.diagnostics.reason = this.budget?.expired ? "budget_exceeded" : "provider_failed";
      // Logged once per outage: retrieval continues without reranking on every query.
      const key = `${this.diagnostics.reason}:${this.diagnostics.detail ?? ""}`;
      if (this.diagnostics.reason !== "budget_exceeded" && !reported.has(key)) {
        reported.add(key);
        logger.warn("reranker", this.diagnostics.reason, { model: provider.descriptor.model, detail: this.diagnostics.detail });
      }
      return null;
    } finally { this.diagnostics.elapsedMs = performance.now() - this.started; }
  }
  close(): void { this.budget?.close(); this.controller.abort(); this.cached.clear(); }
}

/** Explicit /rerank endpoint, compatible with TEI/Cohere-style indexed results. */
export class HttpRerankProvider implements RerankProvider {
  readonly descriptor: RerankProvider["descriptor"];
  private readonly endpoint: URL;
  constructor(private readonly options: { endpoint: string; model: string; version?: string; apiKey?: string }) {
    this.endpoint = new URL(options.endpoint);
    if (!["http:", "https:"].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new Error("Invalid reranker endpoint.");
    for (const text of [options.model, options.version ?? "unversioned"]) if (!text.trim() || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error("Invalid reranker descriptor.");
    this.descriptor = { id: `http-rerank-${createHash("sha256").update(this.endpoint.href).digest("hex").slice(0, 12)}`, model: options.model, version: options.version ?? "unversioned" };
  }
  async rerank(query: string, documents: readonly string[], signal: AbortSignal): Promise<readonly number[]> {
    signal.throwIfAborted();
    if (!query.trim() || query.length > 4096 || documents.length > 64 || documents.some((d) => !d.trim() || d.length > 4096) || documents.reduce((n, d) => n + d.length, 0) > 131072) throw new Error("Reranker input limit exceeded.");
    if (!documents.length) return [];
    const response = await fetch(this.endpoint, { method: "POST", signal, redirect: "error",
      headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.descriptor.model, query, documents, top_n: documents.length, return_documents: false }) });
    if (!response.ok || !response.body) throw new Error(`Reranker returned HTTP ${response.status}.`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
        if (length > 1024 * 1024) throw new Error("Reranker response limit exceeded."); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { results?: Array<{ index: number; relevance_score: number }> };
    if (!Array.isArray(payload.results) || payload.results.length !== documents.length) throw new Error("Invalid reranker result count.");
    const scores = new Array<number>(documents.length), seen = new Set<number>();
    for (const row of payload.results) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= documents.length || seen.has(row.index) || typeof row.relevance_score !== "number" || !Number.isFinite(row.relevance_score)) throw new Error("Invalid reranker results.");
      seen.add(row.index); scores[row.index] = row.relevance_score;
    }
    return scores;
  }
}
let configured: { key: string; provider: RerankProvider } | undefined;
export function configuredReranker(): RerankProvider | null {
  const endpoint = process.env["KNOWLEDGE_RAIL_RERANK_ENDPOINT"], model = process.env["KNOWLEDGE_RAIL_RERANK_MODEL"];
  const baseUrl = process.env["KNOWLEDGE_RAIL_RERANK_BASE_URL"], provider = process.env["KNOWLEDGE_RAIL_RERANK_PROVIDER"];
  if (!endpoint && !model && !baseUrl && !provider) return null;
  if (!model || (provider && provider !== "ollama" && provider !== "http") || (endpoint && baseUrl)
    || (provider === "ollama" && endpoint) || (provider === "http" && baseUrl) || (!endpoint && !baseUrl)) throw new Error("Invalid reranker configuration.");
  const options = { endpoint, baseUrl, provider, model, version: process.env["KNOWLEDGE_RAIL_RERANK_VERSION"], apiKey: process.env["KNOWLEDGE_RAIL_RERANK_API_KEY"] };
  const key = createHash("sha256").update(JSON.stringify(options)).digest("hex");
  if (configured?.key !== key) configured = { key, provider: baseUrl
    ? new OllamaRerankProvider({ baseUrl, model, apiKey: options.apiKey })
    : new HttpRerankProvider({ endpoint: endpoint!, model, version: options.version, apiKey: options.apiKey }) };
  return configured.provider;
}
