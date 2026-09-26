import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { assessRetrievalCoverage, createRetrievalEvidenceSignals, extractQueryEntities, semanticCoverageQueries, measureEvidenceCoherence } from "../src/core/retrieval-coverage.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";
import { configuredReranker } from "../src/core/reranker.js";
import { setupStaticModel } from "../src/core/semantic/static-provider.js";
import { STATIC_MODELS, type StaticModelName } from "../src/core/semantic/static-models.js";
import { PersistentSemanticIndex } from "../src/core/semantic/index.js";
import type { EmbeddingProvider, SemanticCoverageScore } from "../src/core/semantic/types.js";
import { mean, recallAtK } from "./retrieval-metrics.js";

// Coverage diagnostics: the sufficient/gap decision, separated from retrieval misses,
// with the gap reasons behind each error and an exact threshold sensitivity.
// Retrieval settings mirror retrieval-extension-eval.ts; the runtime is unchanged.
//   node --import tsx benchmarks/coverage-diagnostics.ts --provider=lexical [--translate]
//   node --import tsx benchmarks/coverage-diagnostics.ts --provider=http   (KNOWLEDGE_RAIL_EMBEDDING_* env)
//   node --import tsx benchmarks/coverage-diagnostics.ts --provider=static:potion-multilingual-128M --assets=<dir>
// --translate replaces each non-English query with its frozen English rendering, simulating
// the calling agent that rewrites a query in the knowledge language before retrieval.
const argument = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const providerArg = argument("provider", "lexical");
const translate = process.argv.includes("--translate");
const rerankPoolSize = Number(argument("rerank-pool", "32"));
assert.ok(Number.isInteger(rerankPoolSize) && rerankPoolSize >= 1 && rerankPoolSize <= 64);
const output = path.resolve(argument("output", "benchmarks/results/coverage-diagnostics"));
const label = argument("label", `${providerArg.replace(/[^A-Za-z0-9.-]+/g, "_")}${translate ? "-translated" : ""}`);
const DEFAULTS = { facet: 0.72, entity: 0.8, type: 0.72 } as const;

interface Page { path: string; title: string; type: string; body: string }
interface Query { id: string; query: string; split: string; category: string; language: string; relevant: Array<{ path: string; grade: number }>; answerable: boolean; pageTypes?: string[] }
interface Extra { knowledgeLanguage: string; translations: Record<string, string>; negatives: Array<{ id: string; split: string; language: string; query: string; translation?: string }> }
const fixture = JSON.parse(await fs.readFile("benchmarks/fixtures/semantic-rescoring-292.json", "utf8")) as { pages: Page[]; queries: Query[] };
const extension = JSON.parse(await fs.readFile("benchmarks/fixtures/retrieval-extension-292.json", "utf8")) as { queries: Query[] };
const extraRaw = await fs.readFile("benchmarks/fixtures/coverage-diagnostics-292.json");
const extra = JSON.parse(extraRaw.toString("utf8")) as Extra;
const queries = [
  ...fixture.queries.map((q) => ({ ...q, split: q.split === "evaluation" ? "inspected-regression" : q.split })),
  ...extension.queries,
  ...extra.negatives.map((n) => ({ id: n.id, split: n.split, category: "absent-indomain", language: n.language, query: n.query, relevant: [], answerable: false })),
].map((q) => {
  const group = q.answerable ? "answerable" : q.category === "absent-indomain" ? "absent-indomain" : "absent-offdomain";
  if (!translate || q.language === extra.knowledgeLanguage) return { ...q, group, originalQuery: q.query };
  const rendered = extra.translations[q.id] ?? extra.negatives.find((n) => n.id === q.id)?.translation;
  assert.ok(rendered, `${q.id}: missing translation`);
  return { ...q, group, originalQuery: q.query, query: rendered };
});
process.env.KNOWLEDGE_RAIL_USAGE_RANKING = "0";

