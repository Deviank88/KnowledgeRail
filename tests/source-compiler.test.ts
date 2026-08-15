import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  sourceCompileNext,
  sourceCompilePlan,
  sourceCoverage,
  sourceFinalize,
  sourceRecordSegment,
} from "../src/core/ingestion/source-compiler.js";
import {
  segmentSource,
  sourceSegmentAccountingIsComplete,
} from "../src/core/ingestion/source-segmentation.js";

test("source segmentation is deterministic, content-addressed and accounts for every character", () => {
  const sourceUri = "docs/normalized/example.md";
  const content = [
    "preface\n\n",
    "# Requirements\n\n",
    "The service must retain the audit record.\n\n",
    "## Data\n\n",
    "| Field | Rule |\n| --- | --- |\n| audit_id | required |\n",
    "\n```ts\nexport function stableSymbol(): string { return 'ok'; }\n```\n",
    "tail".repeat(400),
  ].join("");

  const first = segmentSource(content, { sourceUri, maxChars: 512 });
  const second = segmentSource(content, { sourceUri, maxChars: 512 });

  assert.deepEqual(second, first);
  assert.equal(sourceSegmentAccountingIsComplete(content, first), true);
  assert.equal(first.every((segment) => segment.chars <= 512), true);
  assert.equal(new Set(first.map((segment) => segment.id)).size, first.length);
  assert.equal(first.some((segment) => segment.kind === "markdown_section"), true);

  const standaloneTable = "| Field | Rule |\n| --- | --- |\n| audit_id | required |\n";
  assert.equal(
    segmentSource(standaloneTable, { sourceUri: "docs/normalized/table.md", maxChars: 512 })[0]?.kind,
    "table_block"
  );
  const standaloneCode = "```ts\nexport function stableSymbol(): string { return 'ok'; }\n```\n";
  assert.equal(
    segmentSource(standaloneCode, { sourceUri: "docs/normalized/code.md", maxChars: 512 })[0]?.kind,
    "code_symbol"
  );
});

