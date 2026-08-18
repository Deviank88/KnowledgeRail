import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { safeResolveWithin } from "../paths.js";
import { captureCodeAnchor } from "../code-evidence/code-anchor.js";
import { PersistentCodeEvidenceIndex } from "../code-evidence/index.js";
import { parseCodeResourceUri } from "../code-evidence/resource-uri.js";
import type { CodeAnchor } from "../code-evidence/types.js";
import { readSourceCoverageLedger } from "./coverage-ledger.js";
import {
  createEvidenceClaim,
  type EvidenceClaim,
  type EvidenceClaimInput,
} from "./evidence-claim.js";
import { mutateEvidenceIrStore, readEvidenceIrStore } from "./evidence-store.js";
import { recomputeEvidenceClaimStatuses } from "./evidence-linker.js";
import { sourceRecordSegment } from "./source-compiler.js";
import { sourceContentHash } from "./source-segmentation.js";

function sameImmutableClaim(left: EvidenceClaim, right: EvidenceClaim): boolean {
  return left.id === right.id && left.sourceUri === right.sourceUri &&
    left.segmentId === right.segmentId && left.text === right.text &&
    left.kind === right.kind && left.origin === right.origin;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiresCompleteCodeIndexRefresh(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("parser version changed") || message.includes("Cannot read code evidence index");
}

async function refreshCodeTargetPaths(
  index: PersistentCodeEvidenceIndex,
  paths: readonly string[]
): Promise<Map<string, string>> {
  const uniquePaths = [...new Set(paths)].sort();
  const failures = new Map<string, string>();
  for (const targetPath of uniquePaths) {
    try {
      await index.updateFile(targetPath);
    } catch (error: unknown) {
      if (requiresCompleteCodeIndexRefresh(error)) {
        try {
          await index.rebuild();
          return failures;
        } catch (rebuildError: unknown) {
          const message = `Code anchor index recovery failed: ${errorMessage(rebuildError)}`;
          for (const path of uniquePaths) failures.set(path, message);
          return failures;
        }
      }
      failures.set(targetPath, errorMessage(error));
    }
  }
  return failures;
}

export async function recordEvidenceClaims(params: {
  wikiRoot: string;
  sourceUri: string;
  sourceContent: string;
  segmentId: string;
  claims: readonly EvidenceClaimInput[];
}): Promise<{ claims: EvidenceClaim[]; created: number; reused: number; anchorWarnings: string[] }> {
  if (params.claims.length === 0) throw new Error("At least one evidence claim is required.");
  const ledger = await readSourceCoverageLedger(params.wikiRoot, params.sourceUri);
  if (!ledger) throw new Error("Source coverage is unknown; plan the source before extracting evidence.");
  if (ledger.sourceHash !== sourceContentHash(params.sourceContent)) {
    throw new Error("Source changed after the coverage plan; re-plan before extracting evidence.");
  }
  const segment = ledger.segments.find((item) => item.id === params.segmentId);
  if (!segment) throw new Error(`Evidence provenance references an unknown segment: ${params.segmentId}.`);
  if (sourceContentHash(params.sourceContent.slice(segment.start, segment.end)) !== segment.hash) {
    throw new Error(`Evidence provenance segment failed its integrity check: ${params.segmentId}.`);
  }

  const now = new Date().toISOString();
  const repositoryRoot = path.dirname(path.resolve(params.wikiRoot));
  const capturedAnchors = new Map<number, CodeAnchor>();
  const anchorWarnings: string[] = [];
  const targetedClaims = params.claims
    .map((claim, index) => ({ claim, index }))
    .filter(({ claim }) => Boolean(claim.target?.codeResourceUri));
  if (targetedClaims.length > 0) {
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot: params.wikiRoot });
    const parsedTargets = new Map<number, { path: string; resourceUri: string }>();
    for (const targeted of targetedClaims) {
      const resourceUri = targeted.claim.target!.codeResourceUri!;
      try {
        parsedTargets.set(targeted.index, {
          path: parseCodeResourceUri(resourceUri, { allowWorkspaceBinding: false }).path,
          resourceUri,
        });
      } catch (error: unknown) {
        anchorWarnings.push(`Claim ${targeted.index + 1} code target was not anchored: ${errorMessage(error)}`);
      }
    }
    const refreshFailures = await refreshCodeTargetPaths(
      index,
      [...parsedTargets.values()].map((target) => target.path)
    );
    for (const targeted of targetedClaims) {
      const target = parsedTargets.get(targeted.index);
      if (!target) continue;
      const refreshFailure = refreshFailures.get(target.path);
      if (refreshFailure) {
        anchorWarnings.push(
          `Claim ${targeted.index + 1} code target was not anchored: ` +
          `Code evidence target is not indexed or readable: ${target.resourceUri} (${refreshFailure})`
        );
        continue;
      }
      try {
        capturedAnchors.set(targeted.index, await captureCodeAnchor({
          repositoryRoot,
          wikiRoot: params.wikiRoot,
          resourceUri: target.resourceUri,
          capturedAt: now,
        }));
      } catch (error: unknown) {
        anchorWarnings.push(`Claim ${targeted.index + 1} code target was not anchored: ${errorMessage(error)}`);
      }
    }
  }

  await sourceRecordSegment({
    wikiRoot: params.wikiRoot,
    sourceUri: params.sourceUri,
    content: params.sourceContent,
    segmentId: params.segmentId,
    resolution: {
      status: "unresolved",
      reason: "evidence_ir_record_pending",
    },
  });

  const result = await mutateEvidenceIrStore(params.wikiRoot, (store) => {
    const byId = new Map(store.claims.map((claim) => [claim.id, claim] as const));
    const recorded: EvidenceClaim[] = [];
    let created = 0;
    let reused = 0;
    for (const [inputIndex, input] of params.claims.entries()) {
      const candidate = createEvidenceClaim({
        sourceUri: params.sourceUri,
        segmentId: params.segmentId,
        input,
        codeAnchor: capturedAnchors.get(inputIndex),
        now,
      });
      const existing = byId.get(candidate.id);
      if (existing) {
        if (!sameImmutableClaim(existing, candidate)) {
          throw new Error(`Evidence claim identity collision: ${candidate.id}.`);
        }
        const previousCodeTarget = existing.target?.codeResourceUri;
        existing.target = candidate.target;
        if (candidate.codeAnchor) existing.codeAnchor = candidate.codeAnchor;
        else if (!candidate.target?.codeResourceUri || candidate.target.codeResourceUri !== previousCodeTarget) {
          delete existing.codeAnchor;
        }
        existing.relations = candidate.relations;
        existing.confidence = candidate.confidence;
        existing.status = candidate.status;
        existing.updatedAt = now;
        recorded.push(existing);
        reused++;
      } else {
        store.claims.push(candidate);
        byId.set(candidate.id, candidate);
        recorded.push(candidate);
        created++;
      }
    }
    store.claims.sort((a, b) => a.id.localeCompare(b.id));
    const recordedIds = new Set(recorded.map((claim) => claim.id));
    const invalidatedResolutionIds = new Set(store.resolutions
      .filter((item) => recordedIds.has(item.claimId) || item.targetClaimIds.some((id) => recordedIds.has(id)))
      .map((item) => item.claimId));
    store.resolutions = store.resolutions.filter((item) => !invalidatedResolutionIds.has(item.claimId));
    store.syntheses = store.syntheses.filter((item) =>
      !item.claimIds.some((claimId) => recordedIds.has(claimId) || invalidatedResolutionIds.has(claimId))
    );
    recomputeEvidenceClaimStatuses(store, now);
    return {
      claims: recorded,
      created,
      reused,
      segmentClaimIds: store.claims
        .filter((claim) => claim.sourceUri === recorded[0]!.sourceUri && claim.segmentId === params.segmentId)
        .map((claim) => claim.id)
        .sort(),
    };
  });
  await sourceRecordSegment({
    wikiRoot: params.wikiRoot,
    sourceUri: params.sourceUri,
    content: params.sourceContent,
    segmentId: params.segmentId,
    resolution: {
      status: "unresolved",
      evidenceRefs: result.segmentClaimIds,
      reason: "evidence_ir_link_pending",
    },
  });
  return { claims: result.claims, created: result.created, reused: result.reused, anchorWarnings };
}

