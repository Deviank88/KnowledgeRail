import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { createSectionContext } from "./document-workflow.js";
import { atomicWriteBuffer, atomicWriteText } from "./fs-service.js";
import { withWikiFileLock } from "./lock-service.js";
import { buildWikiGraph, graphFile, graphReportFile, invalidateWikiGraph, type GraphEdgeKind } from "./graph-index.js";
import { clearRuntimeWikiGraphs } from "./graph-runtime.js";
import { rebuildManifest, manifestFile, wikiMetaDir } from "./manifest-service.js";
import { listWikiPagePaths, readWikiPageRecord, type WikiPageRecord } from "./page-record.js";
import { safeResolveWithin } from "./paths.js";
import {
  clearRetrievalIndexes,
  refreshRetrievalIndex,
  searchRetrievalIndex,
} from "./retrieval-index.js";
import { clearSemanticIndexes, semanticIndexFile } from "./semantic/index.js";
import { tokenizeSearchText } from "./text-analysis.js";
import { ensureDir, readFileSafe } from "./utils.js";
import { PersistentCodeEvidenceIndex, codeEvidenceIndexFile } from "./code-evidence/index.js";
import {
  readSourceCoverageLedger,
  sourceCoverageLedgerFile,
  sourceCoverageLedgerRef,
  writeSourceCoverageLedger,
  type SourceCoverageLedger,
} from "./ingestion/coverage-ledger.js";
import { sourceCompilePlan } from "./ingestion/source-compiler.js";
import { sourceContentHash } from "./ingestion/source-segmentation.js";

export const CURRENT_WIKI_FORMAT = 4;

export type WikiFormatVersion = 1 | 2 | 3 | 4;

export interface WikiState {
  formatVersion: 4;
  artifactVersions: {
    manifest: 1;
    graph: 2;
    retrieval: 1;
    semantic: 1;
    codeEvidence: 1;
    sourceCoverage: 1;
  };
  migratedAt: string;
  migratedFrom: WikiFormatVersion;
}

export interface MigrationPlan {
  detectedVersion: WikiFormatVersion | "unknown";
  targetVersion: 4;
  steps: string[];
  warnings: string[];
  blockers: string[];
  changedFiles: string[];
  canonicalFileCount: number;
  pageCount: number;
  sourceCount: number;
}

export interface CanonicalFileSnapshot {
  path: string;
  size: number;
  sha256: string;
}

export interface CanonicalSnapshot {
  digest: string;
  files: CanonicalFileSnapshot[];
}

export interface LegacyCoverageEntry {
  sourceRef: string;
  normalizedSourceUri?: string;
  pageRefs: string[];
  verification: "existing_ledger" | "source_verified" | "source_unverified";
  status: "preserved" | "legacy_unverified";
  reason: string;
  ledgerRef?: string;
}

export interface LegacyCoverageReport {
  version: 1;
  generatedAt: string;
  state: "requires_reconciliation";
  entries: LegacyCoverageEntry[];
  enrichment: {
    status: "not_generated";
    proposalCount: 0;
  };
}

export interface MigrationProbeResult {
  path: string;
  query: string;
  recovered: boolean;
}

export interface MigrationRegressionReport {
  pageCount: number;
  sourceCount: number;
  retrieval: MigrationProbeResult[];
  documentContext: MigrationProbeResult[];
  graphLinks: Partial<Record<GraphEdgeKind, number>>;
}

export interface MigrationResult {
  plan: MigrationPlan;
  runId: string;
  backupDir: string;
  journalFile: string;
  coverageReportFile: string;
  canonicalDigest: string;
  regression: {
    before: MigrationRegressionReport;
    after: MigrationRegressionReport;
  };
}

interface MigrationJournal {
  version: 1;
  runId: string;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  rolledBackAt?: string;
  sourceVersion: WikiFormatVersion;
  targetVersion: 4;
  status:
    | "backed_up"
    | "coverage_backfilled"
    | "indexes_rebuilt"
    | "validating"
    | "complete"
    | "rolled_back";
  backupFiles: CanonicalFileSnapshot[];
  touchedFiles: string[];
  canonicalBefore: CanonicalSnapshot;
  canonicalAfter?: CanonicalSnapshot;
  regressionBefore?: MigrationRegressionReport;
  regressionAfter?: MigrationRegressionReport;
  coverageReport?: string;
  error?: string;
}

interface SourceResolution {
  sourceUri: string;
  content: string;
}

