import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HybridGoldenFixture } from "./hybrid-retrieval-quality-eval.js";
import type { ProgressiveWideningReport } from "./progressive-widening-eval.js";

type RecallMetric =
  | "candidateRecallAtK"
  | "evidenceRecallAtK"
  | "passageRecallAtK"
  | "graphOnlyRecoveryRate"
  | "multiHopRecall"
  | "sourceCoverageRecall";

interface Budget {
  maxSeedCandidates: number;
  maxVisitedNodes: number;
  maxDepth: number;
  maxEvidence: number;
  tokenBudget: number;
}

interface WideningFixture {
  version: number;
  baseFixture: string;
  initialBudget: Budget;
  maximumBudget: Budget;
  queries: Array<{ id: string; difficulty: "easy" | "difficult" }>;
}

interface WideningBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  baseFixtureVersion: number;
  baseFixtureSha256: string;
  pageCount: number;
  queryCount: number;
  evidenceCount: number;
  easyQueryIds: string[];
  difficultQueryIds: string[];
  initialBudget: Budget;
  maximumBudget: Budget;
  milestoneAMinimumRecall: Record<RecallMetric, number>;
  minimum: {
    oracleRecallAfterWidening: number;
    easyW0Rate: number;
    difficultWideningRate: number;
  };
  maximum: {
    lostRelevantAfterWidening: number;
    fullGraphScanAttempts: number;
    w3FallbackRate: number;
  };
}

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "progressive-widening-baseline-v4.json");
const DEFAULT_FIXTURE = path.join(HERE, "fixtures", "progressive-widening-golden.json");
const EVALUATOR = path.join(HERE, "progressive-widening-eval.ts");
const EPSILON = 1e-9;
const RECALL_METRICS: readonly RecallMetric[] = [
  "candidateRecallAtK",
  "evidenceRecallAtK",
  "passageRecallAtK",
  "graphOnlyRecoveryRate",
  "multiHopRecall",
  "sourceCoverageRecall",
];

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameBudget(actual: Budget, expected: Budget): boolean {
  return (Object.keys(expected) as Array<keyof Budget>).every((key) => actual[key] === expected[key]);
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argValue("baseline") ?? DEFAULT_BASELINE);
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as WideningBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as WideningFixture;
  const baseFixturePath = path.resolve(path.dirname(fixturePath), fixture.baseFixture);
  const baseFixtureBytes = await fs.readFile(baseFixturePath);
  const baseFixture = JSON.parse(baseFixtureBytes.toString("utf8")) as HybridGoldenFixture;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-widening-gate-"));
  const reportPath = path.join(tempDir, "report.json");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", EVALUATOR, `--fixture=${fixturePath}`, `--json=${reportPath}`],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as ProgressiveWideningReport;
    const failures: string[] = [];
    const easyIds = fixture.queries
      .filter((query) => query.difficulty === "easy")
      .map((query) => query.id);
    const difficultIds = fixture.queries
      .filter((query) => query.difficulty === "difficult")
      .map((query) => query.id);
    const goldenById = new Map(baseFixture.queries.map((query) => [query.id, query] as const));
    const evidenceCount = fixture.queries.reduce(
      (sum, query) => sum + (goldenById.get(query.id)?.relevant.length ?? 0),
      0
    );

    if (fixture.version !== baseline.fixtureVersion) {
      failures.push(`Fixture version changed: expected ${baseline.fixtureVersion}, got ${fixture.version}.`);
    }
    if (digest(fixtureBytes) !== baseline.fixtureSha256) failures.push("Widening fixture digest changed.");
    if (baseFixture.version !== baseline.baseFixtureVersion) failures.push("Base fixture version changed.");
    if (digest(baseFixtureBytes) !== baseline.baseFixtureSha256) failures.push("Base fixture digest changed.");
    if (!sameOrderedValues(easyIds, baseline.easyQueryIds)) failures.push("Easy query IDs changed.");
    if (!sameOrderedValues(difficultIds, baseline.difficultQueryIds)) failures.push("Difficult query IDs changed.");
    if (!sameBudget(fixture.initialBudget, baseline.initialBudget)) failures.push("Initial budget changed.");
    if (!sameBudget(fixture.maximumBudget, baseline.maximumBudget)) failures.push("Maximum budget changed.");

    const shapeChecks: Array<[string, number, number]> = [
      ["page count", report.pageCount, baseline.pageCount],
      ["query count", report.queryCount, baseline.queryCount],
      ["evidence count", report.evidenceCount, baseline.evidenceCount],
      ["fixture query count", fixture.queries.length, baseline.queryCount],
      ["fixture evidence count", evidenceCount, baseline.evidenceCount],
    ];
    for (const [label, actual, expected] of shapeChecks) {
      if (actual !== expected) failures.push(`${label} changed: expected ${expected}, got ${actual}.`);
    }

    for (const metric of RECALL_METRICS) {
      const actual = report.metrics[metric];
      const minimum = baseline.milestoneAMinimumRecall[metric];
      const passed = actual + EPSILON >= minimum;
      process.stdout.write(
        `GATE final ${metric}=${actual.toFixed(6)} milestone_A_minimum=${minimum.toFixed(6)} ` +
        `${passed ? "PASS" : "FAIL"}\n`
      );
      if (!passed) failures.push(`${metric} fell below the Milestone A baseline.`);
    }

    for (const metric of ["oracleRecallAfterWidening", "easyW0Rate", "difficultWideningRate"] as const) {
      const actual = report.metrics[metric];
      const minimum = baseline.minimum[metric];
      const passed = actual + EPSILON >= minimum;
      process.stdout.write(
        `GATE ${metric}=${actual.toFixed(6)} minimum=${minimum.toFixed(6)} ${passed ? "PASS" : "FAIL"}\n`
      );
      if (!passed) failures.push(`${metric} regressed below ${minimum}.`);
    }
    for (const metric of ["lostRelevantAfterWidening", "fullGraphScanAttempts", "w3FallbackRate"] as const) {
      const actual = report.metrics[metric];
      const maximum = baseline.maximum[metric];
      const passed = actual <= maximum + EPSILON;
      process.stdout.write(
        `GATE ${metric}=${actual.toFixed(6)} maximum=${maximum.toFixed(6)} ${passed ? "PASS" : "FAIL"}\n`
      );
      if (!passed) failures.push(`${metric} exceeded ${maximum}.`);
    }

    for (const query of report.queries) {
      const golden = goldenById.get(query.id);
      if (!golden) {
        failures.push(`Unexpected evaluated query: ${query.id}.`);
        continue;
      }
      if (!query.finalCoverage.sufficient) failures.push(`${query.id}: final coverage remains insufficient.`);
      if (query.lostRelevantAfterWidening.length > 0) {
        failures.push(`${query.id}: final evidence loss: ${query.lostRelevantAfterWidening.join(", ")}.`);
      }
      if (query.difficulty === "easy" && query.lostRelevantInitially.length > 0) {
        failures.push(`${query.id}: easy query lost evidence at W0.`);
      }
      if (query.difficulty === "difficult" && query.lostRelevantInitially.length === 0) {
        failures.push(`${query.id}: difficult query no longer exercises initial-budget evidence loss.`);
      }
      if (query.difficulty === "difficult" && query.wideningLevel === 0) {
        failures.push(`${query.id}: difficult query did not widen.`);
      }
      const recovered = new Set(query.finalRecoveredEvidence);
      for (const evidence of golden.relevant) {
        if (!recovered.has(evidence.id)) failures.push(`${query.id}: did not recover ${evidence.id}.`);
      }
      if (query.attempts.length !== query.wideningLevel + 1) {
        failures.push(`${query.id}: attempt sequence does not match final widening level.`);
      }
      query.attempts.forEach((attempt, index) => {
        if (attempt.level !== index) failures.push(`${query.id}: non-contiguous attempt sequence.`);
        if (attempt.visitedNodes > attempt.budget.maxVisitedNodes) {
          failures.push(`${query.id}/W${attempt.level}: visited-node budget exceeded.`);
        }
        if (attempt.visitedNodes >= query.graphNodeCount) {
          failures.push(`${query.id}/W${attempt.level}: full graph scan detected.`);
        }
        if (attempt.hitCount > attempt.budget.maxEvidence) {
          failures.push(`${query.id}/W${attempt.level}: evidence budget exceeded.`);
        }
        if (attempt.estimatedContextTokens > attempt.budget.tokenBudget) {
          failures.push(`${query.id}/W${attempt.level}: token budget exceeded.`);
        }
        if (attempt.fallbackUsed && attempt.level !== 3) {
          failures.push(`${query.id}/W${attempt.level}: fallback used before W3.`);
        }
        for (const key of Object.keys(baseline.maximumBudget) as Array<keyof Budget>) {
          if (attempt.budget[key] > baseline.maximumBudget[key]) {
            failures.push(`${query.id}/W${attempt.level}: ${key} exceeds the maximum budget.`);
          }
        }
      });
    }

    if (failures.length > 0) {
      process.stderr.write(
        `\nProgressive widening baseline gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\nProgressive widening baseline gate passed (baseline v${baseline.version}).\n`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
