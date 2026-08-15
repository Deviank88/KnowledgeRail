import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { clearRetrievalIndexes, getWikiPageRecords } from "../src/core/retrieval-index.js";
import { PersistentSemanticIndex } from "../src/core/semantic/index.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";
import {
  loadHybridFixture,
  materializeHybridFixture,
  type HybridGoldenFixture,
} from "./hybrid-retrieval-quality-eval.js";

interface SemanticPage {
  concept: string;
  path: string;
  title: string;
  type: string;
  body: string;
}

interface SemanticOnlyQuery {
  id: string;
  concept: string;
  query: string;
  expectedPaths: string[];
}

interface SemanticGoldenFixture {
  version: number;
  baseFixture: string;
  semanticPages: SemanticPage[];
  semanticOnlyQueries: SemanticOnlyQuery[];
  exactIdentifierQueryId: string;
}

interface EvaluationQuery {
  id: string;
  category: "oracle" | "semantic-only";
  query: string;
  expectedPaths: string[];
}

export interface SemanticQueryReport {
  id: string;
  category: EvaluationQuery["category"];
  baselineRecall: number;
  semanticRecall: number;
  baselineRank: number;
  semanticRank: number;
  baselineContextTokens: number;
  semanticContextTokens: number;
  recallImproved: boolean;
  annCandidateCount: number;
  annVectorCount: number;
  annVisitedBuckets: number;
  baselineMs: number;
  semanticMs: number;
}

export interface SemanticRetrievalReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  baseFixtureVersion: number;
  queryIds: string[];
  exactIdentifierQueryId: string;
  provider: { id: string; model: string; version: string; dimensions: number };
  engine: ReturnType<typeof engineDescriptor>;
  metrics: {
    BaselineRecall: number;
    SemanticRecall: number;
    RecallDelta: number;
    SemanticOnlyBaselineRecall: number;
    SemanticOnlyRecall: number;
    SemanticOnlyImprovedCases: number;
    OracleRegressionCases: number;
    ExactIdentifierRankDelta: number;
    NoBenefitTokenGrowthQueries: number;
    FullVectorScanAttempts: number;
    MaxAnnCandidateRatio: number;
    BaselineLatencyP50Ms: number;
    SemanticLatencyP50Ms: number;
  };
  queries: SemanticQueryReport[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEMANTIC_FIXTURE = path.join(HERE, "fixtures", "semantic-retrieval-golden.json");
const DIMENSIONS = 8;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function axis(index: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, current) => current === index ? 1 : 0);
}

/**
 * This provider deliberately evaluates the retrieval/index/fusion pipeline, not
 * the quality of a third-party embedding model. Known paraphrase pairs share an
 * axis; unrelated corpus passages and queries use orthogonal axes.
 */
class GoldenEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor = {
    id: "deterministic-semantic-golden",
    model: "golden-concept-axis",
    version: "1",
    dimensions: DIMENSIONS,
  };

  private concept(text: string): number[] | null {
    const normalized = text.normalize("NFKC").toLowerCase();
    if (
      normalized.includes("pressure relief choreography") ||
      normalized.includes("maintain responsiveness amid sudden popularity surges")
    ) return axis(0);
    if (
      normalized.includes("quarantine ledger reconciliation") ||
      normalized.includes("recover trustworthy balances after duplicated delivery")
    ) return axis(1);
    return null;
  }

  async embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => this.concept(text) ?? axis(2));
  }

  async embedQuery(text: string): Promise<readonly number[]> {
    return this.concept(text) ?? axis(3);
  }
}

function engineDescriptor() {
  return new LshAnnEngine({
    dimensions: DIMENSIONS,
    tables: 12,
    bitsPerTable: 16,
    probes: 4,
    minimumScore: 0.95,
    seed: "knowledge-rail-semantic-golden-v1",
  }).descriptor;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue / 100) - 1)]!;
}

function recovered(paths: readonly string[], expected: readonly string[]): number {
  const actual = new Set(paths);
  return expected.filter((item) => actual.has(item)).length;
}