const CRITICAL_PAGE_TYPES = new Set([
  "request",
  "requirement",
  "decision",
  "implementation",
  "test_result",
  "release",
]);
const TEXT_SOURCE_EXTENSIONS = new Set([
  ".md", ".txt", ".csv", ".tsv", ".json", ".xml", ".html", ".htm",
  ".rst", ".yaml", ".yml", ".log",
]);
const MAX_LEGACY_SOURCE_BYTES = 5 * 1024 * 1024;

const STATIC_DERIVED_PATHS = [
  ".knowledge-rail/state.json",
  ".knowledge-rail/manifest.json",
  ".knowledge-rail/retrieval-index.json",
  ".knowledge-rail/retrieval-delta.jsonl",
  ".knowledge-rail/graph.json",
  ".knowledge-rail/graph-report.md",
  ".knowledge-rail/semantic-index.json",
  ".knowledge-rail/code-evidence-index.json",
  ".knowledge-rail/entity-index.json",
  ".knowledge-rail/community-index.json",
  ".knowledge-rail/legacy-coverage.json",
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "state.json");
}

function migrationRoot(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "migrations");
}

function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]{8,120}$/.test(runId);
}

function runDirectory(wikiRoot: string, runId: string): string {
  if (!validRunId(runId)) throw new Error("Invalid migration run ID.");
  return nodePath.join(migrationRoot(wikiRoot), runId);
}

function inferredProjectRoot(wikiRoot: string, explicit?: string): string {
  if (explicit) return nodePath.resolve(explicit);
  const root = nodePath.resolve(wikiRoot);
  return nodePath.basename(root).toLowerCase() === "wiki" ? nodePath.dirname(root) : root;
}

async function withMigrationLock<T>(wikiRoot: string, operation: () => Promise<T>): Promise<T> {
  return withWikiFileLock(wikiRoot, nodePath.resolve(wikiRoot), operation);
}

