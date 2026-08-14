import * as path from "node:path";
import { getWikiPageRecords } from "../retrieval-index.js";
import { WIKI_PAGE_TYPES, type WikiPageType } from "../wiki-validation.js";
import {
  normalizedClaimText,
  type EvidenceClaim,
  type EvidenceClaimStatus,
  type EvidenceRelationType,
} from "./evidence-claim.js";
import {
  mutateEvidenceIrStore,
  type EvidenceIrStore,
  type EvidenceLinkResolution,
} from "./evidence-store.js";

const PAGE_TYPES = new Set<string>(WIKI_PAGE_TYPES);

function slug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "evidence";
}

function pageTypeForClaim(claim: EvidenceClaim): WikiPageType {
  if (claim.target?.pageType && PAGE_TYPES.has(claim.target.pageType)) return claim.target.pageType;
  switch (claim.kind) {
    case "requirement":
    case "constraint":
    case "invariant":
    case "exception":
      return "requirement";
    case "decision": return "decision";
    case "risk": return "risk";
    case "incident": return "analysis";
    case "behavior":
    case "procedure": return "implementation";
    default: return "analysis";
  }
}

function pageDir(type: WikiPageType): string {
  const byType: Partial<Record<WikiPageType, string>> = {
    requirement: "requirements",
    decision: "decisions",
    risk: "risks",
    implementation: "implementations",
    analysis: "analysis",
    concept: "concepts",
    entity: "entities",
    test_result: "tests",
    api: "api",
    integration: "integrations",
  };
  return byType[type] ?? `${type.replace(/_/g, "-")}s`;
}

