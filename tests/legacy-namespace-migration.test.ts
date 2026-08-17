import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyWikiMigration,
  detectWikiVersion,
  planWikiMigration,
  rollbackWikiMigration,
} from "../src/core/migration-service.js";
import { readManifest } from "../src/core/manifest-service.js";
import {
  readSourceCoverageLedger,
  sourceCoverageLedgerFile,
} from "../src/core/ingestion/coverage-ledger.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeLegacyNamespaceProject(version: 3 | 4): Promise<{
  projectRoot: string;
  wikiRoot: string;
  pagePath: string;
  pageContent: string;
  sourceContent: string;
  legacyManifestRaw: string;
}> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-legacy-namespace-"));
  const wikiRoot = path.join(projectRoot, "wiki");
  const pagePath = "concepts/Legacy.md";
  const pageContent = [
    "---",
    'title: "Legacy namespace page"',
    "type: concept",
    "tags: [legacy]",
    "sources: [docs/source.md]",
    "---",
    "",
    "# Legacy namespace page",
    "",
    "The amber namespace evidence remains searchable.",
    "",
  ].join("\n");
  const sourceContent = "# Source\n\nThe amber namespace evidence remains searchable.\n";
  await fs.mkdir(path.join(wikiRoot, "concepts"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await fs.mkdir(path.join(wikiRoot, ".llm-wiki"), { recursive: true });
  await fs.writeFile(path.join(wikiRoot, "SCHEMA.md"), "# Legacy schema\n\nWiki format: 3.\n", "utf8");
  await fs.writeFile(path.join(wikiRoot, "index.md"), "# Legacy index\n", "utf8");
  await fs.writeFile(path.join(wikiRoot, "log.md"), "# Legacy log\n", "utf8");
  await fs.writeFile(path.join(wikiRoot, pagePath), pageContent, "utf8");
  await fs.writeFile(path.join(projectRoot, "docs", "source.md"), sourceContent, "utf8");
  await fs.writeFile(path.join(wikiRoot, ".llm-wiki", "state.json"), `${JSON.stringify({
    formatVersion: version,
    artifactVersions: { manifest: 1, graph: 2, retrieval: 1 },
    migratedAt: "2026-07-11T21:30:36.067Z",
    migratedFrom: 1,
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(wikiRoot, ".llm-wiki", "graph.json"), "legacy graph sentinel\n", "utf8");

  const legacyBytes = Buffer.from(pageContent.replace(/\r?\n/g, "\r\n"), "utf8");
  const stat = await fs.stat(path.join(wikiRoot, pagePath));
  const legacyManifestRaw = `${JSON.stringify({
    version: 1,
    generatedAt: "2026-07-31T10:59:32.156Z",
    entries: [{
      path: pagePath,
      size: legacyBytes.length,
      mtimeMs: stat.mtimeMs,
      sha256: sha256(legacyBytes),
      logicalType: "wiki_page",
    }],
  }, null, 2)}\n`;
  await fs.writeFile(path.join(wikiRoot, ".llm-wiki", "manifest.json"), legacyManifestRaw, "utf8");
  return { projectRoot, wikiRoot, pagePath, pageContent, sourceContent, legacyManifestRaw };
}

test("migration detects .llm-wiki, rebuilds its stale CRLF manifest and rolls back", async () => {
  const fixture = await writeLegacyNamespaceProject(3);
  try {
    const plan = await planWikiMigration(fixture.wikiRoot);
    assert.equal(plan.detectedVersion, 3);
    assert.equal(plan.sourceNamespace, "llm_wiki");
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.legacyManifest?.status, "stale");
    assert.equal(plan.legacyManifest?.lineEndingEquivalentMatches, 1);
    assert.equal(plan.legacyManifest?.addedEntries, 3);

    const result = await applyWikiMigration(fixture.wikiRoot, {
      targetVersion: "4",
      backup: true,
      projectRoot: fixture.projectRoot,
    });
    assert.equal(await detectWikiVersion(fixture.wikiRoot), 4);
    assert.equal(result.plan.sourceNamespace, "llm_wiki");
    assert.equal(
      await fs.readFile(path.join(fixture.wikiRoot, ".llm-wiki", "manifest.json"), "utf8"),
      fixture.legacyManifestRaw,
      "the legacy namespace must remain byte-preserved"
    );
    assert.equal(
      await fs.readFile(path.join(result.backupDir, ".llm-wiki", "manifest.json"), "utf8"),
      fixture.legacyManifestRaw
    );

    const rebuilt = await readManifest(fixture.wikiRoot);
    assert.ok(rebuilt);
    assert.equal(rebuilt.version, 2);
    assert.deepEqual(rebuilt.entries.map((entry) => entry.path), [
      "SCHEMA.md",
      fixture.pagePath,
      "index.md",
      "log.md",
    ]);
    const rebuiltPage = rebuilt.entries.find((entry) => entry.path === fixture.pagePath);
    assert.equal(rebuiltPage?.size, Buffer.byteLength(fixture.pageContent));
    assert.equal(rebuiltPage?.sha256, sha256(fixture.pageContent));
    const state = JSON.parse(
      await fs.readFile(path.join(fixture.wikiRoot, ".knowledge-rail", "state.json"), "utf8")
    ) as { artifactVersions?: { manifest?: number } };
    assert.equal(state.artifactVersions?.manifest, 2);

    const journal = JSON.parse(await fs.readFile(result.journalFile, "utf8")) as {
      sourceNamespace?: string;
      legacyManifest?: { lineEndingEquivalentMatches?: number };
    };
    assert.equal(journal.sourceNamespace, "llm_wiki");
    assert.equal(journal.legacyManifest?.lineEndingEquivalentMatches, 1);

    await rollbackWikiMigration(fixture.wikiRoot, result.runId);
    assert.equal(await detectWikiVersion(fixture.wikiRoot), 3);
    assert.equal(
      await fs.access(path.join(fixture.wikiRoot, ".knowledge-rail", "manifest.json"))
        .then(() => true).catch(() => false),
      false
    );
    assert.equal(
      await fs.readFile(path.join(fixture.wikiRoot, ".llm-wiki", "manifest.json"), "utf8"),
      fixture.legacyManifestRaw
    );
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("migration imports valid v4 source coverage from the legacy namespace", async () => {
  const fixture = await writeLegacyNamespaceProject(4);
  try {
    await sourceCompilePlan({
      wikiRoot: fixture.wikiRoot,
      sourceUri: "docs/source.md",
      content: fixture.sourceContent,
    });
    const currentLedger = sourceCoverageLedgerFile(fixture.wikiRoot, "docs/source.md");
    const ledgerBytes = await fs.readFile(currentLedger);
    const legacyLedger = path.join(
      fixture.wikiRoot,
      ".llm-wiki",
      "source-coverage",
      path.basename(currentLedger)
    );
    await fs.mkdir(path.dirname(legacyLedger), { recursive: true });
    await fs.writeFile(legacyLedger, ledgerBytes);
    await fs.rm(path.join(fixture.wikiRoot, ".knowledge-rail"), { recursive: true, force: true });

    const result = await applyWikiMigration(fixture.wikiRoot, {
      targetVersion: "4",
      backup: true,
      projectRoot: fixture.projectRoot,
    });
    assert.equal(result.plan.sourceNamespace, "llm_wiki");
    assert.deepEqual(await fs.readFile(currentLedger), ledgerBytes);
    assert.ok(await readSourceCoverageLedger(fixture.wikiRoot, "docs/source.md"));
    const coverage = JSON.parse(await fs.readFile(result.coverageReportFile, "utf8")) as {
      entries: Array<{ sourceRef: string; verification: string; status: string }>;
    };
    const known = coverage.entries.find((entry) => entry.sourceRef === "docs/source.md");
    assert.deepEqual(
      known && { sourceRef: known.sourceRef, verification: known.verification, status: known.status },
      { sourceRef: "docs/source.md", verification: "existing_ledger", status: "preserved" }
    );
    const journal = JSON.parse(await fs.readFile(result.journalFile, "utf8")) as {
      importedLegacyCoverageFiles?: number;
    };
    assert.equal(journal.importedLegacyCoverageFiles, 1);
    await rollbackWikiMigration(fixture.wikiRoot, result.runId);
    assert.equal(
      await fs.access(currentLedger).then(() => true).catch(() => false),
      false,
      "rollback must remove the imported KnowledgeRail ledger"
    );
    assert.deepEqual(await fs.readFile(legacyLedger), ledgerBytes);
    assert.equal(await detectWikiVersion(fixture.wikiRoot), 4);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("migration blocks ambiguous partial KnowledgeRail metadata beside .llm-wiki", async () => {
  const fixture = await writeLegacyNamespaceProject(3);
  try {
    await fs.mkdir(path.join(fixture.wikiRoot, ".knowledge-rail"), { recursive: true });
    await fs.writeFile(path.join(fixture.wikiRoot, ".knowledge-rail", "manifest.json"), "{}\n", "utf8");
    const plan = await planWikiMigration(fixture.wikiRoot);
    assert.equal(plan.sourceNamespace, "llm_wiki");
    assert.equal(plan.blockers.some((blocker) => blocker.includes("conflicts with partial")), true);
    await assert.rejects(
      () => applyWikiMigration(fixture.wikiRoot, { backup: true, projectRoot: fixture.projectRoot }),
      /conflicts with partial/
    );
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("migration rejects a symlinked legacy metadata namespace", async (t) => {
  const fixture = await writeLegacyNamespaceProject(3);
  const outside = path.join(fixture.projectRoot, "legacy-meta-outside");
  try {
    await fs.rename(path.join(fixture.wikiRoot, ".llm-wiki"), outside);
    try {
      await fs.symlink(outside, path.join(fixture.wikiRoot, ".llm-wiki"), "dir");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (["EPERM", "EACCES", "ENOSYS"].includes(code ?? "")) {
        t.skip(`symlinks unavailable on this platform (${code})`);
        return;
      }
      throw error;
    }
    const before = await fs.readFile(path.join(outside, "manifest.json"), "utf8");
    const plan = await planWikiMigration(fixture.wikiRoot);
    assert.equal(plan.blockers.some((blocker) => blocker.includes("must not be a symbolic link")), true);
    await assert.rejects(
      () => applyWikiMigration(fixture.wikiRoot, { backup: true, projectRoot: fixture.projectRoot }),
      /must not be a symbolic link/
    );
    assert.equal(await fs.readFile(path.join(outside, "manifest.json"), "utf8"), before);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("migration blocks an incomplete journal left in the legacy namespace", async () => {
  const fixture = await writeLegacyNamespaceProject(3);
  try {
    const run = path.join(fixture.wikiRoot, ".llm-wiki", "migrations", "legacy_run_1");
    await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, "journal.json"), `${JSON.stringify({
      version: 1,
      runId: "legacy_run_1",
      status: "backed_up",
    })}\n`, "utf8");
    const plan = await planWikiMigration(fixture.wikiRoot);
    assert.equal(
      plan.blockers.some((blocker) => blocker.includes("Incomplete .llm-wiki migrations")),
      true
    );
    await assert.rejects(
      () => applyWikiMigration(fixture.wikiRoot, { backup: true, projectRoot: fixture.projectRoot }),
      /Incomplete \.llm-wiki migrations/
    );
  } finally {
    clearRetrievalIndexes();
    await fs.rm(fixture.projectRoot, { recursive: true, force: true });
  }
});
