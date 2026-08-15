import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSectionContext } from "../src/core/document-workflow.js";
import {
  applyWikiMigration,
  detectWikiVersion,
  planWikiMigration,
  rollbackWikiMigration,
  type LegacyCoverageReport,
  type WikiFormatVersion,
} from "../src/core/migration-service.js";
import { readSourceCoverageLedger } from "../src/core/ingestion/coverage-ledger.js";
import { clearRetrievalIndexes, searchRetrievalIndex } from "../src/core/retrieval-index.js";

interface GoldenSource {
  path: string;
  content: string;
}

interface GoldenPage {
  path: string;
  title: string;
  type: string;
  requestId?: string;
  sources: string[];
  customFrontmatter: string[];
  body: string;
}

interface GoldenQuery {
  id: string;
  query: string;
  expectedPaths: string[];
}

interface LegacyMigrationFixture {
  version: number;
  sourceVersions: Array<1 | 2 | 3>;
  knownSource: GoldenSource;
  pages: GoldenPage[];
  retrievalQueries: GoldenQuery[];
  documentQuery: Omit<GoldenQuery, "id">;
}

export interface LegacyMigrationCaseReport {
  sourceVersion: 1 | 2 | 3;
  migrationMs: number;
  dryRunWrites: number;
  canonicalBefore: string;
  canonicalAfter: string;
  canonicalAfterRollback: string;
  canonicalPreserved: boolean;
  customMetadataPreserved: boolean;
  backupComplete: boolean;
  targetVersion: WikiFormatVersion | "unknown";
  rollbackVersion: WikiFormatVersion | "unknown";
  pageCountPreserved: boolean;
  sourceCountPreserved: boolean;
  graphLinksPreserved: boolean;
  retrievalRecallBefore: number;
  retrievalRecallAfter: number;
  documentRecallBefore: number;
  documentRecallAfter: number;
  knownSourceLegacyUnverified: boolean;
  unknownSourceTracked: boolean;
  enrichmentProposalCount: number;
  journalComplete: boolean;
  rollbackComplete: boolean;
}

export interface LegacyMigrationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  sourceVersions: number[];
  metrics: {
    CanonicalPreservationRate: number;
    CustomMetadataPreservationRate: number;
    BackupCompletenessRate: number;
    DryRunWriteCount: number;
    TargetV4Rate: number;
    RollbackRecoveryRate: number;
    PageCountPreservationRate: number;
    SourceCountPreservationRate: number;
    GraphLinkPreservationRate: number;
    RetrievalRecallBefore: number;
    RetrievalRecallAfter: number;
    DocumentRecallBefore: number;
    DocumentRecallAfter: number;
    LegacyUnverifiedBackfillRate: number;
    UnknownSourceTrackingRate: number;
    EnrichmentProposalCount: number;
    JournalCompletionRate: number;
    MigrationLatencyP50Ms: number;
    MigrationLatencyP95Ms: number;
  };
  cases: LegacyMigrationCaseReport[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEGACY_MIGRATION_FIXTURE = path.join(HERE, "fixtures", "legacy-migration-golden.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue / 100) - 1)]!;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSnapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(directory: string, relative = ""): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) result.set(childRelative.replace(/\\/g, "/"), sha256(await fs.readFile(child)));
    }
  }
  await walk(root);
  return result;
}

function snapshotDigest(snapshot: Map<string, string>, markdownOnly: boolean): string {
  return sha256([...snapshot.entries()]
    .filter(([file]) =>
      !markdownOnly || (file.toLowerCase().endsWith(".md") && !file.startsWith(".knowledge-rail/"))
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, hash]) => `${file}\0${hash}`)
    .join("\n"));
}

function schemaFor(version: 1 | 2 | 3): string {
  if (version === 1) return "# Legacy schema\n\nVendor-specific v1 conventions remain authoritative.\n";
  if (version === 2) return "# Legacy schema v2\n\nindex.md viene rigenerato automaticamente. Vendor conventions remain authoritative.\n";
  return "# Legacy schema\n\nWiki format: 3. Vendor conventions remain authoritative.\n";
}

function pageMarkdown(page: GoldenPage): string {
  return [
    "---",
    `title: "${page.title}"`,
    `type: ${page.type}`,
    "tags: [legacy, migration-golden]",
    `sources: [${page.sources.join(", ")}]`,
    ...(page.requestId ? [`request_id: ${page.requestId}`] : []),
    ...page.customFrontmatter,
    "---",
    "",
    page.body,
    "",
  ].join("\n");
}

