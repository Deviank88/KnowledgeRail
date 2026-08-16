import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  evidenceClaimId,
  type EvidenceClaimInput,
} from "../src/core/ingestion/evidence-claim.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { evidenceIrStatus, recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { readEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import {
  applyEvidenceSynthesis,
  evidenceSynthesisIsRebuildable,
  planEvidenceSynthesis,
} from "../src/core/ingestion/evidence-synthesis.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { sourceContentHash } from "../src/core/ingestion/source-segmentation.js";

async function plannedSource(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
}): Promise<string> {
  const result = await sourceCompilePlan({ ...params, segmentMaxChars: 4_096 });
  assert.equal(result.ledger.segments.length, 1);
  return result.ledger.segments[0]!.id;
}

function claimId(params: {
  sourceUri: string;
  segmentId: string;
  input: EvidenceClaimInput;
}): string {
  return evidenceClaimId({
    sourceUri: params.sourceUri,
    segmentId: params.segmentId,
    text: params.input.text,
    kind: params.input.kind,
    origin: params.input.origin,
  });
}

test("Evidence IR preserves provenance, epistemic origin, contradictions and rebuildability", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-ir-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceA = "docs/normalized/policy-a.md";
  const sourceB = "docs/normalized/policy-b.md";
  const contentA = "# Retention\n\nThe audit capsule is retained for 365 days.";
  const contentB = "# Retention update\n\nThe audit capsule is retained for 90 days.";

  try {
    const segmentA = await plannedSource({ wikiRoot, sourceUri: sourceA, content: contentA });
    const segmentB = await plannedSource({ wikiRoot, sourceUri: sourceB, content: contentB });
    const baseInput: EvidenceClaimInput = {
      text: "The audit capsule is retained for 365 days.",
      kind: "requirement",
      origin: "explicit",
      confidence: 1,
      target: {
        entityKey: "audit-capsule-retention",
        pagePath: "requirements/AuditCapsuleRetention.md",
        pageTitle: "Audit capsule retention",
        pageType: "requirement",
      },
    };
    const baseId = claimId({ sourceUri: sourceA, segmentId: segmentA, input: baseInput });
    const syntheticInput: EvidenceClaimInput = {
      text: "A shorter retention window may reduce storage pressure.",
      kind: "fact",
      origin: "synthesized",
      confidence: 0.55,
      target: baseInput.target,
    };
    const contradictionInput: EvidenceClaimInput = {
      text: "The audit capsule is retained for 90 days.",
      kind: "requirement",
      origin: "extracted",
      confidence: 0.99,
      target: baseInput.target,
      relations: [{ type: "contradicts", targetClaimId: baseId }],
    };

    const first = await recordEvidenceClaims({
      wikiRoot,
      sourceUri: sourceA,
      sourceContent: contentA,
      segmentId: segmentA,
      claims: [baseInput, syntheticInput],
    });
    const second = await recordEvidenceClaims({
      wikiRoot,
      sourceUri: sourceB,
      sourceContent: contentB,
      segmentId: segmentB,
      claims: [contradictionInput],
    });
    assert.equal(first.created, 2);
    assert.equal(second.created, 1);

    const resolutions = await resolveEvidenceClaims({ wikiRoot });
    const contradiction = resolutions.find((item) => item.disposition === "contradiction");
    assert.ok(contradiction);
    assert.deepEqual(contradiction.targetClaimIds, [baseId]);

    const beforeFailure = await readEvidenceIrStore(wikiRoot);
    await assert.rejects(
      applyEvidenceSynthesis({ wikiRoot, failBeforeWrite: true }),
      /Injected synthesis failure/
    );
    const afterFailure = await readEvidenceIrStore(wikiRoot);
    assert.deepEqual(afterFailure.claims, beforeFailure.claims);
    assert.deepEqual(afterFailure.resolutions, beforeFailure.resolutions);
    assert.equal(afterFailure.syntheses.length, 0);

    const drafts = await applyEvidenceSynthesis({ wikiRoot });
    assert.equal(drafts.length, 1);
    const pagePath = drafts[0]!.pagePath;
    const firstPage = await fs.readFile(path.join(wikiRoot, pagePath), "utf8");
    assert.equal(firstPage.includes("retained for 365 days"), true);
    assert.equal(firstPage.includes("retained for 90 days"), true);
    assert.equal(firstPage.includes("**synthesized** — this is not an explicit source fact"), true);
    assert.equal(firstPage.includes(`${sourceA}#${segmentA}`), true);
    assert.equal(firstPage.includes(`${sourceB}#${segmentB}`), true);

    const persisted = await readEvidenceIrStore(wikiRoot);
    assert.equal(persisted.claims.every((claim) => Boolean(claim.sourceUri && claim.segmentId)), true);
    assert.equal(persisted.claims.find((claim) => claim.id === baseId)?.status, "contradicted");
    assert.equal(
      persisted.claims.find((claim) => claim.text.startsWith("A shorter"))?.origin,
      "synthesized"
    );
    assert.equal(await evidenceSynthesisIsRebuildable(wikiRoot), true);

    await fs.unlink(path.join(wikiRoot, pagePath));
    const rebuildPlan = await planEvidenceSynthesis({ wikiRoot });
    assert.equal(rebuildPlan.length, 1);
    assert.equal(rebuildPlan[0]!.content, firstPage);
    await applyEvidenceSynthesis({ wikiRoot });
    assert.equal(await fs.readFile(path.join(wikiRoot, pagePath), "utf8"), firstPage);

    const status = await evidenceIrStatus(wikiRoot);
    assert.equal(status.claimsWithProvenancePercent, 100);
    assert.equal(status.contradictionCount, 1);
    assert.equal(status.unresolvedLinkCount, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the linker deterministically collapses exact duplicates and records supersession", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-linker-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceA = "docs/normalized/a.md";
  const sourceB = "docs/normalized/b.md";
  const contentA = "# Rule\n\nA request needs two approvals.";
  const contentB = "# Rule revision\n\nA request needs three approvals.";

  try {
    const segmentA = await plannedSource({ wikiRoot, sourceUri: sourceA, content: contentA });
    const segmentB = await plannedSource({ wikiRoot, sourceUri: sourceB, content: contentB });
    const target = {
      entityKey: "approval-policy",
      pagePath: "requirements/ApprovalPolicy.md",
      pageTitle: "Approval policy",
      pageType: "requirement" as const,
    };
    const canonicalInput: EvidenceClaimInput = {
      text: "A request needs two approvals.",
      kind: "requirement",
      origin: "explicit",
      confidence: 1,
      target,
    };
    const canonicalId = claimId({ sourceUri: sourceA, segmentId: segmentA, input: canonicalInput });
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri: sourceA,
      sourceContent: contentA,
      segmentId: segmentA,
      claims: [canonicalInput],
    });
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri: sourceB,
      sourceContent: contentB,
      segmentId: segmentB,
      claims: [
        { ...canonicalInput, origin: "extracted", confidence: 0.98 },
        {
          text: "A request needs three approvals.",
          kind: "requirement",
          origin: "explicit",
          confidence: 1,
          target,
          relations: [{ type: "supersedes", targetClaimId: canonicalId }],
        },
      ],
    });
    const resolutions = await resolveEvidenceClaims({ wikiRoot });
    assert.equal(resolutions.filter((item) => item.disposition === "supersedes").length, 1);
    assert.equal(resolutions.filter((item) => item.disposition === "candidate_new_page").length, 1);

    // Same text with distinct provenance/origin is explicitly linked as a
    // duplicate, but its own claim record and attribution remain durable.
    assert.equal(resolutions.filter((item) => item.disposition === "duplicate").length, 1);
    const drafts = await planEvidenceSynthesis({ wikiRoot });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.claimIds.length, 2);
    const store = await readEvidenceIrStore(wikiRoot);
    assert.equal(store.claims.length, 3);
    assert.equal(store.claims.some((claim) => claim.origin === "extracted"), true);
    assert.equal(store.claims.find((claim) => claim.id === canonicalId)?.status, "superseded");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("identical text for different targets is not treated as a duplicate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-distinct-targets-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceA = "docs/normalized/feature-a.md";
  const sourceB = "docs/normalized/feature-b.md";
  const contentA = "# Feature A\n\nEnabled by default.";
  const contentB = "# Feature B\n\nEnabled by default.";

  try {
    const segmentA = await plannedSource({ wikiRoot, sourceUri: sourceA, content: contentA });
    const segmentB = await plannedSource({ wikiRoot, sourceUri: sourceB, content: contentB });
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri: sourceA,
      sourceContent: contentA,
      segmentId: segmentA,
      claims: [{
        text: "Enabled by default.", kind: "behavior", origin: "extracted", confidence: 0.9,
        target: { pagePath: "implementations/FeatureA.md", pageTitle: "Feature A", pageType: "implementation" },
      }],
    });
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri: sourceB,
      sourceContent: contentB,
      segmentId: segmentB,
      claims: [{
        text: "Enabled by default.", kind: "behavior", origin: "extracted", confidence: 0.9,
        target: { pagePath: "implementations/FeatureB.md", pageTitle: "Feature B", pageType: "implementation" },
      }],
    });
    const resolutions = await resolveEvidenceClaims({ wikiRoot });
    assert.equal(resolutions.every((item) => item.disposition === "candidate_new_page"), true);
    assert.deepEqual(resolutions.map((item) => item.targetPagePath).sort(), [
      "implementations/FeatureA.md",
      "implementations/FeatureB.md",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Evidence IR rejects missing or stale source-segment provenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-provenance-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/source.md";
  const content = "# Fact\n\nStable source fact.";

  try {
    const segmentId = await plannedSource({ wikiRoot, sourceUri, content });
    const input: EvidenceClaimInput = {
      text: "Stable source fact.",
      kind: "fact",
      origin: "explicit",
      confidence: 1,
    };
    await assert.rejects(
      recordEvidenceClaims({
        wikiRoot,
        sourceUri,
        sourceContent: content,
        segmentId: "seg-000000000000000000000000",
        claims: [input],
      }),
      /unknown segment/
    );
    await assert.rejects(
      recordEvidenceClaims({
        wikiRoot,
        sourceUri,
        sourceContent: `${content}\nchanged`,
        segmentId,
        claims: [input],
      }),
      /Source changed/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recording revised evidence invalidates stale links and synthesis", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-revision-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/revision.md";
  const content = "# Rule\n\nA revision must retain its claim identity.";

  try {
    const segmentId = await plannedSource({ wikiRoot, sourceUri, content });
    const input: EvidenceClaimInput = {
      text: "A revision must retain its claim identity.",
      kind: "invariant",
      origin: "explicit",
      confidence: 0.8,
      target: { pagePath: "requirements/Revision.md", pageTitle: "Revision", pageType: "requirement" },
    };
    const first = await recordEvidenceClaims({ wikiRoot, sourceUri, sourceContent: content, segmentId, claims: [input] });
    await resolveEvidenceClaims({ wikiRoot });
    await applyEvidenceSynthesis({ wikiRoot });

    const revised = await recordEvidenceClaims({
      wikiRoot,
      sourceUri,
      sourceContent: content,
      segmentId,
      claims: [{ ...input, confidence: 0.95 }],
    });
    const store = await readEvidenceIrStore(wikiRoot);
    assert.equal(revised.reused, 1);
    assert.equal(revised.claims[0]!.id, first.claims[0]!.id);
    assert.equal(store.resolutions.some((item) => item.claimId === first.claims[0]!.id), false);
    assert.equal(store.syntheses.length, 0);
    assert.equal(store.claims[0]!.confidence, 0.95);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Evidence IR store rejects a symlink escape", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-outside-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/symlink.md";
  const content = "# Fact\n\nEvidence must stay in the workspace.";

  try {
    const segmentId = await plannedSource({ wikiRoot, sourceUri, content });
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    try {
      await fs.symlink(outside, path.join(root, "docs", "evidence-ir"), "dir");
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      t.skip(`symlinks unavailable on this platform (${code})`);
      return;
    }
    await assert.rejects(
      recordEvidenceClaims({
        wikiRoot,
        sourceUri,
        sourceContent: content,
        segmentId,
        claims: [{ text: "Evidence must stay in the workspace.", kind: "fact", origin: "explicit", confidence: 1 }],
      }),
      /does not resolve to docs\/evidence-ir/
    );
    await assert.rejects(fs.stat(path.join(outside, "store.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Evidence IR rejects a symlinked docs directory before creating the store", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-docs-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-evidence-docs-outside-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/docs-symlink.md";
  const content = "# Fact\n\nCanonical evidence stays in the project docs directory.";

  try {
    const segmentId = await plannedSource({ wikiRoot, sourceUri, content });
    try {
      await fs.symlink(outside, path.join(root, "docs"), "dir");
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      t.skip(`symlinks unavailable on this platform (${code})`);
      return;
    }
    await assert.rejects(
      recordEvidenceClaims({
        wikiRoot,
        sourceUri,
        sourceContent: content,
        segmentId,
        claims: [{ text: "Canonical evidence stays in the project docs directory.", kind: "fact", origin: "explicit", confidence: 1 }],
      }),
      /docs directory does not resolve inside the workspace root/
    );
    await assert.rejects(fs.stat(path.join(outside, "evidence-ir")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Evidence synthesis rejects a symlinked target directory before reading or writing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-synthesis-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-synthesis-outside-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/synthesis-symlink.md";
  const content = "# Fact\n\nSynthesis remains within the wiki.";

  try {
    const segmentId = await plannedSource({ wikiRoot, sourceUri, content });
    await fs.writeFile(path.join(outside, "Escaped.md"), "outside sentinel", "utf8");
    try {
      await fs.symlink(outside, path.join(wikiRoot, "requirements"), "dir");
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      t.skip(`symlinks unavailable on this platform (${code})`);
      return;
    }
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri,
      sourceContent: content,
      segmentId,
      claims: [{
        text: "Synthesis remains within the wiki.",
        kind: "requirement",
        origin: "explicit",
        confidence: 1,
        target: { pagePath: "requirements/Escaped.md", pageTitle: "Escaped", pageType: "requirement" },
      }],
    });
    await resolveEvidenceClaims({ wikiRoot });
    await assert.rejects(
      planEvidenceSynthesis({ wikiRoot }),
      /does not resolve to its canonical wiki path/
    );
    assert.equal(await fs.readFile(path.join(outside, "Escaped.md"), "utf8"), "outside sentinel");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
