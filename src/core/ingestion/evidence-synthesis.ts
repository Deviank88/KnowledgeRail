import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteText } from "../fs-service.js";
import { safeResolveWithin } from "../paths.js";
import { frontmatterArray, parseFrontmatter, readFileSafe } from "../utils.js";
import { hasErrors, validateWikiPageContent } from "../wiki-validation.js";
import { readEvidenceIrStore, mutateEvidenceIrStore } from "./evidence-store.js";
import type { EvidenceClaim } from "./evidence-claim.js";

const BLOCK_START = "<!-- knowledge-rail:evidence-ir:start -->";
const BLOCK_END = "<!-- knowledge-rail:evidence-ir:end -->";

export interface EvidenceSynthesisDraft {
  pagePath: string;
  content: string;
  claimIds: string[];
  mode: "create" | "update";
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function renderClaim(claim: EvidenceClaim): string[] {
  const safeText = claim.text.replace(
    /<!--\s*knowledge-rail:evidence-ir:(?:start|end)\s*-->/gi,
    "[reserved Evidence IR marker omitted]"
  );
  const epistemic = claim.origin === "inferred" || claim.origin === "synthesized" ||
    claim.kind === "inference" || claim.kind === "hypothesis"
    ? `> Epistemic state: **${claim.origin}** — this is not an explicit source fact.`
    : `> Epistemic state: **${claim.origin}**.`;
  return [
    `### ${claim.kind}: ${claim.id}`,
    "",
    safeText,
    "",
    epistemic,
    `> Provenance: \`${claim.sourceUri}#${claim.segmentId}\` · confidence ${claim.confidence.toFixed(3)} · status ${claim.status}`,
  ];
}

function managedBlock(claims: readonly EvidenceClaim[]): string {
  return [
    BLOCK_START,
    "## Evidence IR",
    "",
    ...claims.flatMap((claim, index) => [
      ...(index > 0 ? ["", "---", ""] : []),
      ...renderClaim(claim),
    ]),
    BLOCK_END,
  ].join("\n");
}

function replaceManagedBlock(content: string, block: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start < 0 && end < 0) return `${content.trimEnd()}\n\n${block}\n`;
  if (start < 0 || end < start) throw new Error("Existing Evidence IR managed block is malformed.");
  return `${content.slice(0, start).trimEnd()}\n\n${block}\n${content.slice(end + BLOCK_END.length).trimStart()}`.trimEnd() + "\n";
}

function mergeFrontmatterEvidence(content: string, claims: readonly EvidenceClaim[]): string {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return content;
  const metadata = parseFrontmatter(content);
  const sources = [...new Set([
    ...(frontmatterArray(metadata, "sources") ?? []),
    ...claims.map((claim) => claim.sourceUri),
  ])].sort();
  const updated = [...claims.map((claim) => claim.updatedAt.slice(0, 10))].sort().at(-1)!;
  const nextHeader = frontmatterMatch[0]
    .replace(/^sources:.*$/m, `sources: [${sources.map(yaml).join(", ")}]`)
    .replace(/^updated:.*$/m, `updated: ${updated}`);
  return nextHeader + content.slice(frontmatterMatch[0].length);
}

function createPage(params: {
  path: string;
  title: string;
  type: string;
  claims: EvidenceClaim[];
}): string {
  const sources = [...new Set(params.claims.map((claim) => claim.sourceUri))].sort();
  const created = [...params.claims.map((claim) => claim.createdAt.slice(0, 10))].sort()[0]!;
  const updated = [...params.claims.map((claim) => claim.updatedAt.slice(0, 10))].sort().at(-1)!;
  return [
    "---",
    `title: ${yaml(params.title)}`,
    `type: ${params.type}`,
    "tags: [evidence-ir]",
    `created: ${created}`,
    `updated: ${updated}`,
    `sources: [${sources.map(yaml).join(", ")}]`,
    "authority: evidence_ir",
    "---",
    "",
    `# ${params.title}`,
    "",
    managedBlock(params.claims),
    "",
  ].join("\n");
}

async function assertCanonicalSynthesisPath(
  wikiRoot: string,
  absolute: string,
  pagePath: string
): Promise<void> {
  const rootAbsolute = path.resolve(wikiRoot);
  const rootReal = await fs.realpath(rootAbsolute);
  let cursor = absolute;
  while (cursor !== rootAbsolute) {
    try {
      const cursorReal = await fs.realpath(cursor);
      const actual = path.relative(rootReal, cursorReal).replace(/\\/g, "/");
      const expected = path.relative(rootAbsolute, cursor).replace(/\\/g, "/");
      if (actual !== expected) {
        throw new Error(`Evidence synthesis target does not resolve to its canonical wiki path: ${pagePath}`);
      }
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      cursor = path.dirname(cursor);
    }
  }
}

