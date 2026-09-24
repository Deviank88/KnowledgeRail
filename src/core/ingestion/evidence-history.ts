import { claimValidAt } from "./evidence-claim.js";
import { pagePathsByClaim, type EvidenceIrStore } from "./evidence-store.js";

export interface ClaimHistoryEntry {
  id: string;
  text: string;
  recordedStatus: string;
  provenanceVerification: "recorded_only";
  validity: "valid" | "not_yet_valid" | "expired" | "unresolved";
  validFrom: string;
  validUntil?: string;
  sourceUri: string;
  segmentId: string;
  relations: Array<{ type: string; targetClaimId: string }>;
  supersededBy: Array<{ claimId: string; effectiveAt: string; sourceUri: string; segmentId: string; reason: string }>;
}
/** Recorded provenance and effective intervals; no model score can reactivate a claim. */
export function evidenceHistory(store: EvidenceIrStore, pagePaths: readonly string[], asOf: string): { asOf: string; claims: ClaimHistoryEntry[]; warnings: string[] } {
  const at = Date.parse(asOf); if (!Number.isFinite(at)) throw new Error("Invalid history timestamp.");
  const paths = pagePathsByClaim(store), selectedPages = new Set(pagePaths);
  const selected = new Set(store.claims.filter((c) => (paths.get(c.id) ?? [c.target?.pagePath]).some((p) => p && selectedPages.has(p))).map((c) => c.id));
  const edges = store.claims.flatMap((c) => c.relations.map((r) => ({ from: c.id, to: r.targetClaimId })));
  for (const resolution of store.resolutions) for (const target of resolution.targetClaimIds) edges.push({ from: resolution.claimId, to: target });
  const adjacent = new Map<string, Set<string>>();
  for (const edge of edges) for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
    let links = adjacent.get(from); if (!links) { links = new Set(); adjacent.set(from, links); } links.add(to);
  }
  const queue = [...selected];
  for (let i = 0; i < queue.length; i++) for (const id of adjacent.get(queue[i]!) ?? []) {
    if (!selected.has(id)) { selected.add(id); queue.push(id); }
  }
  const warnings: string[] = [];
  const byId = new Map(store.claims.map((c) => [c.id, c]));
  const replacements = new Map<string, string[]>();
  for (const resolution of store.resolutions) if (resolution.disposition === "supersedes") for (const id of resolution.targetClaimIds) {
    const values = replacements.get(id) ?? []; values.push(resolution.claimId); replacements.set(id, values);
  }
  const claims = store.claims.filter((c) => selected.has(c.id)).map((claim): ClaimHistoryEntry => {
    const from = claim.validFrom ?? claim.createdAt;
    const supersededBy = (replacements.get(claim.id) ?? []).flatMap((id) => {
      const replacement = byId.get(id);
      if (!replacement) { warnings.push(`Missing replacement claim ${id}.`); return []; }
      return [{ claimId: replacement.id, effectiveAt: replacement.validFrom ?? replacement.createdAt, sourceUri: replacement.sourceUri, segmentId: replacement.segmentId, reason: replacement.text }];
    });
    if (!claim.validFrom) warnings.push(`${claim.id}: valid_from is absent; recorded creation time is used, not proof of the decision's effective date.`);
    if (claim.status === "superseded" && !claim.validUntil) warnings.push(`${claim.id}: superseded without a closing date; historical validity is unresolved.`);
    if (["ambiguous", "contradicted"].includes(claim.status)) warnings.push(`${claim.id}: the recorded conflict has no historical status timeline; validity remains unresolved.`);
    for (const relation of claim.relations) if (!byId.has(relation.targetClaimId)) warnings.push(`${claim.id}: missing related claim ${relation.targetClaimId}.`);
    const validity = ["ambiguous", "contradicted"].includes(claim.status) || (claim.status === "superseded" && !claim.validUntil) ? "unresolved"
      : at < Date.parse(from) ? "not_yet_valid" : claimValidAt(claim, asOf) ? "valid" : "expired";
    return { id: claim.id, text: claim.text, recordedStatus: claim.status, provenanceVerification: "recorded_only", validity, validFrom: from,
      ...(claim.validUntil ? { validUntil: claim.validUntil } : {}), sourceUri: claim.sourceUri, segmentId: claim.segmentId,
      relations: claim.relations.map((r) => ({ ...r })), supersededBy };
  }).sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id));
  return { asOf, claims, warnings };
}