async function assertMigrationMetaSafe(wikiRoot: string): Promise<void> {
  await ensureDir(wikiRoot);
  const rootReal = await fs.realpath(wikiRoot);
  const meta = wikiMetaDir(wikiRoot);
  try {
    const stat = await fs.lstat(meta);
    if (stat.isSymbolicLink()) throw new Error("Migration metadata directory must not be a symbolic link.");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await ensureDir(meta);
  const metaReal = await fs.realpath(meta);
  const relative = nodePath.relative(rootReal, metaReal);
  if (relative !== ".knowledge-rail" || nodePath.isAbsolute(relative)) {
    throw new Error("Migration metadata directory resolves outside the wiki root.");
  }
  const runs = migrationRoot(wikiRoot);
  try {
    const stat = await fs.lstat(runs);
    if (stat.isSymbolicLink()) throw new Error("Migration journal directory must not be a symbolic link.");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await ensureDir(runs);
  const runsReal = await fs.realpath(runs);
  const runsRelative = nodePath.relative(rootReal, runsReal).replace(/\\/g, "/");
  if (runsRelative !== ".knowledge-rail/migrations") {
    throw new Error("Migration journal directory resolves outside the wiki root.");
  }
}

async function walkFiles(
  root: string,
  options: { include: (relative: string) => boolean; descend: (relative: string) => boolean },
  relative = ""
): Promise<string[]> {
  const directory = relative ? nodePath.join(root, relative) : root;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? nodePath.join(relative, entry.name) : entry.name;
    const normalized = child.replace(/\\/g, "/");
    if (entry.isSymbolicLink()) throw new Error(`Migration refuses symbolic links: ${normalized}.`);
    if (entry.isDirectory()) {
      if (options.descend(normalized)) files.push(...await walkFiles(root, options, child));
    } else if (entry.isFile() && options.include(normalized)) {
      files.push(normalized);
    }
  }
  return files.sort();
}

async function canonicalFiles(wikiRoot: string): Promise<string[]> {
  return walkFiles(wikiRoot, {
    include: (relative) => relative.toLowerCase().endsWith(".md"),
    descend: (relative) => relative !== ".knowledge-rail" && !relative.startsWith(".knowledge-rail/"),
  });
}

async function canonicalSnapshot(wikiRoot: string): Promise<CanonicalSnapshot> {
  const files = await Promise.all((await canonicalFiles(wikiRoot)).map(async (relative) => {
    const bytes = await fs.readFile(nodePath.join(wikiRoot, relative));
    return { path: relative, size: bytes.length, sha256: sha256(bytes) };
  }));
  const digest = sha256(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n"));
  return { digest, files };
}

function snapshotDifferences(before: CanonicalSnapshot, after: CanonicalSnapshot): string[] {
  const previous = new Map(before.files.map((file) => [file.path, file] as const));
  const current = new Map(after.files.map((file) => [file.path, file] as const));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter((path) => previous.get(path)?.sha256 !== current.get(path)?.sha256)
    .sort();
}

async function pageRecords(wikiRoot: string): Promise<WikiPageRecord[]> {
  const records = await Promise.all((await listWikiPagePaths(wikiRoot)).map((relative) =>
    readWikiPageRecord(wikiRoot, relative)
  ));
  return records.filter((record): record is WikiPageRecord => record !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sourceRefs(records: readonly WikiPageRecord[]): Map<string, string[]> {
  const refs = new Map<string, Set<string>>();
  for (const record of records) {
    for (const source of record.sources) {
      const pages = refs.get(source) ?? new Set<string>();
      pages.add(record.path);
      refs.set(source, pages);
    }
  }
  return new Map([...refs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, pages]) => [source, [...pages].sort()]));
}

async function incompleteMigrationRuns(wikiRoot: string): Promise<string[]> {
  try {
    const stat = await fs.lstat(migrationRoot(wikiRoot));
    if (stat.isSymbolicLink()) throw new Error("Migration journal directory must not be a symbolic link.");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(migrationRoot(wikiRoot), { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const incomplete: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validRunId(entry.name)) continue;
    const raw = await readFileSafe(nodePath.join(migrationRoot(wikiRoot), entry.name, "journal.json"));
    if (!raw) continue;
    try {
      const journal = JSON.parse(raw) as { status?: string };
      if (!journal.status || !["complete", "rolled_back"].includes(journal.status)) incomplete.push(entry.name);
    } catch {
      incomplete.push(entry.name);
    }
  }
  return incomplete.sort();
}

export function migrateSchemaText(schema: string): string {
  // Retained as an explicit proposal helper. Migration never applies this text
  // automatically because SCHEMA.md is canonical project knowledge.
  const references: ReadonlyArray<readonly [string, string]> = [
    ["wiki_traceability_report", "knowledge_context mode=graph view=traceability"],
    ["wiki_list_pages", "knowledge_context mode=list"],
    ["wiki_prepare_knowledge_updates", "prompt prepare_knowledge_update"],
    ["wiki_list_files", "knowledge_files action=list"],
    ["wiki_read_file", "knowledge_files action=read"],
    ["wiki_get_schema", "resource wiki://schema"],
    ["wiki_read_log", "resource wiki://log"],
    ["knowledge_normalize_source", "knowledge_files action=normalize"],
    ["knowledge_prepare_request_ingestion", "knowledge_ingest action=report"],
    ["knowledge_prepare_source_ingestion", "knowledge_ingest"],
    ["knowledge_evidence_ir", "knowledge_ingest"],
    ["knowledge_code_evidence", "knowledge_code"],
    ["knowledge_plan_document", "knowledge_document_context action=plan"],
    ["knowledge_section_context", "knowledge_document_context action=section"],
    ["knowledge_write_document", "knowledge_document action=write"],
    ["knowledge_review_document", "knowledge_document action=review"],
    ["knowledge_export_docx", "knowledge_document action=export"],
    ["knowledge_init", "knowledge_admin action=init"],
    ["wiki_init", "knowledge_admin action=init"],
    ["wiki_write_page", "knowledge_page action=write"],
    ["wiki_edit_page", "knowledge_page action=edit"],
    ["wiki_read_page", "knowledge_page action=read"],
    ["wiki_read_resource", "knowledge_page action=read"],
    ["wiki_delete_page", "knowledge_page action=delete"],
    ["wiki_move_page", "knowledge_page action=move"],
    ["wiki_append_log", "knowledge_page action=append_log"],
    ["wiki_search", "knowledge_context mode=search"],
    ["wiki_graph_query", "knowledge_context mode=graph"],
    ["wiki_lint", "knowledge_admin action=lint"],
    ["wiki_migrate", "knowledge_admin action=migrate"],
    ["knowledge_menu", "KnowledgeRail domain tools"],
    ["wiki_menu", "KnowledgeRail domain tools"],
  ];
  let migrated = schema;
  for (const [legacy, replacement] of references) {
    migrated = migrated.replaceAll(legacy, replacement);
  }
  return migrated;
}

function currentState(migratedFrom: WikiFormatVersion, migratedAt: string): WikiState {
  return {
    formatVersion: 4,
    artifactVersions: {
      manifest: 1,
      graph: 2,
      retrieval: 1,
      semantic: 1,
      codeEvidence: 1,
      sourceCoverage: 1,
    },
    migratedAt,
    migratedFrom,
  };
}

export async function initializeWikiState(wikiRoot: string): Promise<void> {
  if (await readFileSafe(stateFile(wikiRoot))) return;
  const now = new Date().toISOString();
  await ensureDir(wikiMetaDir(wikiRoot));
  await atomicWriteText(stateFile(wikiRoot), `${JSON.stringify(currentState(4, now), null, 2)}\n`);
}

export async function detectWikiVersion(
  wikiRoot: string
): Promise<WikiFormatVersion | "unknown"> {
  const stateRaw = await readFileSafe(stateFile(wikiRoot));
  if (stateRaw) {
    try {
      const state = JSON.parse(stateRaw) as { formatVersion?: unknown };
      return [1, 2, 3, 4].includes(state.formatVersion as number)
        ? state.formatVersion as WikiFormatVersion
        : "unknown";
    } catch {
      return "unknown";
    }
  }
  const schema = await readFileSafe(nodePath.join(wikiRoot, "SCHEMA.md"));
  if (!schema) return "unknown";
  if (/Wiki format:\s*3\b/i.test(schema)) return 3;
  return /index\.md viene rigenerato automaticamente|prepare_request_ingestion|\bv2\b/i.test(schema)
    ? 2
    : 1;
}

export async function planWikiMigration(
  wikiRoot: string,
  targetVersion = "4"
): Promise<MigrationPlan> {
  const detectedVersion = await detectWikiVersion(wikiRoot);
  const blockers: string[] = [];
  if (!["4", "4.0", "current"].includes(targetVersion)) {
    blockers.push(`Unsupported target version: ${targetVersion}.`);
  }
  if (detectedVersion === "unknown") blockers.push("Unrecognized wiki version or invalid state.json.");
  let snapshot: CanonicalSnapshot = { digest: sha256(""), files: [] };
  let records: WikiPageRecord[] = [];
  try {
    snapshot = await canonicalSnapshot(wikiRoot);
    records = await pageRecords(wikiRoot);
  } catch (error: unknown) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const incomplete = await incompleteMigrationRuns(wikiRoot);
    if (incomplete.length > 0) {
      blockers.push(`Incomplete migrations require rollback or intervention: ${incomplete.join(", ")}.`);
    }
  } catch (error: unknown) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  const steps = [
    "read-only preflight and format detection",
    "SHA-256 snapshot and complete backup of canonical Markdown",
    "conservative coverage backfill with legacy_unverified state",
    "derived-index invalidation or rebuild",
    "retrieval, document-context, and traceability regression checks",
    "canonical-hash verification and atomic state-format 4 commit",
  ];
  const warnings: string[] = [];
  if (detectedVersion === 1 || detectedVersion === 2) {
    warnings.push(`Format v${detectedVersion} was inferred conservatively from SCHEMA.md.`);
  }
  if (sourceRefs(records).size > 0) {
    warnings.push("Legacy sources without a verifiable ledger remain open as legacy_unverified.");
  }
  return {
    detectedVersion,
    targetVersion: 4,
    steps,
    warnings,
    blockers,
    changedFiles: [...STATIC_DERIVED_PATHS.map((path) => `wiki/${path}`), "wiki/.knowledge-rail/source-coverage/*.json"],
    canonicalFileCount: snapshot.files.length,
    pageCount: records.length,
    sourceCount: sourceRefs(records).size,
  };
}

function regressionQuery(record: WikiPageRecord): string {
  const bodyTerms = tokenizeSearchText(record.body).filter((term) => term.length >= 4).slice(0, 6);
  return [record.requestId, record.title.slice(0, 180), ...bodyTerms]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1_000);
}

async function regressionReport(wikiRoot: string): Promise<MigrationRegressionReport> {
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);
  const records = await pageRecords(wikiRoot);
  const sources = sourceRefs(records);
  const probeRecords = [
    ...records.filter((record) => CRITICAL_PAGE_TYPES.has(record.type)),
    ...records.filter((record) => !CRITICAL_PAGE_TYPES.has(record.type)),
  ].slice(0, 24);
  const retrieval: MigrationProbeResult[] = [];
  for (const record of probeRecords) {
    const query = regressionQuery(record);
    const hits = await searchRetrievalIndex({
      wikiRoot,
      query,
      maxResults: Math.min(50, Math.max(records.length, 10)),
      profile: "coverage",
      forceRefresh: true,
    });
    retrieval.push({ path: record.path, query, recovered: hits.some((hit) => hit.path === record.path) });
  }
  const documentContext: MigrationProbeResult[] = [];
  for (const record of probeRecords.filter((item) => CRITICAL_PAGE_TYPES.has(item.type)).slice(0, 12)) {
    const query = regressionQuery(record);
    const context = await createSectionContext({
      wikiRoot,
      sectionTitle: record.title,
      query,
      maxPages: Math.min(12, Math.max(records.length, 4)),
      maxCharsPerPage: 4_000,
      maxTotalChars: 24_000,
      retrievalProfile: "coverage",
      useGraph: true,
    });
    documentContext.push({
      path: record.path,
      query,
      recovered: context.pages.some((page) => page.relPath === record.path),
    });
  }
  const graph = await buildWikiGraph(wikiRoot);
  const graphLinks: Partial<Record<GraphEdgeKind, number>> = {};
  for (const edge of graph.edges) graphLinks[edge.kind] = (graphLinks[edge.kind] ?? 0) + 1;
  return {
    pageCount: records.length,
    sourceCount: sources.size,
    retrieval,
    documentContext,
    graphLinks,
  };
}

