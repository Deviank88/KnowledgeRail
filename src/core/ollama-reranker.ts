import { createHash } from "node:crypto";
import { RerankRuntimeUnsupportedError, type RerankProvider } from "./reranker.js";

/** The compatibility path is deliberately restricted to the measured GGUF.
 * llama.cpp RANK puts the classifier logit in embd[0]; Ollama's legacy route leaves
 * it unnormalised. /api/embed normalises it and cannot be used for this purpose.
 * See benchmarks/ollama-reranker-results-2.9.2.md for parity evidence and sources.
 */
export const OLLAMA_BGE_RANK_SHA256 = "092f088dd16882bb872e09ac18b624534c6d53780006e31be6fefcc621246fc2";
/** Logits of the pinned weights, measured with llama.cpp RANK (identical on Ollama 0.34.3 and 0.34.4).
 * Every Ollama version must reproduce them before its scores are used. */
export const OLLAMA_BGE_CALIBRATION = [
  { query: "What is the capital of France?", document: "Paris is the capital and largest city of France.", score: 7.7998175621032715 },
  { query: "Qual è la capitale d'Italia?", document: "La ricetta della torta di mele richiede farina, zucchero e tre uova.", score: -11.045934677124023 },
  { query: "Come si attiva il reranker?", document: "Il reranker si attiva configurando l'endpoint del servizio di reranking e il nome del modello.", score: 6.9133758544921875 },
] as const;
/** Covers measured backend drift (Vulkan differed by at most 0.33), not normalised or unrelated outputs. */
const CALIBRATION_TOLERANCE = 1;
export class OllamaRerankProvider implements RerankProvider {
  readonly descriptor: RerankProvider["descriptor"];
  readonly defaultBudgetMs = 0;
  private readonly base: URL;
  /** Calibration verdicts per Ollama version: accepted, or the reason it was refused. */
  private readonly calibrated = new Map<string, true | string>();
  constructor(private readonly options: { baseUrl: string; model: string; apiKey?: string }) {
    this.base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search
      || this.base.hash || this.base.pathname !== "/") throw new Error("Ollama reranking requires its native HTTP(S) base URL.");
    if (!options.model.trim() || options.model.length > 256 || /[\u0000-\u001f\u007f]/.test(options.model)) throw new Error("Invalid reranker model.");
    this.descriptor = { id: `ollama-rerank-${createHash("sha256").update(this.base.href).digest("hex").slice(0, 12)}`,
      model: options.model, version: OLLAMA_BGE_RANK_SHA256 };
  }
  private async request(route: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const response = await fetch(new URL(route, this.base), { signal, redirect: "error", method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Ollama reranker request failed."); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 1024 * 1024) throw new Error("Ollama reranker response too large.");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Ollama response.");
    return result as Record<string, unknown>;
  }
  private async classify(query: string, document: string, signal: AbortSignal): Promise<number> {
    const payload = await this.request("api/embeddings", signal, { model: this.descriptor.model, prompt: `${query}</s>${document}`,
      keep_alive: "5m", options: { num_ctx: 2048, num_batch: 2048 } });
    const values = payload.embedding;
    if (!Array.isArray(values) || (values.length !== 1 && values.length !== 1024)
      || typeof values[0] !== "number" || !Number.isFinite(values[0])) throw new Error("Invalid Ollama classifier score.");
    return values[0];
  }
  /** A new Ollama version is accepted once it reproduces the pinned weights' logits. */
  private async calibrate(version: string, signal: AbortSignal): Promise<void> {
    let verdict = this.calibrated.get(version);
    if (verdict === undefined) {
      const scores: number[] = [];
      for (const pair of OLLAMA_BGE_CALIBRATION) scores.push(await this.classify(pair.query, pair.document, signal));
      const drift = Math.max(...scores.map((score, i) => Math.abs(score - OLLAMA_BGE_CALIBRATION[i]!.score)));
      verdict = drift <= CALIBRATION_TOLERANCE ? true
        : `Ollama ${version} does not reproduce the verified reranker scores (drift ${drift.toFixed(3)}); reranking is disabled for this runtime.`;
      this.calibrated.set(version, verdict);
    }
    if (verdict !== true) throw new RerankRuntimeUnsupportedError(verdict);
  }
  async rerank(query: string, documents: readonly string[], signal: AbortSignal): Promise<readonly number[]> {
    signal.throwIfAborted();
    const invalid = (text: string) => !text.trim() || text.length > 4096 || /<\/?s>|<pad>|<unk>|<mask>/.test(text);
    if (invalid(query) || documents.length > 64 || documents.some(invalid)
      || documents.reduce((n, doc) => n + doc.length, 0) > 131072) throw new Error("Unsupported Ollama reranker input.");
    if (!documents.length) return [];
    // Recheck each pool: model aliases can be replaced while the MCP process lives.
    const { version } = await this.request("api/version", signal);
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new RerankRuntimeUnsupportedError("Ollama did not report a version.");
    const show = await this.request("api/show", signal, { model: this.descriptor.model });
    const info = show.model_info as Record<string, unknown> | undefined;
    const from = typeof show.modelfile === "string" ? /^FROM\s+(.+)$/m.exec(show.modelfile)?.[1]?.trim().replace(/^"|"$/g, "") : undefined;
    if (!from?.endsWith(`sha256-${OLLAMA_BGE_RANK_SHA256}`) || info?.["general.architecture"] !== "bert"
      || info["bert.pooling_type"] !== 4 || info["bert.embedding_length"] !== 1024
      || info["tokenizer.ggml.add_bos_token"] !== true || info["tokenizer.ggml.add_eos_token"] !== true) {
      throw new RerankRuntimeUnsupportedError(`Ollama model ${this.descriptor.model} is not the prepared BGE reranker; run scripts/prepare-ollama-reranker.py.`);
    }
    await this.calibrate(version, signal);
    const scores: number[] = [];
    for (const document of documents) scores.push(await this.classify(query, document, signal));
    return scores;
  }
}
