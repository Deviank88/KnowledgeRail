import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import {
  clearRuntimeWikiGraphs,
  expandRuntimeGraphFromSeeds,
  getRuntimeWikiGraph,
} from "../src/core/graph-runtime.js";
import {
  retrieveWikiHybrid,
  type HybridRetrievalHit,
} from "../src/core/hybrid-retrieval.js";
import {
  clearRetrievalIndexes,
  searchRetrievalIndex,
  type RetrievalHit,
} from "../src/core/retrieval-index.js";
import {
  mean,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  type GradedRelevant,
} from "./retrieval-metrics.js";

interface GoldenPage {
  path: string;
  title: string;
  type: string;
  requestId?: string;
  tags: string[];
  sources: string[];
  body: string;
}

interface GeneratedPages {
  count: number;
  pathPattern: string;
  titlePattern: string;
  type: string;
  tags: string[];
  sources: string[];
  bodyPattern: string;
}

export interface GoldenEvidence extends GradedRelevant {
  id: string;
  heading: string;
  match: string;
  source: string;
  graphOnly?: boolean;
  hop?: number;
}

export interface HybridGoldenQuery {
  id: string;
  case: string;
  query: string;
  critical?: boolean;
  anchorPaths: string[];
  relevant: GoldenEvidence[];
}

interface BoundedBudget {
  lexicalPoolSize: number;
  seedCount: number;
  graphMaxNodes: number;
  graphMaxDepth: number;
  graphBeamWidth: number;
  graphMaxVisitedNodes: number;
}

export interface HybridGoldenFixture {
  version: number;
  k: number;
  boundedBudget: BoundedBudget;
  pages: GoldenPage[];
  generatedPages?: GeneratedPages[];
  queries: HybridGoldenQuery[];
}

export interface EvaluationHit {
  path: string;
  heading: string;
  excerpt: string;
}

export interface RetrievalQualityMetrics {
  candidateRecallAtK: number;
  evidenceRecallAtK: number;
  passageRecallAtK: number;
  mrr: number;
  ndcgAtK: number;
  graphOnlyRecoveryRate: number;
  multiHopRecall: number;
  sourceCoverageRecall: number;
}

export interface QueryEvaluation {
  id: string;
  case: string;
  critical: boolean;
  lexical: RetrievalQualityMetrics;
  bounded: RetrievalQualityMetrics;
  oracle: RetrievalQualityMetrics;
  lexicalRecoveredEvidence: string[];
  boundedRecoveredEvidence: string[];
  oracleRecoveredEvidence: string[];
  lostRelevantByPruning: string[];
  topPaths: {
    lexical: string[];
    bounded: string[];
    oracle: string[];
  };
  cost: {
    lexicalMs: number;
    boundedMs: number;
    lexicalCandidates: number;
    boundedLexicalPool: number;
    boundedVisitedNodes: number;
    boundedVisitedEdges: number;
    oracleVisitedNodes: number;
    oracleVisitedEdges: number;
  };
}

export interface AggregateEvaluation extends RetrievalQualityMetrics {
  lostRelevantByPruning: number;
  criticalLostRelevantByPruning: number;
  meanLexicalMs: number;
  meanBoundedMs: number;
  meanBoundedVisitedNodes: number;
  meanBoundedVisitedEdges: number;
}

