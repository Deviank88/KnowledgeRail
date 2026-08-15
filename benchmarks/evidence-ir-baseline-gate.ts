import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EVIDENCE_IR_FIXTURE,
  evaluateEvidenceIr,
} from "./evidence-ir-eval.js";

interface EvidenceIrBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  sourceCount: number;
  claimCount: number;
  orderedClaimIds: string[];
  synthesizedPagePaths: string[];
  duplicateClaimCount: number;
  contradictionCount: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "evidence-ir-baseline-v4.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_EVIDENCE_IR_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as EvidenceIrBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateEvidenceIr(fixturePath);
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "sourceCount", report.sourceCount === baseline.sourceCount, report.sourceCount);
  check(failures, "claimCount", report.claimCount === baseline.claimCount, report.claimCount);
  check(failures, "orderedClaimIds", sameValues(report.orderedClaimIds, baseline.orderedClaimIds), report.orderedClaimIds.join(","));
  check(failures, "synthesizedPagePaths", sameValues(report.synthesizedPagePaths, baseline.synthesizedPagePaths), report.synthesizedPagePaths.join(","));
  check(failures, "durableStorePath", report.durableStorePath === "docs/evidence-ir/store.json", report.durableStorePath);
  check(failures, "claimsWithProvenancePercent", report.claimsWithProvenancePercent === 100, report.claimsWithProvenancePercent);
  check(failures, "originPreservationPercent", report.originPreservationPercent === 100, report.originPreservationPercent);
  check(failures, "representedClaimsPercent", report.representedClaimsPercent === 100, report.representedClaimsPercent);
  check(failures, "contradictionCount", report.contradictionCount === baseline.contradictionCount, report.contradictionCount);
  check(failures, "contradictionResolutionRate", report.contradictionResolutionRate === 1, report.contradictionResolutionRate);
  check(failures, "duplicateClaimCount", report.duplicateClaimCount === baseline.duplicateClaimCount, report.duplicateClaimCount);
  check(failures, "linkingErrorCount", report.linkingErrorCount === 0, report.linkingErrorCount);
  check(failures, "extractionFailureDetected", report.extractionFailureDetected, report.extractionFailureDetected);
  check(failures, "linkingFailureDetected", report.linkingFailureDetected, report.linkingFailureDetected);
  check(failures, "synthesisFailureDetected", report.synthesisFailureDetected, report.synthesisFailureDetected);
  check(failures, "synthesisFailureEvidenceRetentionPercent", report.synthesisFailureEvidenceRetentionPercent === 100, report.synthesisFailureEvidenceRetentionPercent);
  check(failures, "unsupportedSourceFactCount", report.unsupportedSourceFactCount === 0, report.unsupportedSourceFactCount);
  check(failures, "rebuildableFromIr", report.rebuildableFromIr, report.rebuildableFromIr);
  check(failures, "rebuildContentMatchPercent", report.rebuildContentMatchPercent === 100, report.rebuildContentMatchPercent);
  check(failures, "sourceCoveragePercent", report.sourceCoveragePercent === 100, report.sourceCoveragePercent);
  check(failures, "unresolvedSegmentCount", report.unresolvedSegmentCount === 0, report.unresolvedSegmentCount);
  check(failures, "sourceCanonicalHashesPreserved", report.sourceCanonicalHashesPreserved, report.sourceCanonicalHashesPreserved);

  if (failures.length > 0) {
    process.stderr.write(`\nEvidence IR gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nEvidence IR gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