function proposedPage(claim: EvidenceClaim): { path: string; title: string; type: WikiPageType } {
  const type = pageTypeForClaim(claim);
  const title = claim.target?.pageTitle ?? claim.target?.entityKey ??
    `${claim.kind}: ${claim.text.slice(0, 72).replace(/\s+/g, " ").trim()}`;
  return {
    path: claim.target?.pagePath ?? `${pageDir(type)}/${slug(title)}.md`,
    title,
    type,
  };
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function candidatePages(
  claim: EvidenceClaim,
  pages: Awaited<ReturnType<typeof getWikiPageRecords>>
): string[] {
  if (claim.target?.pagePath) {
    return pages.some((page) => page.path === claim.target!.pagePath)
      ? [claim.target.pagePath]
      : [];
  }
  const anchors = [claim.target?.entityKey, claim.target?.pageTitle]
    .filter((value): value is string => Boolean(value))
    .map(normalized);
  if (anchors.length === 0) return [];
  return pages.filter((page) => {
    const values = [page.title, page.path, page.requestId ?? "", ...page.tags, ...page.aliases].map(normalized);
    return anchors.some((anchor) => values.includes(anchor));
  }).map((page) => page.path).sort();
}

function relationResolution(
  claim: EvidenceClaim,
  store: EvidenceIrStore,
  relationType: EvidenceRelationType,
  now: string
): EvidenceLinkResolution | null {
  const relations = claim.relations.filter((relation) => relation.type === relationType);
  if (relations.length === 0) return null;
  const targetClaimIds = [...new Set(relations.map((relation) => relation.targetClaimId))].sort();
  if (targetClaimIds.some((id) => id === claim.id || !store.claims.some((item) => item.id === id))) {
    throw new Error(`${claim.id} has an invalid ${relationType} relation target.`);
  }
  const targetPaths = store.resolutions
    .filter((item) => targetClaimIds.includes(item.claimId) && item.targetPagePath)
    .map((item) => item.targetPagePath!)
    .sort();
  const targetClaimPaths = targetClaimIds
    .map((id) => store.claims.find((item) => item.id === id))
    .filter((item): item is EvidenceClaim => Boolean(item))
    .map((item) => proposedPage(item).path)
    .sort();
  const targetPath = targetPaths[0] ?? targetClaimPaths[0];
  const targetClaim = targetClaimIds
    .map((id) => store.claims.find((item) => item.id === id))
    .find((item): item is EvidenceClaim => Boolean(item));
  const targetProposed = targetClaim ? proposedPage(targetClaim) : undefined;
  const proposed = proposedPage(claim);
  const disposition = relationType === "contradicts"
    ? "contradiction"
    : relationType === "supersedes" ? "supersedes" : "duplicate";
  return {
    claimId: claim.id,
    disposition,
    targetClaimIds,
    candidatePagePaths: [...new Set([...targetPaths, ...targetClaimPaths])],
    ...(targetPath ? {
      targetPagePath: targetPath,
      targetPageTitle: targetProposed?.title,
      targetPageType: targetProposed?.type,
    } : {}),
    ...(!targetPath && relationType !== "duplicate"
      ? { targetPagePath: proposed.path, targetPageTitle: proposed.title, targetPageType: proposed.type }
      : {}),
    reason: `explicit_${relationType}_relation`,
    resolvedAt: now,
  };
}

export function recomputeEvidenceClaimStatuses(store: EvidenceIrStore, now: string): void {
  const priority: Record<EvidenceClaimStatus, number> = {
    active: 0,
    ambiguous: 1,
    superseded: 2,
    contradicted: 3,
  };
  const statuses = new Map(store.claims.map((claim) => [claim.id, "active" as EvidenceClaimStatus]));
  const elevate = (claimId: string, status: EvidenceClaimStatus): void => {
    const current = statuses.get(claimId);
    if (current !== undefined && priority[status] > priority[current]) statuses.set(claimId, status);
  };
  for (const resolution of store.resolutions) {
    if (resolution.disposition === "ambiguous") elevate(resolution.claimId, "ambiguous");
    if (resolution.disposition === "supersedes") {
      for (const id of resolution.targetClaimIds) elevate(id, "superseded");
    }
    if (resolution.disposition === "contradiction") {
      elevate(resolution.claimId, "contradicted");
      for (const id of resolution.targetClaimIds) elevate(id, "contradicted");
    }
  }
  for (const claim of store.claims) {
    const status = statuses.get(claim.id)!;
    if (claim.status !== status) {
      claim.status = status;
      claim.updatedAt = now;
    }
  }
}

export async function resolveEvidenceClaims(params: {
  wikiRoot: string;
  claimIds?: readonly string[];
}): Promise<EvidenceLinkResolution[]> {
  const pages = await getWikiPageRecords(params.wikiRoot, true);
  return mutateEvidenceIrStore(params.wikiRoot, (store) => {
    const selected = params.claimIds?.length
      ? params.claimIds.map((id) => {
        const claim = store.claims.find((item) => item.id === id);
        if (!claim) throw new Error(`Unknown evidence claim: ${id}.`);
        return claim;
      })
      : store.claims;
    const now = new Date().toISOString();
    const output: EvidenceLinkResolution[] = [];

    for (const claim of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
      const explicit = relationResolution(claim, store, "contradicts", now) ??
        relationResolution(claim, store, "supersedes", now) ??
        relationResolution(claim, store, "duplicate", now);
      const proposed = proposedPage(claim);
      const duplicates = store.claims
        .filter((item) =>
          item.id.localeCompare(claim.id) < 0 &&
          normalizedClaimText(item.text) === normalizedClaimText(claim.text) &&
          proposedPage(item).path === proposed.path
        )
        .map((item) => item.id)
        .sort();
      const duplicateTarget = duplicates[0]
        ? store.claims.find((item) => item.id === duplicates[0])
        : undefined;
      const duplicatePage = duplicateTarget ? proposedPage(duplicateTarget) : undefined;
      const matches = candidatePages(claim, pages);
      const resolution: EvidenceLinkResolution = explicit ?? (duplicates.length > 0
        ? {
          claimId: claim.id,
          disposition: "duplicate",
          targetClaimIds: duplicates,
          candidatePagePaths: duplicatePage ? [duplicatePage.path] : [],
          ...(duplicatePage ? {
            targetPagePath: duplicatePage.path,
            targetPageTitle: duplicatePage.title,
            targetPageType: duplicatePage.type,
          } : {}),
          reason: "exact_normalized_claim_text",
          resolvedAt: now,
        }
        : matches.length === 1
          ? {
            claimId: claim.id,
            disposition: "candidate_update",
            targetClaimIds: [],
            candidatePagePaths: matches,
            targetPagePath: matches[0],
            targetPageTitle: pages.find((page) => page.path === matches[0])?.title,
            ...(PAGE_TYPES.has(pages.find((page) => page.path === matches[0])?.type ?? "")
              ? { targetPageType: pages.find((page) => page.path === matches[0])!.type }
              : {}),
            reason: "single_existing_page_match",
            resolvedAt: now,
          }
          : matches.length > 1
            ? {
              claimId: claim.id,
              disposition: "ambiguous",
              targetClaimIds: [],
              candidatePagePaths: matches,
              reason: "multiple_existing_page_matches",
              resolvedAt: now,
            }
            : {
              claimId: claim.id,
              disposition: "candidate_new_page",
              targetClaimIds: [],
              candidatePagePaths: [],
              targetPagePath: proposed.path,
              targetPageTitle: proposed.title,
              targetPageType: proposed.type,
              reason: "no_existing_page_match",
              resolvedAt: now,
            });
      const existingIndex = store.resolutions.findIndex((item) => item.claimId === claim.id);
      if (existingIndex >= 0) store.resolutions[existingIndex] = resolution;
      else store.resolutions.push(resolution);
      output.push(resolution);
    }
    store.resolutions.sort((a, b) => a.claimId.localeCompare(b.claimId));
    recomputeEvidenceClaimStatuses(store, now);
    return output;
  });
}
