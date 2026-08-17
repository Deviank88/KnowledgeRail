import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DRIFT_FIXTURE,
  evaluateDriftDetection,
} from "./drift-detection-eval.js";

interface DriftBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  scenarioCount: number;
  minimumVerdictAccuracy: number;
  maximumFalsePositiveRate: number;
  maximumSilentMissRate: number;
  scaleAnchorCount: number;
  scopedAnchorCount: number;
  scenarioIds: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "drift-detection-baseline-v4.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function check(failures: string[], label: string, passed: boolean, actual: unknown): void {
  process.stdout.write(`GATE ${label}=${String(actual)} ${passed ? "PASS" : "FAIL"}\n`);
  if (!passed) failures.push(`${label} failed (actual: ${String(actual)}).`);
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argValue("baseline") ?? DEFAULT_BASELINE);
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_DRIFT_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as DriftBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateDriftDetection(fixturePath);
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "scenarioCount", report.scenarioCount === baseline.scenarioCount, report.scenarioCount);
  check(failures, "VerdictAccuracy", report.verdictAccuracy >= baseline.minimumVerdictAccuracy, report.verdictAccuracy);
  check(failures, "FalsePositiveRate", report.falsePositiveRate <= baseline.maximumFalsePositiveRate, report.falsePositiveRate);
  check(failures, "SilentMissRate", report.silentMissRate <= baseline.maximumSilentMissRate, report.silentMissRate);
  check(failures, "scaleAnchorCount", report.scaleAnchorCount === baseline.scaleAnchorCount, report.scaleAnchorCount);
  check(failures, "scopedAnchorCount", report.scopedAnchorCount === baseline.scopedAnchorCount, report.scopedAnchorCount);
  check(
    failures,
    "scenarioIds",
    sameValues(report.results.map((result) => result.id), baseline.scenarioIds),
    report.results.map((result) => result.id).join(",")
  );
  check(
    failures,
    "allGoldenScenarios",
    report.results.every((result) => result.passed),
    report.results.filter((result) => !result.passed).map((result) => result.id).join(",") || "all"
  );

  process.stdout.write(
    `PERF full=${report.fullEvaluationMs}ms/${report.scaleAnchorCount} ` +
      `scoped=${report.scopedEvaluationMs}ms/${report.scopedAnchorCount}\n`
  );
  if (failures.length > 0) {
    process.stderr.write(`\nDrift detection gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nDrift detection gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
