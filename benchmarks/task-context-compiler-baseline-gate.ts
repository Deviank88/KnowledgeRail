import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TASK_CONTEXT_FIXTURE,
  evaluateTaskContextCompiler,
} from "./task-context-compiler-eval.js";

interface TaskContextBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  baseFixtureVersion: number;
  baseFixtureSha256: string;
  taskIds: string[];
  intentCount: number;
  maxEvidence: number;
  heuristicTokenBudget: number;
  minimumTaskContextEvidenceRecall: number;
  minimumBoundedHybridEvidenceRecall: number;
  minimumHybridParityRecall: number;
  minimumIntentCategoryCoverage: number;
  minimumChangeImpactRecall: number;
  minimumExpectedUnknownReportingRate: number;
  maximumLostRelevantVsOracle: number;
  maximumLostRelevantVsHybrid: number;
  maximumFallbackRate: number;
  maximumFullGraphScanAttempts: number;
  maximumWideningLevel: number;
  maximumVisitedNodes: number;
}

interface FixtureLocator {
  baseFixture: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "task-context-baseline-v4.json");

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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_TASK_CONTEXT_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as TaskContextBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as FixtureLocator;
  const baseFixturePath = path.resolve(path.dirname(fixturePath), fixture.baseFixture);
  const baseFixtureBytes = await fs.readFile(baseFixturePath);
  const report = await evaluateTaskContextCompiler(fixturePath);
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "baseFixtureVersion", report.baseFixtureVersion === baseline.baseFixtureVersion, report.baseFixtureVersion);
  check(failures, "baseFixtureSha256", digest(baseFixtureBytes) === baseline.baseFixtureSha256, digest(baseFixtureBytes));
  check(failures, "taskIds", JSON.stringify(report.taskIds) === JSON.stringify(baseline.taskIds), report.taskIds.join(","));
  check(failures, "taskCount", report.taskCount === baseline.taskIds.length, report.taskCount);
  check(failures, "intentCount", report.intentCount === baseline.intentCount, report.intentCount);
  check(failures, "maxEvidence", report.maxEvidence === baseline.maxEvidence, report.maxEvidence);
  check(failures, "heuristicTokenBudget", report.heuristicTokenBudget === baseline.heuristicTokenBudget, report.heuristicTokenBudget);
  check(
    failures,
    "TaskContextEvidenceRecall",
    report.metrics.TaskContextEvidenceRecall >= baseline.minimumTaskContextEvidenceRecall,
    report.metrics.TaskContextEvidenceRecall
  );
  check(
    failures,
    "BoundedHybridEvidenceRecall",
    report.metrics.BoundedHybridEvidenceRecall >= baseline.minimumBoundedHybridEvidenceRecall,
    report.metrics.BoundedHybridEvidenceRecall
  );
  check(
    failures,
    "HybridParityRecall",
    report.metrics.HybridParityRecall >= baseline.minimumHybridParityRecall,
    report.metrics.HybridParityRecall
  );
  check(
    failures,
    "IntentCategoryCoverage",
    report.metrics.IntentCategoryCoverage >= baseline.minimumIntentCategoryCoverage,
    report.metrics.IntentCategoryCoverage
  );
  check(
    failures,
    "ChangeImpactRecall",
    report.metrics.ChangeImpactRecall >= baseline.minimumChangeImpactRecall,
    report.metrics.ChangeImpactRecall
  );
  check(
    failures,
    "ExpectedUnknownReportingRate",
    report.metrics.ExpectedUnknownReportingRate >= baseline.minimumExpectedUnknownReportingRate,
    report.metrics.ExpectedUnknownReportingRate
  );
  check(
    failures,
    "LostRelevantVsOracle",
    report.metrics.LostRelevantVsOracle <= baseline.maximumLostRelevantVsOracle,
    report.metrics.LostRelevantVsOracle
  );
  check(
    failures,
    "LostRelevantVsHybrid",
    report.metrics.LostRelevantVsHybrid <= baseline.maximumLostRelevantVsHybrid,
    report.metrics.LostRelevantVsHybrid
  );
  check(failures, "FallbackRate", report.metrics.FallbackRate <= baseline.maximumFallbackRate, report.metrics.FallbackRate);
  check(
    failures,
    "FullGraphScanAttempts",
    report.metrics.FullGraphScanAttempts <= baseline.maximumFullGraphScanAttempts,
    report.metrics.FullGraphScanAttempts
  );
  check(
    failures,
    "MaxContextTokens",
    report.metrics.MaxContextTokens <= baseline.heuristicTokenBudget,
    report.metrics.MaxContextTokens
  );

  for (const task of report.tasks) {
    check(failures, `${task.id}.evidenceRecall`, task.evidenceRecall === 1, task.evidenceRecall);
    check(failures, `${task.id}.hybridParityRecall`, task.hybridParityRecall === 1, task.hybridParityRecall);
    check(failures, `${task.id}.categoryCoverage`, task.categoryCoverage === 1, task.categoryCoverage);
    check(failures, `${task.id}.impactCoverage`, task.impactCoverage === 1, task.impactCoverage);
    check(failures, `${task.id}.expectedUnknowns`, task.expectedUnknownKindsPresent, task.expectedUnknownKindsPresent);
    check(failures, `${task.id}.lostOracle`, task.lostOracleEvidenceIds.length === 0, task.lostOracleEvidenceIds.length);
    check(failures, `${task.id}.lostHybrid`, task.lostHybridEvidenceIds.length === 0, task.lostHybridEvidenceIds.length);
    check(failures, `${task.id}.selectedEvidence`, task.selectedEvidenceCount <= baseline.maxEvidence, task.selectedEvidenceCount);
    check(failures, `${task.id}.contextTokens`, task.contextTokens <= baseline.heuristicTokenBudget, task.contextTokens);
    check(failures, `${task.id}.wideningLevel`, task.wideningLevel <= baseline.maximumWideningLevel, task.wideningLevel);
    check(failures, `${task.id}.visitedNodes`, task.visitedNodes <= baseline.maximumVisitedNodes, task.visitedNodes);
    check(failures, `${task.id}.fallbackUsed`, !task.fallbackUsed, task.fallbackUsed);
    check(failures, `${task.id}.fullGraphScanAttempted`, !task.fullGraphScanAttempted, task.fullGraphScanAttempted);
  }

  if (failures.length > 0) {
    process.stderr.write(
      `\nTask context compiler gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nTask context compiler gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
