import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LEGACY_MIGRATION_FIXTURE,
  evaluateLegacyMigration,
} from "./legacy-migration-eval.js";

interface LegacyMigrationBaseline {
  version: number;
  fixtureVersion: number;
  fixtureSha256: string;
  sourceVersions: number[];
  minimumCanonicalPreservationRate: number;
  minimumCustomMetadataPreservationRate: number;
  minimumBackupCompletenessRate: number;
  maximumDryRunWriteCount: number;
  minimumTargetV4Rate: number;
  minimumRollbackRecoveryRate: number;
  minimumPageCountPreservationRate: number;
  minimumSourceCountPreservationRate: number;
  minimumGraphLinkPreservationRate: number;
  minimumRetrievalRecallBefore: number;
  minimumRetrievalRecallAfter: number;
  minimumDocumentRecallBefore: number;
  minimumDocumentRecallAfter: number;
  minimumLegacyUnverifiedBackfillRate: number;
  minimumUnknownSourceTrackingRate: number;
  maximumEnrichmentProposalCount: number;
  minimumJournalCompletionRate: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, "fixtures", "legacy-migration-baseline-v4.json");

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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_LEGACY_MIGRATION_FIXTURE);
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as LegacyMigrationBaseline;
  const fixtureBytes = await fs.readFile(fixturePath);
  const report = await evaluateLegacyMigration(fixturePath);
  const metrics = report.metrics;
  const failures: string[] = [];

  check(failures, "fixtureVersion", report.fixtureVersion === baseline.fixtureVersion, report.fixtureVersion);
  check(failures, "fixtureSha256", digest(fixtureBytes) === baseline.fixtureSha256, digest(fixtureBytes));
  check(failures, "sourceVersions", JSON.stringify(report.sourceVersions) === JSON.stringify(baseline.sourceVersions), report.sourceVersions.join(","));
  check(failures, "CanonicalPreservationRate", metrics.CanonicalPreservationRate >= baseline.minimumCanonicalPreservationRate, metrics.CanonicalPreservationRate);
  check(failures, "CustomMetadataPreservationRate", metrics.CustomMetadataPreservationRate >= baseline.minimumCustomMetadataPreservationRate, metrics.CustomMetadataPreservationRate);
  check(failures, "BackupCompletenessRate", metrics.BackupCompletenessRate >= baseline.minimumBackupCompletenessRate, metrics.BackupCompletenessRate);
  check(failures, "DryRunWriteCount", metrics.DryRunWriteCount <= baseline.maximumDryRunWriteCount, metrics.DryRunWriteCount);
  check(failures, "TargetV4Rate", metrics.TargetV4Rate >= baseline.minimumTargetV4Rate, metrics.TargetV4Rate);
  check(failures, "RollbackRecoveryRate", metrics.RollbackRecoveryRate >= baseline.minimumRollbackRecoveryRate, metrics.RollbackRecoveryRate);
  check(failures, "PageCountPreservationRate", metrics.PageCountPreservationRate >= baseline.minimumPageCountPreservationRate, metrics.PageCountPreservationRate);
  check(failures, "SourceCountPreservationRate", metrics.SourceCountPreservationRate >= baseline.minimumSourceCountPreservationRate, metrics.SourceCountPreservationRate);
  check(failures, "GraphLinkPreservationRate", metrics.GraphLinkPreservationRate >= baseline.minimumGraphLinkPreservationRate, metrics.GraphLinkPreservationRate);
  check(failures, "RetrievalRecallBefore", metrics.RetrievalRecallBefore >= baseline.minimumRetrievalRecallBefore, metrics.RetrievalRecallBefore);
  check(failures, "RetrievalRecallAfter", metrics.RetrievalRecallAfter >= baseline.minimumRetrievalRecallAfter, metrics.RetrievalRecallAfter);
  check(failures, "retrievalInvariant", metrics.RetrievalRecallAfter >= metrics.RetrievalRecallBefore, `${metrics.RetrievalRecallBefore}->${metrics.RetrievalRecallAfter}`);
  check(failures, "DocumentRecallBefore", metrics.DocumentRecallBefore >= baseline.minimumDocumentRecallBefore, metrics.DocumentRecallBefore);
  check(failures, "DocumentRecallAfter", metrics.DocumentRecallAfter >= baseline.minimumDocumentRecallAfter, metrics.DocumentRecallAfter);
  check(failures, "documentInvariant", metrics.DocumentRecallAfter >= metrics.DocumentRecallBefore, `${metrics.DocumentRecallBefore}->${metrics.DocumentRecallAfter}`);
  check(failures, "LegacyUnverifiedBackfillRate", metrics.LegacyUnverifiedBackfillRate >= baseline.minimumLegacyUnverifiedBackfillRate, metrics.LegacyUnverifiedBackfillRate);
  check(failures, "UnknownSourceTrackingRate", metrics.UnknownSourceTrackingRate >= baseline.minimumUnknownSourceTrackingRate, metrics.UnknownSourceTrackingRate);
  check(failures, "EnrichmentProposalCount", metrics.EnrichmentProposalCount <= baseline.maximumEnrichmentProposalCount, metrics.EnrichmentProposalCount);
  check(failures, "JournalCompletionRate", metrics.JournalCompletionRate >= baseline.minimumJournalCompletionRate, metrics.JournalCompletionRate);

  for (const item of report.cases) {
    check(failures, `v${item.sourceVersion}.canonical`, item.canonicalPreserved, item.canonicalPreserved);
    check(failures, `v${item.sourceVersion}.customMetadata`, item.customMetadataPreserved, item.customMetadataPreserved);
    check(failures, `v${item.sourceVersion}.backup`, item.backupComplete, item.backupComplete);
    check(failures, `v${item.sourceVersion}.target`, item.targetVersion === 4, item.targetVersion);
    check(failures, `v${item.sourceVersion}.rollback`, item.rollbackComplete && item.rollbackVersion === item.sourceVersion, item.rollbackVersion);
  }

  if (failures.length > 0) {
    process.stderr.write(`\nLegacy migration gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nLegacy migration gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
