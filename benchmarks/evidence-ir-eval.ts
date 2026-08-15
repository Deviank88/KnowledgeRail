import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceClaimId,
  type EvidenceClaimInput,
  type EvidenceClaimKind,
  type EvidenceClaimOrigin,
  type EvidenceRelationType,
} from "../src/core/ingestion/evidence-claim.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import {
  evidenceIrStatus,
  reconcileEvidenceCoverage,
  recordEvidenceClaims,
} from "../src/core/ingestion/evidence-pipeline.js";
import { evidenceIrStoreFile, readEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import {
  applyEvidenceSynthesis,
  evidenceSynthesisIsRebuildable,
} from "../src/core/ingestion/evidence-synthesis.js";
import { sourceCompilePlan, sourceCoverage } from "../src/core/ingestion/source-compiler.js";
import { sourceContentHash } from "../src/core/ingestion/source-segmentation.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import type { WikiPageType } from "../src/core/wiki-validation.js";

interface FixtureRelation {
  type: EvidenceRelationType;
  targetKey: string;
}

interface FixtureClaim {
  key: string;
  text: string;
  kind: EvidenceClaimKind;
  origin: EvidenceClaimOrigin;
  confidence: number;
  relations?: FixtureRelation[];
}

interface FixtureSource {
  key: string;
  uri: string;
  content: string;
  claims: FixtureClaim[];
}

interface EvidenceIrFixture {
  version: number;
  target: {
    entityKey: string;
    pagePath: string;
    pageTitle: string;
    pageType: WikiPageType;
  };
  sources: FixtureSource[];
}

export interface EvidenceIrEvaluationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  sourceCount: number;
  claimCount: number;
  orderedClaimIds: string[];
  durableStorePath: string;
  claimsWithProvenancePercent: number;
  originPreservationPercent: number;
  representedClaimsPercent: number;
  contradictionCount: number;
  contradictionResolutionRate: number;
  duplicateClaimCount: number;
  duplicateClaimRate: number;
  linkingErrorCount: number;
  extractionFailureDetected: boolean;
  linkingFailureDetected: boolean;
  synthesisFailureDetected: boolean;
  synthesisFailureEvidenceRetentionPercent: number;
  unsupportedSourceFactCount: number;
  synthesizedPageCount: number;
  synthesizedPagePaths: string[];
  rebuildableFromIr: boolean;
  rebuildContentMatchPercent: number;
  sourceCoveragePercent: number;
  unresolvedSegmentCount: number;
  sourceCanonicalHashesPreserved: boolean;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EVIDENCE_IR_FIXTURE = path.join(HERE, "fixtures", "evidence-ir-golden.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export async function evaluateEvidenceIr(
  fixturePath = DEFAULT_EVIDENCE_IR_FIXTURE
): Promise<EvidenceIrEvaluationReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as EvidenceIrFixture;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-ir-eval-"));
  const wikiRoot = path.join(root, "wiki");
  const segmentBySource = new Map<string, string>();
  const claimIdByKey = new Map<string, string>();
  const sourceHashesBefore = new Map<string, string>();
  let extractionFailureDetected = false;
  let linkingFailureDetected = false;
  let synthesisFailureDetected = false;

  try {
    for (const source of fixture.sources) {
      const absolute = path.join(root, source.uri);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, source.content, "utf8");
      sourceHashesBefore.set(source.uri, sourceContentHash(source.content));
      const plan = await sourceCompilePlan({
        wikiRoot,
        sourceUri: source.uri,
        content: source.content,
        segmentMaxChars: 4_096,
      });
      if (plan.ledger.segments.length !== 1) throw new Error(`${source.key} must have one golden segment.`);
      segmentBySource.set(source.uri, plan.ledger.segments[0]!.id);
    }

    for (const source of fixture.sources) {
      const segmentId = segmentBySource.get(source.uri)!;
      for (const claim of source.claims) {
        claimIdByKey.set(claim.key, evidenceClaimId({
          sourceUri: source.uri,
          segmentId,
          text: claim.text,
          kind: claim.kind,
          origin: claim.origin,
        }));
      }
    }

    const extractionProbeSource = fixture.sources[0]!;
    const extractionProbeClaim = extractionProbeSource.claims[0]!;
    try {
      await recordEvidenceClaims({
        wikiRoot,
        sourceUri: extractionProbeSource.uri,
        sourceContent: `${extractionProbeSource.content}\nstale`,
        segmentId: segmentBySource.get(extractionProbeSource.uri)!,
        claims: [{
          text: extractionProbeClaim.text,
          kind: extractionProbeClaim.kind,
          origin: extractionProbeClaim.origin,
          confidence: extractionProbeClaim.confidence,
          target: fixture.target,
        }],
      });
    } catch (error: unknown) {
      extractionFailureDetected = error instanceof Error && error.message.includes("Source changed");
      if (!extractionFailureDetected) throw error;
    }

    for (const source of fixture.sources) {
      const claims: EvidenceClaimInput[] = source.claims.map((claim) => ({
        text: claim.text,
        kind: claim.kind,
        origin: claim.origin,
        confidence: claim.confidence,
        target: fixture.target,
        relations: claim.relations?.map((relation) => ({
          type: relation.type,
          targetClaimId: claimIdByKey.get(relation.targetKey) ?? "missing",
        })),
      }));
      await recordEvidenceClaims({
        wikiRoot,
        sourceUri: source.uri,
        sourceContent: source.content,
        segmentId: segmentBySource.get(source.uri)!,
        claims,
      });
    }

    try {
      await resolveEvidenceClaims({ wikiRoot, claimIds: ["claim-00000000000000000000000000000000"] });
    } catch (error: unknown) {
      linkingFailureDetected = error instanceof Error && error.message.includes("Unknown evidence claim");
      if (!linkingFailureDetected) throw error;
    }
    const resolutions = await resolveEvidenceClaims({ wikiRoot });
    const beforeFailure = await readEvidenceIrStore(wikiRoot);
    try {
      await applyEvidenceSynthesis({ wikiRoot, failBeforeWrite: true });
      throw new Error("Injected synthesis failure did not fail.");
    } catch (error: unknown) {
      synthesisFailureDetected = error instanceof Error && error.message.includes("Injected synthesis failure");
      if (!synthesisFailureDetected) throw error;
    }
    const afterFailure = await readEvidenceIrStore(wikiRoot);
    const retainedClaims = beforeFailure.claims.filter((claim) =>
      afterFailure.claims.some((item) => JSON.stringify(item) === JSON.stringify(claim))
    ).length;

    const firstDrafts = await applyEvidenceSynthesis({ wikiRoot });
    await reconcileEvidenceCoverage(wikiRoot);
    const firstContents = new Map<string, string>();
    for (const draft of firstDrafts) {
      firstContents.set(draft.pagePath, await fs.readFile(path.join(wikiRoot, draft.pagePath), "utf8"));
    }
    const storeAfterSynthesis = await readEvidenceIrStore(wikiRoot);
    const status = await evidenceIrStatus(wikiRoot);
    const represented = storeAfterSynthesis.claims.filter((claim) => {
      const resolution = storeAfterSynthesis.resolutions.find((item) => item.claimId === claim.id);
      if (!resolution?.targetPagePath) return false;
      if (resolution.disposition === "duplicate") return firstContents.has(resolution.targetPagePath);
      return storeAfterSynthesis.syntheses.some((item) =>
        item.pagePath === resolution.targetPagePath && item.claimIds.includes(claim.id)
      );
    }).length;
    const unsupportedSourceFactCount = storeAfterSynthesis.claims.filter((claim) => {
      if (!(claim.origin === "inferred" || claim.origin === "synthesized" || claim.kind === "hypothesis" || claim.kind === "inference")) {
        return false;
      }
      const page = [...firstContents.values()].find((content) => content.includes(claim.id));
      return !page?.includes("non è un fatto esplicito della fonte");
    }).length;
    const contradictionResolutions = resolutions.filter((item) => item.disposition === "contradiction");
    const contradictionPreserved = contradictionResolutions.filter((resolution) => {
      const claim = storeAfterSynthesis.claims.find((item) => item.id === resolution.claimId);
      const targets = resolution.targetClaimIds.map((id) =>
        storeAfterSynthesis.claims.find((item) => item.id === id)
      );
      const page = resolution.targetPagePath ? firstContents.get(resolution.targetPagePath) : undefined;
      return Boolean(claim && targets.every(Boolean) && page?.includes(claim.text) && targets.every((item) => page.includes(item!.text)));
    }).length;

    for (const pagePath of firstContents.keys()) await fs.unlink(path.join(wikiRoot, pagePath));
    const rebuildableFromIr = await evidenceSynthesisIsRebuildable(wikiRoot);
    const rebuiltDrafts = await applyEvidenceSynthesis({ wikiRoot });
    let rebuildMatches = 0;
    for (const draft of rebuiltDrafts) {
      const rebuilt = await fs.readFile(path.join(wikiRoot, draft.pagePath), "utf8");
      if (rebuilt === firstContents.get(draft.pagePath)) rebuildMatches++;
    }
    const coverages = await Promise.all(fixture.sources.map((source) =>
      sourceCoverage({ wikiRoot, sourceUri: source.uri, content: source.content })
    ));
    const sourceCanonicalHashesPreserved = (await Promise.all(fixture.sources.map(async (source) =>
      sourceContentHash(await fs.readFile(path.join(root, source.uri), "utf8")) ===
        sourceHashesBefore.get(source.uri)
    ))).every(Boolean);
    const orderedClaimIds = storeAfterSynthesis.claims.map((claim) => claim.id).sort();
    const duplicateClaimCount = resolutions.filter((item) => item.disposition === "duplicate").length;
    const report: EvidenceIrEvaluationReport = {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      sourceCount: fixture.sources.length,
      claimCount: storeAfterSynthesis.claims.length,
      orderedClaimIds,
      durableStorePath: path.relative(root, evidenceIrStoreFile(wikiRoot)).replace(/\\/g, "/"),
      claimsWithProvenancePercent: status.claimsWithProvenancePercent,
      originPreservationPercent: fixture.sources.flatMap((source) => source.claims).filter((golden) => {
        const id = claimIdByKey.get(golden.key);
        return storeAfterSynthesis.claims.find((claim) => claim.id === id)?.origin === golden.origin;
      }).length / storeAfterSynthesis.claims.length * 100,
      representedClaimsPercent: represented / storeAfterSynthesis.claims.length * 100,
      contradictionCount: contradictionResolutions.length,
      contradictionResolutionRate: contradictionResolutions.length === 0
        ? 1
        : contradictionPreserved / contradictionResolutions.length,
      duplicateClaimCount,
      duplicateClaimRate: duplicateClaimCount / storeAfterSynthesis.claims.length,
      linkingErrorCount: status.unresolvedLinkCount,
      extractionFailureDetected,
      linkingFailureDetected,
      synthesisFailureDetected,
      synthesisFailureEvidenceRetentionPercent: retainedClaims / beforeFailure.claims.length * 100,
      unsupportedSourceFactCount,
      synthesizedPageCount: firstContents.size,
      synthesizedPagePaths: [...firstContents.keys()].sort(),
      rebuildableFromIr,
      rebuildContentMatchPercent: firstContents.size === 0 ? 100 : rebuildMatches / firstContents.size * 100,
      sourceCoveragePercent: coverages.reduce((sum, item) => sum + item.metrics.sourceCoveragePercent, 0) / coverages.length,
      unresolvedSegmentCount: coverages.reduce((sum, item) => sum + item.metrics.unresolvedSegmentCount, 0),
      sourceCanonicalHashesPreserved,
    };
    process.stdout.write(
      `Evidence IR fixture: ${report.sourceCount} sources, ${report.claimCount} claims, ` +
      `${report.synthesizedPageCount} synthesized page(s)\n`
    );
    process.stdout.write(
      `SUMMARY provenance=${report.claimsWithProvenancePercent.toFixed(2)} ` +
      `origin=${report.originPreservationPercent.toFixed(2)} ` +
      `represented=${report.representedClaimsPercent.toFixed(2)} ` +
      `linkingErrors=${report.linkingErrorCount} ` +
      `contradictionResolution=${report.contradictionResolutionRate.toFixed(4)} ` +
      `failureRetention=${report.synthesisFailureEvidenceRetentionPercent.toFixed(2)} ` +
      `rebuildMatch=${report.rebuildContentMatchPercent.toFixed(2)}\n`
    );
    return report;
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_EVIDENCE_IR_FIXTURE);
  const report = await evaluateEvidenceIr(fixturePath);
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