let provider: EmbeddingProvider | null = null;
if (providerArg === "http") provider = configuredEmbeddingProvider();
else if (providerArg.startsWith("static:")) {
  const name = providerArg.slice(7) as StaticModelName; assert.ok(STATIC_MODELS[name], "Unknown static model");
  const assets = path.resolve(argument("assets", path.join(os.tmpdir(), "knowledgerail-static-evaluation")));
  await fs.mkdir(assets, { recursive: true });
  const setup = await setupStaticModel(assets, name, true);
  Object.assign(process.env, setup.environment);
  provider = configuredEmbeddingProvider();
} else assert.equal(providerArg, "lexical", "--provider must be lexical, http or static:<model>");
if (providerArg !== "lexical") assert.ok(provider, "Embedding provider is not configured");

type Kind = "facet" | "entity" | "type";
type Thresholds = Record<Kind, number>;
const kindOf = (id: string) => id.slice(0, id.indexOf(":")) as Kind;
/** Moves every score so that `score >= t` holds exactly when `shifted >= runtime threshold`. */
const shifted = (scores: readonly SemanticCoverageScore[], t: Thresholds) => scores.map((s) => {
  const delta = DEFAULTS[kindOf(s.id)] - t[kindOf(s.id)];
  return { id: s.id, pages: s.pages.map((p) => ({ pagePath: p.pagePath, score: p.score + delta,
    passages: p.passages?.map((x) => ({ passageId: x.passageId, score: x.score + delta })) })) };
});
const maxScore = (score: SemanticCoverageScore | undefined, paths?: ReadonlySet<string>) =>
  Math.max(-1, ...(score?.pages ?? []).filter((p) => !paths || paths.has(p.pagePath)).map((p) => p.score));

