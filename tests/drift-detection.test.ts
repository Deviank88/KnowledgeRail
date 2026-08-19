import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { compactStructuredContext } from "../src/tools/context-tools.js";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { codeResourceUri, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import {
  detectCodeDrift,
  evaluateCodeAnchor,
  normalizeRepositoryPath,
  readDriftLedger,
} from "../src/core/drift-detection.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import {
  backfillEvidenceCodeAnchors,
  recordEvidenceClaims,
} from "../src/core/ingestion/evidence-pipeline.js";
import {
  evidenceIrStoreFile,
  mutateEvidenceIrStore,
  readEvidenceIrStore,
} from "../src/core/ingestion/evidence-store.js";
import { applyEvidenceSynthesis } from "../src/core/ingestion/evidence-synthesis.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

interface DriftFixture {
  root: string;
  wikiRoot: string;
  servicePath: string;
  otherPath: string;
  serviceContent: string;
  serviceClaimId: string;
  otherClaimId: string;
  servicePage: string;
  anchor: NonNullable<Awaited<ReturnType<typeof readEvidenceIrStore>>["claims"][number]["codeAnchor"]>;
}

async function createFixture(): Promise<DriftFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-drift-"));
  const wikiRoot = path.join(root, "wiki");
  const servicePath = path.join(root, "src/service.ts");
  const otherPath = path.join(root, "src/audit.ts");
  const serviceContent = [
    "/** Return the current invoice retry limit. */",
    "export function invoiceRetryLimit(): number {",
    "  return 3;",
    "}",
    "",
  ].join("\n");
  const otherContent = [
    "/** Record the invoice audit event. */",
    "export function recordInvoiceAudit(): string {",
    "  return \"recorded\";",
    "}",
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(servicePath), { recursive: true });
  await Promise.all([
    fs.writeFile(servicePath, serviceContent, "utf8"),
    fs.writeFile(otherPath, otherContent, "utf8"),
  ]);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index.rebuild();
  const serviceHit = (await index.symbol("invoiceRetryLimit"))[0];
  const otherHit = (await index.symbol("recordInvoiceAudit"))[0];
  assert.ok(serviceHit);
  assert.ok(otherHit);

  const sourceUri = "docs/normalized/invoice-notes.md";
  const sourceContent = [
    "# Invoice behavior",
    "",
    "The invoice retry limit is implemented by invoiceRetryLimit.",
    "The invoice audit event is implemented by recordInvoiceAudit.",
    "A non-code operating note is retained separately.",
    "A future invoice symbol is not available yet.",
  ].join("\n");
  const plan = await sourceCompilePlan({ wikiRoot, sourceUri, content: sourceContent, segmentMaxChars: 4_096 });
  const segmentId = plan.ledger.segments[0]!.id;
  const servicePage = "implementations/InvoiceRetry.md";
  const recorded = await recordEvidenceClaims({
    wikiRoot,
    sourceUri,
    sourceContent,
    segmentId,
    claims: [
      {
        text: "The invoice retry limit is implemented by invoiceRetryLimit.",
        kind: "behavior",
        origin: "explicit",
        confidence: 1,
        target: {
          pagePath: servicePage,
          pageTitle: "Invoice retry implementation",
          pageType: "implementation",
          codeResourceUri: codeResourceUri(serviceHit.fragment),
        },
      },
      {
        text: "The invoice audit event is implemented by recordInvoiceAudit.",
        kind: "behavior",
        origin: "explicit",
        confidence: 1,
        target: {
          pagePath: "implementations/InvoiceAudit.md",
          pageTitle: "Invoice audit implementation",
          pageType: "implementation",
          codeResourceUri: codeResourceUri(otherHit.fragment),
        },
      },
      {
        text: "A non-code operating note is retained separately.",
        kind: "fact",
        origin: "explicit",
        confidence: 1,
        target: {
          pagePath: "concepts/InvoiceOperations.md",
          pageTitle: "Invoice operations",
          pageType: "concept",
        },
      },
      {
        text: "A future invoice symbol is not available yet.",
        kind: "hypothesis",
        origin: "explicit",
        confidence: 0.5,
        target: {
          pagePath: "implementations/FutureInvoice.md",
          pageTitle: "Future invoice implementation",
          pageType: "implementation",
          codeResourceUri: "code://repo/src/missing.ts#symbol-0123456789abcdefabcd",
        },
      },
    ],
  });
  assert.equal(await fs.readFile(servicePath, "utf8"), serviceContent);
  assert.equal(recorded.anchorWarnings.length, 1);
  assert.match(recorded.anchorWarnings[0]!, /not indexed/);
  assert.equal(recorded.claims.filter((claim) => claim.codeAnchor).length, 2);
  assert.equal(recorded.claims[2]!.codeAnchor, undefined);
  assert.equal(recorded.claims[3]!.codeAnchor, undefined);
  await resolveEvidenceClaims({ wikiRoot });
  await applyEvidenceSynthesis({ wikiRoot });
  const serviceClaim = recorded.claims[0]!;
  const otherClaim = recorded.claims[1]!;
  assert.ok(serviceClaim.codeAnchor);
  return {
    root,
    wikiRoot,
    servicePath,
    otherPath,
    serviceContent,
    serviceClaimId: serviceClaim.id,
    otherClaimId: otherClaim.id,
    servicePage,
    anchor: serviceClaim.codeAnchor,
  };
}

