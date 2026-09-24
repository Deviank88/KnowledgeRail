import { createHash } from "node:crypto";
import { SemanticBudget } from "./semantic/budget.js";
import { EmbeddingRequestQueue } from "./semantic/build-queue.js";
import { OllamaRerankProvider } from "./ollama-reranker.js";

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
  budgetMs: number;
  elapsedMs: number;
  reason?: "unconfigured" | "invalid_configuration" | "budget_exceeded" | "provider_failed" | "invalid_response" | "stale_candidates";
  provider?: RerankProvider["descriptor"];
}
const queues = new WeakMap<RerankProvider, EmbeddingRequestQueue>();
export class RerankSession {
  readonly diagnostics: RerankDiagnostics;
  private budget?: SemanticBudget;
  private readonly controller = new AbortController();
  private started?: number;
  private readonly cached = new Map<string, readonly number[]>();
  /** Zero means no deadline; a positive budget is an explicit operational override. */
  constructor(private readonly provider: RerankProvider | null, private readonly milliseconds = provider?.defaultBudgetMs ?? 0) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 30_000) throw new Error("Invalid reranker budget.");
    this.diagnostics = { enabled: provider !== null, applied: false, candidateCount: 0, calls: 0, budgetMs: milliseconds, elapsedMs: 0,
      ...(provider ? { provider: provider.descriptor } : { reason: "unconfigured" as const }) };
  }
  async score(query: string, documents: readonly string[]): Promise<readonly number[] | null> {
    this.diagnostics.applied = false;
    if (!this.provider || !documents.length || this.diagnostics.reason) return null;
    this.started ??= performance.now();
    if (this.milliseconds) this.budget ??= new SemanticBudget(this.milliseconds);
    this.diagnostics.candidateCount = documents.length;
    const key = createHash("sha256").update(JSON.stringify([query, documents])).digest("hex");
    const cached = this.cached.get(key);
    if (cached) { this.diagnostics.applied = true; this.diagnostics.elapsedMs = performance.now() - this.started; return cached; }
    const provider = this.provider;
    let queue = queues.get(provider); if (!queue) { queue = new EmbeddingRequestQueue(); queues.set(provider, queue); }
    try {
      const signal = this.budget?.signal ?? this.controller.signal;
      const operation = () => queue!.run(() => {
        this.diagnostics.calls++;
        return provider.rerank(query, documents, signal);
      }, true, signal);
      const scores = await (this.budget ? this.budget.run(operation) : operation());
      if (scores.length !== documents.length || scores.some((s) => typeof s !== "number" || !Number.isFinite(s))) {
        this.diagnostics.reason = "invalid_response"; return null;
      }
      if (this.cached.size < 3) this.cached.set(key, [...scores]);
      this.diagnostics.applied = true; return scores;
    } catch {
      this.diagnostics.reason = this.budget?.expired ? "budget_exceeded" : "provider_failed";
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