export async function backfillEvidenceCodeAnchors(wikiRoot: string): Promise<{
  eligible: number;
  anchored: number;
  unresolved: number;
  warnings: string[];
}> {
  const snapshot = await readEvidenceIrStore(wikiRoot);
  const eligible = snapshot.claims.filter((claim) =>
    Boolean(claim.target?.codeResourceUri) && claim.codeAnchor === undefined
  );
  if (eligible.length === 0) return { eligible: 0, anchored: 0, unresolved: 0, warnings: [] };

  const repositoryRoot = path.dirname(path.resolve(wikiRoot));
  const capturedAt = new Date().toISOString();
  const captured = new Map<string, { anchor: CodeAnchor; resourceUri: string }>();
  const warnings: string[] = [];
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
  const parsedTargets = new Map<string, { path: string; resourceUri: string }>();
  for (const claim of eligible) {
    const resourceUri = claim.target!.codeResourceUri!;
    try {
      parsedTargets.set(claim.id, {
        path: parseCodeResourceUri(resourceUri, { allowWorkspaceBinding: false }).path,
        resourceUri,
      });
    } catch (error: unknown) {
      warnings.push(`${claim.id} was not anchored: ${errorMessage(error)}`);
    }
  }
  const refreshFailures = await refreshCodeTargetPaths(
    index,
    [...parsedTargets.values()].map((target) => target.path)
  );
  for (const claim of eligible) {
    const target = parsedTargets.get(claim.id);
    if (!target) continue;
    const refreshFailure = refreshFailures.get(target.path);
    if (refreshFailure) {
      warnings.push(`${claim.id} was not anchored: Code evidence target is not indexed or readable: ` +
        `${target.resourceUri} (${refreshFailure})`);
      continue;
    }
    try {
      captured.set(claim.id, {
        resourceUri: target.resourceUri,
        anchor: await captureCodeAnchor({
          repositoryRoot,
          wikiRoot,
          resourceUri: target.resourceUri,
          capturedAt,
        }),
      });
    } catch (error: unknown) {
      warnings.push(`${claim.id} was not anchored: ${errorMessage(error)}`);
    }
  }

  let anchored = 0;
  if (captured.size > 0) {
    await mutateEvidenceIrStore(wikiRoot, (store) => {
      for (const claim of store.claims) {
        const candidate = captured.get(claim.id);
        if (
          !candidate || claim.codeAnchor ||
          claim.target?.codeResourceUri !== candidate.resourceUri
        ) continue;
        claim.codeAnchor = candidate.anchor;
        claim.updatedAt = capturedAt;
        anchored++;
      }
    });
  }
  if (anchored < captured.size) {
    warnings.push(`${captured.size - anchored} claim(s) changed while code anchors were being backfilled.`);
  }
  return {
    eligible: eligible.length,
    anchored,
    unresolved: eligible.length - anchored,
    warnings,
  };
}

