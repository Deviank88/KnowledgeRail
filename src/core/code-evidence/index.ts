import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import fg from "fast-glob";
import { TopResults } from "../top-results.js";
import { atomicWriteText } from "../fs-service.js";
import { withWikiFileLock } from "../lock-service.js";
import { logger } from "../logger.js";
import { wikiMetaDir } from "../manifest-service.js";
import { safeResolveWithin } from "../paths.js";
import { tokenizeSearchText } from "../text-analysis.js";
import { readFileSafe } from "../utils.js";
import { registerWorkspaceState, touchWorkspaceState } from "../workspace-state.js";
import {
  CodeQueryRuntime,
  DEFAULT_QUERY_ADAPTERS,
  codePathAllowed,
  normalizedCodeText,
  normalizedQualifiedSymbol,
} from "./query-runtime.js";
import {
  createDefaultKnowledgeAdapterRegistry,
  KnowledgeAdapterRegistry,
  sameAdapterRoster,
  type AdapterRegistration,
} from "./adapter-registry.js";
import {
  CODE_EVIDENCE_INDEX_VERSION,
  CODE_IMPACT_MAX_ROOTS,
  CODE_IMPACT_REFERENCES_PER_ROOT,
  type CodeImpactTarget,
  type CodeImpactResult,
  type CodeImportDiagnostics,
  type CodeEvidenceAdapterRosterEntry,
  type CodeEvidenceFileRecord,
  type CodeEvidenceHit,
  type CodeEvidenceIndex,
  type CodeEvidenceSnapshot,
  type CodeEvidenceUpdateReport,
  type CodeReference,
  type CodeSearchOptions,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
  type ProjectStructure,
} from "./types.js";

const DEFAULT_MAX_RESULTS = 12;
const MAX_RESULTS = 100;
const MAX_CODE_FILE_BYTES = 2 * 1024 * 1024;
const INDEX_FILE_NAME = "code-evidence-index.json";
const MAX_QUERY_CACHE_ESTIMATED_BYTES = 32 * 1024 * 1024;
interface QueryCacheState {
  identity?: string;
  runtime?: CodeQueryRuntime;
  pending?: Promise<CodeQueryRuntime>;
  estimatedBytes: number;
  snapshotEstimatedBytes: number;
}
const queryStates = new Map<string, QueryCacheState>();
const CODE_IGNORES = [
  ".git/**",
  ".agents/**",
  ".codex/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
  "wiki/.knowledge-rail/**",
  "wiki/.llm-wiki/**",
];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0") || nodePath.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid repository-relative code path: ${path}`);
  }
  return normalized;
}

function fingerprint(path: string, contentHash: string, parserVersion: string): string {
  return sha256(`${path}\0${contentHash}\0${parserVersion}`);
}

