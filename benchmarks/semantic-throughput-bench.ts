import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { embeddingCorpus } from "./embedding-corpus.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";
import { cosine, storeVector } from "../src/core/semantic/vector.js";

if (!process.argv.includes("--live")) throw new Error("Use --live to authorize the configured embedding provider.");
const provider = configuredEmbeddingProvider();
if (!provider) throw new Error("Configure a local embedding provider first.");
const wiki = path.resolve(process.argv.find((a) => a.startsWith("--wiki="))?.slice(7) ?? "wiki");
const texts = await embeddingCorpus(wiki, 1000);
await provider.embedDocuments(texts.slice(0, 1));
console.log(JSON.stringify({ phase: "corpus", passages: texts.length, characters: texts.reduce((n, s) => n + s.length, 0), provider: provider.descriptor }));
let reference: readonly (readonly number[])[] = [];
for (const batchSize of [64, 128, 256]) for (const concurrency of [1, 2, 4]) {
  const batches = Array.from({ length: Math.ceil(texts.length / batchSize) }, (_, i) => texts.slice(i * batchSize, (i + 1) * batchSize));
  let cursor = 0;
  const result: Array<readonly (readonly number[])[]> = [];
  const start = performance.now();
  try {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (cursor < batches.length) {
        const i = cursor++;
        result[i] = await provider.embedDocuments(batches[i]!);
      }
    }));
    const failure = workers.find((worker) => worker.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const elapsedMs = performance.now() - start;
    if (!reference.length) reference = result.flat();
    console.log(JSON.stringify({ phase: "throughput", batchSize, concurrency, elapsedMs, passagesPerSecond: texts.length * 1000 / elapsedMs, errors: 0 }));
  } catch (error) {
    console.log(JSON.stringify({ phase: "throughput", batchSize, concurrency, elapsedMs: performance.now() - start, errors: 1, error: String(error) }));
  }
}
const queries = [
  "Come vengono aggiornati gli embedding quando cambia una pagina?", "Come si recupera un indice corrotto?",
  "Come si seleziona il workspace?", "Quali linguaggi di codice sono supportati?", "Come si mantiene la provenienza delle decisioni?",
  "What happens when the embedding model changes?", "How are code references resolved?", "How are stale claims detected?",
  "How do compact responses reduce context?", "Which cache limits apply per workspace?",
];
const queryVectors = provider.embedQueries ? await provider.embedQueries(queries) : await Promise.all(queries.map((q) => provider.embedQuery(q)));
const quantized = reference.map((v) => storeVector(v, provider.descriptor.dimensions, "i8").vector);
let thresholdChanges = 0, topChanges = 0, maxError = 0;
for (const query of queryVectors) {
  const q8 = storeVector(query, provider.descriptor.dimensions, "i8").vector;
  const full = reference.map((v, i) => ({ i, score: cosine(query, v) }));
  const compact = quantized.map((v, i) => ({ i, score: cosine(q8, v) }));
  for (let i = 0; i < full.length; i++) {
    maxError = Math.max(maxError, Math.abs(full[i]!.score - compact[i]!.score));
    for (const threshold of [0.72, 0.80]) if ((full[i]!.score >= threshold) !== (compact[i]!.score >= threshold)) thresholdChanges++;
  }
  const ranked = (values: typeof full) => values.sort((a, b) => b.score - a.score || a.i - b.i)[0]?.i;
  if (ranked(full) !== ranked(compact)) topChanges++;
}
console.log(JSON.stringify({ phase: "quantization", passages: reference.length, queries: queries.length, thresholdChanges, topChanges, maxError,
  limitation: "One installed embedding model and authored probes; not the independent two-model acceptance gate." }));

// Controlled truncation ablation on the same real corpus and query embeddings.
for (const limit of [512, 2048]) {
  const start = performance.now(); const vectors: Array<readonly number[]> = [];
  for (let i = 0; i < texts.length; i += 64) vectors.push(...await provider.embedDocuments(texts.slice(i, i + 64).map((text) => text.slice(0, limit))));
  const rank = (query: readonly number[], values: readonly (readonly number[])[]) => values.map((v, i) => ({ i, score: cosine(query, v) })).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 5).map((v) => v.i);
  const overlap = queryVectors.map((q) => { const before = rank(q, reference), after = rank(q, vectors); return before.filter((i) => after.includes(i)).length / 5; });
  console.log(JSON.stringify({ phase: "truncation", limit, truncatedPassages: texts.filter((t) => t.length > limit).length, elapsedMs: performance.now() - start,
    meanTop5Overlap: overlap.reduce((n, x) => n + x, 0) / overlap.length,
    limitation: "Ranking stability on authored probes, not relevance accuracy. Default remains 64000; no truncation optimization is inferred from throughput alone." }));
}
