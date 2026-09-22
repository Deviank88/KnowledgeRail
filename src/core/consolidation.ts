import { createHash } from "node:crypto";
import { normalizedClaimText, type EvidenceClaim } from "./ingestion/evidence-claim.js";
import { readEvidenceIrStore, mutateEvidenceIrStore, pagePathsByClaim, type EvidenceIrStore } from "./ingestion/evidence-store.js";
import { resolveEvidenceClaims } from "./ingestion/evidence-linker.js";
import { getWikiPageRecords } from "./retrieval-index.js";
import { usageWindow } from "./usage-ledger.js";
import { wikiPageUri } from "../context/resource-uri.js";

function identity(claim: EvidenceClaim): string {
  // Different validity, code/test anchors or epistemic origins are not interchangeable.
  return JSON.stringify([normalizedClaimText(claim.text), claim.kind, claim.origin, claim.target ?? null,
    claim.validFrom ?? claim.createdAt, claim.validUntil ?? null, claim.codeAnchor?.rangeHash ?? null,
    claim.testEvidence?.map((test) => [test.resourceUri, test.anchor.rangeHash]) ?? []]);
}
function duplicateGroups(store: EvidenceIrStore) {
  const groups = new Map<string, EvidenceClaim[]>();
  for (const claim of store.claims) {
    if (claim.status !== "active" || claim.relations.some((relation) => relation.type !== "duplicate")) continue;
    const key = identity(claim), group = groups.get(key) ?? [];
    group.push(claim); groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => group.sort((a, b) => a.id.localeCompare(b.id)))
    .sort((a, b) => a[0]!.id.localeCompare(b[0]!.id));
}
export async function consolidateKnowledge(wikiRoot: string, options: { apply?: boolean; days?: number; proposals?: readonly string[]; now?: number } = {}) {
  const days = options.days ?? 90, now = options.now ?? Date.now();
  const proposals = options.proposals ?? [];
  if (proposals.length > 8 || proposals.some((text) => !text.trim() || text.length > 4096)) throw new Error("Consolidation accepts at most eight bounded review proposals.");
  const [store, pages, usage] = await Promise.all([readEvidenceIrStore(wikiRoot), getWikiPageRecords(wikiRoot, false, { persist: false }), usageWindow(wikiRoot, days, now)]);
  const groups = duplicateGroups(store);
  const duplicateIds: string[] = [];
  if (options.apply) await mutateEvidenceIrStore(wikiRoot, (latest) => {
    for (const group of duplicateGroups(latest)) for (const duplicate of group.slice(1)) {
      const canonical = group[0]!;
      if (!duplicate.relations.some((relation) => relation.type === "duplicate" && relation.targetClaimId === canonical.id)) {
        duplicate.relations = [{ type: "duplicate", targetClaimId: canonical.id }];
        duplicate.updatedAt = new Date(now).toISOString();
      }
      duplicateIds.push(duplicate.id);
    }
  });
  if (duplicateIds.length) await resolveEvidenceClaims({ wikiRoot, claimIds: duplicateIds });
  const associated = pagePathsByClaim(store), concepts = new Map<string, { text: string; pages: Set<string>; claimIds: string[] }>();
  for (const claim of store.claims.filter((item) => item.status === "active")) {
    const key = `${claim.kind}\0${normalizedClaimText(claim.text)}`, item = concepts.get(key) ?? { text: claim.text, pages: new Set<string>(), claimIds: [] };
    for (const page of associated.get(claim.id) ?? (claim.target?.pagePath ? [claim.target.pagePath] : [])) item.pages.add(page);
    item.claimIds.push(claim.id); concepts.set(key, item);
  }
  const duplicates = groups.map((group) => ({ canonical: group[0]!.id, aliases: group.slice(1).map((claim) => claim.id),
    provenance: group.map((claim) => `${claim.sourceUri}#${claim.segmentId}`).sort() }));
  const report = { applied: !!options.apply, claimsBefore: store.claims.length, claimsAfter: store.claims.length,
    canonicalClaimsAfter: store.claims.length - groups.reduce((n, group) => n + group.length - 1, 0), duplicates,
    usage: { days, observedSince: usage.observedSince, unobservedPages: pages.filter((page) => !usage.served.has(wikiPageUri(page.path))).map((page) => page.path).sort(),
      note: "No observed disclosure in retained local records is not proof that a page was never used." },
    concepts: [...concepts.values()].filter((item) => item.pages.size > 1).map((item) => ({ text: item.text, pages: [...item.pages].sort(), claimIds: item.claimIds.sort() })),
    proposals: [...proposals], deletions: 0, synthesisApplied: false };
  const digest = createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 16);
  const escaped = (value: unknown) => JSON.stringify(value, null, 2).replace(/</gu, "\\u003c").replace(/`/gu, "\\u0060");
  const review = ["---", "title: Consolidation review", "type: analysis", `created: ${new Date(now).toISOString().slice(0, 10)}`,
    `updated: ${new Date(now).toISOString().slice(0, 10)}`, "tags: [maintenance, review]", "---", "# Consolidation review", "",
    "Duplicate claims retain their original IDs and source provenance. No page is deleted or synthesized by consolidation.", "",
    "Concept candidates and supplied proposals require explicit review before any canonical page change.", "", "```json", escaped(report), "```", ""].join("\n");
  return { ...report, reviewPath: `analysis/ConsolidationReview-${digest}.md`, review };
}