export async function evidenceIrStatus(wikiRoot: string): Promise<{
  claimCount: number;
  claimsWithProvenancePercent: number;
  unresolvedLinkCount: number;
  contradictionCount: number;
  synthesisCount: number;
}> {
  const store = await readEvidenceIrStore(wikiRoot);
  const linked = new Set(store.resolutions.map((item) => item.claimId));
  return {
    claimCount: store.claims.length,
    claimsWithProvenancePercent: store.claims.length === 0
      ? 100
      : store.claims.filter((claim) => claim.sourceUri && claim.segmentId).length / store.claims.length * 100,
    unresolvedLinkCount: store.claims.filter((claim) => !linked.has(claim.id)).length +
      store.resolutions.filter((item) => item.disposition === "ambiguous").length,
    contradictionCount: store.resolutions.filter((item) => item.disposition === "contradiction").length,
    synthesisCount: store.syntheses.length,
  };
}

export async function reconcileEvidenceCoverage(wikiRoot: string): Promise<{
  segmentsRecorded: number;
  segmentsPending: number;
}> {
  const store = await readEvidenceIrStore(wikiRoot);
  const workspaceRoot = path.dirname(path.resolve(wikiRoot));
  const resolutionByClaim = new Map(store.resolutions.map((item) => [item.claimId, item] as const));
  const synthesisByClaim = new Map<string, typeof store.syntheses[number]>();
  for (const synthesis of store.syntheses) {
    for (const claimId of synthesis.claimIds) synthesisByClaim.set(claimId, synthesis);
  }
  const pageValidity = new Map<string, boolean>();
  const pageIsCurrent = async (pagePath: string): Promise<boolean> => {
    const cached = pageValidity.get(pagePath);
    if (cached !== undefined) return cached;
    const synthesis = store.syntheses.find((item) => item.pagePath === pagePath);
    if (!synthesis) {
      try {
        const stat = await fs.stat(safeResolveWithin(wikiRoot, pagePath));
        const valid = stat.isFile();
        pageValidity.set(pagePath, valid);
        return valid;
      } catch {
        pageValidity.set(pagePath, false);
        return false;
      }
    }
    try {
      const bytes = await fs.readFile(safeResolveWithin(wikiRoot, pagePath));
      const valid = createHash("sha256").update(bytes).digest("hex") === synthesis.contentHash;
      pageValidity.set(pagePath, valid);
      return valid;
    } catch {
      pageValidity.set(pagePath, false);
      return false;
    }
  };

  const groups = new Map<string, typeof store.claims>();
  for (const claim of store.claims) {
    const key = `${claim.sourceUri}\0${claim.segmentId}`;
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }
  let segmentsRecorded = 0;
  let segmentsPending = 0;

  const markPending = async (claims: typeof store.claims, reason: string): Promise<void> => {
    const first = claims[0]!;
    const sourceContent = await fs.readFile(safeResolveWithin(workspaceRoot, first.sourceUri), "utf8");
    await sourceRecordSegment({
      wikiRoot,
      sourceUri: first.sourceUri,
      content: sourceContent,
      segmentId: first.segmentId,
      resolution: {
        status: "unresolved",
        evidenceRefs: claims.map((claim) => claim.id).sort(),
        reason,
      },
    });
    segmentsPending++;
  };

  for (const claims of groups.values()) {
    const first = claims[0]!;
    const resolutions = claims.map((claim) => resolutionByClaim.get(claim.id));
    if (resolutions.some((item) => !item || item.disposition === "ambiguous")) {
      await markPending(claims, "evidence_ir_link_pending");
      continue;
    }
    const pageRefs = [...new Set(resolutions.flatMap((item) =>
      item?.targetPagePath ? [item.targetPagePath] : []
    ))].sort();
    const represented = await Promise.all(claims.map(async (claim) => {
      const resolution = resolutionByClaim.get(claim.id)!;
      if (resolution.disposition === "duplicate") {
        return Boolean(resolution.targetPagePath && await pageIsCurrent(resolution.targetPagePath));
      }
      const synthesis = synthesisByClaim.get(claim.id);
      return Boolean(
        synthesis && synthesis.pagePath === resolution.targetPagePath &&
        await pageIsCurrent(synthesis.pagePath)
      );
    }));
    if (represented.some((value) => !value) || pageRefs.length === 0) {
      await markPending(claims, "evidence_ir_representation_pending");
      continue;
    }
    const sourceContent = await fs.readFile(safeResolveWithin(workspaceRoot, first.sourceUri), "utf8");
    const dispositions = resolutions.map((item) => item!.disposition);
    const status = dispositions.includes("contradiction") || claims.some((claim) => claim.status === "contradicted")
      ? "contradicted"
      : dispositions.every((item) => item === "duplicate") ? "duplicate" : "integrated";
    await sourceRecordSegment({
      wikiRoot,
      sourceUri: first.sourceUri,
      content: sourceContent,
      segmentId: first.segmentId,
      resolution: {
        status,
        evidenceRefs: claims.map((claim) => claim.id).sort(),
        pageRefs,
        ...(status === "contradicted" ? { reason: "evidence_ir_contradiction_preserved" } : {}),
      },
    });
    segmentsRecorded++;
  }
  return { segmentsRecorded, segmentsPending };
}
