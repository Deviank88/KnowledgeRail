import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MULTI_LANGUAGE_FIXTURE_ROOT,
  evaluateMultiLanguageCodeEvidence,
} from "./multi-language-code-evidence-eval.js";

interface Baseline {
  version: number;
  corpusSha256: string;
  languages: string[];
  minimumPrecision: number;
  minimumRecall: number;
  sourceFileCount: number;
  sourceLineCount: number;
  sourceByteCount: number;
  labeledSourceFileCount: number;
  labeledSourceLineCount: number;
  labeledSourceByteCount: number;
  expectedSymbolCount: number;
  maximumInitialBuildMs: number;
  maximumUnchangedBuildMs: number;
  maximumPythonExtractionMs: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "multi-language-code-evidence-baseline-v3.json");

function check(failures: string[], label: string, passed: boolean, actual: unknown): void {
  process.stdout.write(`GATE ${label}=${String(actual)} ${passed ? "PASS" : "FAIL"}\n`);
  if (!passed) failures.push(`${label} failed (actual: ${String(actual)}).`);
}

async function main(): Promise<void> {
  const baseline = JSON.parse(await fs.readFile(DEFAULT_BASELINE, "utf8")) as Baseline;
  const report = await evaluateMultiLanguageCodeEvidence(DEFAULT_MULTI_LANGUAGE_FIXTURE_ROOT);
  const failures: string[] = [];
  const languages = report.languageResults.map((result) => result.language);
  check(failures, "baselineVersion", baseline.version === 3, baseline.version);
  check(failures, "corpusSha256", report.corpusSha256 === baseline.corpusSha256, report.corpusSha256);
  check(failures, "languages", JSON.stringify(languages) === JSON.stringify(baseline.languages), languages.join(","));
  check(failures, "sourceFileCount", report.sourceFileCount === baseline.sourceFileCount, report.sourceFileCount);
  check(failures, "sourceLineCount", report.sourceLineCount === baseline.sourceLineCount, report.sourceLineCount);
  check(failures, "sourceByteCount", report.sourceByteCount === baseline.sourceByteCount, report.sourceByteCount);
  check(
    failures,
    "labeledSourceFileCount",
    report.labeledSourceFileCount === baseline.labeledSourceFileCount,
    report.labeledSourceFileCount
  );
  check(
    failures,
    "labeledSourceLineCount",
    report.labeledSourceLineCount === baseline.labeledSourceLineCount,
    report.labeledSourceLineCount
  );
  check(
    failures,
    "labeledSourceByteCount",
    report.labeledSourceByteCount === baseline.labeledSourceByteCount,
    report.labeledSourceByteCount
  );
  check(
    failures,
    "expectedSymbolCount",
    report.expectedSymbolCount === baseline.expectedSymbolCount,
    report.expectedSymbolCount
  );
  for (const result of report.languageResults) {
    check(failures, `${result.language}.precision`, result.precision >= baseline.minimumPrecision, result.precision);
    check(failures, `${result.language}.recall`, result.recall >= baseline.minimumRecall, result.recall);
  }
  const python = report.languageResults.find((result) => result.language === "python");
  check(
    failures,
    "python.extractionMs",
    python !== undefined && python.extractionMs <= baseline.maximumPythonExtractionMs,
    python?.extractionMs ?? "missing"
  );
  check(
    failures,
    "maskingIntegrity",
    report.maskingResults.every((result) => result.passed),
    report.maskingResults.filter((result) => !result.passed).map((result) => result.language).join(",") || "all"
  );
  check(failures, "initialReparsedFiles", report.initialReparsedFiles === baseline.sourceFileCount, report.initialReparsedFiles);
  check(failures, "unchangedReusedFiles", report.unchangedReusedFiles === baseline.sourceFileCount, report.unchangedReusedFiles);
  check(
    failures,
    "initialBuildMs",
    report.initialBuildMs <= baseline.maximumInitialBuildMs,
    report.initialBuildMs
  );
  check(
    failures,
    "unchangedBuildMs",
    report.unchangedBuildMs <= baseline.maximumUnchangedBuildMs,
    report.unchangedBuildMs
  );
  if (failures.length > 0) {
    process.stderr.write(`\nMulti-language code-evidence gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nMulti-language code-evidence gate passed (baseline v3).\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
