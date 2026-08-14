import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODE_EVIDENCE_FIXTURE,
  evaluateCodeEvidence,
} from "./code-evidence-eval.js";

interface CodeEvidenceBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  fileCount: number;
  normalTaskCount: number;
  minimumCodeEvidenceRecall: number;
  minimumSymbolResolutionAccuracy: number;
  minimumReferenceRecall: number;
  maximumCodeContextBytes: number;
  maximumGrepFallbackRate: number;
  taskNames: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "code-evidence-baseline-v4.json");

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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_CODE_EVIDENCE_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as CodeEvidenceBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateCodeEvidence(fixturePath);
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "fileCount", report.fileCount === baseline.fileCount, report.fileCount);
  check(failures, "normalTaskCount", report.normalTaskCount === baseline.normalTaskCount, report.normalTaskCount);
  check(failures, "CodeEvidenceRecall", report.codeEvidenceRecall >= baseline.minimumCodeEvidenceRecall, report.codeEvidenceRecall);
  check(failures, "SymbolResolutionAccuracy", report.symbolResolutionAccuracy >= baseline.minimumSymbolResolutionAccuracy, report.symbolResolutionAccuracy);
  check(failures, "ReferenceRecall", report.referenceRecall >= baseline.minimumReferenceRecall, report.referenceRecall);
  check(failures, "CodeContextBytes", report.codeContextBytes > 0 && report.codeContextBytes <= baseline.maximumCodeContextBytes, report.codeContextBytes);
  check(failures, "GrepFallbackRate", report.grepFallbackRate <= baseline.maximumGrepFallbackRate, report.grepFallbackRate);
  check(failures, "initialReparsedFiles", report.initialReparsedFiles === baseline.fileCount, report.initialReparsedFiles);
  check(failures, "unchangedReusedFiles", report.unchangedReusedFiles === baseline.fileCount, report.unchangedReusedFiles);
  check(failures, "renameReparsedFiles", report.renameReparsedFiles === 1, report.renameReparsedFiles);
  check(failures, "renamedSymbolVisible", report.renamedSymbolVisible, report.renamedSymbolVisible);
  check(failures, "oldSymbolRemoved", report.oldSymbolRemoved, report.oldSymbolRemoved);
  check(failures, "deletedFileRemoved", report.deletedFileRemoved, report.deletedFileRemoved);
  check(
    failures,
    "taskNames",
    sameValues(report.taskResults.map((result) => result.task), baseline.taskNames),
    report.taskResults.map((result) => result.task).join(",")
  );
  check(
    failures,
    "allGoldenTasks",
    report.taskResults.every((result) => result.passed),
    report.taskResults.filter((result) => !result.passed).map((result) => result.task).join(",") || "all"
  );

  if (failures.length > 0) {
    process.stderr.write(`\nCode evidence gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nCode evidence gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
