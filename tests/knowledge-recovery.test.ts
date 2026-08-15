import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { evidenceClaimId, type EvidenceClaimInput } from "../src/core/ingestion/evidence-claim.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { applyEvidenceSynthesis } from "../src/core/ingestion/evidence-synthesis.js";
import {
  sourceCompilePlan,
  sourceCoverage,
} from "../src/core/ingestion/source-compiler.js";
import {
  knowledgeRecoveryStatus,
  knowledgeRecoveryStoreFile,
  recordKnowledgeRecoveryUsage,
  resolveKnowledgeRecoveryEvent,
} from "../src/core/knowledge-recovery.js";

test("knowledge recovery deduplicates durable debt, tracks LateRecoveryRate and reopens rediscovered gaps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-debt-"));
  const wikiRoot = path.join(root, "wiki");
  const evidenceRef = "code://repo/src/orders.ts#symbol-0123456789abcdefabcd";

  try {
    const first = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: 2,
      timestamp: "2026-08-14T10:00:00.000Z",
      events: [{
        evidenceRef,
        sourceUri: evidenceRef,
        discoveredBy: "code_index",
        expectedWikiPages: ["implementations/OrderSync.md"],
        reason: "Indexed implementation evidence was used but absent from canonical wiki knowledge.",
      }],
    });
    assert.equal(first.created, 1);
    assert.equal(first.metrics.lateRecoveryRate, 0.5);
    assert.equal(first.metrics.knowledgeRecoveryPending, 1);
    assert.equal(await fs.stat(knowledgeRecoveryStoreFile(wikiRoot)).then((stat) => stat.isFile()), true);
    await assert.rejects(fs.access(path.join(wikiRoot, "implementations", "OrderSync.md")));

    const duplicate = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: 1,
      timestamp: "2026-08-14T10:01:00.000Z",
      events: [{
        evidenceRef,
        sourceUri: evidenceRef,
        discoveredBy: "grep_fallback",
        expectedWikiPages: ["implementations/OrderSync.md"],
        reason: "A diagnostic fallback confirmed the same missing evidence.",
      }],
    });
    assert.equal(duplicate.created, 0);
    assert.equal(duplicate.reused, 1);
    assert.equal(duplicate.events[0]?.occurrences, 2);
    assert.equal(duplicate.metrics.uniqueRecoveryEventCount, 1);

    const resolved = await resolveKnowledgeRecoveryEvent({
      wikiRoot,
      eventId: first.events[0]!.id,
      resolution: "intentionally_ignored",
      reason: "Diagnostic-only implementation detail; no canonical writeback is appropriate.",
      timestamp: "2026-08-14T10:02:00.000Z",
    });
    assert.equal(resolved.event.resolution, "intentionally_ignored");
    assert.equal(resolved.metrics.knowledgeRecoveryPending, 0);

    const representedUsage = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: 5,
      events: [],
      timestamp: "2026-08-14T10:03:00.000Z",
    });
    assert.equal(representedUsage.metrics.lateRecoveryRate, 2 / 8);

    const reopened = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: 1,
      events: [{
        evidenceRef,
        sourceUri: evidenceRef,
        discoveredBy: "code_index",
        expectedWikiPages: ["implementations/OrderSync.md"],
        reason: "The intentionally omitted detail became relevant again.",
      }],
      timestamp: "2026-08-14T10:04:00.000Z",
    });
    assert.equal(reopened.reopened, 1);
    assert.equal(reopened.events[0]?.occurrences, 3);
    assert.equal(reopened.metrics.knowledgeRecoveryPending, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source recovery closes only after provenance synthesis and coverage reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-source-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/retry-policy.md";
  const sourceContent = "# Retry policy\n\nOrder synchronization retries exactly four times before the DLQ.";
  const sourceFile = path.join(root, sourceUri);
  const pagePath = "requirements/OrderSyncRetry.md";
  const input: EvidenceClaimInput = {
    text: "Order synchronization retries exactly four times before the DLQ.",
    kind: "requirement",
    origin: "explicit",
    confidence: 1,
    target: {
      entityKey: "order-sync-retry",
      pagePath,
      pageTitle: "Order synchronization retry",
      pageType: "requirement",
    },
  };

  try {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, sourceContent, "utf8");
    const plan = await sourceCompilePlan({
      wikiRoot,
      sourceUri,
      content: sourceContent,
      segmentMaxChars: 4_096,
    });
    const segmentId = plan.ledger.segments[0]!.id;
    const claimId = evidenceClaimId({
      sourceUri,
      segmentId,
      text: input.text,
      kind: input.kind,
      origin: input.origin,
    });
    await recordEvidenceClaims({
      wikiRoot,
      sourceUri,
      sourceContent,
      segmentId,
      claims: [input],
    });
    const recorded = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: 2,
      events: [{
        evidenceRef: claimId,
        sourceUri,
        discoveredBy: "source_fallback",
        expectedWikiPages: [pagePath],
        reason: "The fallback found a requirement that was not represented in the wiki.",
      }],
    });
    assert.equal(recorded.metrics.lateRecoveryRate, 0.5);
    await assert.rejects(fs.access(path.join(wikiRoot, pagePath)));
    await assert.rejects(
      resolveKnowledgeRecoveryEvent({
        wikiRoot,
        eventId: recorded.events[0]!.id,
        resolution: "new_page",
        pageRefs: [pagePath],
        reason: "Premature resolution probe.",
      })
    );
    assert.equal((await knowledgeRecoveryStatus(wikiRoot)).metrics.knowledgeRecoveryPending, 1);

    await resolveEvidenceClaims({ wikiRoot, claimIds: [claimId] });
    const drafts = await applyEvidenceSynthesis({ wikiRoot, claimIds: [claimId] });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.pagePath, pagePath);
    const result = await resolveKnowledgeRecoveryEvent({
      wikiRoot,
      eventId: recorded.events[0]!.id,
      resolution: "new_page",
      pageRefs: [pagePath],
      reason: "Evidence IR synthesis wrote the validated canonical page with exact provenance.",
    });
    assert.equal(result.metrics.knowledgeRecoveryPending, 0);
    assert.equal(result.event.resolution, "new_page");

    const coverage = await sourceCoverage({ wikiRoot, sourceUri, content: sourceContent });
    const segment = coverage.ledger.segments.find((item) => item.id === segmentId);
    assert.equal(segment?.status, "integrated");
    assert.equal(segment?.evidenceRefs.includes(claimId), true);
    assert.equal(segment?.pageRefs.includes(pagePath), true);

    const afterWriteback = await recordKnowledgeRecoveryUsage({
      wikiRoot,
      totalEvidenceUsed: 2,
      events: [],
    });
    assert.equal(afterWriteback.metrics.lateRecoveryRate, 0.25);
    assert.equal(afterWriteback.metrics.uniqueRecoveryEventCount, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("knowledge recovery fails closed for traversal and corrupt durable state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-security-"));
  const wikiRoot = path.join(root, "wiki");
  const evidenceRef = "code://repo/src/safe.ts#symbol-0123456789abcdefabcd";

  try {
    await assert.rejects(
      recordKnowledgeRecoveryUsage({
        wikiRoot,
        totalEvidenceUsed: 1,
        events: [{
          evidenceRef,
          sourceUri: evidenceRef,
          discoveredBy: "code_index",
          expectedWikiPages: ["../outside.md"],
          reason: "Traversal probe.",
        }],
      }),
      /relative wiki Markdown path/
    );

    await fs.mkdir(path.dirname(knowledgeRecoveryStoreFile(wikiRoot)), { recursive: true });
    await fs.writeFile(knowledgeRecoveryStoreFile(wikiRoot), "{not-json}\n", "utf8");
    await assert.rejects(
      recordKnowledgeRecoveryUsage({
        wikiRoot,
        totalEvidenceUsed: 1,
        events: [],
      }),
      /invalid JSON; refusing to overwrite durable debt/
    );
    assert.equal(await fs.readFile(knowledgeRecoveryStoreFile(wikiRoot), "utf8"), "{not-json}\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent recovery observations preserve counters and event occurrences", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-concurrent-"));
  const wikiRoot = path.join(root, "wiki");

  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const variant = index % 2;
      const evidenceRef = `code://repo/src/worker-${variant}.ts#symbol-${variant === 0
        ? "0123456789abcdefabcd"
        : "fedcba9876543210abcd"}`;
      return recordKnowledgeRecoveryUsage({
        wikiRoot,
        totalEvidenceUsed: 1,
        events: [{
          evidenceRef,
          sourceUri: evidenceRef,
          discoveredBy: "code_index",
          expectedWikiPages: [`implementations/Worker${variant}.md`],
          reason: `Concurrent recovery observation ${index}.`,
        }],
      });
    }));
    const status = await knowledgeRecoveryStatus(wikiRoot);
    assert.equal(status.metrics.totalEvidenceUsed, 12);
    assert.equal(status.metrics.lateRecoveryEvidenceUsed, 12);
    assert.equal(status.metrics.uniqueRecoveryEventCount, 2);
    assert.deepEqual(status.events.map((event) => event.occurrences), [6, 6]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("knowledge recovery rejects a symlinked canonical docs directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-docs-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-recovery-docs-outside-"));
  const wikiRoot = path.join(root, "wiki");
  const evidenceRef = "code://repo/src/safe.ts#symbol-0123456789abcdefabcd";

  try {
    try {
      await fs.symlink(outside, path.join(root, "docs"), "dir");
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      t.skip(`symlinks unavailable on this platform (${code})`);
      return;
    }
    await assert.rejects(
      recordKnowledgeRecoveryUsage({
        wikiRoot,
        totalEvidenceUsed: 1,
        events: [{
          evidenceRef,
          sourceUri: evidenceRef,
          discoveredBy: "code_index",
          reason: "Symlink escape probe.",
        }],
      }),
      /docs directory does not resolve inside the workspace root/
    );
    await assert.rejects(fs.stat(path.join(outside, "evidence-ir")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
