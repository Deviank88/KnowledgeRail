import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceClaimId,
  type EvidenceClaimInput,
} from "../src/core/ingestion/evidence-claim.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { applyEvidenceSynthesis } from "../src/core/ingestion/evidence-synthesis.js";
import {
  sourceCompilePlan,
  sourceCoverage,
} from "../src/core/ingestion/source-compiler.js";
import { sourceContentHash } from "../src/core/ingestion/source-segmentation.js";
import {
  knowledgeRecoveryStatus,
  knowledgeRecoveryStoreFile,
  recordKnowledgeRecoveryUsage,
  resolveKnowledgeRecoveryEvent,
  type KnowledgeRecoveryDiscoveryMethod,
} from "../src/core/knowledge-recovery.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

interface KnowledgeRecoveryFixture {
  version: number;
  source: { uri: string; content: string };
  claim: EvidenceClaimInput;
  discovery: {
    discoveredBy: KnowledgeRecoveryDiscoveryMethod;
    reason: string;
  };
  firstUsageEvidenceCount: number;
  duplicateUsageEvidenceCount: number;
  representedUsageEvidenceCount: number;
}

export interface KnowledgeRecoveryEvaluationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  claimId: string;
  recoveryEventId: string;
  recoveryStorePath: string;
  uniqueRecoveryEventCount: number;
  duplicateEventOccurrences: number;
  initialLateRecoveryRate: number;
  finalLateRecoveryRate: number;
  lateRecoveryRateDecreased: boolean;
  pendingBeforeWriteback: number;
  pendingAfterWriteback: number;
  noAutomaticWikiRewrite: boolean;
  prematureResolutionBlocked: boolean;
  provenancePreserved: boolean;
  coverageLedgerUpdated: boolean;
  sourceCanonicalHashPreserved: boolean;
  resolvedPagePath: string;
  finalResolution: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KNOWLEDGE_RECOVERY_FIXTURE = path.join(
  HERE,
  "fixtures",
  "knowledge-recovery-golden.json"
);

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export async function evaluateKnowledgeRecovery(
  fixturePath = DEFAULT_KNOWLEDGE_RECOVERY_FIXTURE
): Promise<KnowledgeRecoveryEvaluationReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as KnowledgeRecoveryFixture;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-eval-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceFile = path.join(root, fixture.source.uri);
  const pagePath = fixture.claim.target?.pagePath;
  if (!pagePath) throw new Error("Knowledge recovery golden claim requires a target page path.");

  try {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, fixture.source.content, "utf8");
    const sourceHash = sourceContentHash(fixture.source.content);
    const plan = await sourceCompilePlan({
      wikiRoot,
      sourceUri: fixture.source.uri,
      content: fixture.source.content,
      segmentMaxChars: 4_096,
    });
    if (plan.ledger.segments.length !== 1) {
      throw new Error("Knowledge recovery golden source must have exactly one segment.");
    }
    const segmentId = plan.ledger.segments[0]!.id;
    const claimId = evidenceClaimId({
      sourceUri: fixture.source.uri,
      segmentId,
      text: fixture.claim.text,
      kind: fixture.claim.kind,
      origin: fixture.claim.origin,
    });
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri: fixture.source.uri,
      sourceContent: fixture.source.content,
      segmentId,
      claims: [fixture.claim],
    });
    const event = {
      evidenceRef: claimId,
      sourceUri: fixture.source.uri,
      discoveredBy: fixture.discovery.discoveredBy,
      expectedWikiPages: [pagePath],
      reason: fixture.discovery.reason,
    } as const;
    const first = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: fixture.firstUsageEvidenceCount,
      events: [event],
      timestamp: "2026-08-14T10:00:00.000Z",
    });
    const repeated = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: fixture.duplicateUsageEvidenceCount,
      events: [event],
      timestamp: "2026-08-14T10:01:00.000Z",
    });
    const before = await knowledgeRecoveryStatus(wikiRoot);
    let noAutomaticWikiRewrite = false;
    try {
      await fs.access(path.join(wikiRoot, pagePath));
    } catch {
      noAutomaticWikiRewrite = true;
    }
    let prematureResolutionBlocked = false;
    try {
      await resolveKnowledgeRecoveryEvent({
        wikiRoot,
        eventId: first.events[0]!.id,
        resolution: "new_page",
        pageRefs: [pagePath],
        reason: "Premature gate probe.",
      });
    } catch {
      prematureResolutionBlocked = true;
    }

    await resolveEvidenceClaims({ wikiRoot, claimIds: [claimId] });
    await applyEvidenceSynthesis({ wikiRoot, claimIds: [claimId] });
    const resolved = await resolveKnowledgeRecoveryEvent({
      wikiRoot,
      eventId: first.events[0]!.id,
      resolution: "new_page",
      pageRefs: [pagePath],
      reason: "Validated Evidence IR synthesis represented the recovered requirement.",
      timestamp: "2026-08-14T10:02:00.000Z",
    });
    const page = await fs.readFile(path.join(wikiRoot, pagePath), "utf8");
    const coverage = await sourceCoverage({
      wikiRoot,
      sourceUri: fixture.source.uri,
      content: fixture.source.content,
    });
    const segment = coverage.ledger.segments.find((item) => item.id === segmentId);
    const afterRepresentedUsage = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: fixture.representedUsageEvidenceCount,
      events: [],
      timestamp: "2026-08-14T10:03:00.000Z",
    });
    const after = await knowledgeRecoveryStatus(wikiRoot);
    const report: KnowledgeRecoveryEvaluationReport = {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      claimId,
      recoveryEventId: first.events[0]!.id,
      recoveryStorePath: path.relative(root, knowledgeRecoveryStoreFile(wikiRoot)).replace(/\\/g, "/"),
      uniqueRecoveryEventCount: repeated.metrics.uniqueRecoveryEventCount,
      duplicateEventOccurrences: repeated.events[0]!.occurrences,
      initialLateRecoveryRate: before.metrics.lateRecoveryRate,
      finalLateRecoveryRate: afterRepresentedUsage.metrics.lateRecoveryRate,
      lateRecoveryRateDecreased:
        afterRepresentedUsage.metrics.lateRecoveryRate < before.metrics.lateRecoveryRate,
      pendingBeforeWriteback: before.metrics.knowledgeRecoveryPending,
      pendingAfterWriteback: after.metrics.knowledgeRecoveryPending,
      noAutomaticWikiRewrite,
      prematureResolutionBlocked,
      provenancePreserved:
        page.includes(claimId) && page.includes(`${fixture.source.uri}#${segmentId}`),
      coverageLedgerUpdated: Boolean(
        segment?.status === "integrated" &&
        segment.evidenceRefs.includes(claimId) &&
        segment.pageRefs.includes(pagePath)
      ),
      sourceCanonicalHashPreserved:
        sourceContentHash(await fs.readFile(sourceFile, "utf8")) === sourceHash,
      resolvedPagePath: resolved.event.pageRefs[0] ?? "",
      finalResolution: resolved.event.resolution,
    };
    process.stdout.write(
      `Knowledge recovery fixture: debt=${report.uniqueRecoveryEventCount}, ` +
      `occurrences=${report.duplicateEventOccurrences}, pending ${report.pendingBeforeWriteback}->${report.pendingAfterWriteback}\n`
    );
    process.stdout.write(
      `SUMMARY LateRecoveryRate ${report.initialLateRecoveryRate.toFixed(4)}->${report.finalLateRecoveryRate.toFixed(4)} ` +
      `provenance=${report.provenancePreserved} coverage=${report.coverageLedgerUpdated} ` +
      `noAutoRewrite=${report.noAutomaticWikiRewrite}\n`
    );
    return report;
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_KNOWLEDGE_RECOVERY_FIXTURE);
  const report = await evaluateKnowledgeRecovery(fixturePath);
  const outputPath = argValue("json");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`JSON written to ${resolved}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
