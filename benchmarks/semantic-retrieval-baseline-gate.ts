import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SEMANTIC_FIXTURE,
  evaluateSemanticRetrieval,
} from "./semantic-retrieval-eval.js";
import {
  DEFAULT_COVERAGE_FIXTURE,
  evaluateCoverageQuality,
} from "./coverage-quality-eval.js";

interface SemanticBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  baseFixtureVersion: number;
  baseFixtureSha256: string;
  queryIds: string[];
  exactIdentifierQueryId: string;
  provider: object;
  engine: object;
  minimumBaselineRecall: number;
  minimumSemanticRecall: number;
  minimumRecallDelta: number;
  minimumSemanticOnlyRecall: number;
  minimumSemanticOnlyImprovedCases: number;
  maximumOracleRegressionCases: number;
  maximumExactIdentifierRankDelta: number;
  maximumNoBenefitTokenGrowthQueries: number;
  maximumFullVectorScanAttempts: number;
  maximumAnnCandidateRatio: number;
  coverageFixtureVersion: number;
  coverageFixtureSha256: string;
  minimumCoverageCaseCount: number;
  minimumLegacyDisplayGapPrecision: number;
  minimumLegacyFullPoolGapPrecision: number;
  minimumLexicalGapPrecision: number;
  minimumSemanticGapPrecision: number;
  minimumPoolPrecisionDelta: number;
  minimumLexicalPrecisionDelta: number;
  minimumSemanticPrecisionDelta: number;
  maximumLegacyDisplaySilentMiss: number;
  maximumLegacyFullPoolSilentMiss: number;
  maximumLexicalSilentMiss: number;
  maximumSemanticSilentMiss: number;
}

