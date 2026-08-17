import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import {
  retrieveWikiHybrid,
  type HybridRetrievalAttempt,
  type RetrievalBudget,
  type RetrievalCoverage,
  type RetrievalCoverageRequirements,
  type RetrievalWideningLevel,
} from "../src/core/hybrid-retrieval.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import { mean } from "./retrieval-metrics.js";
import {
  asEvaluationHits,
  loadHybridFixture,
  materializeHybridFixture,
  qualityMetrics,
  recoveredEvidenceIds,
  type HybridGoldenQuery,
  type RetrievalQualityMetrics,
} from "./hybrid-retrieval-quality-eval.js";

type Difficulty = "easy" | "difficult";

interface WideningQueryConfig {
  id: string;
  difficulty: Difficulty;
  query?: string;
  initialBudget?: Partial<RetrievalBudget>;
  coverageRequirements?: RetrievalCoverageRequirements;
  minimumWideningLevel?: RetrievalWideningLevel;
  minimumFinalGraphDepth?: number;
}

interface ProgressiveFixture {
  version: number;
  baseFixture: string;
  initialBudget: RetrievalBudget;
  maximumBudget: RetrievalBudget;
  queries: WideningQueryConfig[];
}

export interface ProgressiveQueryReport {
  id: string;
  difficulty: Difficulty;
  query: string;
  initialCoverage: RetrievalCoverage;
  finalCoverage: RetrievalCoverage;
  initialRecoveredEvidence: string[];
  finalRecoveredEvidence: string[];
  lostRelevantInitially: string[];
  lostRelevantAfterWidening: string[];
  wideningLevel: RetrievalWideningLevel;
  initialBudgetSuccess: boolean;
  finalQuality: RetrievalQualityMetrics;
  contextTokensAfterWidening: number;
  elapsedMs: number;
  graphNodeCount: number;
  attempts: HybridRetrievalAttempt[];
}

export interface ProgressiveWideningMetrics extends RetrievalQualityMetrics {
  initialBudgetSuccessRate: number;
  wideningRate: number;
  averageWideningLevel: number;
  oracleRecallAfterWidening: number;
  contextTokensAfterWidening: number;
  lostRelevantAfterWidening: number;
  easyW0Rate: number;
  difficultWideningRate: number;
  fullGraphScanAttempts: number;
  w3FallbackRate: number;
  meanTotalVisitedNodes: number;
}

