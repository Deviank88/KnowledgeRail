import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  HybridEvaluationReport,
  HybridGoldenFixture,
  RetrievalQualityMetrics,
} from "./hybrid-retrieval-quality-eval.js";

type GatedMetric = keyof RetrievalQualityMetrics;

interface HybridBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  pageCount: number;
  queryCount: number;
  evidenceCount: number;
  graphOnlyEvidenceCount: number;
  multiHopEvidenceCount: number;
  k: number;
  queryIds: string[];
  criticalQueryIds: string[];
  evidenceIds: string[];
  maximumBoundedBudget: Record<string, number>;
  minimum: Record<GatedMetric, number>;
}

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "hybrid-retrieval-baseline-v4.json");
const DEFAULT_FIXTURE = path.join(HERE, "fixtures", "hybrid-retrieval-golden.json");
const EVALUATOR = path.join(HERE, "hybrid-retrieval-quality-eval.ts");
const EPSILON = 1e-9;
const GATED_METRICS: readonly GatedMetric[] = [
  "candidateRecallAtK",
  "evidenceRecallAtK",
  "passageRecallAtK",
  "mrr",
  "ndcgAtK",
  "graphOnlyRecoveryRate",
  "multiHopRecall",
  "sourceCoverageRecall",
];
const QUALITY_COMPARISON_METRICS: readonly GatedMetric[] = [
  "candidateRecallAtK",
  "evidenceRecallAtK",
  "passageRecallAtK",
  "mrr",
  "ndcgAtK",
  "sourceCoverageRecall",
];

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function fixturePageCount(fixture: HybridGoldenFixture): number {
  return fixture.pages.length + (fixture.generatedPages ?? []).reduce((sum, item) => sum + item.count, 0);
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argValue("baseline") ?? DEFAULT_BASELINE);
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf-8")) as HybridBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf-8")) as HybridGoldenFixture;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-hybrid-gate-"));
  const reportPath = path.join(tempDir, "report.json");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", EVALUATOR, `--fixture=${fixturePath}`, `--json=${reportPath}`],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    const report = JSON.parse(await fs.readFile(reportPath, "utf-8")) as HybridEvaluationReport;
    const failures: string[] = [];
    const evidence = fixture.queries.flatMap((query) => query.relevant);
    const graphOnlyEvidence = evidence.filter((item) => item.graphOnly);
    const multiHopEvidence = evidence.filter((item) => (item.hop ?? 0) >= 2);
    const queryIds = fixture.queries.map((query) => query.id);
    const criticalQueryIds = fixture.queries.filter((query) => query.critical).map((query) => query.id);
    const evidenceIds = evidence.map((item) => item.id);
    const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");

    const fixtureChecks: Array<[string, number, number]> = [
      ["fixture version", fixture.version, baseline.fixtureVersion],
      ["page count", fixturePageCount(fixture), baseline.pageCount],
      ["query count", fixture.queries.length, baseline.queryCount],
      ["evidence count", evidence.length, baseline.evidenceCount],
      ["graph-only evidence count", graphOnlyEvidence.length, baseline.graphOnlyEvidenceCount],
      ["multi-hop evidence count", multiHopEvidence.length, baseline.multiHopEvidenceCount],
      ["K", fixture.k, baseline.k],
    ];
    for (const [label, actual, expected] of fixtureChecks) {
      if (actual !== expected) failures.push(`${label} changed: expected ${expected}, got ${actual}.`);
    }
    if (!sameOrderedValues(queryIds, baseline.queryIds)) failures.push("Golden query IDs changed.");
    if (!sameOrderedValues(criticalQueryIds, baseline.criticalQueryIds)) {
      failures.push("Critical golden query IDs changed.");
    }
    if (!sameOrderedValues(evidenceIds, baseline.evidenceIds)) failures.push("Golden evidence IDs changed.");
    if (fixtureSha256 !== baseline.fixtureSha256) {
      failures.push(`Golden fixture digest changed: expected ${baseline.fixtureSha256}, got ${fixtureSha256}.`);
    }

    if (report.pageCount !== baseline.pageCount || report.queryCount !== baseline.queryCount) {
      failures.push(
        `Evaluator dataset shape changed: pages=${report.pageCount}, queries=${report.queryCount}.`
      );
    }
    for (const [budgetName, maximum] of Object.entries(baseline.maximumBoundedBudget)) {
      const actual = report.boundedBudget[budgetName as keyof typeof report.boundedBudget];
      const passed = typeof actual === "number" && actual <= maximum;
      process.stdout.write(
        `BUDGET ${budgetName}=${String(actual)} maximum=${maximum} ${passed ? "PASS" : "FAIL"}\n`
      );
      if (!passed) failures.push(`Bounded budget ${budgetName} increased: ${String(actual)} > ${maximum}.`);
    }

    for (const metric of GATED_METRICS) {
      const value = report.bounded[metric];
      const minimum = baseline.minimum[metric];
      const passed = value + EPSILON >= minimum;
      process.stdout.write(
        `GATE bounded ${metric}=${value.toFixed(6)} minimum=${minimum.toFixed(6)} ` +
        `${passed ? "PASS" : "FAIL"}\n`
      );
      if (!passed) failures.push(`${metric} regressed: ${value.toFixed(6)} < ${minimum.toFixed(6)}.`);
    }

    if (report.bounded.lostRelevantByPruning !== 0) {
      failures.push(`LostRelevantByPruning must be 0, got ${report.bounded.lostRelevantByPruning}.`);
    }
    if (report.bounded.criticalLostRelevantByPruning !== 0) {
      failures.push(
        `Critical LostRelevantByPruning must be 0, got ${report.bounded.criticalLostRelevantByPruning}.`
      );
    }

    const goldenById = new Map(fixture.queries.map((query) => [query.id, query] as const));
    for (const query of report.queries) {
      const golden = goldenById.get(query.id);
      if (!golden) {
        failures.push(`Unexpected evaluated query: ${query.id}.`);
        continue;
      }
      const boundedRecovered = new Set(query.boundedRecoveredEvidence);
      const lexicalRecovered = new Set(query.lexicalRecoveredEvidence);
      const oracleRecovered = new Set(query.oracleRecoveredEvidence);
      for (const expected of golden.relevant) {
        if (!oracleRecovered.has(expected.id)) {
          failures.push(`${query.id}: oracle did not recover ${expected.id}.`);
        }
        if (expected.graphOnly && lexicalRecovered.has(expected.id)) {
          failures.push(`${query.id}: ${expected.id} is labelled graph-only but lexical retrieval recovered it.`);
        }
        if (expected.graphOnly && !boundedRecovered.has(expected.id)) {
          failures.push(`${query.id}: graph-only evidence ${expected.id} was not recovered.`);
        }
        if ((expected.hop ?? 0) >= 2 && !boundedRecovered.has(expected.id)) {
          failures.push(`${query.id}: multi-hop evidence ${expected.id} was not recovered.`);
        }
      }
      if (golden.critical && query.lostRelevantByPruning.length > 0) {
        failures.push(
          `${query.id}: critical evidence pruned: ${query.lostRelevantByPruning.join(", ")}.`
        );
      }
    }

    for (const metric of QUALITY_COMPARISON_METRICS) {
      if (report.bounded[metric] + EPSILON < report.lexical[metric]) {
        failures.push(
          `Bounded ${metric} is below lexical-only: ` +
          `${report.bounded[metric].toFixed(6)} < ${report.lexical[metric].toFixed(6)}.`
        );
      }
    }
    const improvements = QUALITY_COMPARISON_METRICS.filter(
      (metric) => report.bounded[metric] > report.lexical[metric] + EPSILON
    );
    process.stdout.write(
      `QUALITY improvements_vs_lexical=${improvements.join(",") || "none"} ` +
      `${improvements.length > 0 ? "PASS" : "FAIL"}\n`
    );
    if (improvements.length === 0) {
      failures.push("Bounded retrieval did not improve any gated recall/quality metric over lexical-only.");
    }

    if (failures.length > 0) {
      process.stderr.write(
        `\nHybrid retrieval baseline gate failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`\nHybrid retrieval baseline gate passed (baseline v${baseline.version}).\n`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
