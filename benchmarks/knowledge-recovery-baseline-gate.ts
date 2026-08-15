import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KNOWLEDGE_RECOVERY_FIXTURE,
  evaluateKnowledgeRecovery,
} from "./knowledge-recovery-eval.js";

interface KnowledgeRecoveryBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  claimId: string;
  recoveryEventId: string;
  resolvedPagePath: string;
  uniqueRecoveryEventCount: number;
  duplicateEventOccurrences: number;
  initialLateRecoveryRate: number;
  maximumFinalLateRecoveryRate: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(
  HERE,
  "fixtures",
  "knowledge-recovery-baseline-v4.json"
);

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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_KNOWLEDGE_RECOVERY_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as KnowledgeRecoveryBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateKnowledgeRecovery(fixturePath);
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "claimId", report.claimId === baseline.claimId, report.claimId);
  check(failures, "recoveryEventId", report.recoveryEventId === baseline.recoveryEventId, report.recoveryEventId);
  check(failures, "recoveryStorePath", report.recoveryStorePath === "docs/evidence-ir/knowledge-recovery.json", report.recoveryStorePath);
  check(failures, "resolvedPagePath", report.resolvedPagePath === baseline.resolvedPagePath, report.resolvedPagePath);
  check(failures, "uniqueRecoveryEventCount", report.uniqueRecoveryEventCount === baseline.uniqueRecoveryEventCount, report.uniqueRecoveryEventCount);
  check(failures, "duplicateEventOccurrences", report.duplicateEventOccurrences === baseline.duplicateEventOccurrences, report.duplicateEventOccurrences);
  check(failures, "initialLateRecoveryRate", report.initialLateRecoveryRate === baseline.initialLateRecoveryRate, report.initialLateRecoveryRate);
  check(failures, "finalLateRecoveryRate", report.finalLateRecoveryRate <= baseline.maximumFinalLateRecoveryRate, report.finalLateRecoveryRate);
  check(failures, "lateRecoveryRateDecreased", report.lateRecoveryRateDecreased, report.lateRecoveryRateDecreased);
  check(failures, "pendingBeforeWriteback", report.pendingBeforeWriteback === 1, report.pendingBeforeWriteback);
  check(failures, "pendingAfterWriteback", report.pendingAfterWriteback === 0, report.pendingAfterWriteback);
  check(failures, "noAutomaticWikiRewrite", report.noAutomaticWikiRewrite, report.noAutomaticWikiRewrite);
  check(failures, "prematureResolutionBlocked", report.prematureResolutionBlocked, report.prematureResolutionBlocked);
  check(failures, "provenancePreserved", report.provenancePreserved, report.provenancePreserved);
  check(failures, "coverageLedgerUpdated", report.coverageLedgerUpdated, report.coverageLedgerUpdated);
  check(failures, "sourceCanonicalHashPreserved", report.sourceCanonicalHashPreserved, report.sourceCanonicalHashPreserved);
  check(failures, "finalResolution", report.finalResolution === "new_page", report.finalResolution);

  if (failures.length > 0) {
    process.stderr.write(
      `\nKnowledge recovery gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nKnowledge recovery gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