function emptySnapshot(adapters: readonly CodeEvidenceAdapterRosterEntry[]): CodeEvidenceSnapshot {
  return {
    version: CODE_EVIDENCE_INDEX_VERSION,
    adapters: adapters.map((entry) => ({
      extensionClaims: [...entry.extensionClaims],
      parserVersion: entry.parserVersion,
    })),
    generatedAt: new Date(0).toISOString(),
    files: [],
    fragments: [],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validAdapterRosterEntry(value: unknown): value is CodeEvidenceAdapterRosterEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CodeEvidenceAdapterRosterEntry>;
  return typeof entry.parserVersion === "string" && entry.parserVersion.length > 0 &&
    isStringArray(entry.extensionClaims) && entry.extensionClaims.length > 0 &&
    entry.extensionClaims.every((claim) => /^\.[a-z0-9.-]+$/.test(claim));
}

function validFragment(value: unknown): value is KnowledgeFragment {
  if (!value || typeof value !== "object") return false;
  const fragment = value as Partial<KnowledgeFragment>;
  return typeof fragment.id === "string" &&
    typeof fragment.path === "string" &&
    typeof fragment.symbol === "string" &&
    typeof fragment.qualifiedName === "string" &&
    ["module", "class", "function", "method", "route", "test", "comment"].includes(fragment.kind ?? "") &&
    typeof fragment.definition === "string" &&
    Number.isInteger(fragment.range?.startLine) &&
    Number.isInteger(fragment.range?.endLine) &&
    (fragment.range?.startLine ?? 0) >= 1 &&
    (fragment.range?.endLine ?? 0) >= (fragment.range?.startLine ?? 1) &&
    isStringArray(fragment.imports) &&
    isStringArray(fragment.references) &&
    isStringArray(fragment.calls) &&
    Array.isArray(fragment.routes) && fragment.routes.every((route) =>
      route && typeof route.method === "string" && typeof route.path === "string" &&
      (route.handler === undefined || typeof route.handler === "string")
    ) &&
    isStringArray(fragment.configKeys) &&
    isStringArray(fragment.databaseRefs) &&
    typeof fragment.isTest === "boolean" &&
    (fragment.docComment === undefined || typeof fragment.docComment === "string");
}

function validateSnapshot(value: unknown): CodeEvidenceSnapshot {
  if (!value || typeof value !== "object") throw new Error("Code evidence index is not an object.");
  const snapshot = value as Partial<CodeEvidenceSnapshot>;
  if ((snapshot as { version?: unknown }).version === 1) {
    throw new Error("Code evidence index v1 requires a one-time rebuild to snapshot v2.");
  }
  if (
    snapshot.version !== CODE_EVIDENCE_INDEX_VERSION ||
    !Array.isArray(snapshot.adapters) || !snapshot.adapters.every(validAdapterRosterEntry) ||
    typeof snapshot.generatedAt !== "string" ||
    !Array.isArray(snapshot.files) ||
    !Array.isArray(snapshot.fragments) ||
    !snapshot.fragments.every(validFragment)
  ) {
    throw new Error("Code evidence index has an unsupported or invalid schema.");
  }
  const claimedExtensions = snapshot.adapters.flatMap((entry) => entry.extensionClaims);
  if (new Set(claimedExtensions).size !== claimedExtensions.length) {
    throw new Error("Code evidence index adapter roster contains overlapping extension claims.");
  }
  const ids = new Set(snapshot.fragments.map((fragment) => fragment.id));
  if (ids.size !== snapshot.fragments.length) throw new Error("Code evidence index contains duplicate fragment ids.");
  for (const record of snapshot.files) {
    if (
      !record || typeof record !== "object" ||
      typeof record.path !== "string" ||
      typeof record.contentHash !== "string" ||
      typeof record.fingerprint !== "string" ||
      typeof record.parserVersion !== "string" ||
      !isStringArray(record.fragmentIds) ||
      record.fragmentIds.some((id) => !ids.has(id))
    ) {
      throw new Error("Code evidence index contains an invalid file record.");
    }
  }
  return snapshot as CodeEvidenceSnapshot;
}

export function codeEvidenceIndexFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), INDEX_FILE_NAME);
}