interface Concept { id: string; kind: Kind; text: string; lexicalInPool?: boolean; poolMax?: number; relevantMax?: number; nonRelevantMax?: number }
interface Row {
  coherence: { page: number; passage: number };
  rerank: { maxScore: number | null; scoredCandidates: number };
  id: string; split: string; category: string; group: string; language: string; query: string; originalQuery: string;
  answerable: boolean; retrieval: "complete" | "partial" | "miss" | "n/a"; evidenceRetrieved: boolean; sufficient: boolean;
  coverageMode: string; gaps: string[]; queryFacetCoverage: number; poolSize: number; poolRecall: number;
  semanticChangedDecision: boolean; semanticChangedGaps: boolean; conceptsOverThreshold: Array<{ text: string; kind: Kind; score: number; lexicalInPool?: boolean }>;
  concepts: Concept[]; recompute: (t: Thresholds) => boolean;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-coverage-"));
try {
  for (const page of fixture.pages) {
    const file = path.join(root, "wiki", page.path); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: ${JSON.stringify(page.title)}\ntype: ${page.type}\n---\n\n${page.body}`);
  }
  const wiki = path.join(root, "wiki"), records = await getWikiPageRecords(wiki, true, { persist: false });
  const allPaths = records.map((r) => r.path);
  let index: PersistentSemanticIndex | undefined;
  if (provider) {
    index = new PersistentSemanticIndex(wiki, provider);
    const start = performance.now(); await index.synchronize(records);
    process.stderr.write(`indexed ${records.length} pages in ${Math.round(performance.now() - start)} ms\n`);
    await provider.embedQuery("warm-up");
  }

  const rows: Row[] = [];
  for (const q of queries) {
    const result = await retrieveWikiHybrid({ wikiRoot: wiki, query: q.query, pageTypes: q.pageTypes, maxResults: 8,
      semanticEnabled: !!index, semanticIndex: index, progressiveWidening: false, semanticBudgetMs: 30_000, rerankPoolSize,
      initialBudget: { maxEvidence: 8, tokenBudget: 4000 }, maximumBudget: { maxEvidence: 8, tokenBudget: 4000 }, persistDerivedIndexes: false });
    assert.ok(!result.semantic.budgetExceeded, `${q.id}: semantic budget exceeded`);
    const concepts = semanticCoverageQueries(q.query);
    const poolPaths = result.coverageHits.map((h) => h.path);
    const poolScores = index && result.coverage.coverageMode !== "lexical" ? await index.assessCoverage(concepts, poolPaths) : [];
    const allScores = index ? await index.assessCoverage(concepts, allPaths) : [];
    const signals = createRetrievalEvidenceSignals(q.query);
    const assess = (scores: readonly SemanticCoverageScore[]) => assessRetrievalCoverage({ query: q.query, hits: result.coverageHits,
      displayHits: result.hits, evidenceSignals: signals, graphResult: result.graphResult, coverageMode: result.coverage.coverageMode, semanticScores: scores });
    // The sweep is valid only if the default thresholds reproduce the runtime decision.
    const check = assess(shifted(poolScores, DEFAULTS));
    assert.deepEqual([check.sufficient, check.evidenceGaps], [result.coverage.sufficient, result.coverage.evidenceGaps], `${q.id}: recomputed coverage differs`);
    // Same pool without semantic scores: the decision the lexical signals alone would take.
    const lexicalOnly = assess([]);
    const relevant = new Set(q.relevant.map((r) => r.path));
    const nonRelevant = new Set(allPaths.filter((p) => !relevant.has(p)));
    const poolSignals = new Set(result.coverageHits.flatMap((h) => [...signals(h)]));
    const entities = extractQueryEntities(q.query);
    const poolRecall = recallAtK(result.coverageHits, q.relevant, poolPaths.length);
    const retrieval = !q.answerable ? "n/a" as const : poolRecall === 0 ? "miss" as const : poolRecall < 1 ? "partial" as const : "complete" as const;
    const conceptRows: Concept[] = concepts.map((c) => {
      const kind = kindOf(c.id), position = Number(c.id.slice(c.id.indexOf(":") + 1));
      return { id: c.id, kind, text: c.text,
        lexicalInPool: kind === "facet" ? poolSignals.has(`facet:${c.text}`) : kind === "entity" ? poolSignals.has(`entity:${entities[position]}`) : undefined,
        poolMax: poolScores.length ? maxScore(poolScores.find((s) => s.id === c.id)) : undefined,
        relevantMax: allScores.length && relevant.size ? maxScore(allScores.find((s) => s.id === c.id), relevant) : undefined,
        nonRelevantMax: allScores.length ? maxScore(allScores.find((s) => s.id === c.id), nonRelevant) : undefined };
    });
    const rerankScores = result.coverageHits.flatMap((hit) => hit.channels.rerankScore === undefined ? [] : [hit.channels.rerankScore]);
    rows.push({ id: q.id, split: q.split, category: q.category, group: q.group, language: q.language, query: q.query, originalQuery: q.originalQuery,
      answerable: q.answerable, retrieval, evidenceRetrieved: q.answerable && poolRecall > 0,
      sufficient: result.coverage.sufficient, coverageMode: result.coverage.coverageMode, gaps: result.coverage.evidenceGaps,
      queryFacetCoverage: result.coverage.queryFacetCoverage, poolSize: poolPaths.length, poolRecall,
      semanticChangedDecision: lexicalOnly.sufficient !== result.coverage.sufficient,
      semanticChangedGaps: JSON.stringify(lexicalOnly.evidenceGaps) !== JSON.stringify(result.coverage.evidenceGaps),
      conceptsOverThreshold: conceptRows.filter((c) => c.poolMax !== undefined && c.poolMax >= DEFAULTS[c.kind])
        .map((c) => ({ text: c.text, kind: c.kind, score: c.poolMax!, lexicalInPool: c.lexicalInPool })),
      coherence: measureEvidenceCoherence(q.query, result.coverageHits),
      rerank: {
        maxScore: rerankScores.length ? Math.max(...rerankScores) : null,
        scoredCandidates: rerankScores.length,
      },
      concepts: conceptRows, recompute: (t) => assess(shifted(poolScores, t)).sufficient });
  }

  // Two labels: `answerable` (the answer exists in the corpus, end to end) and
  // `evidenceRetrieved` (a judged relevant page is in the pool the decision can see).
  // A gap after a retrieval miss is a retrieval error, not a sufficiency error.
  const rates = (items: readonly Row[], positive: (r: Row) => boolean, decide: (r: Row) => boolean) => {
    const c = { positives: 0, negatives: 0, tp: 0, fn: 0, tn: 0, fp: 0 };
    for (const r of items) {
      const s = decide(r);
      if (positive(r)) { c.positives++; if (s) c.tp++; else c.fn++; } else { c.negatives++; if (s) c.fp++; else c.tn++; }
    }
    const falseGapRate = c.positives ? c.fn / c.positives : null, falseSufficientRate = c.negatives ? c.fp / c.negatives : null;
    return { ...c, accuracy: items.length ? (c.tp + c.tn) / items.length : null, falseGapRate, falseSufficientRate,
      balancedAccuracy: falseGapRate === null || falseSufficientRate === null ? null : 1 - (falseGapRate + falseSufficientRate) / 2 };
  };
  const endToEnd = (r: Row) => r.answerable, onEvidence = (r: Row) => r.evidenceRetrieved;
  const splits = ["development", "inspected-regression", "holdout"];
  const scopes: Record<string, (r: Row) => boolean> = {
    all: () => true, ...Object.fromEntries(splits.map((s) => [s, (r: Row) => r.split === s])),
    "original-100": (r) => r.group !== "absent-indomain", "language-it": (r) => r.language === "it", "language-en": (r) => r.language === "en",
  };
  const summarize = (decide: (r: Row) => boolean) => Object.fromEntries(Object.entries(scopes).map(([name, filter]) => {
    const items = rows.filter(filter);
    return [name, { endToEnd: rates(items, endToEnd, decide), onRetrievedEvidence: rates(items, onEvidence, decide) }];
  }));
  const groups = Object.fromEntries(["answerable", "absent-offdomain", "absent-indomain"].map((g) => {
    const items = rows.filter((r) => r.group === g);
    return [g, { count: items.length, sufficient: items.filter((r) => r.sufficient).length,
      retrieval: g === "answerable" ? Object.fromEntries(["complete", "partial", "miss"].map((k) => [k, items.filter((r) => r.retrieval === k).length])) : undefined,
      sufficientByRetrieval: g === "answerable" ? Object.fromEntries(["complete", "partial", "miss"].map((k) => [k, items.filter((r) => r.retrieval === k && r.sufficient).length])) : undefined }];
  }));
  const gapCounter = (items: readonly Row[]) => {
    const counts: Record<string, number> = {};
    for (const r of items) for (const g of r.gaps) { const key = g.startsWith("entity:") ? "entity" : g; counts[key] = (counts[key] ?? 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };
  // Sufficiency errors: evidence was retrieved but a gap was declared, or nothing relevant was retrieved and sufficiency was declared.
  const falseGaps = rows.filter((r) => r.evidenceRetrieved && !r.sufficient);
  const falseSufficient = rows.filter((r) => !r.evidenceRetrieved && r.sufficient);
  const entityGaps: Record<string, number> = {};
  for (const r of falseGaps) for (const g of r.gaps) if (g.startsWith("entity:")) entityGaps[g.slice(7)] = (entityGaps[g.slice(7)] ?? 0) + 1;
  const onlyReason = (reason: (g: string) => boolean) => falseGaps.filter((r) => r.gaps.every(reason)).length;

  // Exact threshold sensitivity. Selection maximizes balanced accuracy on retrieved evidence in
  // the development split only; ties prefer higher (stricter) thresholds.
  let sweep: unknown = undefined;
  if (index) {
    const grid: Array<{ facet: number; entity: number; perScope: Record<string, ReturnType<typeof rates>> }> = [];
    const points: Array<{ facet: number; entity: number }> = [{ facet: DEFAULTS.facet, entity: DEFAULTS.entity }];
    for (let facet = 0.3; facet <= 0.9001; facet += 0.05) for (let entity = 0.3; entity <= 0.9001; entity += 0.05) {
      points.push({ facet: Number(facet.toFixed(2)), entity: Number(entity.toFixed(2)) });
    }
    for (const point of points) {
      const t = { ...point, type: DEFAULTS.type };
      const decided = new Map(rows.map((r) => [r.id, r.recompute(t)]));
      grid.push({ ...t, perScope: Object.fromEntries(Object.entries(scopes).map(([name, filter]) => [name, rates(rows.filter(filter), onEvidence, (r) => decided.get(r.id)!)])) });
    }
    const dev = (g: typeof grid[number]) => g.perScope.development!.balancedAccuracy ?? -1;
    const best = [...grid].sort((a, b) => dev(b) - dev(a) || b.facet - a.facet || b.entity - a.entity)[0]!;
    sweep = { objective: "development balanced accuracy on retrieved evidence", selected: best,
      defaults: grid.find((g) => g.facet === DEFAULTS.facet && g.entity === DEFAULTS.entity) ?? null, grid };
  }
  const percentiles = (values: number[]) => { const v = [...values].sort((a, b) => a - b); const at = (p: number) => v[Math.max(0, Math.ceil(v.length * p) - 1)];
    return v.length ? { n: v.length, p10: at(0.1), p50: at(0.5), p90: at(0.9), max: v[v.length - 1] } : { n: 0 }; };
  const facetScores = index ? {
    retrievedUnmatchedFacetRelevantMax: percentiles(rows.filter((r) => r.evidenceRetrieved).flatMap((r) => r.concepts.filter((c) => c.kind === "facet" && !c.lexicalInPool).map((c) => c.relevantMax!))),
    offdomainFacetPoolMax: percentiles(rows.filter((r) => r.group === "absent-offdomain").flatMap((r) => r.concepts.filter((c) => c.kind === "facet").map((c) => c.poolMax ?? -1))),
    indomainNegativeFacetPoolMax: percentiles(rows.filter((r) => r.group === "absent-indomain").flatMap((r) => r.concepts.filter((c) => c.kind === "facet").map((c) => c.poolMax ?? -1))),
    retrievedUnmatchedEntityRelevantMax: percentiles(rows.filter((r) => r.evidenceRetrieved).flatMap((r) => r.concepts.filter((c) => c.kind === "entity" && !c.lexicalInPool).map((c) => c.relevantMax!))),
  } : undefined;

  const sources = ["benchmarks/fixtures/semantic-rescoring-292.json", "benchmarks/fixtures/retrieval-extension-292.json", "benchmarks/fixtures/coverage-diagnostics-292.json"];
  const report = { generatedAt: new Date().toISOString(), provider: provider?.descriptor ?? "lexical", label, translated: translate,
    fixtures: Object.fromEntries(await Promise.all(sources.map(async (s) => [s, createHash("sha256").update(await fs.readFile(s)).digest("hex")] as const))),
    settings: { maxResults: 8, rerankPoolSize, reranker: configuredReranker()?.descriptor,
      progressiveWidening: false, budget: { maxEvidence: 8, tokenBudget: 4000 }, thresholds: DEFAULTS },
    groups, summary: summarize((r) => r.sufficient),
    meanPoolRecallAnswerable: mean(rows.filter((r) => r.answerable).map((r) => r.poolRecall)),
    semanticContribution: { changedDecisions: rows.filter((r) => r.semanticChangedDecision).map((r) => r.id), changedGaps: rows.filter((r) => r.semanticChangedGaps).map((r) => r.id),
      conceptsOverThreshold: rows.flatMap((r) => r.conceptsOverThreshold.map((c) => ({ id: r.id, ...c }))) },
    falseGapReasons: gapCounter(falseGaps), falseGapsOnlyEntity: onlyReason((g) => g.startsWith("entity:")),
    falseGapsOnlyFacets: onlyReason((g) => g === "query_facets" || g === "passage_evidence"),
    falseGapEntities: Object.entries(entityGaps).sort((a, b) => b[1] - a[1]),
    falseSufficient: falseSufficient.map((r) => ({ id: r.id, group: r.group, retrieval: r.retrieval })),
    facetScores, sweep, rows: rows.map(({ recompute: _, ...r }) => r) };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
  const { rows: _rows, sweep: sweepOut, ...brief } = report;
  const compactSweep = sweepOut as { selected: unknown; defaults: unknown } | undefined;
  console.log(JSON.stringify({ ...brief, sweep: compactSweep && { selected: compactSweep.selected, defaults: compactSweep.defaults } }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