export async function planEvidenceSynthesis(params: {
  wikiRoot: string;
  claimIds?: readonly string[];
}): Promise<EvidenceSynthesisDraft[]> {
  const store = await readEvidenceIrStore(params.wikiRoot);
  const selected = params.claimIds?.length ? new Set(params.claimIds) : null;
  const selectedClaims = selected ? store.claims.filter((claim) => selected.has(claim.id)) : store.claims;
  if (selected && selectedClaims.length !== selected.size) throw new Error("Synthesis references unknown claim IDs.");
  for (const claim of selectedClaims) {
    const resolution = store.resolutions.find((item) => item.claimId === claim.id);
    if (!resolution) throw new Error(`Claim has not been linked: ${claim.id}.`);
    if (resolution.disposition === "ambiguous") throw new Error(`Claim link remains ambiguous: ${claim.id}.`);
  }
  const selectedTargetPaths = selected
    ? new Set(selectedClaims.map((claim) =>
      store.resolutions.find((item) => item.claimId === claim.id)?.targetPagePath
    ).filter((value): value is string => Boolean(value)))
    : null;
  const claimsToSynthesize = selectedTargetPaths
    ? store.claims.filter((claim) => {
      const resolution = store.resolutions.find((item) => item.claimId === claim.id);
      return Boolean(resolution?.targetPagePath && selectedTargetPaths.has(resolution.targetPagePath));
    })
    : store.claims;
  const byPage = new Map<string, { title: string; type: string; claims: EvidenceClaim[] }>();

  for (const claim of claimsToSynthesize) {
    const resolution = store.resolutions.find((item) => item.claimId === claim.id);
    if (!resolution) throw new Error(`Claim has not been linked: ${claim.id}.`);
    if (resolution.disposition === "ambiguous") throw new Error(`Claim link remains ambiguous: ${claim.id}.`);
    if (resolution.disposition === "duplicate") continue;
    if (!resolution.targetPagePath) throw new Error(`Claim has no synthesis target: ${claim.id}.`);
    const group = byPage.get(resolution.targetPagePath) ?? {
      title: resolution.targetPageTitle ?? path.basename(resolution.targetPagePath, ".md").replace(/_/g, " "),
      type: resolution.targetPageType ?? "analysis",
      claims: [],
    };
    group.claims.push(claim);
    byPage.set(resolution.targetPagePath, group);
  }

  const drafts: EvidenceSynthesisDraft[] = [];
  for (const [pagePath, group] of [...byPage].sort(([a], [b]) => a.localeCompare(b))) {
    group.claims.sort((a, b) => a.id.localeCompare(b.id));
    const absolute = safeResolveWithin(params.wikiRoot, pagePath);
    await assertCanonicalSynthesisPath(params.wikiRoot, absolute, pagePath);
    const existing = await readFileSafe(absolute);
    const content = existing === null
      ? createPage({ path: pagePath, title: group.title, type: group.type, claims: group.claims })
      : replaceManagedBlock(
        mergeFrontmatterEvidence(existing, group.claims),
        managedBlock(group.claims)
      );
    drafts.push({
      pagePath,
      content,
      claimIds: group.claims.map((claim) => claim.id),
      mode: existing === null ? "create" : "update",
    });
  }
  return drafts;
}

export async function applyEvidenceSynthesis(params: {
  wikiRoot: string;
  claimIds?: readonly string[];
  failBeforeWrite?: boolean;
}): Promise<EvidenceSynthesisDraft[]> {
  const drafts = await planEvidenceSynthesis(params);
  if (params.failBeforeWrite) throw new Error("Injected synthesis failure before wiki mutation.");
  for (const draft of drafts) {
    const validation = await validateWikiPageContent(draft.content, { checkSourceExists: false });
    if (hasErrors(validation.issues)) throw new Error(`Generated evidence synthesis is invalid: ${draft.pagePath}.`);
  }
  for (const draft of drafts) {
    const absolute = safeResolveWithin(params.wikiRoot, draft.pagePath);
    const parent = path.dirname(absolute);
    await assertCanonicalSynthesisPath(params.wikiRoot, absolute, draft.pagePath);
    await fs.mkdir(parent, { recursive: true });
    const [rootReal, parentReal] = await Promise.all([
      fs.realpath(params.wikiRoot),
      fs.realpath(parent),
    ]);
    const relative = path.relative(rootReal, parentReal);
    const expectedParentRaw = path.dirname(draft.pagePath).replace(/\\/g, "/");
    const expectedParent = expectedParentRaw === "." ? "" : expectedParentRaw;
    if (relative.replace(/\\/g, "/") !== expectedParent) {
      throw new Error(`Evidence synthesis target does not resolve to its canonical wiki path: ${draft.pagePath}`);
    }
    await atomicWriteText(absolute, draft.content);
  }
  await mutateEvidenceIrStore(params.wikiRoot, (store) => {
    const now = new Date().toISOString();
    for (const draft of drafts) {
      const record = {
        pagePath: draft.pagePath,
        claimIds: draft.claimIds,
        contentHash: createHash("sha256").update(draft.content, "utf8").digest("hex"),
        synthesizedAt: now,
      };
      const index = store.syntheses.findIndex((item) => item.pagePath === draft.pagePath);
      if (index >= 0) store.syntheses[index] = record;
      else store.syntheses.push(record);
    }
    store.syntheses.sort((a, b) => a.pagePath.localeCompare(b.pagePath));
  });
  return drafts;
}

export async function evidenceSynthesisIsRebuildable(wikiRoot: string): Promise<boolean> {
  const store = await readEvidenceIrStore(wikiRoot);
  if (store.claims.length === 0) return true;
  try {
    const drafts = await planEvidenceSynthesis({ wikiRoot });
    return drafts.every((draft) => draft.claimIds.length > 0 && draft.content.includes(BLOCK_START));
  } catch {
    return false;
  }
}