export async function readCodeEvidenceSnapshot(
  wikiRoot: string,
  adapters: readonly CodeEvidenceAdapterRosterEntry[] = createDefaultKnowledgeAdapterRegistry().roster()
): Promise<CodeEvidenceSnapshot> {
  const raw = await readFileSafe(codeEvidenceIndexFile(wikiRoot));
  if (raw === null) return emptySnapshot(adapters);
  try {
    return validateSnapshot(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    throw new Error(`Cannot read code evidence index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function discardCorruptSnapshot(
  wikiRoot: string,
  adapters: readonly CodeEvidenceAdapterRosterEntry[],
  error: unknown
): Promise<CodeEvidenceSnapshot> {
  logger.warn("code-evidence", "corrupt_index_discarded", {}, error);
  await fs.unlink(codeEvidenceIndexFile(wikiRoot)).catch(() => undefined);
  return emptySnapshot(adapters);
}

async function writeSnapshot(wikiRoot: string, snapshot: CodeEvidenceSnapshot): Promise<void> {
  await atomicWriteText(codeEvidenceIndexFile(wikiRoot), `${JSON.stringify(snapshot, null, 2)}\n`);
  const state = queryStates.get(nodePath.resolve(wikiRoot));
  if (state) forgetQueryRuntime(state);
}

function forgetQueryRuntime(state: QueryCacheState): void {
  state.estimatedBytes = 0;
  state.snapshotEstimatedBytes = 0;
  state.runtime = undefined;
  state.identity = undefined;
}

function queryState(wikiRoot: string): QueryCacheState {
  let state = queryStates.get(wikiRoot);
  if (!state) {
    state = { estimatedBytes: 0, snapshotEstimatedBytes: 0 };
    queryStates.set(wikiRoot, state);
    const registered = state;
    registerWorkspaceState(wikiRoot, "code-evidence-query", () => {
      forgetQueryRuntime(registered);
      queryStates.delete(wikiRoot);
    });
  } else {
    touchWorkspaceState(wikiRoot);
  }
  return state;
}

async function querySnapshotIdentity(wikiRoot: string): Promise<{ identity: string; size: number } | null> {
  try {
    const stat = await fs.stat(codeEvidenceIndexFile(wikiRoot), { bigint: true });
    if (!stat.isFile()) throw new Error("Code evidence index is not a regular file.");
    return {
      identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`,
      size: Number(stat.size),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadQueryRuntime(
  requestedRoot: string,
  registry: KnowledgeAdapterRegistry
): Promise<CodeQueryRuntime> {
  const adapters = registry.roster();
  const root = nodePath.resolve(requestedRoot);
  const state = queryState(root);
  const before = await querySnapshotIdentity(root);
  if (before && state.runtime && state.identity === before.identity && state.runtime.registry === registry) return state.runtime;
  if (state.pending) {
    await state.pending;
    // A waiting caller verifies the file again: a writer may have replaced it
    // while the first caller was reading or constructing the query structures.
    return loadQueryRuntime(root, registry);
  }
  forgetQueryRuntime(state);
  if (!before) return new CodeQueryRuntime(emptySnapshot(adapters), registry);
  state.pending = (async () => {
    let identity = before;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await readCodeEvidenceSnapshot(root, adapters);
      const after = await querySnapshotIdentity(root);
      if (!after) return new CodeQueryRuntime(emptySnapshot(adapters), registry);
      if (identity.identity === after.identity) {
        const runtime = new CodeQueryRuntime(snapshot, registry);
        // Include an allowance for parsed objects and the lazy symbol/reference
        // maps. This is an admission estimate, not V8 heap accounting.
        const estimatedBytes = after.size * 4 + snapshot.fragments.length * 512;
        if (estimatedBytes <= MAX_QUERY_CACHE_ESTIMATED_BYTES && queryStates.get(root) === state) {
          // Admission and invalidation belong to this project alone. A large
          // snapshot in one workspace must not displace another project's cache.
          state.runtime = runtime;
          state.identity = after.identity;
          state.estimatedBytes = estimatedBytes;
          state.snapshotEstimatedBytes = estimatedBytes;
        }
        return runtime;
      }
      identity = after;
    }
    // A busy external writer must not attach a cached generation to metadata
    // from different bytes. Serve a freshly validated, uncached snapshot.
    return new CodeQueryRuntime(await readCodeEvidenceSnapshot(root, adapters), registry);
  })().finally(() => { state.pending = undefined; });
  return state.pending;
}

/** Internal diagnostics for capacity checks; not part of the MCP tool payload. */
export function getCodeQueryCacheDiagnostics(wikiRoot: string): { cached: boolean; estimatedBytes: number; maxEstimatedBytes: number } {
  const state = queryStates.get(nodePath.resolve(wikiRoot));
  return {
    cached: state?.runtime !== undefined,
    estimatedBytes: state?.estimatedBytes ?? 0,
    maxEstimatedBytes: MAX_QUERY_CACHE_ESTIMATED_BYTES,
  };
}

function accountProjectStructure(wikiRoot: string, runtime: CodeQueryRuntime): void {
  const state = queryStates.get(wikiRoot);
  if (state?.runtime !== runtime) return;
  const estimatedBytes = state.snapshotEstimatedBytes + runtime.projectStructureEstimatedBytes();
  if (estimatedBytes > MAX_QUERY_CACHE_ESTIMATED_BYTES) forgetQueryRuntime(state);
  else state.estimatedBytes = estimatedBytes;
}

async function readCodeSource(repositoryRoot: string, path: string): Promise<{ source: CodeSource; contentHash: string }> {
  const normalized = normalizedRelativePath(path);
  const lexicalTarget = safeResolveWithin(repositoryRoot, normalized);
  const [rootReal, targetReal] = await Promise.all([
    fs.realpath(repositoryRoot),
    fs.realpath(lexicalTarget),
  ]);
  const relativeReal = nodePath.relative(rootReal, targetReal);
  if (relativeReal === "" || relativeReal.startsWith("..") || nodePath.isAbsolute(relativeReal)) {
    throw new Error(`Code path resolves outside the repository root: ${path}`);
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) throw new Error(`Code path is not a regular file: ${path}`);
  if (stat.size > MAX_CODE_FILE_BYTES) {
    throw new Error(`Code file exceeds ${MAX_CODE_FILE_BYTES} bytes: ${path}`);
  }
  const content = await fs.readFile(targetReal, "utf8");
  return {
    source: { repositoryRoot: rootReal, path: normalized, content },
    contentHash: sha256(content),
  };
}

function report(params: {
  scannedFiles: number;
  reusedFiles: number;
  reparsedFiles: number;
  removedFiles: number;
  snapshot: CodeEvidenceSnapshot;
}): CodeEvidenceUpdateReport {
  return {
    scannedFiles: params.scannedFiles,
    reusedFiles: params.reusedFiles,
    reparsedFiles: params.reparsedFiles,
    removedFiles: params.removedFiles,
    fragmentCount: params.snapshot.fragments.length,
  };
}

function clampResults(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new Error(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  return value;
}

function fieldIncludes(values: readonly string[], term: string): boolean {
  return values.some((value) => normalizedCodeText(value).includes(term));
}

export function scoreFragment(fragment: KnowledgeFragment, queryNormalized: string, terms: readonly string[]): {
  score: number;
  matchedTerms: string[];
} {
  const symbol = normalizedCodeText(fragment.symbol);
  const qualifiedName = normalizedCodeText(fragment.qualifiedName);
  const path = normalizedCodeText(fragment.path);
  const definition = normalizedCodeText(fragment.definition);
  const docComment = normalizedCodeText(fragment.docComment ?? "");
  const routeText = fragment.routes.map((route) => `${route.method} ${route.path} ${route.handler ?? ""}`.toLowerCase());
  let score = symbol === queryNormalized || qualifiedName === queryNormalized ? 120 : 0;
  if (symbol.includes(queryNormalized) || qualifiedName.includes(queryNormalized)) score += 32;
  if (path.includes(queryNormalized)) score += 16;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    let termScore = 0;
    if (symbol === term || qualifiedName === term) termScore += 18;
    else if (symbol.includes(term) || qualifiedName.includes(term)) termScore += 12;
    if (path.includes(term)) termScore += 6;
    if (definition.includes(term)) termScore += 6;
    if (fieldIncludes(fragment.calls, term)) termScore += 9;
    if (fieldIncludes(fragment.references, term)) termScore += 5;
    if (fieldIncludes(fragment.imports, term)) termScore += 5;
    if (fieldIncludes(fragment.configKeys, term)) termScore += 12;
    if (fieldIncludes(fragment.databaseRefs, term)) termScore += 10;
    if (routeText.some((value) => value.includes(term))) termScore += 12;
    if (docComment.includes(term)) termScore += 4;
    if (termScore > 0) {
      score += termScore;
      matchedTerms.push(term);
    }
  }
  if (terms.length > 0) score += (matchedTerms.length / terms.length) * 20;
  if (fragment.kind === "module") score *= 0.72;
  return { score, matchedTerms };
}

export function codeResourceUri(fragment: KnowledgeFragment): string {
  const encodedPath = fragment.path.split("/").map(encodeURIComponent).join("/");
  return `code://repo/${encodedPath}#${encodeURIComponent(fragment.id)}`;
}

function sortedFragments(fragments: readonly KnowledgeFragment[]): KnowledgeFragment[] {
  return [...fragments].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.range.startLine - right.range.startLine ||
    left.id.localeCompare(right.id)
  );
}

function rosterWithAdapter(
  roster: readonly CodeEvidenceAdapterRosterEntry[],
  registry: KnowledgeAdapterRegistry,
  adapter: KnowledgeAdapter
): CodeEvidenceAdapterRosterEntry[] {
  const claims = [...registry.extensionClaimsFor(adapter)].sort();
  const retained = roster.filter((entry) =>
    !entry.extensionClaims.some((claim) => claims.includes(claim))
  );
  return [...retained, { extensionClaims: claims, parserVersion: adapter.parserVersion }]
    .sort((left, right) => left.extensionClaims.join("\0").localeCompare(right.extensionClaims.join("\0")));
}

export class PersistentCodeEvidenceIndex implements CodeEvidenceIndex {
  readonly repositoryRoot: string;
  readonly wikiRoot: string;
  readonly registry: KnowledgeAdapterRegistry;

  constructor(params: {
    repositoryRoot: string;
    wikiRoot: string;
    adapter?: KnowledgeAdapter;
    adapters?: readonly (KnowledgeAdapter | AdapterRegistration)[];
    registry?: KnowledgeAdapterRegistry;
  }) {
    this.repositoryRoot = nodePath.resolve(params.repositoryRoot);
    this.wikiRoot = nodePath.resolve(params.wikiRoot);
    const supplied = Number(Boolean(params.adapter)) + Number(Boolean(params.adapters)) + Number(Boolean(params.registry));
    if (supplied > 1) throw new Error("Configure only one of adapter, adapters, or registry.");
    this.registry = params.registry ?? (params.adapters
      ? new KnowledgeAdapterRegistry(params.adapters)
      : params.adapter
        ? new KnowledgeAdapterRegistry([params.adapter])
        : DEFAULT_QUERY_ADAPTERS);
  }

  async snapshot(): Promise<CodeEvidenceSnapshot> {
    return readCodeEvidenceSnapshot(this.wikiRoot, this.registry.roster());
  }

  private async queryRuntime(repair = true): Promise<CodeQueryRuntime> {
    let runtime: CodeQueryRuntime;
    try {
      runtime = await loadQueryRuntime(this.wikiRoot, this.registry);
    } catch (error) {
      if (!repair) throw error;
      // Filesystem failures are not corrupt derived data and must reach callers.
      if ((error as NodeJS.ErrnoException).code) throw error;
      await this.rebuild();
      runtime = await loadQueryRuntime(this.wikiRoot, this.registry);
    }
    if (runtime.snapshot.files.length > 0 && !sameAdapterRoster(runtime.snapshot.adapters, this.registry.roster())) {
      throw new Error("Code evidence adapter roster changed; rebuild the index to refresh only affected languages.");
    }
    return runtime;
  }

  private async ensureCurrentSnapshotSchema(): Promise<void> {
    try {
      await this.snapshot();
    } catch {
      await this.rebuild();
    }
  }

  async rebuild(): Promise<CodeEvidenceUpdateReport> {
    return withWikiFileLock(this.wikiRoot, codeEvidenceIndexFile(this.wikiRoot), async () => {
      const before = await this.snapshot().catch((error: unknown) =>
        discardCorruptSnapshot(this.wikiRoot, this.registry.roster(), error)
      );
      const paths = (await fg(this.registry.globPatterns(), {
        cwd: this.repositoryRoot,
        caseSensitiveMatch: false,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: CODE_IGNORES,
      })).map(normalizedRelativePath).sort();
      const oldFiles = new Map(before.files.map((record) => [record.path, record]));
      const oldFragments = new Map(before.fragments.map((fragment) => [fragment.id, fragment]));
      const files: CodeEvidenceFileRecord[] = [];
      const fragments: KnowledgeFragment[] = [];
      let reusedFiles = 0;
      let reparsedFiles = 0;

      for (const path of paths) {
        const adapter = this.registry.resolve({ path });
        if (!adapter) continue;
        const { source, contentHash } = await readCodeSource(this.repositoryRoot, path);
        const nextFingerprint = fingerprint(path, contentHash, adapter.parserVersion);
        const previous = oldFiles.get(path);
        if (previous?.fingerprint === nextFingerprint && previous.parserVersion === adapter.parserVersion) {
          const reused = previous.fragmentIds.map((id) => oldFragments.get(id));
          if (reused.every((fragment): fragment is KnowledgeFragment => fragment !== undefined)) {
            reusedFiles++;
            files.push(previous);
            fragments.push(...reused);
            continue;
          }
        }
        const extracted = await adapter.extract(source);
        reparsedFiles++;
        files.push({
          path,
          contentHash,
          fingerprint: nextFingerprint,
          parserVersion: adapter.parserVersion,
          fragmentIds: extracted.map((fragment) => fragment.id),
        });
        fragments.push(...extracted);
      }

      const snapshot: CodeEvidenceSnapshot = {
        version: CODE_EVIDENCE_INDEX_VERSION,
        adapters: this.registry.roster(),
        generatedAt: new Date().toISOString(),
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
        fragments: sortedFragments(fragments),
      };
      await writeSnapshot(this.wikiRoot, snapshot);
      return report({
        scannedFiles: paths.length,
        reusedFiles,
        reparsedFiles,
        removedFiles: before.files.filter((record) => !paths.includes(record.path)).length,
        snapshot,
      });
    });
  }

  async updateFile(path: string): Promise<CodeEvidenceUpdateReport> {
    await this.ensureCurrentSnapshotSchema();
    return withWikiFileLock(this.wikiRoot, codeEvidenceIndexFile(this.wikiRoot), async () => {
      const normalizedPath = normalizedRelativePath(path);
      safeResolveWithin(this.repositoryRoot, normalizedPath);
      const before = await this.snapshot();
      if (this.isProjectManifest(normalizedPath)) return this.invalidateProjectStructure(before);
      const adapter = this.registry.resolve({ path: normalizedPath });
      if (!adapter) throw new Error(`No code evidence adapter supports: ${normalizedPath}`);
      const { source, contentHash } = await readCodeSource(this.repositoryRoot, normalizedPath);
      const nextFingerprint = fingerprint(normalizedPath, contentHash, adapter.parserVersion);
      const previous = before.files.find((record) => record.path === normalizedPath);
      if (previous?.fingerprint === nextFingerprint && previous.parserVersion === adapter.parserVersion) {
        return report({ scannedFiles: 1, reusedFiles: 1, reparsedFiles: 0, removedFiles: 0, snapshot: before });
      }
      const extracted = await adapter.extract(source);
      const files = before.files.filter((record) => record.path !== normalizedPath);
      files.push({
        path: normalizedPath,
        contentHash,
        fingerprint: nextFingerprint,
        parserVersion: adapter.parserVersion,
        fragmentIds: extracted.map((fragment) => fragment.id),
      });
      const snapshot: CodeEvidenceSnapshot = {
        version: CODE_EVIDENCE_INDEX_VERSION,
        adapters: rosterWithAdapter(before.adapters, this.registry, adapter),
        generatedAt: new Date().toISOString(),
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
        fragments: sortedFragments([
          ...before.fragments.filter((fragment) => fragment.path !== normalizedPath),
          ...extracted,
        ]),
      };
      await writeSnapshot(this.wikiRoot, snapshot);
      return report({ scannedFiles: 1, reusedFiles: 0, reparsedFiles: 1, removedFiles: 0, snapshot });
    });
  }

  async removeFile(path: string): Promise<CodeEvidenceUpdateReport> {
    await this.ensureCurrentSnapshotSchema();
    return withWikiFileLock(this.wikiRoot, codeEvidenceIndexFile(this.wikiRoot), async () => {
      const normalizedPath = normalizedRelativePath(path);
      safeResolveWithin(this.repositoryRoot, normalizedPath);
      const before = await this.snapshot();
      if (this.isProjectManifest(normalizedPath)) return this.invalidateProjectStructure(before);
      const existed = before.files.some((record) => record.path === normalizedPath);
      if (!existed) {
        return report({ scannedFiles: 0, reusedFiles: before.files.length, reparsedFiles: 0, removedFiles: 0, snapshot: before });
      }
      const snapshot: CodeEvidenceSnapshot = {
        ...before,
        generatedAt: new Date().toISOString(),
        files: before.files.filter((record) => record.path !== normalizedPath),
        fragments: before.fragments.filter((fragment) => fragment.path !== normalizedPath),
      };
      await writeSnapshot(this.wikiRoot, snapshot);
      return report({ scannedFiles: 0, reusedFiles: snapshot.files.length, reparsedFiles: 0, removedFiles: 1, snapshot });
    });
  }

  private isProjectManifest(path: string): boolean {
    const fileName = nodePath.posix.basename(path);
    return this.registry.registrations.some(({ adapter }) => adapter.projectManifests?.some((spec) => spec.fileName === fileName));
  }

  private async invalidateProjectStructure(before: CodeEvidenceSnapshot): Promise<CodeEvidenceUpdateReport> {
    // Publish a new derived generation so other processes also discover newly
    // created nested manifests. Existing source fragments and anchors stay intact.
    const snapshot = { ...before, generatedAt: new Date().toISOString() };
    await writeSnapshot(this.wikiRoot, snapshot);
    return report({ scannedFiles: 0, reusedFiles: before.files.length, reparsedFiles: 0, removedFiles: 0, snapshot });
  }

  async search(query: string, options: CodeSearchOptions = {}): Promise<CodeEvidenceHit[]> {
    if (!query.trim()) throw new Error("Code evidence query must not be empty.");
    const maxResults = clampResults(options.maxResults);
    const kindFilter = options.kinds ? new Set(options.kinds) : null;
    const terms = tokenizeSearchText(query);
    const queryNormalized = normalizedCodeText(query).trim();
    const { snapshot } = await this.queryRuntime();
    const best = new TopResults<{ fragment: KnowledgeFragment; score: number; matchedTerms: string[] }>(
      maxResults, (left, right) => right.score - left.score ||
        left.fragment.path.localeCompare(right.fragment.path) ||
        left.fragment.range.startLine - right.fragment.range.startLine
    );
    for (const fragment of snapshot.fragments) {
      if ((kindFilter && !kindFilter.has(fragment.kind)) || !codePathAllowed(fragment.path, options.paths)) continue;
      const scored = scoreFragment(fragment, queryNormalized, terms);
      if (scored.score > 0) best.add({ fragment, ...scored });
    }
    return best.sorted().map((hit) => ({ ...hit, fragment: structuredClone(hit.fragment), resourceUri: codeResourceUri(hit.fragment) }));
  }

  async symbol(name: string, options: CodeSearchOptions = {}): Promise<CodeEvidenceHit[]> {
    if (!name.trim()) throw new Error("Symbol name must not be empty.");
    const maxResults = clampResults(options.maxResults);
    const sought = normalizedQualifiedSymbol(name);
    if (!sought) throw new Error("Symbol name must contain an identifier.");
    const runtime = await this.queryRuntime();
    return runtime.symbol(sought, options, maxResults)
      .map((hit) => ({ ...hit, fragment: structuredClone(hit.fragment), resourceUri: codeResourceUri(hit.fragment) }));
  }

  async references(symbolId: string, options: CodeSearchOptions = {}): Promise<CodeReference[]> {
    return (await this.referenceQuery(symbolId, options)).references;
  }

  /** Read-only context expansion. Shares the ordinary runtime/admission policy;
   * never rebuilds, updates source files or writes a snapshot on failure. */
  async impact(targets: readonly CodeImpactTarget[]): Promise<CodeImpactResult> {
    // Automatic task-context reads must not follow an index from another wiki.
    try {
      const [rootReal, indexReal] = await Promise.all([fs.realpath(this.wikiRoot), fs.realpath(codeEvidenceIndexFile(this.wikiRoot))]);
      if (nodePath.relative(rootReal, indexReal).replace(/\\/g, "/") !== `.knowledge-rail/${INDEX_FILE_NAME}`) {
        throw new Error("Code impact index resolves outside its canonical workspace location.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const unique = [...new Map(targets.map((target) => [`${target.path}\0${target.fragmentId ?? ""}`, target])).values()];
    const requested = unique.slice(0, CODE_IMPACT_MAX_ROOTS);
    const runtime = await this.queryRuntime(false);
    const byPath = new Map(requested.map((target) => [target.path, [] as KnowledgeFragment[]]));
    for (const fragment of runtime.snapshot.fragments) byPath.get(fragment.path)?.push(fragment);
    const roots: CodeImpactResult["roots"] = [];
    const unresolved: CodeImpactTarget[] = [];
    const resolved = requested.map((target) => {
      const fragments = byPath.get(target.path)!;
      const fragment = target.fragmentId
        ? fragments.find((candidate) => candidate.id === target.fragmentId)
        : fragments.find((candidate) => candidate.kind === "module" && candidate.qualifiedName === target.path) ??
          fragments.find((candidate) => candidate.kind === "module");
      if (!fragment) unresolved.push(target);
      return { requested: target, fragment, fragments };
    });
    let relationsTruncated = false;
    if (resolved.some((root) => root.fragment)) await runtime.refreshProjectStructure(this.repositoryRoot);
    for (const root of resolved) {
      if (!root.fragment) continue;
      const targets = root.requested.fragmentId ? [root.fragment] : root.fragments.filter((fragment) => fragment.kind !== "comment");
      const references = runtime.referencesTo(targets, {}, CODE_IMPACT_REFERENCES_PER_ROOT + 1);
      relationsTruncated ||= references.length > CODE_IMPACT_REFERENCES_PER_ROOT;
      roots.push({ requested: { ...root.requested }, fragment: structuredClone(root.fragment),
        references: references.slice(0, CODE_IMPACT_REFERENCES_PER_ROOT).map((reference) => ({
          source: structuredClone(reference.source), target: structuredClone(reference.target), relation: reference.relation,
          resourceUri: codeResourceUri(reference.source),
        })),
      });
    }
    accountProjectStructure(this.wikiRoot, runtime);
    return { generatedAt: runtime.snapshot.generatedAt, roots, unresolved: structuredClone(unresolved),
      omittedRoots: unique.length - requested.length, relationsTruncated,
      manifestWarnings: structuredClone(runtime.projectStructureWarnings()),
      ...(roots.length ? { importDiagnostics: structuredClone(runtime.importResolutionDiagnostics().diagnostics) } : {}),
    };
  }

  async referencesWithDiagnostics(symbolId: string, options: CodeSearchOptions = {}): Promise<{
    references: CodeReference[];
    manifestWarnings: ProjectStructure["warnings"];
    importDiagnostics: CodeImportDiagnostics;
  }> {
    const { runtime, references } = await this.referenceQuery(symbolId, options);
    return { references, manifestWarnings: structuredClone(runtime.projectStructureWarnings()),
      importDiagnostics: structuredClone(runtime.importResolutionDiagnostics().diagnostics) };
  }

  private async referenceQuery(symbolId: string, options: CodeSearchOptions): Promise<{ runtime: CodeQueryRuntime; references: CodeReference[] }> {
    if (!symbolId.trim()) throw new Error("symbolId must not be empty.");
    const maxResults = clampResults(options.maxResults);
    const runtime = await this.queryRuntime();
    await runtime.refreshProjectStructure(this.repositoryRoot);
    const references = runtime.references(symbolId, options, maxResults);
    accountProjectStructure(this.wikiRoot, runtime);
    const target = references[0] ? structuredClone(references[0].target) : undefined;
    return { runtime, references: references.map((reference) => ({
      ...reference, source: structuredClone(reference.source), target: target!,
      resourceUri: codeResourceUri(reference.source),
    })) };
  }

  /** Bounded callers may expose these warnings without changing existing hit shapes. */
  async projectStructureWarnings(options: { refresh?: boolean } = {}): Promise<ProjectStructure["warnings"]> {
    const runtime = await this.queryRuntime();
    if (options.refresh !== false) await runtime.refreshProjectStructure(this.repositoryRoot);
    accountProjectStructure(this.wikiRoot, runtime);
    return structuredClone(runtime.projectStructureWarnings());
  }
}
