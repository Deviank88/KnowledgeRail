import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyWikiMigration,
  detectWikiVersion,
  planWikiMigration,
  rollbackWikiMigration,
  type WikiFormatVersion,
} from "../src/core/migration-service.js";
import {
  readSourceCoverageLedger,
  sourceCoverageLedgerFile,
} from "../src/core/ingestion/coverage-ledger.js";
import { clearRetrievalIndexes, searchRetrievalIndex } from "../src/core/retrieval-index.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";

interface LegacyFixture {
  projectRoot: string;
  wikiRoot: string;
  canonical: Map<string, string>;
}

async function writeLegacyProject(version: 1 | 2 | 3): Promise<LegacyFixture> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `knowledge-rail-legacy-v${version}-`));
  const wikiRoot = path.join(projectRoot, "wiki");
  await fs.mkdir(path.join(wikiRoot, "requirements"), { recursive: true });
  await fs.mkdir(path.join(wikiRoot, "decisions"), { recursive: true });
  await fs.mkdir(path.join(wikiRoot, "tests"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "docs", "specs"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "docs", "specs", "legacy.md"),
    "# Legacy source\n\nThe amber gateway accepts exactly six delivery attempts.\n",
    "utf8"
  );

  const schema = version === 1
    ? "# Legacy schema\n\nCustom v1 conventions remain authoritative.\n"
    : "# Legacy schema v2\n\nindex.md viene rigenerato automaticamente. Custom conventions remain authoritative.\n";
  const canonical = new Map<string, string>([
    ["SCHEMA.md", schema],
    ["index.md", "# Legacy index\n\nHand-maintained historical catalog.\n"],
    ["log.md", "# Legacy log\n\n- historical operation\n"],
    ["requirements/REQ_AMBER.md", [
      "---",
      'title: "REQ-AMBER delivery policy"',
      "type: requirement",
      "request_id: REQ-AMBER",
      "tags: [amber, legacy]",
      "sources: [docs/specs/legacy.md, vendor/archive.pdf]",
      'custom_extension: "preserve-verbatim"',
      "---",
      "",
      "# Requirement",
      "",
      "The amber gateway accepts exactly six delivery attempts.",
      "",
    ].join("\n")],
    ["decisions/AmberDecision.md", [
      "---",
      'title: "Amber escalation decision"',
      "type: decision",
      "request_id: REQ-AMBER",
      "tags: [amber]",
      "sources: [docs/specs/legacy.md]",
      "---",
      "",
      "# Decision",
      "",
      "After the sixth failure, the message enters manual review.",
      "",
    ].join("\n")],
    ["tests/AmberTest.md", [
      "---",
      'title: "Amber retry verification"',
      "type: test_result",
      "request_id: REQ-AMBER",
      "tags: [amber, test]",
      "sources: [docs/specs/legacy.md]",
      "---",
      "",
      "# Verification",
      "",
      "The test proves escalation begins only after six failures.",
      "",
    ].join("\n")],
  ]);
  for (const [relative, content] of canonical) {
    const file = path.join(wikiRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  if (version === 3) {
    await fs.mkdir(path.join(wikiRoot, ".knowledge-rail"), { recursive: true });
    await fs.writeFile(path.join(wikiRoot, ".knowledge-rail", "state.json"), `${JSON.stringify({
      formatVersion: 3,
      artifactVersions: { manifest: 1, graph: 2, retrieval: 1 },
      migratedAt: "2026-01-01T00:00:00.000Z",
      migratedFrom: 2,
    }, null, 2)}\n`, "utf8");
  }
  return { projectRoot, wikiRoot, canonical };
}

async function assertCanonicalExact(fixture: LegacyFixture): Promise<void> {
  for (const [relative, content] of fixture.canonical) {
    assert.equal(await fs.readFile(path.join(fixture.wikiRoot, relative), "utf8"), content, relative);
  }
}

for (const version of [1, 2, 3] as const) {
  test(`v${version} migration preserves canonical knowledge, backfills coverage and rolls back`, async () => {
    const fixture = await writeLegacyProject(version);
    try {
      const plan = await planWikiMigration(fixture.wikiRoot);
      assert.equal(plan.detectedVersion, version);
      assert.equal(plan.targetVersion, 4);
      assert.equal(plan.blockers.length, 0);
      assert.equal(plan.pageCount, 3);
      assert.equal(plan.sourceCount, 2);
      assert.equal(await fs.stat(path.join(fixture.wikiRoot, ".knowledge-rail")).then(() => true).catch(() => false), version === 3);
      await assertCanonicalExact(fixture);

      clearRetrievalIndexes();
      const before = await searchRetrievalIndex({
        wikiRoot: fixture.wikiRoot,
        query: "REQ-AMBER exactly six delivery attempts",
        maxResults: 10,
        forceRefresh: true,
      });
      assert.equal(before[0]?.path, "requirements/REQ_AMBER.md");

      const result = await applyWikiMigration(fixture.wikiRoot, {
        targetVersion: "4",
        backup: true,
        projectRoot: fixture.projectRoot,
      });
      assert.equal(await detectWikiVersion(fixture.wikiRoot), 4);
      assert.equal(result.plan.detectedVersion, version);
      assert.equal(result.regression.after.pageCount, result.regression.before.pageCount);
      assert.deepEqual(result.regression.after.graphLinks, result.regression.before.graphLinks);
      assert.equal(result.regression.after.retrieval.every((probe) => probe.recovered), true);
      assert.equal(result.regression.after.documentContext.every((probe) => probe.recovered), true);
      await assertCanonicalExact(fixture);

      const ledger = await readSourceCoverageLedger(fixture.wikiRoot, "docs/specs/legacy.md");
      assert.ok(ledger);
      assert.equal(ledger.state, "open");
      assert.equal(ledger.segments.length > 0, true);
      assert.equal(ledger.segments.every((segment) => segment.status === "legacy_unverified"), true);
      const coverage = JSON.parse(await fs.readFile(result.coverageReportFile, "utf8")) as {
        entries: Array<{ sourceRef: string; verification: string; status: string }>;
        enrichment: { status: string; proposalCount: number };
      };
      assert.equal(coverage.entries.find((entry) => entry.sourceRef === "docs/specs/legacy.md")?.verification, "source_verified");
      assert.equal(coverage.entries.find((entry) => entry.sourceRef === "vendor/archive.pdf")?.status, "legacy_unverified");
      assert.deepEqual(coverage.enrichment, { status: "not_generated", proposalCount: 0 });

      for (const relative of fixture.canonical.keys()) {
        assert.equal(
          await fs.readFile(path.join(result.backupDir, relative), "utf8"),
          fixture.canonical.get(relative),
          `backup ${relative}`
        );
      }
      const journal = JSON.parse(await fs.readFile(result.journalFile, "utf8")) as {
        status: string;
        canonicalBefore: { digest: string };
        canonicalAfter: { digest: string };
      };
      assert.equal(journal.status, "complete");
      assert.equal(journal.canonicalAfter.digest, journal.canonicalBefore.digest);

      const rollback = await rollbackWikiMigration(fixture.wikiRoot, result.runId);
      assert.equal(rollback.status, "rolled_back");
      assert.equal(await detectWikiVersion(fixture.wikiRoot), version as WikiFormatVersion);
      assert.equal(
        await fs.access(sourceCoverageLedgerFile(fixture.wikiRoot, "docs/specs/legacy.md")).then(() => true).catch(() => false),
        false,
        "rollback must remove a ledger that did not exist before migration"
      );
      await assertCanonicalExact(fixture);
    } finally {
      clearRetrievalIndexes();
      await fs.rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });
}

test("failed migration restores derived state and records an automatic rollback", async () => {
  const fixture = await writeLegacyProject(3);
  const graphSentinel = "legacy-derived-graph-sentinel\n";
  try {
    await fs.mkdir(path.join(fixture.wikiRoot, ".knowledge-rail", "source-coverage"), { recursive: true });
    await fs.writeFile(path.join(fixture.wikiRoot, ".knowledge-rail", "graph.json"), graphSentinel, "utf8");
    await fs.writeFile(
      sourceCoverageLedgerFile(fixture.wikiRoot, "docs/specs/legacy.md"),
      "{ invalid coverage ledger",
      "utf8"
    );

    await assert.rejects(
      () => applyWikiMigration(fixture.wikiRoot, {
        targetVersion: "4",
        backup: true,
        projectRoot: fixture.projectRoot,
      }),
      /Existing source coverage ledger is invalid/
    );
    assert.equal(await detectWikiVersion(fixture.wikiRoot), 3);
    assert.equal(await fs.readFile(path.join(fixture.wikiRoot, ".knowledge-rail", "graph.json"), "utf8"), graphSentinel);
    await assertCanonicalExact(fixture);
    const runs = await fs.readdir(path.join(fixture.wikiRoot, ".knowledge-rail", "migrations"));
    assert.equal(runs.length, 1);
    const journal = JSON.parse(await fs.readFile(
      path.join(fixture.wikiRoot, ".knowledge-rail", "migrations", runs[0]!, "journal.json"),
      "utf8"
    )) as { status: string; error: string };
    assert.equal(journal.status, "rolled_back");
    assert.match(journal.error, /invalid/);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("migration preserves an existing valid coverage ledger and its provenance state", async () => {
  const fixture = await writeLegacyProject(3);
  try {
    const content = await fs.readFile(path.join(fixture.projectRoot, "docs", "specs", "legacy.md"), "utf8");
    await sourceCompilePlan({
      wikiRoot: fixture.wikiRoot,
      sourceUri: "docs/specs/legacy.md",
      content,
    });
    const ledgerFile = sourceCoverageLedgerFile(fixture.wikiRoot, "docs/specs/legacy.md");
    const before = await fs.readFile(ledgerFile, "utf8");
    const result = await applyWikiMigration(fixture.wikiRoot, {
      targetVersion: "4",
      backup: true,
      projectRoot: fixture.projectRoot,
    });
    assert.equal(await fs.readFile(ledgerFile, "utf8"), before);
    const coverage = JSON.parse(await fs.readFile(result.coverageReportFile, "utf8")) as {
      entries: Array<{ sourceRef: string; verification: string; status: string }>;
    };
    const known = coverage.entries.find((entry) => entry.sourceRef === "docs/specs/legacy.md");
    assert.deepEqual(known && { verification: known.verification, status: known.status }, {
      verification: "existing_ledger",
      status: "preserved",
    });
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("explicit rollback refuses to overwrite canonical knowledge changed after migration", async () => {
  const fixture = await writeLegacyProject(3);
  try {
    const result = await applyWikiMigration(fixture.wikiRoot, {
      targetVersion: "4",
      backup: true,
      projectRoot: fixture.projectRoot,
    });
    await fs.appendFile(
      path.join(fixture.wikiRoot, "requirements", "REQ_AMBER.md"),
      "\nNew post-migration knowledge.\n",
      "utf8"
    );
    await assert.rejects(
      () => rollbackWikiMigration(fixture.wikiRoot, result.runId),
      /refuses to overwrite newer knowledge/
    );
    assert.match(
      await fs.readFile(path.join(fixture.wikiRoot, "requirements", "REQ_AMBER.md"), "utf8"),
      /New post-migration knowledge/
    );
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("migration rejects a symlinked journal directory before writing a backup", async (t) => {
  const fixture = await writeLegacyProject(3);
  const outside = path.join(fixture.projectRoot, "outside-migrations");
  try {
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, path.join(fixture.wikiRoot, ".knowledge-rail", "migrations"), "dir");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (["EPERM", "EACCES", "ENOSYS"].includes(code ?? "")) {
        t.skip(`symlinks unavailable on this platform (${code})`);
        return;
      }
      throw error;
    }
    const plan = await planWikiMigration(fixture.wikiRoot);
    assert.equal(plan.blockers.some((blocker) => blocker.includes("must not be a symbolic link")), true);
    await assert.rejects(
      () => applyWikiMigration(fixture.wikiRoot, {
        targetVersion: "4",
        backup: true,
        projectRoot: fixture.projectRoot,
      }),
      /must not be a symbolic link/
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("rollback validates the complete backup before changing derived state", async () => {
  const fixture = await writeLegacyProject(3);
  try {
    const result = await applyWikiMigration(fixture.wikiRoot, {
      targetVersion: "4",
      backup: true,
      projectRoot: fixture.projectRoot,
    });
    const currentState = await fs.readFile(path.join(fixture.wikiRoot, ".knowledge-rail", "state.json"), "utf8");
    await fs.appendFile(path.join(result.backupDir, ".knowledge-rail", "state.json"), "tampered", "utf8");
    await assert.rejects(
      () => rollbackWikiMigration(fixture.wikiRoot, result.runId),
      /backup integrity check failed/
    );
    assert.equal(
      await fs.readFile(path.join(fixture.wikiRoot, ".knowledge-rail", "state.json"), "utf8"),
      currentState,
      "failed backup validation must not partially restore targets"
    );
    assert.equal(await detectWikiVersion(fixture.wikiRoot), 4);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});
