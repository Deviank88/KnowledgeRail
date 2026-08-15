import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOURCE_COVERAGE_FIXTURE,
  evaluateSourceCoverage,
} from "./source-coverage-eval.js";

interface SourceCoverageBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  sourceChars: number;
  segmentMaxChars: number;
  segmentCount: number;
  finalSegmentId: string;
  minimumRelevantMarkerOffsetPercent: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "source-coverage-baseline-v4.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(
  failures: string[],
  label: string,
  passed: boolean,
  actual: string | number | boolean
): void {
  process.stdout.write(`GATE ${label}=${actual} ${passed ? "PASS" : "FAIL"}\n`);
  if (!passed) failures.push(`${label} failed (actual: ${actual}).`);
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argValue("baseline") ?? DEFAULT_BASELINE);
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_SOURCE_COVERAGE_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as SourceCoverageBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateSourceCoverage(fixturePath);
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "sourceChars", report.sourceChars === baseline.sourceChars && report.sourceChars > 100_000, report.sourceChars);
  check(failures, "segmentMaxChars", report.segmentMaxChars === baseline.segmentMaxChars, report.segmentMaxChars);
  check(failures, "segmentCount", report.segmentCount === baseline.segmentCount, report.segmentCount);
  check(failures, "finalSegmentId", report.finalSegmentId === baseline.finalSegmentId, report.finalSegmentId);
  check(
    failures,
    "relevantMarkerOffsetPercent",
    report.relevantMarkerOffsetPercent >= baseline.minimumRelevantMarkerOffsetPercent,
    report.relevantMarkerOffsetPercent.toFixed(4)
  );
  check(failures, "maximumObservedSegmentChars", report.maximumObservedSegmentChars <= report.segmentMaxChars, report.maximumObservedSegmentChars);
  check(failures, "sourceAccountingComplete", report.sourceAccountingComplete, report.sourceAccountingComplete);
  check(failures, "unknownCoverageRejected", report.unknownCoverageRejected, report.unknownCoverageRejected);
  check(failures, "prematureFinalizeBlocked", report.prematureFinalizeBlocked, report.prematureFinalizeBlocked);
  check(failures, "finalSegmentDiscovered", report.finalSegmentDiscovered, report.finalSegmentDiscovered);
  check(failures, "coverageBeforeFinalSegment", report.beforeFinalSegment.sourceCoveragePercent < 100, report.beforeFinalSegment.sourceCoveragePercent);
  check(failures, "unresolvedBeforeFinalSegment", report.beforeFinalSegment.unresolvedSegmentCount > 0, report.beforeFinalSegment.unresolvedSegmentCount);
  check(failures, "unrepresentedBeforeFinalSegment", report.beforeFinalSegment.unrepresentedEvidenceCount > 0, report.beforeFinalSegment.unrepresentedEvidenceCount);
  check(failures, "sourceCoveragePercent", report.final.sourceCoveragePercent === 100, report.final.sourceCoveragePercent);
  check(failures, "unresolvedSegmentCount", report.final.unresolvedSegmentCount === 0, report.final.unresolvedSegmentCount);
  check(failures, "unrepresentedEvidenceCount", report.final.unrepresentedEvidenceCount === 0, report.final.unrepresentedEvidenceCount);
  check(failures, "segmentsProcessed", report.final.segmentsProcessed === report.segmentCount, report.final.segmentsProcessed);
  check(failures, "segmentsIgnoredWithReason", report.final.segmentsIgnoredWithReason === report.segmentCount - 1, report.final.segmentsIgnoredWithReason);
  check(failures, "finalEvidenceRefs", report.finalEvidenceRefs.length > 0, report.finalEvidenceRefs.length);
  check(failures, "finalPageRefs", report.finalPageRefs.length > 0, report.finalPageRefs.length);
  check(failures, "retrievalRecovered", report.retrievalRecovered, report.retrievalRecovered);
  check(failures, "retrievalUsedSourceFallback", !report.retrievalUsedSourceFallback, report.retrievalUsedSourceFallback);

  if (failures.length > 0) {
    process.stderr.write(
      `\nSource coverage compiler gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nSource coverage compiler gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