interface FixtureLocator {
  baseFixture: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "semantic-retrieval-baseline-v4.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(failures: string[], label: string, passed: boolean, actual: unknown): void {
  process.stdout.write(`GATE ${label}=${String(actual)} ${passed ? "PASS" : "FAIL"}\n`);
  if (!passed) failures.push(`${label} failed (actual: ${String(actual)}).`);
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argValue("baseline") ?? DEFAULT_BASELINE);
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_SEMANTIC_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as SemanticBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as FixtureLocator;
  const baseFixtureBytes = await fs.readFile(path.resolve(path.dirname(fixturePath), fixture.baseFixture));
  const report = await evaluateSemanticRetrieval(fixturePath);
  const coverageFixtureBytes = await fs.readFile(DEFAULT_COVERAGE_FIXTURE);
  const coverage = await evaluateCoverageQuality();
  const metrics = report.metrics;
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "baseFixtureVersion", report.baseFixtureVersion === baseline.baseFixtureVersion, report.baseFixtureVersion);
  check(failures, "baseFixtureSha256", digest(baseFixtureBytes) === baseline.baseFixtureSha256, digest(baseFixtureBytes));
  check(failures, "queryIds", JSON.stringify(report.queryIds) === JSON.stringify(baseline.queryIds), report.queryIds.join(","));
  check(failures, "exactIdentifierQueryId", report.exactIdentifierQueryId === baseline.exactIdentifierQueryId, report.exactIdentifierQueryId);
  check(failures, "providerDescriptor", JSON.stringify(report.provider) === JSON.stringify(baseline.provider), JSON.stringify(report.provider));
  check(failures, "engineDescriptor", JSON.stringify(report.engine) === JSON.stringify(baseline.engine), JSON.stringify(report.engine));
  check(failures, "BaselineRecall", metrics.BaselineRecall >= baseline.minimumBaselineRecall, metrics.BaselineRecall);
  check(failures, "SemanticRecall", metrics.SemanticRecall >= baseline.minimumSemanticRecall, metrics.SemanticRecall);
  check(failures, "RecallDelta", metrics.RecallDelta >= baseline.minimumRecallDelta, metrics.RecallDelta);
  check(failures, "accuracyOracleInvariant", metrics.SemanticRecall >= metrics.BaselineRecall, `${metrics.BaselineRecall}->${metrics.SemanticRecall}`);
  check(failures, "SemanticOnlyRecall", metrics.SemanticOnlyRecall >= baseline.minimumSemanticOnlyRecall, metrics.SemanticOnlyRecall);
  check(failures, "SemanticOnlyImprovedCases", metrics.SemanticOnlyImprovedCases >= baseline.minimumSemanticOnlyImprovedCases, metrics.SemanticOnlyImprovedCases);
  check(failures, "OracleRegressionCases", metrics.OracleRegressionCases <= baseline.maximumOracleRegressionCases, metrics.OracleRegressionCases);
  check(failures, "ExactIdentifierRankDelta", metrics.ExactIdentifierRankDelta <= baseline.maximumExactIdentifierRankDelta, metrics.ExactIdentifierRankDelta);
  check(failures, "NoBenefitTokenGrowthQueries", metrics.NoBenefitTokenGrowthQueries <= baseline.maximumNoBenefitTokenGrowthQueries, metrics.NoBenefitTokenGrowthQueries);
  check(failures, "FullVectorScanAttempts", metrics.FullVectorScanAttempts <= baseline.maximumFullVectorScanAttempts, metrics.FullVectorScanAttempts);
  check(failures, "MaxAnnCandidateRatio", metrics.MaxAnnCandidateRatio <= baseline.maximumAnnCandidateRatio, metrics.MaxAnnCandidateRatio);
  check(failures, "coverageFixtureVersion", coverage.fixtureVersion === baseline.coverageFixtureVersion, coverage.fixtureVersion);
  check(failures, "coverageFixtureSha256", digest(coverageFixtureBytes) === baseline.coverageFixtureSha256, digest(coverageFixtureBytes));
  check(failures, "coverageCaseCount", coverage.caseCount >= baseline.minimumCoverageCaseCount, coverage.caseCount);
  check(failures, "LegacyDisplayGapPrecision", coverage.baseline205.gapPrecision >= baseline.minimumLegacyDisplayGapPrecision, coverage.baseline205.gapPrecision);
  check(failures, "LegacyFullPoolGapPrecision", coverage.baseline205FullPool.gapPrecision >= baseline.minimumLegacyFullPoolGapPrecision, coverage.baseline205FullPool.gapPrecision);
  check(failures, "LexicalGapPrecision", coverage.lexical.gapPrecision >= baseline.minimumLexicalGapPrecision, coverage.lexical.gapPrecision);
  check(failures, "SemanticGapPrecision", coverage.semantic.gapPrecision >= baseline.minimumSemanticGapPrecision, coverage.semantic.gapPrecision);
  check(
    failures,
    "PoolGapPrecisionDelta",
    coverage.baseline205FullPool.gapPrecision - coverage.baseline205.gapPrecision >= baseline.minimumPoolPrecisionDelta,
    coverage.baseline205FullPool.gapPrecision - coverage.baseline205.gapPrecision
  );
  check(
    failures,
    "LexicalMatchingGapPrecisionDelta",
    coverage.lexical.gapPrecision - coverage.baseline205FullPool.gapPrecision >= baseline.minimumLexicalPrecisionDelta,
    coverage.lexical.gapPrecision - coverage.baseline205FullPool.gapPrecision
  );
  check(
    failures,
    "SemanticGapPrecisionDelta",
    coverage.semantic.gapPrecision - coverage.lexical.gapPrecision >= baseline.minimumSemanticPrecisionDelta,
    coverage.semantic.gapPrecision - coverage.lexical.gapPrecision
  );
  check(failures, "LegacyDisplaySilentMiss", coverage.baseline205.silentMiss <= baseline.maximumLegacyDisplaySilentMiss, coverage.baseline205.silentMiss);
  check(failures, "LegacyFullPoolSilentMiss", coverage.baseline205FullPool.silentMiss <= baseline.maximumLegacyFullPoolSilentMiss, coverage.baseline205FullPool.silentMiss);
  check(failures, "LexicalSilentMiss", coverage.lexical.silentMiss <= baseline.maximumLexicalSilentMiss, coverage.lexical.silentMiss);
  check(failures, "SemanticSilentMiss", coverage.semantic.silentMiss <= baseline.maximumSemanticSilentMiss, coverage.semantic.silentMiss);

  for (const query of report.queries) {
    check(failures, `${query.id}.recallInvariant`, query.semanticRecall >= query.baselineRecall, `${query.baselineRecall}->${query.semanticRecall}`);
    check(
      failures,
      `${query.id}.tokenBenefitInvariant`,
      query.recallImproved || query.semanticContextTokens <= query.baselineContextTokens,
      `${query.baselineContextTokens}->${query.semanticContextTokens}`
    );
  }

  if (failures.length > 0) {
    process.stderr.write(`\nSemantic retrieval gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nSemantic retrieval gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