function assertRegressionPreserved(
  before: MigrationRegressionReport,
  after: MigrationRegressionReport
): void {
  const failures: string[] = [];
  if (after.pageCount !== before.pageCount) failures.push(`page count ${before.pageCount}->${after.pageCount}`);
  if (after.sourceCount !== before.sourceCount) failures.push(`source count ${before.sourceCount}->${after.sourceCount}`);
  const assertProbes = (label: string, previous: MigrationProbeResult[], current: MigrationProbeResult[]) => {
    const afterByPath = new Map(current.map((probe) => [probe.path, probe] as const));
    for (const probe of previous.filter((item) => item.recovered)) {
      if (!afterByPath.get(probe.path)?.recovered) failures.push(`${label} lost ${probe.path}`);
    }
  };
  assertProbes("retrieval", before.retrieval, after.retrieval);
  assertProbes("document context", before.documentContext, after.documentContext);
  for (const kind of new Set([
    ...Object.keys(before.graphLinks),
    ...Object.keys(after.graphLinks),
  ] as GraphEdgeKind[])) {
    if ((before.graphLinks[kind] ?? 0) !== (after.graphLinks[kind] ?? 0)) {
      failures.push(`graph ${kind} ${(before.graphLinks[kind] ?? 0)}->${(after.graphLinks[kind] ?? 0)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Migration regression failed: ${failures.join("; ")}.`);
}

async function backupMigrationInputs(
  wikiRoot: string,
  backupDir: string,
  canonical: CanonicalSnapshot
): Promise<CanonicalFileSnapshot[]> {
  const metaFiles = await walkFiles(wikiRoot, {
    include: (relative) => relative.startsWith(".knowledge-rail/"),
    descend: (relative) =>
      relative !== ".knowledge-rail/migrations" && !relative.startsWith(".knowledge-rail/migrations/"),
  });
  const paths = [...new Set([...canonical.files.map((file) => file.path), ...metaFiles])].sort();
  const snapshots: CanonicalFileSnapshot[] = [];
  for (const relative of paths) {
    const bytes = await fs.readFile(nodePath.join(wikiRoot, relative));
    const destination = nodePath.join(backupDir, relative);
    await ensureDir(nodePath.dirname(destination));
    await fs.writeFile(destination, bytes);
    snapshots.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
  }
  await atomicWriteText(
    nodePath.join(nodePath.dirname(backupDir), "backup-manifest.json"),
    `${JSON.stringify({ version: 1, files: snapshots }, null, 2)}\n`
  );
  return snapshots;
}

function normalizeLegacySourceRef(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized || normalized.includes("\0") || normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  ) return null;
  return normalized.startsWith("docs/") ? normalized : `docs/${normalized}`;
}

function ledgerMatchesSource(ledger: SourceCoverageLedger, content: string): boolean {
  if (ledger.sourceHash !== sourceContentHash(content)) return false;
  let cursor = 0;
  for (const segment of ledger.segments) {
    if (
      segment.start !== cursor || segment.end > content.length ||
      segment.hash !== sourceContentHash(content.slice(segment.start, segment.end))
    ) return false;
    cursor = segment.end;
  }
  return cursor === content.length;
}

async function resolveLegacySource(projectRoot: string, sourceRef: string): Promise<SourceResolution | null> {
  const sourceUri = normalizeLegacySourceRef(sourceRef);
  if (!sourceUri || !TEXT_SOURCE_EXTENSIONS.has(nodePath.extname(sourceUri).toLowerCase())) return null;
  const docsRoot = nodePath.join(projectRoot, "docs");
  const relative = sourceUri.slice("docs/".length);
  let target: string;
  try {
    target = safeResolveWithin(docsRoot, relative);
    const [projectReal, docsReal, targetReal] = await Promise.all([
      fs.realpath(projectRoot),
      fs.realpath(docsRoot),
      fs.realpath(target),
    ]);
    if (nodePath.relative(projectReal, docsReal) !== "docs") return null;
    const relativeReal = nodePath.relative(docsReal, targetReal);
    if (relativeReal.startsWith("..") || nodePath.isAbsolute(relativeReal)) return null;
    const stat = await fs.stat(targetReal);
    if (!stat.isFile() || stat.size > MAX_LEGACY_SOURCE_BYTES) return null;
    const content = await fs.readFile(targetReal, "utf8");
    if (content.includes("\0")) return null;
    return { sourceUri, content };
  } catch {
    return null;
  }
}

async function legacyCoverageBackfill(params: {
  wikiRoot: string;
  projectRoot: string;
  records: readonly WikiPageRecord[];
  now: string;
  touchedFiles: Set<string>;
}): Promise<LegacyCoverageReport> {
  const entries: LegacyCoverageEntry[] = [];
  for (const [sourceRef, pageRefs] of sourceRefs(params.records)) {
    const resolution = await resolveLegacySource(params.projectRoot, sourceRef);
    if (!resolution) {
      entries.push({
        sourceRef,
        pageRefs,
        verification: "source_unverified",
        status: "legacy_unverified",
        reason: "legacy_source_cannot_be_verified_inside_project_docs",
      });
      continue;
    }
    const ledgerPath = sourceCoverageLedgerFile(params.wikiRoot, resolution.sourceUri);
    const existingRaw = await readFileSafe(ledgerPath);
    const existing = await readSourceCoverageLedger(params.wikiRoot, resolution.sourceUri);
    if (existingRaw !== null && existing === null) {
      throw new Error(`Existing source coverage ledger is invalid: ${resolution.sourceUri}.`);
    }
    if (existing) {
      if (!ledgerMatchesSource(existing, resolution.content)) {
        throw new Error(`Existing source coverage ledger is stale for: ${resolution.sourceUri}.`);
      }
      entries.push({
        sourceRef,
        normalizedSourceUri: resolution.sourceUri,
        pageRefs,
        verification: "existing_ledger",
        status: "preserved",
        reason: `existing_${existing.state}`,
        ledgerRef: sourceCoverageLedgerRef(resolution.sourceUri),
      });
      continue;
    }
    params.touchedFiles.add(nodePath.relative(params.wikiRoot, ledgerPath).replace(/\\/g, "/"));
    const planned = await sourceCompilePlan({
      wikiRoot: params.wikiRoot,
      sourceUri: resolution.sourceUri,
      content: resolution.content,
    });
    const ledger: SourceCoverageLedger = {
      ...planned.ledger,
      updatedAt: params.now,
      state: "open",
      segments: planned.ledger.segments.map((segment) => ({
        ...segment,
        status: "legacy_unverified",
        evidenceRefs: [],
        pageRefs: [],
        reason: "legacy_coverage_requires_explicit_reconciliation",
        processedAt: params.now,
      })),
    };
    delete ledger.finalizedAt;
    await writeSourceCoverageLedger(params.wikiRoot, ledger);
    entries.push({
      sourceRef,
      normalizedSourceUri: resolution.sourceUri,
      pageRefs,
      verification: "source_verified",
      status: "legacy_unverified",
      reason: "source_exists_but_legacy_coverage_is_not_proven",
      ledgerRef: sourceCoverageLedgerRef(resolution.sourceUri),
    });
  }
  const report: LegacyCoverageReport = {
    version: 1,
    generatedAt: params.now,
    state: "requires_reconciliation",
    entries,
    enrichment: { status: "not_generated", proposalCount: 0 },
  };
  const reportPath = nodePath.join(wikiMetaDir(params.wikiRoot), "legacy-coverage.json");
  params.touchedFiles.add(".knowledge-rail/legacy-coverage.json");
  await atomicWriteText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function rebuildDerivedIndexes(params: {
  wikiRoot: string;
  projectRoot: string;
  touchedFiles: Set<string>;
}): Promise<void> {
  const invalidated = [
    manifestFile(params.wikiRoot),
    nodePath.join(wikiMetaDir(params.wikiRoot), "retrieval-index.json"),
    nodePath.join(wikiMetaDir(params.wikiRoot), "retrieval-delta.jsonl"),
    graphFile(params.wikiRoot),
    graphReportFile(params.wikiRoot),
    semanticIndexFile(params.wikiRoot),
    codeEvidenceIndexFile(params.wikiRoot),
    nodePath.join(wikiMetaDir(params.wikiRoot), "entity-index.json"),
    nodePath.join(wikiMetaDir(params.wikiRoot), "community-index.json"),
  ];
  for (const file of invalidated) {
    params.touchedFiles.add(nodePath.relative(params.wikiRoot, file).replace(/\\/g, "/"));
    await fs.rm(file, { force: true });
  }
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(params.wikiRoot);
  clearSemanticIndexes();
  await rebuildManifest(params.wikiRoot);
  await refreshRetrievalIndex(params.wikiRoot, { force: true });
  await buildWikiGraph(params.wikiRoot);
  await new PersistentCodeEvidenceIndex({
    repositoryRoot: params.projectRoot,
    wikiRoot: params.wikiRoot,
  }).rebuild();
}

async function restoreTouchedFiles(params: {
  wikiRoot: string;
  backupDir: string;
  backupFiles: readonly CanonicalFileSnapshot[];
  touchedFiles: readonly string[];
}): Promise<void> {
  const backedUp = new Map(params.backupFiles.map((file) => [file.path, file] as const));
  const touched = [...new Set(params.touchedFiles)].sort();
  const restoredBytes = new Map<string, Buffer>();
  // Validate every required backup before changing any target. A tampered
  // backup therefore cannot leave a partially rolled-back derived state.
  for (const relative of touched) {
    const backup = backedUp.get(relative);
    if (backup) {
      const source = safeResolveWithin(params.backupDir, relative);
      const sourceStat = await fs.lstat(source);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(`Migration backup is not a regular file: ${relative}.`);
      }
      const bytes = await fs.readFile(source);
      if (bytes.length !== backup.size || sha256(bytes) !== backup.sha256) {
        throw new Error(`Migration backup integrity check failed: ${relative}.`);
      }
      restoredBytes.set(relative, bytes);
    }
  }
  for (const relative of touched) {
    const target = safeResolveWithin(params.wikiRoot, relative);
    const bytes = restoredBytes.get(relative);
    if (bytes) {
      await ensureDir(nodePath.dirname(target));
      await atomicWriteBuffer(target, bytes);
    } else {
      await fs.rm(target, { force: true });
    }
  }
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(params.wikiRoot);
  clearSemanticIndexes();
}

async function writeJournal(file: string, journal: MigrationJournal): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(journal, null, 2)}\n`);
}

export async function applyWikiMigration(
  wikiRoot: string,
  options: { targetVersion?: string; backup: boolean; projectRoot?: string }
): Promise<MigrationResult> {
  return withMigrationLock(wikiRoot, async () => {
    const plan = await planWikiMigration(wikiRoot, options.targetVersion ?? "4");
    if (!options.backup) throw new Error("backup=true is required to apply the migration.");
    if (plan.blockers.length > 0) throw new Error(plan.blockers.join(" "));
    const sourceVersion = plan.detectedVersion;
    if (sourceVersion === "unknown") throw new Error("Unrecognized wiki version.");
    await assertMigrationMetaSafe(wikiRoot);
    const projectRoot = inferredProjectRoot(wikiRoot, options.projectRoot);
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replace(/[:.]/g, "-")}_${randomUUID()}`;
    const runDir = runDirectory(wikiRoot, runId);
    const backupDir = nodePath.join(runDir, "backup");
    const stagingDir = nodePath.join(runDir, "staging");
    const journalFile = nodePath.join(runDir, "journal.json");
    const coverageReportFile = nodePath.join(runDir, "coverage-report.json");
    await ensureDir(backupDir);
    await ensureDir(stagingDir);
    const canonicalBefore = await canonicalSnapshot(wikiRoot);
    const backupFiles = await backupMigrationInputs(wikiRoot, backupDir, canonicalBefore);
    const touchedFiles = new Set<string>(STATIC_DERIVED_PATHS);
    const journal: MigrationJournal = {
      version: 1,
      runId,
      startedAt,
      sourceVersion,
      targetVersion: 4,
      status: "backed_up",
      backupFiles,
      touchedFiles: [...touchedFiles].sort(),
      canonicalBefore,
    };
    await writeJournal(journalFile, journal);

    try {
      const before = await regressionReport(wikiRoot);
      journal.regressionBefore = before;
      const records = await pageRecords(wikiRoot);
      const coverage = await legacyCoverageBackfill({
        wikiRoot,
        projectRoot,
        records,
        now: startedAt,
        touchedFiles,
      });
      await atomicWriteText(coverageReportFile, `${JSON.stringify(coverage, null, 2)}\n`);
      journal.coverageReport = nodePath.relative(wikiRoot, coverageReportFile).replace(/\\/g, "/");
      journal.status = "coverage_backfilled";
      journal.touchedFiles = [...touchedFiles].sort();
      await writeJournal(journalFile, journal);

      await rebuildDerivedIndexes({ wikiRoot, projectRoot, touchedFiles });
      journal.status = "indexes_rebuilt";
      journal.touchedFiles = [...touchedFiles].sort();
      await writeJournal(journalFile, journal);

      const after = await regressionReport(wikiRoot);
      journal.regressionAfter = after;
      journal.status = "validating";
      await writeJournal(journalFile, journal);
      assertRegressionPreserved(before, after);
      const canonicalAfter = await canonicalSnapshot(wikiRoot);
      const changedCanonical = snapshotDifferences(canonicalBefore, canonicalAfter);
      if (changedCanonical.length > 0) {
        throw new Error(`Canonical Markdown changed during migration: ${changedCanonical.join(", ")}.`);
      }

      const state = currentState(sourceVersion, new Date().toISOString());
      const stagedState = nodePath.join(stagingDir, "state.json");
      await atomicWriteText(stagedState, `${JSON.stringify(state, null, 2)}\n`);
      JSON.parse((await readFileSafe(stagedState)) ?? "");
      touchedFiles.add(".knowledge-rail/state.json");
      await atomicWriteText(stateFile(wikiRoot), (await readFileSafe(stagedState)) ?? "");

      journal.status = "complete";
      journal.completedAt = new Date().toISOString();
      journal.canonicalAfter = canonicalAfter;
      journal.touchedFiles = [...touchedFiles].sort();
      await writeJournal(journalFile, journal);
      return {
        plan,
        runId,
        backupDir,
        journalFile,
        coverageReportFile,
        canonicalDigest: canonicalAfter.digest,
        regression: { before, after },
      };
    } catch (error: unknown) {
      await restoreTouchedFiles({
        wikiRoot,
        backupDir,
        backupFiles,
        touchedFiles: [...touchedFiles],
      });
      journal.status = "rolled_back";
      journal.failedAt = new Date().toISOString();
      journal.rolledBackAt = journal.failedAt;
      journal.error = error instanceof Error ? error.message : String(error);
      journal.touchedFiles = [...touchedFiles].sort();
      await writeJournal(journalFile, journal);
      throw error;
    }
  });
}