test("coverage ledger remains open until every segment has an explicit valid disposition", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-compiler-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/large.md";
  const content = [
    "# First\n\n",
    "alpha ".repeat(180),
    "\n\n# Second\n\n",
    "omega ".repeat(180),
  ].join("");
  await fs.mkdir(path.join(wikiRoot, "client-sources"), { recursive: true });

  try {
    await assert.rejects(
      sourceCoverage({ wikiRoot, sourceUri, content }),
      /Source coverage is unknown/
    );
    const planned = await sourceCompilePlan({
      wikiRoot,
      sourceUri,
      content,
      segmentMaxChars: 700,
    });
    assert.equal(planned.ledger.state, "open");
    assert.equal(planned.metrics.sourceCoveragePercent, 0);
    assert.equal(planned.metrics.unresolvedSegmentCount, planned.metrics.totalSegments);

    const first = await sourceCompileNext({ wikiRoot, sourceUri, content, maxChars: 700 });
    assert.ok(first);
    await assert.rejects(
      sourceFinalize({ wikiRoot, sourceUri, content }),
      /Cannot finalize source coverage/
    );
    await assert.rejects(
      sourceRecordSegment({
        wikiRoot,
        sourceUri,
        content,
        segmentId: first.segment.id,
        resolution: { status: "irrelevant" },
      }),
      /irrelevant requires a reason/
    );
    await sourceRecordSegment({
      wikiRoot,
      sourceUri,
      content,
      segmentId: first.segment.id,
      resolution: { status: "irrelevant", reason: "formatting-only preface" },
    });

    const remaining = (await sourceCoverage({ wikiRoot, sourceUri, content })).ledger.segments
      .filter((segment) => segment.status === "unresolved");
    const finalSegment = remaining.at(-1);
    assert.ok(finalSegment);
    for (const segment of remaining.slice(0, -1)) {
      await sourceRecordSegment({
        wikiRoot,
        sourceUri,
        content,
        segmentId: segment.id,
        resolution: { status: "irrelevant", reason: "fixture filler" },
      });
    }

    const pageRef = "client-sources/final.md";
    await fs.writeFile(path.join(wikiRoot, pageRef), "# Final\n\nrepresented evidence", "utf8");
    await sourceRecordSegment({
      wikiRoot,
      sourceUri,
      content,
      segmentId: finalSegment.id,
      resolution: {
        status: "integrated",
        evidenceRefs: [`${sourceUri}#${finalSegment.id}`],
        pageRefs: [pageRef],
      },
    });
    const finalized = await sourceFinalize({ wikiRoot, sourceUri, content });
    assert.equal(finalized.ledger.state, "fully_covered");
    assert.equal(finalized.metrics.sourceCoveragePercent, 100);
    assert.equal(finalized.metrics.unresolvedSegmentCount, 0);
    assert.equal(finalized.metrics.unrepresentedEvidenceCount, 0);
    assert.equal(finalized.metrics.segmentsProcessed, finalized.metrics.totalSegments);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("changing a compiled source reopens coverage and rejects stale reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-refresh-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/changing.md";
  const original = "# Stable\n\nSame evidence.";
  const changed = `${original}\n\n# New\n\nPreviously unseen evidence.`;

  try {
    const initial = await sourceCompilePlan({ wikiRoot, sourceUri, content: original, segmentMaxChars: 500 });
    await assert.rejects(
      sourceCompileNext({ wikiRoot, sourceUri, content: changed, maxChars: 500 }),
      /Source changed after compilation plan/
    );
    const refreshed = await sourceCompilePlan({ wikiRoot, sourceUri, content: changed, segmentMaxChars: 500 });
    assert.equal(refreshed.refreshed, true);
    assert.notEqual(refreshed.ledger.sourceHash, initial.ledger.sourceHash);
    assert.equal(refreshed.ledger.state, "open");
    assert.equal(refreshed.metrics.unresolvedSegmentCount > 0, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid derived ledgers fail closed as unknown coverage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-invalid-ledger-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/corrupt.md";
  const content = "# Evidence\n\nnot actually accounted";

  try {
    const planned = await sourceCompilePlan({ wikiRoot, sourceUri, content, segmentMaxChars: 500 });
    const ledgerDir = path.join(wikiRoot, ".knowledge-rail", "source-coverage");
    const [ledgerFile] = await fs.readdir(ledgerDir);
    assert.ok(ledgerFile);
    await fs.writeFile(
      path.join(ledgerDir, ledgerFile),
      JSON.stringify({ ...planned.ledger, state: "fully_covered", finalizedAt: new Date().toISOString() }),
      "utf8"
    );
    await assert.rejects(
      sourceCoverage({ wikiRoot, sourceUri, content }),
      /Source coverage is unknown/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent segment resolutions are serialized without lost updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-concurrent-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/normalized/concurrent.md";
  const content = `# One\n\n${"alpha ".repeat(100)}\n\n# Two\n\n${"beta ".repeat(100)}`;

  try {
    const planned = await sourceCompilePlan({ wikiRoot, sourceUri, content, segmentMaxChars: 500 });
    const [first, second] = planned.ledger.segments;
    assert.ok(first);
    assert.ok(second);
    await Promise.all([
      sourceRecordSegment({
        wikiRoot,
        sourceUri,
        content,
        segmentId: first.id,
        resolution: { status: "irrelevant", reason: "first explicit resolution" },
      }),
      sourceRecordSegment({
        wikiRoot,
        sourceUri,
        content,
        segmentId: second.id,
        resolution: { status: "irrelevant", reason: "second explicit resolution" },
      }),
    ]);
    const coverage = await sourceCoverage({ wikiRoot, sourceUri, content });
    assert.equal(coverage.ledger.segments.find((segment) => segment.id === first.id)?.status, "irrelevant");
    assert.equal(coverage.ledger.segments.find((segment) => segment.id === second.id)?.status, "irrelevant");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("page evidence references reject symlinks escaping the wiki root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-page-ref-security-"));
  const wikiRoot = path.join(root, "wiki");
  const outside = path.join(root, "outside.md");
  const link = path.join(wikiRoot, "client-sources", "escape.md");
  const sourceUri = "docs/normalized/security.md";
  const content = "# Security\n\nEvidence.";

  try {
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.writeFile(outside, "# Outside\n\nnot canonical", "utf8");
    try {
      await fs.symlink(outside, link, "file");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        t.skip(`symlinks unavailable on this platform (${code})`);
        return;
      }
      throw error;
    }
    const planned = await sourceCompilePlan({ wikiRoot, sourceUri, content, segmentMaxChars: 500 });
    const segment = planned.ledger.segments[0];
    assert.ok(segment);
    await assert.rejects(
      sourceRecordSegment({
        wikiRoot,
        sourceUri,
        content,
        segmentId: segment.id,
        resolution: {
          status: "integrated",
          evidenceRefs: [`${sourceUri}#${segment.id}`],
          pageRefs: ["client-sources/escape.md"],
        },
      }),
      /resolves outside the wiki root/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