async function materializeFixture(
  fixture: LegacyMigrationFixture,
  sourceVersion: 1 | 2 | 3
): Promise<{ projectRoot: string; wikiRoot: string; canonical: Map<string, string> }> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `knowledge-rail-migration-eval-v${sourceVersion}-`));
  const wikiRoot = path.join(projectRoot, "wiki");
  const canonical = new Map<string, string>([
    ["SCHEMA.md", schemaFor(sourceVersion)],
    ["index.md", "# Legacy index\n\nPreserve this catalog verbatim.\n"],
    ["log.md", "# Legacy log\n\n- preserved operation\n"],
  ]);
  for (const page of fixture.pages) canonical.set(page.path, pageMarkdown(page));
  for (const [relative, content] of canonical) {
    const file = path.join(wikiRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  const sourceFile = path.join(projectRoot, fixture.knownSource.path);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, fixture.knownSource.content, "utf8");
  if (sourceVersion === 3) {
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

async function retrievalRecall(wikiRoot: string, queries: readonly GoldenQuery[]): Promise<number> {
  let expected = 0;
  let recovered = 0;
  for (const query of queries) {
    const hits = await searchRetrievalIndex({
      wikiRoot,
      query: query.query,
      maxResults: 10,
      profile: "coverage",
      forceRefresh: true,
    });
    const paths = new Set(hits.map((hit) => hit.path));
    for (const path of query.expectedPaths) {
      expected++;
      if (paths.has(path)) recovered++;
    }
  }
  return ratio(recovered, expected);
}

async function documentRecall(
  wikiRoot: string,
  query: LegacyMigrationFixture["documentQuery"]
): Promise<number> {
  const context = await createSectionContext({
    wikiRoot,
    sectionTitle: "Orchid settlement controls",
    query: query.query,
    maxPages: 10,
    maxCharsPerPage: 4_000,
    maxTotalChars: 24_000,
    retrievalProfile: "coverage",
    useGraph: true,
  });
  const paths = new Set(context.pages.map((page) => page.relPath));
  return ratio(query.expectedPaths.filter((item) => paths.has(item)).length, query.expectedPaths.length);
}

async function evaluateCase(
  fixture: LegacyMigrationFixture,
  sourceVersion: 1 | 2 | 3
): Promise<LegacyMigrationCaseReport> {
  const materialized = await materializeFixture(fixture, sourceVersion);
  const { projectRoot, wikiRoot, canonical } = materialized;
  try {
    const initialTree = await fileSnapshot(wikiRoot);
    const canonicalBefore = snapshotDigest(initialTree, true);
    const plan = await planWikiMigration(wikiRoot);
    if (plan.blockers.length > 0) throw new Error(plan.blockers.join(" "));
    const afterPlan = await fileSnapshot(wikiRoot);
    const dryRunWrites = [...new Set([...initialTree.keys(), ...afterPlan.keys()])]
      .filter((file) => initialTree.get(file) !== afterPlan.get(file)).length;

    clearRetrievalIndexes();
    const retrievalBefore = await retrievalRecall(wikiRoot, fixture.retrievalQueries);
    const documentBefore = await documentRecall(wikiRoot, fixture.documentQuery);
    const started = performance.now();
    const migration = await applyWikiMigration(wikiRoot, {
      targetVersion: "4",
      backup: true,
      projectRoot,
    });
    const migrationMs = performance.now() - started;
    const afterTree = await fileSnapshot(wikiRoot);
    const canonicalAfter = snapshotDigest(afterTree, true);
    const retrievalAfter = await retrievalRecall(wikiRoot, fixture.retrievalQueries);
    const documentAfter = await documentRecall(wikiRoot, fixture.documentQuery);
    const coverage = JSON.parse(await fs.readFile(migration.coverageReportFile, "utf8")) as LegacyCoverageReport;
    const ledger = await readSourceCoverageLedger(wikiRoot, fixture.knownSource.path);
    const backupComplete = (await Promise.all([...canonical.entries()].map(async ([relative, content]) =>
      await fs.readFile(path.join(migration.backupDir, relative), "utf8") === content
    ))).every(Boolean);
    const metadataPreserved = (await Promise.all(fixture.pages.map(async (page) => {
      const content = await fs.readFile(path.join(wikiRoot, page.path), "utf8");
      return page.customFrontmatter.every((line) => content.includes(line));
    }))).every(Boolean);
    const journal = JSON.parse(await fs.readFile(migration.journalFile, "utf8")) as { status?: string };
    const targetVersion = await detectWikiVersion(wikiRoot);
    await rollbackWikiMigration(wikiRoot, migration.runId);
    const rollbackTree = await fileSnapshot(wikiRoot);
    const canonicalAfterRollback = snapshotDigest(rollbackTree, true);
    const rollbackVersion = await detectWikiVersion(wikiRoot);
    const rolledJournal = JSON.parse(await fs.readFile(migration.journalFile, "utf8")) as { status?: string };

    return {
      sourceVersion,
      migrationMs,
      dryRunWrites,
      canonicalBefore,
      canonicalAfter,
      canonicalAfterRollback,
      canonicalPreserved: canonicalBefore === canonicalAfter,
      customMetadataPreserved: metadataPreserved,
      backupComplete,
      targetVersion,
      rollbackVersion,
      pageCountPreserved: migration.regression.before.pageCount === migration.regression.after.pageCount,
      sourceCountPreserved: migration.regression.before.sourceCount === migration.regression.after.sourceCount,
      graphLinksPreserved: JSON.stringify(migration.regression.before.graphLinks) === JSON.stringify(migration.regression.after.graphLinks),
      retrievalRecallBefore: retrievalBefore,
      retrievalRecallAfter: retrievalAfter,
      documentRecallBefore: documentBefore,
      documentRecallAfter: documentAfter,
      knownSourceLegacyUnverified: Boolean(
        ledger?.state === "open" && ledger.segments.every((segment) => segment.status === "legacy_unverified")
      ),
      unknownSourceTracked: coverage.entries.some((entry) =>
        entry.sourceRef === "vendor/orchid-archive.pdf" &&
        entry.verification === "source_unverified" && entry.status === "legacy_unverified"
      ),
      enrichmentProposalCount: coverage.enrichment.proposalCount,
      journalComplete: journal.status === "complete",
      rollbackComplete:
        rolledJournal.status === "rolled_back" && canonicalBefore === canonicalAfterRollback,
    };
  } finally {
    clearRetrievalIndexes();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

export async function evaluateLegacyMigration(
  fixturePath = DEFAULT_LEGACY_MIGRATION_FIXTURE
): Promise<LegacyMigrationReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as LegacyMigrationFixture;
  const cases: LegacyMigrationCaseReport[] = [];
  for (const sourceVersion of fixture.sourceVersions) {
    const report = await evaluateCase(fixture, sourceVersion);
    cases.push(report);
    process.stdout.write(
      `v${sourceVersion}->v4 canonical=${report.canonicalPreserved} ` +
      `retrieval=${report.retrievalRecallBefore.toFixed(3)}->${report.retrievalRecallAfter.toFixed(3)} ` +
      `document=${report.documentRecallBefore.toFixed(3)}->${report.documentRecallAfter.toFixed(3)} ` +
      `coverage=${report.knownSourceLegacyUnverified} rollback=${report.rollbackComplete} ` +
      `latency=${report.migrationMs.toFixed(2)}ms\n`
    );
  }
  const metrics: LegacyMigrationReport["metrics"] = {
    CanonicalPreservationRate: ratio(cases.filter((item) => item.canonicalPreserved).length, cases.length),
    CustomMetadataPreservationRate: ratio(cases.filter((item) => item.customMetadataPreserved).length, cases.length),
    BackupCompletenessRate: ratio(cases.filter((item) => item.backupComplete).length, cases.length),
    DryRunWriteCount: cases.reduce((sum, item) => sum + item.dryRunWrites, 0),
    TargetV4Rate: ratio(cases.filter((item) => item.targetVersion === 4).length, cases.length),
    RollbackRecoveryRate: ratio(cases.filter((item) => item.rollbackComplete && item.rollbackVersion === item.sourceVersion).length, cases.length),
    PageCountPreservationRate: ratio(cases.filter((item) => item.pageCountPreserved).length, cases.length),
    SourceCountPreservationRate: ratio(cases.filter((item) => item.sourceCountPreserved).length, cases.length),
    GraphLinkPreservationRate: ratio(cases.filter((item) => item.graphLinksPreserved).length, cases.length),
    RetrievalRecallBefore: mean(cases.map((item) => item.retrievalRecallBefore)),
    RetrievalRecallAfter: mean(cases.map((item) => item.retrievalRecallAfter)),
    DocumentRecallBefore: mean(cases.map((item) => item.documentRecallBefore)),
    DocumentRecallAfter: mean(cases.map((item) => item.documentRecallAfter)),
    LegacyUnverifiedBackfillRate: ratio(cases.filter((item) => item.knownSourceLegacyUnverified).length, cases.length),
    UnknownSourceTrackingRate: ratio(cases.filter((item) => item.unknownSourceTracked).length, cases.length),
    EnrichmentProposalCount: cases.reduce((sum, item) => sum + item.enrichmentProposalCount, 0),
    JournalCompletionRate: ratio(cases.filter((item) => item.journalComplete).length, cases.length),
    MigrationLatencyP50Ms: percentile(cases.map((item) => item.migrationMs), 50),
    MigrationLatencyP95Ms: percentile(cases.map((item) => item.migrationMs), 95),
  };
  const report: LegacyMigrationReport = {
    generatedAt: new Date().toISOString(),
    fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
    fixtureVersion: fixture.version,
    sourceVersions: fixture.sourceVersions,
    metrics,
    cases,
  };
  process.stdout.write(
    `SUMMARY Canonical=${metrics.CanonicalPreservationRate.toFixed(4)} ` +
    `Metadata=${metrics.CustomMetadataPreservationRate.toFixed(4)} ` +
    `Retrieval=${metrics.RetrievalRecallBefore.toFixed(4)}->${metrics.RetrievalRecallAfter.toFixed(4)} ` +
    `Document=${metrics.DocumentRecallBefore.toFixed(4)}->${metrics.DocumentRecallAfter.toFixed(4)} ` +
    `Coverage=${metrics.LegacyUnverifiedBackfillRate.toFixed(4)} ` +
    `Rollback=${metrics.RollbackRecoveryRate.toFixed(4)} DryRunWrites=${metrics.DryRunWriteCount}\n`
  );
  return report;
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_LEGACY_MIGRATION_FIXTURE);
  const report = await evaluateLegacyMigration(fixturePath);
  const outputPath = argValue("json");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`JSON written to ${resolved}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
