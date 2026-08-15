import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EDITORIAL_FIXTURE,
  evaluateEditorialIntelligence,
} from "./editorial-intelligence-eval.js";

interface EditorialBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  sectionIds: string[];
  minimumDocumentQualityRecall: number;
  maximumDocumentOutputChars: number;
  baselineV3SectionEvidenceRecall: number;
  minimumSectionEvidenceRecall: number;
  minimumSectionEvidenceRecallDelta: number;
  minimumGapReportingRate: number;
  minimumRequiredEvidencePlanAccuracy: number;
  minimumSourceCoveragePercent: number;
  maximumClaimsWithoutProvenance: number;
  maximumContextTokens: number;
  maximumTokenBudgetViolationCount: number;
  maximumFullGraphScanAttempts: number;
  maximumFullSourceGrepAttempts: number;
  maximumFallbackUses: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "editorial-intelligence-baseline-v4.json");

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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_EDITORIAL_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as EditorialBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateEditorialIntelligence(fixturePath);
  const metrics = report.metrics;
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "sectionIds", JSON.stringify(report.sectionIds) === JSON.stringify(baseline.sectionIds), report.sectionIds.join(","));
  check(failures, "DocumentQualityRecall", metrics.DocumentQualityRecall >= baseline.minimumDocumentQualityRecall, metrics.DocumentQualityRecall);
  check(failures, "BaselineV3SectionEvidenceRecall", metrics.BaselineV3SectionEvidenceRecall === baseline.baselineV3SectionEvidenceRecall, metrics.BaselineV3SectionEvidenceRecall);
  check(failures, "SectionEvidenceRecall", metrics.SectionEvidenceRecall >= baseline.minimumSectionEvidenceRecall, metrics.SectionEvidenceRecall);
  check(failures, "SectionEvidenceRecallDelta", metrics.SectionEvidenceRecallDelta >= baseline.minimumSectionEvidenceRecallDelta, metrics.SectionEvidenceRecallDelta);
  check(failures, "sectionRecallInvariant", metrics.SectionEvidenceRecall >= metrics.BaselineV3SectionEvidenceRecall, `${metrics.BaselineV3SectionEvidenceRecall}->${metrics.SectionEvidenceRecall}`);
  check(failures, "GapReportingRate", metrics.GapReportingRate >= baseline.minimumGapReportingRate, metrics.GapReportingRate);
  check(failures, "RequiredEvidencePlanAccuracy", metrics.RequiredEvidencePlanAccuracy >= baseline.minimumRequiredEvidencePlanAccuracy, metrics.RequiredEvidencePlanAccuracy);
  check(failures, "SourceCoveragePercent", metrics.SourceCoveragePercent >= baseline.minimumSourceCoveragePercent, metrics.SourceCoveragePercent);
  check(failures, "ClaimsWithoutProvenance", metrics.ClaimsWithoutProvenanceEditorial <= baseline.maximumClaimsWithoutProvenance, metrics.ClaimsWithoutProvenanceEditorial);
  check(
    failures,
    "provenanceInvariant",
    metrics.ClaimsWithoutProvenanceEditorial <= metrics.ClaimsWithoutProvenanceBaseline,
    `${metrics.ClaimsWithoutProvenanceBaseline}->${metrics.ClaimsWithoutProvenanceEditorial}`
  );
  check(failures, "MaxContextTokens", metrics.MaxContextTokens <= baseline.maximumContextTokens, metrics.MaxContextTokens);
  check(failures, "TokenBudgetViolationCount", metrics.TokenBudgetViolationCount <= baseline.maximumTokenBudgetViolationCount, metrics.TokenBudgetViolationCount);
  check(failures, "FullGraphScanAttempts", metrics.FullGraphScanAttempts <= baseline.maximumFullGraphScanAttempts, metrics.FullGraphScanAttempts);
  check(failures, "FullSourceGrepAttempts", metrics.FullSourceGrepAttempts <= baseline.maximumFullSourceGrepAttempts, metrics.FullSourceGrepAttempts);
  check(
    failures,
    "FallbackUses",
    report.sections.filter((section) => section.fallbackUsed).length <= baseline.maximumFallbackUses,
    report.sections.filter((section) => section.fallbackUsed).length
  );

  for (const section of report.sections) {
    check(failures, `${section.id}.recallInvariant`, section.editorialRecall >= section.baselineV3Recall, `${section.baselineV3Recall}->${section.editorialRecall}`);
    check(failures, `${section.id}.gapExpected`, section.gapReported === section.expectedGap, section.gapReported);
    check(failures, `${section.id}.withinTokenBudget`, section.withinTokenBudget, `${section.contextTokens}/${section.tokenBudget}`);
    check(failures, `${section.id}.fullSourceGrep`, !section.fullSourceGrepAttempted, section.fullSourceGrepAttempted);
  }
  for (const document of report.documentQuality) {
    check(
      failures,
      `${document.name}.qualityInvariant`,
      document.editorialRecall >= document.baselineRecall,
      `${document.baselineRecall}->${document.editorialRecall}`
    );
    check(
      failures,
      `${document.name}.outputChars`,
      document.outputChars <= baseline.maximumDocumentOutputChars,
      document.outputChars
    );
  }

  if (failures.length > 0) {
    process.stderr.write(
      `\nEditorial Intelligence gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nEditorial Intelligence gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