export async function rollbackWikiMigration(
  wikiRoot: string,
  runId: string
): Promise<{ runId: string; status: "rolled_back"; restoredFiles: number }> {
  return withMigrationLock(wikiRoot, async () => {
    await assertMigrationMetaSafe(wikiRoot);
    const runDir = runDirectory(wikiRoot, runId);
    const journalFile = nodePath.join(runDir, "journal.json");
    const raw = await readFileSafe(journalFile);
    if (!raw) throw new Error(`Migration journal not found: ${runId}.`);
    const journal = JSON.parse(raw) as MigrationJournal;
    if (journal.version !== 1 || journal.runId !== runId || journal.status !== "complete") {
      throw new Error("Only a completed migration with a valid journal can be rolled back.");
    }
    const current = await canonicalSnapshot(wikiRoot);
    if (!journal.canonicalAfter || current.digest !== journal.canonicalAfter.digest) {
      throw new Error("Canonical Markdown changed after migration; rollback refuses to overwrite newer knowledge.");
    }
    await restoreTouchedFiles({
      wikiRoot,
      backupDir: nodePath.join(runDir, "backup"),
      backupFiles: journal.backupFiles,
      touchedFiles: journal.touchedFiles,
    });
    journal.status = "rolled_back";
    journal.rolledBackAt = new Date().toISOString();
    await writeJournal(journalFile, journal);
    return { runId, status: "rolled_back", restoredFiles: journal.touchedFiles.length };
  });
}

export function formatMigrationPlan(plan: MigrationPlan): string {
  return [
    "# Wiki migration",
    "",
    `Detected version: ${plan.detectedVersion}`,
    `Target version: ${plan.targetVersion}`,
    `Canonical Markdown files: ${plan.canonicalFileCount}`,
    `Knowledge pages: ${plan.pageCount}`,
    `Referenced sources: ${plan.sourceCount}`,
    "",
    "## Step",
    ...plan.steps.map((step) => `- ${step}`),
    "",
    "## Updated derived artifacts",
    ...plan.changedFiles.map((file) => `- ${file}`),
    ...(plan.warnings.length > 0 ? ["", "## Warning", ...plan.warnings.map((warning) => `- ${warning}`)] : []),
    ...(plan.blockers.length > 0 ? ["", "## Blocker", ...plan.blockers.map((blocker) => `- ${blocker}`)] : []),
  ].join("\n");
}
