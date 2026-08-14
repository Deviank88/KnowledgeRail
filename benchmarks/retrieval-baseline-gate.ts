import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "retrieval-baseline-v3.json");
const EVALUATOR = path.join(HERE, "retrieval-quality-eval.ts");
const EPSILON = 1e-9;

type GatedMetric = "recallAt5" | "mrr" | "ndcgAt5" | "passageHeadingMatch";
const GATED_METRICS: readonly GatedMetric[] = [
  "recallAt5",
  "mrr",
  "ndcgAt5",
  "passageHeadingMatch",
];

interface ProfileSummary {
  profile: string;
  recallAt5: number;
  precisionAt5: number;
  mrr: number;
  ndcgAt5: number;
  passageHeadingMatch: number;
}

interface EvaluationReport {
  pageCount: number;
  queryCount: number;
  profiles: ProfileSummary[];
}

interface BaselineProfile {
  observed: Record<string, number>;
  minimum: Record<GatedMetric, number>;
}

interface Baseline {
  version: number;
  pageCount: number;
  queryCount: number;
  profiles: Record<string, BaselineProfile>;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argValue("baseline") ?? DEFAULT_BASELINE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf-8")) as Baseline;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-retrieval-gate-"));
  const reportPath = path.join(tempDir, "report.json");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", EVALUATOR, `--json=${reportPath}`],
      { maxBuffer: 1024 * 1024 }
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    const report = JSON.parse(await fs.readFile(reportPath, "utf-8")) as EvaluationReport;
    const failures: string[] = [];

    if (report.pageCount !== baseline.pageCount) {
      failures.push(`Golden page count changed: expected ${baseline.pageCount}, got ${report.pageCount}.`);
    }
    if (report.queryCount !== baseline.queryCount) {
      failures.push(`Golden query count changed: expected ${baseline.queryCount}, got ${report.queryCount}.`);
    }

    for (const [profileName, expected] of Object.entries(baseline.profiles)) {
      const actual = report.profiles.find((profile) => profile.profile === profileName);
      if (!actual) {
        failures.push(`Missing retrieval profile in evaluation: ${profileName}.`);
        continue;
      }

      for (const metric of GATED_METRICS) {
        const minimum = expected.minimum[metric];
        const value = actual[metric];
        const passed = value + EPSILON >= minimum;
        process.stdout.write(
          `GATE profile=${profileName} ${metric}=${value.toFixed(4)} ` +
          `minimum=${minimum.toFixed(4)} ${passed ? "PASS" : "FAIL"}\n`
        );
        if (!passed) {
          failures.push(
            `${profileName}.${metric} regressed: ${value.toFixed(4)} < ${minimum.toFixed(4)}.`
          );
        }
      }
    }

    const unexpectedProfiles = report.profiles
      .map((profile) => profile.profile)
      .filter((profile) => !baseline.profiles[profile]);
    if (unexpectedProfiles.length > 0) {
      failures.push(
        `Evaluation contains profiles not represented in baseline: ${unexpectedProfiles.join(", ")}.`
      );
    }

    if (failures.length > 0) {
      process.stderr.write(`\nRetrieval baseline gate failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`\nRetrieval baseline gate passed (baseline v${baseline.version}).\n`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