function bestRank(paths: readonly string[], expected: readonly string[]): number {
  const expectedSet = new Set(expected);
  const index = paths.findIndex((item) => expectedSet.has(item));
  return index < 0 ? 0 : index + 1;
}

async function writeSemanticPage(wikiRoot: string, page: SemanticPage): Promise<void> {
  const file = path.join(wikiRoot, page.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    `title: "${page.title}"`,
    `type: ${page.type}`,
    `tags: [semantic-golden, ${page.concept}]`,
    "sources: [benchmarks/semantic-golden]",
    "---",
    "",
    page.body,
  ].join("\n"), "utf8");
}

function evaluationQueries(
  base: HybridGoldenFixture,
  fixture: SemanticGoldenFixture
): EvaluationQuery[] {
  return [
    ...base.queries.map((query) => ({
      id: query.id,
      category: "oracle" as const,
      query: query.query,
      expectedPaths: [...new Set(query.relevant.map((evidence) => evidence.path))],
    })),
    ...fixture.semanticOnlyQueries.map((query) => ({
      id: query.id,
      category: "semantic-only" as const,
      query: query.query,
      expectedPaths: query.expectedPaths,
    })),
  ];
}

export async function evaluateSemanticRetrieval(
  fixturePath = DEFAULT_SEMANTIC_FIXTURE
): Promise<SemanticRetrievalReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as SemanticGoldenFixture;
  const baseFixturePath = path.resolve(path.dirname(fixturePath), fixture.baseFixture);
  const base = await loadHybridFixture(baseFixturePath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-semantic-eval-"));
  const wikiRoot = path.join(root, "wiki");
  const reports: SemanticQueryReport[] = [];
  const provider = new GoldenEmbeddingProvider();
  const engine = new LshAnnEngine({
    dimensions: DIMENSIONS,
    tables: 12,
    bitsPerTable: 16,
    probes: 4,
    minimumScore: 0.95,
    seed: "knowledge-rail-semantic-golden-v1",
  });

  try {
    await materializeHybridFixture(wikiRoot, base);
    for (const page of fixture.semanticPages) await writeSemanticPage(wikiRoot, page);
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    const index = new PersistentSemanticIndex(wikiRoot, provider, engine);
    await index.synchronize(await getWikiPageRecords(wikiRoot, true));
    const queries = evaluationQueries(base, fixture);
    process.stdout.write(
      `Semantic retrieval golden dataset: ${index.descriptor.pageCount} pages, ` +
      `${index.descriptor.passageCount} passages, ${queries.length} queries\n`
    );

    for (const query of queries) {
      const baselineStart = performance.now();
      const baseline = await retrieveWikiHybrid({
        wikiRoot,
        query: query.query,
        maxResults: base.k,
        profile: "balanced",
        progressiveWidening: false,
        ...base.boundedBudget,
      });
      const baselineMs = performance.now() - baselineStart;
      const semanticStart = performance.now();
      const semantic = await retrieveWikiHybrid({
        wikiRoot,
        query: query.query,
        maxResults: base.k,
        profile: "balanced",
        progressiveWidening: false,
        semanticIndex: index,
        ...base.boundedBudget,
      });
      const semanticMs = performance.now() - semanticStart;
      const baselinePaths = baseline.hits.map((hit) => hit.path);
      const semanticPaths = semantic.hits.map((hit) => hit.path);
      const baselineRecovered = recovered(baselinePaths, query.expectedPaths);
      const semanticRecovered = recovered(semanticPaths, query.expectedPaths);
      const report: SemanticQueryReport = {
        id: query.id,
        category: query.category,
        baselineRecall: ratio(baselineRecovered, query.expectedPaths.length),
        semanticRecall: ratio(semanticRecovered, query.expectedPaths.length),
        baselineRank: bestRank(baselinePaths, query.expectedPaths),
        semanticRank: bestRank(semanticPaths, query.expectedPaths),
        baselineContextTokens: baseline.estimatedContextTokens,
        semanticContextTokens: semantic.estimatedContextTokens,
        recallImproved: semanticRecovered > baselineRecovered,
        annCandidateCount: semantic.semantic.candidateCount,
        annVectorCount: semantic.semantic.vectorCount,
        annVisitedBuckets: semantic.semantic.visitedBuckets,
        baselineMs,
        semanticMs,
      };
      reports.push(report);
      process.stdout.write(
        `${query.id.padEnd(28)} ${query.category.padEnd(13)} ` +
        `recall=${report.baselineRecall.toFixed(3)}->${report.semanticRecall.toFixed(3)} ` +
        `rank=${report.baselineRank}->${report.semanticRank} ` +
        `tokens=${report.baselineContextTokens}->${report.semanticContextTokens} ` +
        `ann=${report.annCandidateCount}/${report.annVectorCount}\n`
      );
    }

    const semanticOnly = reports.filter((report) => report.category === "semantic-only");
    const oracle = reports.filter((report) => report.category === "oracle");
    const exact = reports.find((report) => report.id === fixture.exactIdentifierQueryId);
    if (!exact) throw new Error(`Exact identifier query not found: ${fixture.exactIdentifierQueryId}.`);
    const metrics: SemanticRetrievalReport["metrics"] = {
      BaselineRecall: mean(reports.map((report) => report.baselineRecall)),
      SemanticRecall: mean(reports.map((report) => report.semanticRecall)),
      RecallDelta: mean(reports.map((report) => report.semanticRecall - report.baselineRecall)),
      SemanticOnlyBaselineRecall: mean(semanticOnly.map((report) => report.baselineRecall)),
      SemanticOnlyRecall: mean(semanticOnly.map((report) => report.semanticRecall)),
      SemanticOnlyImprovedCases: semanticOnly.filter((report) => report.recallImproved).length,
      OracleRegressionCases: oracle.filter((report) => report.semanticRecall < report.baselineRecall).length,
      ExactIdentifierRankDelta: exact.semanticRank - exact.baselineRank,
      NoBenefitTokenGrowthQueries: reports.filter((report) =>
        !report.recallImproved && report.semanticContextTokens > report.baselineContextTokens
      ).length,
      FullVectorScanAttempts: reports.filter((report) =>
        report.annVectorCount > 1 && report.annCandidateCount >= report.annVectorCount
      ).length,
      MaxAnnCandidateRatio: Math.max(0, ...reports.map((report) =>
        ratio(report.annCandidateCount, report.annVectorCount)
      )),
      BaselineLatencyP50Ms: percentile(reports.map((report) => report.baselineMs), 50),
      SemanticLatencyP50Ms: percentile(reports.map((report) => report.semanticMs), 50),
    };
    const result: SemanticRetrievalReport = {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      baseFixtureVersion: base.version,
      queryIds: reports.map((report) => report.id),
      exactIdentifierQueryId: fixture.exactIdentifierQueryId,
      provider: provider.descriptor,
      engine: engine.descriptor,
      metrics,
      queries: reports,
    };
    process.stdout.write(
      `SUMMARY Recall=${metrics.BaselineRecall.toFixed(4)}->${metrics.SemanticRecall.toFixed(4)} ` +
      `Delta=${metrics.RecallDelta.toFixed(4)} SemanticOnly=${metrics.SemanticOnlyRecall.toFixed(4)} ` +
      `Improved=${metrics.SemanticOnlyImprovedCases} OracleRegressions=${metrics.OracleRegressionCases} ` +
      `ExactRankDelta=${metrics.ExactIdentifierRankDelta} ` +
      `NoBenefitTokenGrowth=${metrics.NoBenefitTokenGrowthQueries} ` +
      `FullVectorScans=${metrics.FullVectorScanAttempts} ` +
      `MaxAnnCandidateRatio=${metrics.MaxAnnCandidateRatio.toFixed(4)}\n`
    );
    return result;
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_SEMANTIC_FIXTURE);
  const report = await evaluateSemanticRetrieval(fixturePath);
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