export interface HybridEvaluationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  pageCount: number;
  queryCount: number;
  k: number;
  boundedBudget: BoundedBudget;
  lexical: AggregateEvaluation;
  bounded: AggregateEvaluation;
  oracle: AggregateEvaluation;
  queries: QueryEvaluation[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HYBRID_FIXTURE = path.join(HERE, "fixtures", "hybrid-retrieval-golden.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

function generatedValue(pattern: string, index: number): string {
  return pattern.replaceAll("{index}", String(index).padStart(2, "0"));
}

export function expandedHybridPages(fixture: HybridGoldenFixture): GoldenPage[] {
  const generated = (fixture.generatedPages ?? []).flatMap((template) =>
    Array.from({ length: template.count }, (_, index) => ({
      path: generatedValue(template.pathPattern, index),
      title: generatedValue(template.titlePattern, index),
      type: template.type,
      tags: template.tags,
      sources: template.sources,
      body: generatedValue(template.bodyPattern, index),
    }))
  );
  return [...fixture.pages, ...generated];
}

export async function loadHybridFixture(
  fixturePath = DEFAULT_HYBRID_FIXTURE
): Promise<HybridGoldenFixture> {
  return JSON.parse(await fs.readFile(fixturePath, "utf-8")) as HybridGoldenFixture;
}

export async function materializeHybridFixture(
  root: string,
  fixture: HybridGoldenFixture
): Promise<number> {
  const pages = expandedHybridPages(fixture);
  for (const page of pages) {
    const absolute = path.join(root, page.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(
      absolute,
      [
        "---",
        `title: ${JSON.stringify(page.title)}`,
        `type: ${page.type}`,
        `tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
        `sources: [${page.sources.map((source) => JSON.stringify(source)).join(", ")}]`,
        ...(page.requestId ? [`request_id: ${JSON.stringify(page.requestId)}`] : []),
        "created: 2026-08-13",
        "updated: 2026-08-13",
        "---",
        "",
        page.body,
      ].join("\n"),
      "utf-8"
    );
  }
  return pages.length;
}

function relevantPaths(relevant: readonly GoldenEvidence[]): GradedRelevant[] {
  const grades = new Map<string, number>();
  for (const evidence of relevant) {
    grades.set(evidence.path, Math.max(grades.get(evidence.path) ?? 0, evidence.grade ?? 1));
  }
  return [...grades].map(([path, grade]) => ({ path, grade }));
}

export function recoveredEvidenceIds(
  hits: readonly EvaluationHit[],
  relevant: readonly GoldenEvidence[],
  k: number
): Set<string> {
  const top = hits.slice(0, k);
  return new Set(relevant.filter((evidence) => {
    const hit = top.find((candidate) => candidate.path === evidence.path);
    return Boolean(hit && normalize(hit.excerpt).includes(normalize(evidence.match)));
  }).map((evidence) => evidence.id));
}

function recoveredPassageIds(
  hits: readonly EvaluationHit[],
  relevant: readonly GoldenEvidence[],
  k: number
): Set<string> {
  const top = hits.slice(0, k);
  return new Set(relevant.filter((evidence) => {
    const hit = top.find((candidate) => candidate.path === evidence.path);
    return Boolean(hit && normalize(hit.heading) === normalize(evidence.heading));
  }).map((evidence) => evidence.id));
}

function ratio(recovered: ReadonlySet<string>, expected: readonly GoldenEvidence[]): number {
  return expected.length === 0 ? 1 : recovered.size / expected.length;
}

function subsetRatio(recovered: ReadonlySet<string>, expected: readonly GoldenEvidence[]): number {
  return expected.length === 0
    ? 1
    : expected.filter((item) => recovered.has(item.id)).length / expected.length;
}

export function qualityMetrics(
  hits: readonly EvaluationHit[],
  query: HybridGoldenQuery,
  k: number,
  overrides: {
    evidence?: ReadonlySet<string>;
    passages?: ReadonlySet<string>;
  } = {}
): RetrievalQualityMetrics {
  const evidence = overrides.evidence ?? recoveredEvidenceIds(hits, query.relevant, k);
  const passages = overrides.passages ?? recoveredPassageIds(hits, query.relevant, k);
  const graphOnly = query.relevant.filter((item) => item.graphOnly);
  const multiHop = query.relevant.filter((item) => (item.hop ?? 0) >= 2);
  const expectedSources = new Set(query.relevant.map((item) => item.source));
  const recoveredSources = new Set(
    query.relevant.filter((item) => evidence.has(item.id)).map((item) => item.source)
  );
  return {
    candidateRecallAtK: recallAtK(hits, relevantPaths(query.relevant), k),
    evidenceRecallAtK: ratio(evidence, query.relevant),
    passageRecallAtK: ratio(passages, query.relevant),
    mrr: reciprocalRank(hits, relevantPaths(query.relevant)),
    ndcgAtK: ndcgAtK(hits, relevantPaths(query.relevant), k),
    graphOnlyRecoveryRate: subsetRatio(evidence, graphOnly),
    multiHopRecall: subsetRatio(evidence, multiHop),
    sourceCoverageRecall: expectedSources.size === 0 ? 1 : recoveredSources.size / expectedSources.size,
  };
}

export function asEvaluationHits(
  hits: readonly (RetrievalHit | HybridRetrievalHit)[]
): EvaluationHit[] {
  return hits.map((hit) => ({ path: hit.path, heading: hit.heading, excerpt: hit.excerpt }));
}

async function oracleHits(
  wikiRoot: string,
  fixture: HybridGoldenFixture,
  query: HybridGoldenQuery
): Promise<{
  hits: EvaluationHit[];
  evidence: Set<string>;
  passages: Set<string>;
  visitedNodes: number;
  visitedEdges: number;
}> {
  const pageCount = expandedHybridPages(fixture).length;
  const lexical = await searchRetrievalIndex({
    wikiRoot,
    query: query.query,
    maxResults: pageCount,
    profile: "coverage",
  });
  const runtime = await getRuntimeWikiGraph(wikiRoot);
  const seedPaths = [...new Set([...lexical.map((hit) => hit.path), ...query.anchorPaths])];
  const seedNodeIds = seedPaths
    .map((pagePath) => runtime.pageNodeByPath.get(pagePath))
    .filter((nodeId): nodeId is string => Boolean(nodeId));
  const maxLexicalScore = Math.max(lexical[0]?.score ?? 0, 1e-9);
  const scoresByPath = new Map(lexical.map((hit) => [hit.path, hit.score / maxLexicalScore] as const));
  const seedScores = new Map(seedNodeIds.map((nodeId) => {
    const nodePath = runtime.nodesById.get(nodeId)?.path ?? "";
    return [nodeId, Math.max(scoresByPath.get(nodePath) ?? 0, 1)] as const;
  }));
  const graph = expandRuntimeGraphFromSeeds(runtime, {
    seedNodeIds,
    seedScores,
    maxNodes: runtime.graph.nodes.length,
    maxDepth: runtime.graph.nodes.length,
    beamWidth: runtime.graph.nodes.length,
    maxVisitedNodes: runtime.graph.nodes.length,
    hubPenalty: false,
  });

  const records = new Map(lexical.map((hit) => [hit.path, hit.record] as const));
  const rankedRelevant = [...query.relevant]
    .sort((a, b) => (b.grade ?? 1) - (a.grade ?? 1) || a.path.localeCompare(b.path))
    .map((item) => item.path);
  const rankedPaths = [...new Set([
    ...rankedRelevant,
    ...query.anchorPaths,
    ...lexical.map((hit) => hit.path),
    ...graph.nodes.filter((node) => node.kind === "page" && node.path).map((node) => node.path!),
  ])];
  const relevantByPath = new Map<string, GoldenEvidence>();
  for (const evidence of [...query.relevant].sort((a, b) => (b.grade ?? 1) - (a.grade ?? 1))) {
    if (!relevantByPath.has(evidence.path)) relevantByPath.set(evidence.path, evidence);
  }
  const hits: EvaluationHit[] = rankedPaths.map((pagePath) => {
    const lexicalHit = lexical.find((hit) => hit.path === pagePath);
    if (lexicalHit) return asEvaluationHits([lexicalHit])[0]!;
    const expected = relevantByPath.get(pagePath);
    const record = records.get(pagePath);
    const passage = record?.passages.find((item) => item.heading === expected?.heading);
    return {
      path: pagePath,
      heading: expected?.heading ?? passage?.heading ?? "",
      excerpt: expected?.match ?? passage?.text ?? "",
    };
  });

  return {
    hits,
    evidence: new Set(query.relevant.map((item) => item.id)),
    passages: new Set(query.relevant.map((item) => item.id)),
    visitedNodes: graph.stats.visitedNodes,
    visitedEdges: graph.stats.visitedEdges,
  };
}

function emptyAggregate(): AggregateEvaluation {
  return {
    candidateRecallAtK: 0,
    evidenceRecallAtK: 0,
    passageRecallAtK: 0,
    mrr: 0,
    ndcgAtK: 0,
    graphOnlyRecoveryRate: 0,
    multiHopRecall: 0,
    sourceCoverageRecall: 0,
    lostRelevantByPruning: 0,
    criticalLostRelevantByPruning: 0,
    meanLexicalMs: 0,
    meanBoundedMs: 0,
    meanBoundedVisitedNodes: 0,
    meanBoundedVisitedEdges: 0,
  };
}

function aggregate(
  queries: readonly QueryEvaluation[],
  goldenQueries: readonly HybridGoldenQuery[],
  channel: "lexical" | "bounded" | "oracle"
): AggregateEvaluation {
  if (queries.length === 0) return emptyAggregate();
  const metrics = queries.map((query) => query[channel]);
  const goldenById = new Map(goldenQueries.map((query) => [query.id, query] as const));
  const aggregateMetrics: AggregateEvaluation = {
    candidateRecallAtK: mean(metrics.map((item) => item.candidateRecallAtK)),
    evidenceRecallAtK: mean(metrics.map((item) => item.evidenceRecallAtK)),
    passageRecallAtK: mean(metrics.map((item) => item.passageRecallAtK)),
    mrr: mean(metrics.map((item) => item.mrr)),
    ndcgAtK: mean(metrics.map((item) => item.ndcgAtK)),
    graphOnlyRecoveryRate: mean(metrics.map((item) => item.graphOnlyRecoveryRate)),
    multiHopRecall: mean(metrics.map((item) => item.multiHopRecall)),
    sourceCoverageRecall: mean(metrics.map((item) => item.sourceCoverageRecall)),
    lostRelevantByPruning: channel === "bounded"
      ? queries.reduce((sum, query) => sum + query.lostRelevantByPruning.length, 0)
      : 0,
    criticalLostRelevantByPruning: channel === "bounded"
      ? queries.filter((query) => query.critical)
        .reduce((sum, query) => sum + query.lostRelevantByPruning.length, 0)
      : 0,
    meanLexicalMs: mean(queries.map((query) => query.cost.lexicalMs)),
    meanBoundedMs: mean(queries.map((query) => query.cost.boundedMs)),
    meanBoundedVisitedNodes: mean(queries.map((query) => query.cost.boundedVisitedNodes)),
    meanBoundedVisitedEdges: mean(queries.map((query) => query.cost.boundedVisitedEdges)),
  };

  const evidenceFor = (predicate: (item: GoldenEvidence) => boolean): [number, number] => {
    let recovered = 0;
    let expected = 0;
    for (const query of queries) {
      const recoveredIds = channel === "oracle"
        ? new Set(query.oracleRecoveredEvidence)
        : channel === "bounded"
          ? new Set(query.boundedRecoveredEvidence)
          : new Set(query.lexicalRecoveredEvidence);
      const relevant = goldenById.get(query.id)?.relevant ?? [];
      for (const evidence of relevant.filter(predicate)) {
        expected++;
        if (recoveredIds.has(evidence.id)) recovered++;
      }
    }
    return [recovered, expected];
  };
  const [graphRecovered, graphExpected] = evidenceFor((item) => Boolean(item.graphOnly));
  const [hopRecovered, hopExpected] = evidenceFor((item) => (item.hop ?? 0) >= 2);
  aggregateMetrics.graphOnlyRecoveryRate = graphExpected === 0 ? 1 : graphRecovered / graphExpected;
  aggregateMetrics.multiHopRecall = hopExpected === 0 ? 1 : hopRecovered / hopExpected;
  return aggregateMetrics;
}

export async function evaluateHybridFixture(
  fixturePath = DEFAULT_HYBRID_FIXTURE
): Promise<HybridEvaluationReport> {
  const fixture = await loadHybridFixture(fixturePath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-oracle-"));
  const wikiRoot = path.join(root, "wiki");
  const queries: QueryEvaluation[] = [];

  try {
    const pageCount = await materializeHybridFixture(wikiRoot, fixture);
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);

    process.stdout.write(
      `Hybrid retrieval golden dataset: ${pageCount} pages, ${fixture.queries.length} queries, K=${fixture.k}\n`
    );
    for (const query of fixture.queries) {
      const lexicalStart = performance.now();
      const lexicalHits = await searchRetrievalIndex({
        wikiRoot,
        query: query.query,
        maxResults: fixture.k,
        profile: "balanced",
      });
      const lexicalMs = performance.now() - lexicalStart;

      const boundedStart = performance.now();
      const boundedResult = await retrieveWikiHybrid({
        wikiRoot,
        query: query.query,
        maxResults: fixture.k,
        profile: "balanced",
        progressiveWidening: false,
        ...fixture.boundedBudget,
      });
      const boundedMs = performance.now() - boundedStart;
      const oracle = await oracleHits(wikiRoot, fixture, query);
      const lexical = asEvaluationHits(lexicalHits);
      const bounded = asEvaluationHits(boundedResult.hits);
      const lexicalEvidence = recoveredEvidenceIds(lexical, query.relevant, fixture.k);
      const boundedEvidence = recoveredEvidenceIds(bounded, query.relevant, fixture.k);
      const oracleEvidence = oracle.evidence;
      const lostRelevantByPruning = [...oracleEvidence]
        .filter((evidenceId) => !boundedEvidence.has(evidenceId))
        .sort();
      const evaluation: QueryEvaluation = {
        id: query.id,
        case: query.case,
        critical: query.critical ?? false,
        lexical: qualityMetrics(lexical, query, fixture.k),
        bounded: qualityMetrics(bounded, query, fixture.k),
        oracle: qualityMetrics(oracle.hits, query, fixture.k, {
          evidence: oracle.evidence,
          passages: oracle.passages,
        }),
        lexicalRecoveredEvidence: [...lexicalEvidence].sort(),
        boundedRecoveredEvidence: [...boundedEvidence].sort(),
        oracleRecoveredEvidence: [...oracleEvidence].sort(),
        lostRelevantByPruning,
        topPaths: {
          lexical: lexical.slice(0, fixture.k).map((hit) => hit.path),
          bounded: bounded.slice(0, fixture.k).map((hit) => hit.path),
          oracle: oracle.hits.slice(0, fixture.k).map((hit) => hit.path),
        },
        cost: {
          lexicalMs,
          boundedMs,
          lexicalCandidates: lexicalHits.length,
          boundedLexicalPool: boundedResult.lexicalHits.length,
          boundedVisitedNodes: boundedResult.graphResult.stats.visitedNodes,
          boundedVisitedEdges: boundedResult.graphResult.stats.visitedEdges,
          oracleVisitedNodes: oracle.visitedNodes,
          oracleVisitedEdges: oracle.visitedEdges,
        },
      };
      queries.push(evaluation);
      process.stdout.write(
        `${query.id.padEnd(24)} ` +
        `lexical(E=${evaluation.lexical.evidenceRecallAtK.toFixed(3)},P=${evaluation.lexical.passageRecallAtK.toFixed(3)}) ` +
        `bounded(E=${evaluation.bounded.evidenceRecallAtK.toFixed(3)},P=${evaluation.bounded.passageRecallAtK.toFixed(3)}) ` +
        `oracle(E=${evaluation.oracle.evidenceRecallAtK.toFixed(3)}) ` +
        `lost=${lostRelevantByPruning.length} visited=${evaluation.cost.boundedVisitedNodes}\n`
      );
    }

    const report: HybridEvaluationReport = {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      pageCount,
      queryCount: fixture.queries.length,
      k: fixture.k,
      boundedBudget: fixture.boundedBudget,
      lexical: aggregate(queries, fixture.queries, "lexical"),
      bounded: aggregate(queries, fixture.queries, "bounded"),
      oracle: aggregate(queries, fixture.queries, "oracle"),
      queries,
    };
    process.stdout.write(
      `SUMMARY lexical CandidateRecall@K=${report.lexical.candidateRecallAtK.toFixed(4)} ` +
      `EvidenceRecall@K=${report.lexical.evidenceRecallAtK.toFixed(4)} ` +
      `PassageRecall@K=${report.lexical.passageRecallAtK.toFixed(4)} ` +
      `MRR=${report.lexical.mrr.toFixed(4)} NDCG@K=${report.lexical.ndcgAtK.toFixed(4)}\n`
    );
    process.stdout.write(
      `SUMMARY bounded CandidateRecall@K=${report.bounded.candidateRecallAtK.toFixed(4)} ` +
      `EvidenceRecall@K=${report.bounded.evidenceRecallAtK.toFixed(4)} ` +
      `PassageRecall@K=${report.bounded.passageRecallAtK.toFixed(4)} ` +
      `MRR=${report.bounded.mrr.toFixed(4)} NDCG@K=${report.bounded.ndcgAtK.toFixed(4)} ` +
      `GraphOnlyRecoveryRate=${report.bounded.graphOnlyRecoveryRate.toFixed(4)} ` +
      `MultiHopRecall=${report.bounded.multiHopRecall.toFixed(4)} ` +
      `SourceCoverageRecall=${report.bounded.sourceCoverageRecall.toFixed(4)} ` +
      `LostRelevantByPruning=${report.bounded.lostRelevantByPruning}\n`
    );
    return report;
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_HYBRID_FIXTURE);
  const report = await evaluateHybridFixture(fixturePath);
  const outputPath = argValue("json");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    process.stdout.write(`JSON written to ${resolved}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