async function cleanupFixture(fixture: DriftFixture): Promise<void> {
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(fixture.wikiRoot);
  await fs.rm(fixture.root, { recursive: true, force: true });
}

test("code anchors detect substantive drift without formatting false positives", async () => {
  const fixture = await createFixture();
  try {
    const storeFile = evidenceIrStoreFile(fixture.wikiRoot);
    const pageFile = path.join(fixture.wikiRoot, fixture.servicePage);
    const canonicalBefore = await Promise.all([
      fs.readFile(storeFile, "utf8"),
      fs.readFile(pageFile, "utf8"),
    ]);
    const fresh = await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      checkedAt: "2026-08-18T08:00:00.000Z",
    });
    assert.deepEqual(
      { checked: fresh.summary.checkedAnchors, fresh: fresh.summary.fresh, drift: fresh.summary.driftSuspected },
      { checked: 2, fresh: 2, drift: 0 }
    );
    assert.deepEqual(await Promise.all([
      fs.readFile(storeFile, "utf8"),
      fs.readFile(pageFile, "utf8"),
    ]), canonicalBefore);

    await fs.writeFile(fixture.servicePath, fixture.serviceContent.replace("  return 3;", "  return 3;   "), "utf8");
    const formattingOnly = await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      paths: ["src/service.ts"],
      checkedAt: "2026-08-18T08:01:00.000Z",
    });
    assert.equal(formattingOnly.summary.checkedAnchors, 1);
    assert.equal(formattingOnly.entries[0]?.verdict, "fresh");

    await fs.writeFile(fixture.servicePath, fixture.serviceContent.replace("return 3", "return 4"), "utf8");
    const changed = await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      paths: ["src"],
      checkedAt: "2026-08-18T08:02:00.000Z",
    });
    const serviceEntry = changed.entries.find((entry) => entry.claimId === fixture.serviceClaimId);
    assert.equal(serviceEntry?.verdict, "drift_suspected");
    assert.equal(serviceEntry?.reason, "content_changed");
    assert.deepEqual(serviceEntry?.pagePaths, [fixture.servicePage]);
    assert.deepEqual(changed.summary.recommendedClaimIds, [fixture.serviceClaimId]);

    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(fixture.wikiRoot);
    const context = await compileTaskContext({
      wikiRoot: fixture.wikiRoot,
      intent: "understand",
      objective: "Understand the invoice retry limit implementation",
      query: "invoice retry limit invoiceRetryLimit",
      maxEvidence: 8,
      heuristicTokenBudget: 4_000,
    });
    const stale = context.evidence.find((evidence) => evidence.path === fixture.servicePage);
    assert.equal(stale?.stale, true);
    assert.equal(stale?.staleReason, "drift_suspected");
    assert.deepEqual(stale?.driftClaimIds, [fixture.serviceClaimId]);
    assert.equal(context.implementationEvidence.some((evidence) => evidence.path === fixture.servicePage), false);
    assert.equal(context.gaps.some((gap) =>
      gap.kind === "stale_evidence" && gap.reason === "drift_suspected" &&
      gap.claimIds?.includes(fixture.serviceClaimId)
    ), true);
    const compact = compactStructuredContext(context);
    const compactStale = compact.evidence.find((evidence) => evidence.path === fixture.servicePage);
    assert.equal(compactStale?.stale, true);
    assert.equal(compactStale?.staleReason, "drift_suspected");

    await fs.unlink(fixture.servicePath);
    const missing = await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      paths: ["src/service.ts"],
      checkedAt: "2026-08-18T08:03:00.000Z",
    });
    assert.equal(missing.entries[0]?.verdict, "drift_suspected");
    assert.equal(missing.entries[0]?.reason, "file_missing");

    await fs.mkdir(fixture.servicePath);
    const unresolvable = await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      checkedAt: "2026-08-18T08:04:00.000Z",
    });
    assert.deepEqual(
      {
        checked: unresolvable.summary.checkedAnchors,
        fresh: unresolvable.summary.fresh,
        drift: unresolvable.summary.driftSuspected,
        unresolvable: unresolvable.summary.anchorUnresolvable,
      },
      { checked: 2, fresh: 1, drift: 0, unresolvable: 1 }
    );
    assert.equal(
      unresolvable.entries.find((entry) => entry.claimId === fixture.serviceClaimId)?.verdict,
      "anchor_unresolvable"
    );
    assert.equal(
      unresolvable.entries.find((entry) => entry.claimId === fixture.otherClaimId)?.verdict,
      "fresh"
    );
    assert.deepEqual(unresolvable.summary.recommendedClaimIds, [fixture.serviceClaimId]);

    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(fixture.wikiRoot);
    const unresolvedContext = await compileTaskContext({
      wikiRoot: fixture.wikiRoot,
      intent: "understand",
      objective: "Understand the invoice retry limit implementation",
      query: "invoice retry limit invoiceRetryLimit",
      maxEvidence: 8,
      heuristicTokenBudget: 4_000,
    });
    const unresolvedEvidence = unresolvedContext.evidence.find((evidence) =>
      evidence.path === fixture.servicePage
    );
    assert.equal(unresolvedEvidence?.stale, true);
    assert.equal(unresolvedEvidence?.staleReason, "anchor_unresolvable");
    assert.equal(unresolvedContext.gaps.some((gap) =>
      gap.kind === "stale_evidence" && gap.reason === "anchor_unresolvable" &&
      gap.claimIds?.includes(fixture.serviceClaimId)
    ), true);

    const parserOnly = evaluateCodeAnchor({
      anchor: fixture.anchor,
      content: fixture.serviceContent,
      parserVersion: "typescript-javascript-deterministic-v3",
    });
    assert.deepEqual(parserOnly, {
      verdict: "fresh",
      reason: "parser_version_changed",
      observedRangeHash: fixture.anchor.rangeHash,
    });
    assert.equal(evaluateCodeAnchor({ anchor: fixture.anchor, content: "export {};\n" }).reason, "range_out_of_bounds");
    assert.throws(() => normalizeRepositoryPath("C:/outside.ts"), /repository-relative/);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("path-scoped drift checks replace only their slice of the derived ledger", async () => {
  const fixture = await createFixture();
  try {
    await detectCodeDrift({ repositoryRoot: fixture.root, wikiRoot: fixture.wikiRoot });
    await fs.writeFile(fixture.servicePath, fixture.serviceContent.replace("return 3", "return 9"), "utf8");
    const scoped = await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      paths: ["src/service.ts"],
    });
    assert.equal(scoped.summary.scope, "paths");
    assert.equal(scoped.summary.checkedAnchors, 1);
    assert.deepEqual(scoped.entries.map((entry) => entry.claimId), [fixture.serviceClaimId]);
    const ledger = await readDriftLedger(fixture.wikiRoot);
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries.find((entry) => entry.claimId === fixture.serviceClaimId)?.verdict, "drift_suspected");
    assert.equal(ledger.entries.find((entry) => entry.claimId === fixture.otherClaimId)?.verdict, "fresh");

    await fs.unlink(fixture.servicePath);
    await detectCodeDrift({
      repositoryRoot: fixture.root,
      wikiRoot: fixture.wikiRoot,
      paths: ["src/service.ts"],
    });
    assert.equal((await readDriftLedger(fixture.wikiRoot)).entries.length, 2);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("claim anchoring refreshes only targeted code files", async () => {
  const fixture = await createFixture();
  try {
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: fixture.root, wikiRoot: fixture.wikiRoot });
    const snapshot = await index.snapshot();
    const fragment = snapshot.fragments.find((candidate) =>
      candidate.path === "src/service.ts" && candidate.symbol === "invoiceRetryLimit"
    );
    assert.ok(fragment);
    const targetUri = codeResourceUri(fragment);
    const unrelatedPath = path.join(fixture.root, "src/unrelated-after-index.ts");
    await fs.writeFile(unrelatedPath, "export const unrelatedAfterIndex = true;\n", "utf8");
    await fs.writeFile(fixture.servicePath, fixture.serviceContent.replace("return 3", "return 7"), "utf8");

    const sourceUri = "docs/normalized/incremental-anchor.md";
    const sourceContent = "# Incremental anchor\n\nThe retry limit is currently implemented by invoiceRetryLimit.\n";
    const plan = await sourceCompilePlan({
      wikiRoot: fixture.wikiRoot,
      sourceUri,
      content: sourceContent,
      segmentMaxChars: 4_096,
    });
    const recorded = await recordEvidenceClaims({
      wikiRoot: fixture.wikiRoot,
      sourceUri,
      sourceContent,
      segmentId: plan.ledger.segments[0]!.id,
      claims: [{
        text: "The retry limit is currently implemented by invoiceRetryLimit.",
        kind: "behavior",
        origin: "explicit",
        confidence: 1,
        target: {
          pagePath: "implementations/IncrementalInvoiceRetry.md",
          pageTitle: "Incremental invoice retry",
          pageType: "implementation",
          codeResourceUri: targetUri,
        },
      }],
    });

    assert.equal(recorded.anchorWarnings.length, 0);
    assert.ok(recorded.claims[0]?.codeAnchor);
    const after = await index.snapshot();
    assert.equal(after.files.some((file) => file.path === "src/unrelated-after-index.ts"), false);
    assert.notEqual(
      after.files.find((file) => file.path === "src/service.ts")?.contentHash,
      snapshot.files.find((file) => file.path === "src/service.ts")?.contentHash
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("migration backfill anchors only code targets that still resolve", async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(
      path.join(fixture.root, "src/unrelated-before-backfill.ts"),
      "export const unrelatedBeforeBackfill = true;\n",
      "utf8"
    );
    await mutateEvidenceIrStore(fixture.wikiRoot, (store) => {
      delete store.claims.find((claim) => claim.id === fixture.serviceClaimId)!.codeAnchor;
    });
    const result = await backfillEvidenceCodeAnchors(fixture.wikiRoot);
    assert.deepEqual(
      { eligible: result.eligible, anchored: result.anchored, unresolved: result.unresolved },
      { eligible: 2, anchored: 1, unresolved: 1 }
    );
    assert.equal(result.warnings.length, 1);
    const store = await readEvidenceIrStore(fixture.wikiRoot);
    assert.ok(store.claims.find((claim) => claim.id === fixture.serviceClaimId)?.codeAnchor);
    assert.equal(
      store.claims.find((claim) => claim.target?.codeResourceUri?.includes("src/missing.ts"))?.codeAnchor,
      undefined
    );
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: fixture.root, wikiRoot: fixture.wikiRoot });
    assert.equal(
      (await index.snapshot()).files.some((file) => file.path === "src/unrelated-before-backfill.ts"),
      false
    );
  } finally {
    await cleanupFixture(fixture);
  }
});