export interface ProgressiveWideningReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  baseFixture: string;
  pageCount: number;
  queryCount: number;
  evidenceCount: number;
  initialBudget: RetrievalBudget;
  maximumBudget: RetrievalBudget;
  metrics: ProgressiveWideningMetrics;
  queries: ProgressiveQueryReport[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROGRESSIVE_FIXTURE = path.join(
  HERE,
  "fixtures",
  "progressive-widening-golden.json"
);

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function mergeBudget(base: RetrievalBudget, override?: Partial<RetrievalBudget>): RetrievalBudget {
  return { ...base, ...override };
}

function aggregateSubsetRecall(
  reports: readonly ProgressiveQueryReport[],
  goldenById: ReadonlyMap<string, HybridGoldenQuery>,
  predicate: (evidence: HybridGoldenQuery["relevant"][number]) => boolean
): number {
  let expected = 0;
  let recovered = 0;
  for (const report of reports) {
    const recoveredIds = new Set(report.finalRecoveredEvidence);
    for (const evidence of goldenById.get(report.id)?.relevant.filter(predicate) ?? []) {
      expected++;
      if (recoveredIds.has(evidence.id)) recovered++;
    }
  }
  return expected === 0 ? 1 : recovered / expected;
}

export async function evaluateProgressiveWidening(
  fixturePath = DEFAULT_PROGRESSIVE_FIXTURE
): Promise<ProgressiveWideningReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as ProgressiveFixture;
  const baseFixturePath = path.resolve(path.dirname(fixturePath), fixture.baseFixture);
  const baseFixture = await loadHybridFixture(baseFixturePath);
  const goldenById = new Map(baseFixture.queries.map((query) => [query.id, query] as const));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-progressive-widening-"));
  const wikiRoot = path.join(root, "wiki");
  const reports: ProgressiveQueryReport[] = [];

  try {
    const pageCount = await materializeHybridFixture(wikiRoot, baseFixture);
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    process.stdout.write(
      `Progressive widening dataset: ${pageCount} pages, ${fixture.queries.length} queries\n`
    );

    for (const config of fixture.queries) {
      const golden = goldenById.get(config.id);
      if (!golden) throw new Error(`Unknown base golden query: ${config.id}.`);
      const query = config.query ?? golden.query;
      const evaluationQuery: HybridGoldenQuery = { ...golden, query };
      const initialBudget = mergeBudget(fixture.initialBudget, config.initialBudget);
      const common = {
        wikiRoot,
        query,
        maxResults: baseFixture.k,
        lexicalPoolSize: baseFixture.k,
        profile: "balanced" as const,
        initialBudget,
        maximumBudget: fixture.maximumBudget,
        coverageRequirements: config.coverageRequirements,
      };
      const initial = await retrieveWikiHybrid({
        ...common,
        progressiveWidening: false,
      });
      const startedAt = performance.now();
      const final = await retrieveWikiHybrid({
        ...common,
        progressiveWidening: true,
      });
      const elapsedMs = performance.now() - startedAt;
      const initialRecovered = recoveredEvidenceIds(
        asEvaluationHits(initial.hits),
        evaluationQuery.relevant,
        baseFixture.k
      );
      const finalRecovered = recoveredEvidenceIds(
        asEvaluationHits(final.hits),
        evaluationQuery.relevant,
        baseFixture.k
      );
      const expectedIds = evaluationQuery.relevant.map((evidence) => evidence.id);
      const lostInitially = expectedIds.filter((id) => !initialRecovered.has(id));
      const lostAfter = expectedIds.filter((id) => !finalRecovered.has(id));
      const report: ProgressiveQueryReport = {
        id: config.id,
        difficulty: config.difficulty,
        query,
        initialCoverage: initial.coverage,
        finalCoverage: final.coverage,
        initialRecoveredEvidence: [...initialRecovered].sort(),
        finalRecoveredEvidence: [...finalRecovered].sort(),
        lostRelevantInitially: lostInitially.sort(),
        lostRelevantAfterWidening: lostAfter.sort(),
        wideningLevel: final.wideningLevel,
        initialBudgetSuccess: initial.coverage.displaySufficient && lostInitially.length === 0,
        finalQuality: qualityMetrics(
          asEvaluationHits(final.hits),
          evaluationQuery,
          baseFixture.k
        ),
        contextTokensAfterWidening: final.estimatedContextTokens,
        elapsedMs,
        graphNodeCount: final.graphResult.graph.nodes.length,
        attempts: final.attempts,
      };
      reports.push(report);
      process.stdout.write(
        `${config.id.padEnd(24)} ${config.difficulty.padEnd(9)} ` +
        `W${report.wideningLevel} initialLost=${lostInitially.length} finalLost=${lostAfter.length} ` +
        `tokens=${report.contextTokensAfterWidening} ` +
        `gaps=${report.finalCoverage.evidenceGaps.join(",") || "none"}\n`
      );
    }

    const qualities = reports.map((report) => report.finalQuality);
    const easy = reports.filter((report) => report.difficulty === "easy");
    const difficult = reports.filter((report) => report.difficulty === "difficult");
    const recoveredEvidenceCount = reports.reduce(
      (sum, report) => sum + report.finalRecoveredEvidence.length,
      0
    );
    const evidenceCount = fixture.queries.reduce(
      (sum, config) => sum + (goldenById.get(config.id)?.relevant.length ?? 0),
      0
    );
    const fullGraphScanAttempts = reports.reduce((count, report) =>
      count + report.attempts.filter((attempt) => attempt.visitedNodes >= report.graphNodeCount).length,
    0);
    const metrics: ProgressiveWideningMetrics = {
      candidateRecallAtK: mean(qualities.map((quality) => quality.candidateRecallAtK)),
      evidenceRecallAtK: mean(qualities.map((quality) => quality.evidenceRecallAtK)),
      passageRecallAtK: mean(qualities.map((quality) => quality.passageRecallAtK)),
      mrr: mean(qualities.map((quality) => quality.mrr)),
      ndcgAtK: mean(qualities.map((quality) => quality.ndcgAtK)),
      graphOnlyRecoveryRate: aggregateSubsetRecall(
        reports,
        goldenById,
        (evidence) => Boolean(evidence.graphOnly)
      ),
      multiHopRecall: aggregateSubsetRecall(
        reports,
        goldenById,
        (evidence) => (evidence.hop ?? 0) >= 2
      ),
      sourceCoverageRecall: mean(qualities.map((quality) => quality.sourceCoverageRecall)),
      initialBudgetSuccessRate: reports.filter((report) => report.initialBudgetSuccess).length / reports.length,
      wideningRate: reports.filter((report) => report.wideningLevel > 0).length / reports.length,
      averageWideningLevel: mean(reports.map((report) => report.wideningLevel)),
      oracleRecallAfterWidening: evidenceCount === 0 ? 1 : recoveredEvidenceCount / evidenceCount,
      contextTokensAfterWidening: mean(
        reports.map((report) => report.contextTokensAfterWidening)
      ),
      lostRelevantAfterWidening: reports.reduce(
        (sum, report) => sum + report.lostRelevantAfterWidening.length,
        0
      ),
      easyW0Rate: easy.length === 0
        ? 1
        : easy.filter((report) => report.wideningLevel === 0).length / easy.length,
      difficultWideningRate: difficult.length === 0
        ? 1
        : difficult.filter((report) => report.wideningLevel > 0).length / difficult.length,
      fullGraphScanAttempts,
      w3FallbackRate: reports.filter((report) => report.wideningLevel === 3).length / reports.length,
      meanTotalVisitedNodes: mean(reports.map((report) =>
        report.attempts.reduce((sum, attempt) => sum + attempt.visitedNodes, 0)
      )),
    };
    process.stdout.write(
      `SUMMARY initialBudgetSuccessRate=${metrics.initialBudgetSuccessRate.toFixed(4)} ` +
      `wideningRate=${metrics.wideningRate.toFixed(4)} ` +
      `averageWideningLevel=${metrics.averageWideningLevel.toFixed(4)} ` +
      `oracleRecallAfterWidening=${metrics.oracleRecallAfterWidening.toFixed(4)} ` +
      `contextTokensAfterWidening=${metrics.contextTokensAfterWidening.toFixed(2)} ` +
      `lostRelevantAfterWidening=${metrics.lostRelevantAfterWidening}\n`
    );

    return {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      baseFixture: path.relative(process.cwd(), baseFixturePath).replace(/\\/g, "/"),
      pageCount,
      queryCount: fixture.queries.length,
      evidenceCount,
      initialBudget: fixture.initialBudget,
      maximumBudget: fixture.maximumBudget,
      metrics,
      queries: reports,
    };
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_PROGRESSIVE_FIXTURE);
  const report = await evaluateProgressiveWidening(fixturePath);
  const outputPath = argValue("json");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`JSON written to ${resolved}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
