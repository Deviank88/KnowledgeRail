import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SEMANTIC_FIXTURE,
  evaluateSemanticRetrieval,
} from "./semantic-retrieval-eval.js";

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
