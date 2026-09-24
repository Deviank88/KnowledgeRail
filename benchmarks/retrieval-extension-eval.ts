import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { semanticCoverageQueries } from "../src/core/retrieval-coverage.js";
import { StaticEmbeddingProvider } from "../src/core/semantic/static-provider.js";
import { STATIC_MODELS, type StaticModelName } from "../src/core/semantic/static-models.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";
import { PersistentSemanticIndex } from "../src/core/semantic/index.js";
import { ExactAnnEngine } from "../src/core/semantic/exact-engine.js";
import { HnswAnnEngine } from "../src/core/semantic/hnsw-engine.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import type { AnnEngine, EmbeddingProvider } from "../src/core/semantic/types.js";
import type { RerankProvider } from "../src/core/reranker.js";
import { mean, ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from "./retrieval-metrics.js";

const argument = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = path.resolve(argument("output", "benchmarks/results/retrieval-extension-292"));
const model = argument("provider", "ollama"), collect = process.argv.includes("--collect");
const verifyFinal = process.argv.includes("--verify-final");
const reference = verifyFinal ? JSON.parse(await fs.readFile(path.join(output, `${model}-report.json`), "utf8")) : undefined;
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
interface Page { path: string; title: string; type: string; body: string }
interface Query { id: string; query: string; split: string; category: string; language: string; relevant: Array<{ path: string; grade: number }>; answerable: boolean; pageTypes?: string[] }
const fixture = JSON.parse(await fs.readFile("benchmarks/fixtures/semantic-rescoring-292.json", "utf8")) as { pages: Page[]; queries: Query[] };
const extension = JSON.parse(await fs.readFile("benchmarks/fixtures/retrieval-extension-292.json", "utf8")) as { queries: Query[] };
const queries = [...fixture.queries.map((q) => ({ ...q, split: q.split === "evaluation" ? "inspected-regression" : q.split })), ...extension.queries];
process.env.KNOWLEDGE_RAIL_USAGE_RANKING = "0";
await fs.mkdir(output, { recursive: true });
let actual: EmbeddingProvider;
if (model === "ollama") {
  const config = JSON.parse(await fs.readFile(argument("config", path.join(os.homedir(), ".claude.json")), "utf8"));
  for (const [key, value] of Object.entries(config.mcpServers["knowledge-rail"].env)) if (key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_")) process.env[key] = String(value);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.KNOWLEDGE_RAIL_EMBEDDING_BASE_URL!).hostname));
  actual = configuredEmbeddingProvider()!;
} else {
  const name = model as StaticModelName; assert.ok(STATIC_MODELS[name]);
  actual = new StaticEmbeddingProvider(path.join(argument("assets", "/private/tmp/knowledgerail-static-evaluation"), ".knowledge-rail/models", name), name, STATIC_MODELS[name]);
}
const old = JSON.parse(await fs.readFile(`benchmarks/results/semantic-rescoring-292/${model}-annotated-vectors.json`, "utf8"));
assert.deepEqual(old.descriptor, actual.descriptor);
const sources = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { encoding: "utf8" }).trim().split("\n"))].sort();
const digest = createHash("sha256"); for (const source of sources) digest.update(source).update(await fs.readFile(source));
const runtimeSourcesSha256 = digest.digest("hex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr292-extension-"));
const pairs = new Map<string, { query: string; document: string }>();
let scoreData: { descriptor: RerankProvider["descriptor"]; scores: Record<string, number> } | undefined;
if (!collect) scoreData = JSON.parse(await fs.readFile(path.join(output, "reranker-scores.json"), "utf8"));
const reranker: RerankProvider = {
  descriptor: scoreData?.descriptor ?? { id: "collection-only", model: "not-a-model", version: "1" },
  async rerank(query, documents) { return documents.map((document) => {
    const id = sha([query, document]); pairs.set(id, { query, document });
    if (collect) return 0;
    const score = scoreData!.scores[id]; assert.equal(typeof score, "number", `Missing real cross-encoder score ${id}`); return score!;
  }); },
};
interface Variant { name: string; kind: "lsh" | "lsh8" | "exact" | "hnsw"; policy: "threshold" | "top-k"; pool: number; rerank?: number }
const variants: Variant[] = [];
for (const pool of [32, 64]) {
  variants.push({ name: `lsh-threshold-${pool}`, kind: "lsh", policy: "threshold", pool });
  for (const kind of ["lsh", "lsh8", "exact", "hnsw"] as const) variants.push({ name: `${kind}-top-k-${pool}`, kind, policy: "top-k", pool });
}
for (const kind of ["exact", "hnsw"] as const) variants.push({ name: `${kind}-threshold-64`, kind, policy: "threshold", pool: 64 });
for (const rerank of [32, 64]) for (const kind of ["lsh", "exact", "hnsw"] as const) {
  const policy = kind === "lsh" ? "threshold" : "top-k";
  variants.push({ name: `${kind}-${policy}-64-rerank-${rerank}`, kind, policy, pool: 64, rerank });
}
const results: Record<string, Array<{ id: string; split: string; category: string; ndcg: number; recall: number; precision: number; mrr: number; coverageAccuracy: number; poolRecall: number; paths: string[]; coverage: unknown; latencyMs: number[]; semantic: unknown; rerank: unknown }>> = {};
const indexes = new Map<string, { index: PersistentSemanticIndex; engine: AnnEngine }>();
const build = [];
function bootstrap(values: number[]): [number, number] {
  let state = 292;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const samples = Array.from({ length: 10000 }, () => mean(values.map(() => values[Math.floor(random() * values.length)]!)));
  return [percentile(samples, .025), percentile(samples, .975)];
}
try {
  for (const page of fixture.pages) {
    const file = path.join(root, "wiki", page.path); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: ${JSON.stringify(page.title)}\ntype: ${page.type}\n---\n\n${page.body}`);
  }
  const wiki = path.join(root, "wiki"), records = await getWikiPageRecords(wiki, true, { persist: false });
  assert.equal(sha({ records: records.map((r) => [r.path, r.raw]), queries: fixture.queries }), old.corpusDigest);
  const documents = [...new Set(records.flatMap((r) => r.passages.map((p) => `${p.heading}\n${p.text}`.normalize("NFC").trim())))];
  const oldQueries = [...new Set(fixture.queries.flatMap((q) => [normalize(q.query), ...semanticCoverageQueries(q.query).map((c) => normalize(c.text))]))];
  const queryVectors = new Map(oldQueries.map((q, i) => [q, old.queries[i] as number[]]));
  const documentVectors = new Map(documents.map((d, i) => [d, old.documents[i] as number[]]));
  const newQueries = [...new Set(extension.queries.flatMap((q) => [normalize(q.query), ...semanticCoverageQueries(q.query).map((c) => normalize(c.text))]))].filter((q) => !queryVectors.has(q));
  const cacheFile = path.join(output, `${model}-new-vectors.json`);
  let cached;
  try { cached = JSON.parse(await fs.readFile(cacheFile, "utf8")); assert.equal(cached.inputDigest, sha(newQueries)); assert.deepEqual(cached.descriptor, actual.descriptor); }
  catch {
    const vectors = [], start = performance.now();
    for (let i = 0; i < newQueries.length; i += 32) vectors.push(...await actual.embedQueries!(newQueries.slice(i, i + 32)));
    cached = { descriptor: actual.descriptor, inputDigest: sha(newQueries), inputs: newQueries, vectors, embeddingMs: performance.now() - start };
    await fs.writeFile(cacheFile, JSON.stringify(cached));
  }
  newQueries.forEach((q, i) => queryVectors.set(q, cached.vectors[i]));
  const get = (map: Map<string, number[]>, text: string) => { const value = map.get(text); assert.ok(value, `Missing vector for ${text}`); return value; };
  const frozen: EmbeddingProvider = { descriptor: actual.descriptor,
    async embedDocuments(texts) { return texts.map((t) => get(documentVectors, t)); },
    async embedQuery(text) { return get(queryVectors, text); }, async embedQueries(texts) { return texts.map((t) => get(queryVectors, t)); } };
  for (const kind of ["lsh", "lsh8", "exact", "hnsw"] as const) {
    const engine: AnnEngine = kind === "exact" ? new ExactAnnEngine({ dimensions: actual.descriptor.dimensions }) : kind === "hnsw" ? new HnswAnnEngine({ dimensions: actual.descriptor.dimensions }) : new LshAnnEngine({ dimensions: actual.descriptor.dimensions, probes: kind === "lsh8" ? 8 : 4 });
    const directory = path.join(root, kind); await fs.cp(wiki, directory, { recursive: true });
    const index = new PersistentSemanticIndex(directory, frozen, engine, { dtype: "i8" });
    const start = performance.now(); await index.synchronize(records); await engine.ready?.();
    build.push({ kind, ms: performance.now() - start, descriptor: engine.descriptor }); indexes.set(kind, { index, engine });
  }
  for (const variant of variants) results[variant.name] = [];
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi]!;
    for (let run = 0; run < (collect || verifyFinal ? 1 : 5); run++) {
      const offset = (qi + run) % variants.length;
      for (const v of [...variants.slice(offset), ...variants.slice(0, offset)]) {
        if (collect && !v.rerank) continue;
        const start = performance.now();
        const result = await retrieveWikiHybrid({ wikiRoot: wiki, query: q.query, pageTypes: q.pageTypes, semanticIndex: indexes.get(v.kind)!.index,
          semanticCandidatePolicy: v.policy, semanticPoolSize: v.pool, maxResults: 8, progressiveWidening: false,
          semanticBudgetMs: 1500, initialBudget: { maxEvidence: 8, tokenBudget: 4000 }, maximumBudget: { maxEvidence: 8, tokenBudget: 4000 },
          persistDerivedIndexes: false, rerankEnabled: !!v.rerank, reranker: v.rerank ? reranker : undefined, rerankPoolSize: v.rerank });
        const elapsed = performance.now() - start;
        assert.ok(!result.semantic.budgetExceeded);
        if (v.rerank && result.coverageHits.length) assert.ok(result.rerank?.applied, `${v.name}/${q.id}: ${result.rerank?.reason}`);
        if (collect) continue;
        if (reference) {
          const expected = reference.results[v.name][qi]; assert.equal(expected.id, q.id);
          assert.deepEqual(result.hits.map((h) => h.path), expected.paths, `${v.name}/${q.id}: final runtime evidence changed`);
          assert.deepEqual(result.coverage, expected.coverage, `${v.name}/${q.id}: final runtime coverage changed`);
        }
        if (run) {
          assert.deepEqual(result.hits.map((h) => h.path), results[v.name]![qi]!.paths, "Repeated runs changed selected evidence");
          assert.deepEqual(result.coverage, results[v.name]![qi]!.coverage, "Repeated runs changed coverage");
          results[v.name]![qi]!.latencyMs.push(elapsed); continue;
        }
        results[v.name]!.push({ id: q.id, split: q.split, category: q.category, paths: result.hits.map((h) => h.path),
          ndcg: ndcgAtK(result.hits, q.relevant, 8), recall: recallAtK(result.hits, q.relevant, 8), precision: precisionAtK(result.hits, q.relevant, 8), mrr: reciprocalRank(result.hits, q.relevant),
          poolRecall: recallAtK(result.coverageHits, q.relevant, result.coverageHits.length), coverageAccuracy: Number(result.coverage.sufficient === q.answerable),
          coverage: result.coverage, semantic: result.semantic, rerank: result.rerank, latencyMs: [elapsed] });
      }
    }
    if (qi % 20 === 0) process.stderr.write(`${model} ${collect ? "collect" : "evaluate"} ${qi + 1}/${queries.length}\n`);
  }
  if (collect) {
    await fs.writeFile(path.join(output, `${model}-reranker-pairs.json`), JSON.stringify(Object.fromEntries(pairs)));
    console.log(JSON.stringify({ model, pairs: pairs.size, queries: queries.length, newEmbeddingInputs: newQueries.length }));
  } else if (reference) {
    const report = { model, runtimeSourcesSha256, comparedRuntimeSourcesSha256: reference.runtimeSourcesSha256,
      queries: queries.length, variants: variants.length, comparisons: queries.length * variants.length,
      pathsAndCoverageIdentical: true, generatedAt: new Date().toISOString() };
    await fs.writeFile(path.join(output, `${model}-final-parity.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } else {
    const comparisons = [];
    for (const split of ["development", "inspected-regression", "holdout"]) for (const v of variants) {
      const base = results["lsh-threshold-32"]!.filter((r) => r.split === split), rows = results[v.name]!.filter((r) => r.split === split);
      const deltas = rows.map((r, i) => r.ndcg - base[i]!.ndcg);
      comparisons.push({ variant: v.name, split, ndcg: mean(rows.map((r) => r.ndcg)), delta: mean(deltas), ci95: bootstrap(deltas),
        recall: mean(rows.map((r) => r.recall)), precision: mean(rows.map((r) => r.precision)), mrr: mean(rows.map((r) => r.mrr)), poolRecall: mean(rows.map((r) => r.poolRecall)), coverageAccuracy: mean(rows.map((r) => r.coverageAccuracy)),
        improved: rows.filter((r, i) => r.ndcg > base[i]!.ndcg).map((r) => r.id), regressed: rows.filter((r, i) => r.ndcg < base[i]!.ndcg).map((r) => r.id),
        p50: percentile(rows.flatMap((r) => r.latencyMs), .5), p95: percentile(rows.flatMap((r) => r.latencyMs), .95) });
    }
    const development = comparisons.filter((c) => c.split === "development").sort((a, b) => b.ndcg - a.ndcg || variants.findIndex((v) => v.name === a.variant) - variants.findIndex((v) => v.name === b.variant));
    const report = { runtimeSourcesSha256, model, descriptor: actual.descriptor, generatedAt: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
      queryFixtureSha256: createHash("sha256").update(await fs.readFile("benchmarks/fixtures/retrieval-extension-292.json")).digest("hex"),
      newEmbeddingInputs: newQueries.length, embeddingMs: cached.embeddingMs, build, selectedByDevelopment: development[0]!.variant, comparisons, results,
      limitations: ["New wording over existing judged pages, not independent human labels.", "Timings use frozen real embedding and cross-encoder outputs, not live inference.", "Old evaluation queries are inspected regressions, not the extension holdout."] };
    await fs.writeFile(path.join(output, `${model}-report.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ model, selectedByDevelopment: report.selectedByDevelopment, comparisons: comparisons.filter((c) => c.split === "holdout") }));
  }
} finally { for (const { index } of indexes.values()) index.dispose(); await fs.rm(root, { recursive: true, force: true }); }
