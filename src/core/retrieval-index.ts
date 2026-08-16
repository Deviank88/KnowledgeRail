import * as fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import * as nodePath from "node:path";
import { atomicWriteText } from "./fs-service.js";
import { withWikiFileLock } from "./lock-service.js";
import {
  evictWorkspaceState,
  registerWorkspaceState,
  touchWorkspaceState,
} from "./workspace-state.js";
import { listWikiPagePaths, readWikiPageRecord, type WikiPageRecord } from "./page-record.js";
import { wikiMetaDir } from "./manifest-service.js";
import { ensureDir, readFileSafe } from "./utils.js";
import { normalizeSearchText, tokenizeSearchText, type RetrievalProfile } from "./text-analysis.js";

interface Posting {
  body: number;
  title: number;
  metadata: number;
}

interface PersistedRetrievalIndex {
  version: 1;
  generatedAt: string;
  records: WikiPageRecord[];
}

interface IndexState {
  records: Map<string, WikiPageRecord>;
  postings: Map<string, Map<string, Posting>>;
  totalTokenCount: number;
  lastScanMs: number;
  loaded: boolean;
  dirty: boolean;
  persistenceDirty: boolean;
  watcherReliable: boolean;
  generation: number;
  watcher?: FSWatcher;
}

export interface RetrievalHit {
  path: string;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  requestId?: string;
  score: number;
  excerpt: string;
  heading: string;
  record: WikiPageRecord;
}

const states = new Map<string, IndexState>();
const passageTokenCache = new WeakMap<WikiPageRecord, ReadonlyArray<ReadonlySet<string>>>();
const SNAPSHOT_VERSION = 1;
const DEFAULT_REFRESH_MS = 2_000;
const DEFAULT_RECONCILIATION_MS = 60_000;

function snapshotFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "retrieval-index.json");
}

function deltaFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "retrieval-delta.jsonl");
}

async function enqueuePersistence(wikiRoot: string, operation: () => Promise<void>): Promise<void> {
  await withWikiFileLock(wikiRoot, `${nodePath.resolve(wikiRoot)}:retrieval`, operation);
}

function emptyState(): IndexState {
  return {
    records: new Map(),
    postings: new Map(),
    totalTokenCount: 0,
    lastScanMs: 0,
    loaded: false,
    dirty: true,
    persistenceDirty: false,
    watcherReliable: false,
    generation: 0,
  };
}

function stateFor(wikiRoot: string): IndexState {
  const root = nodePath.resolve(wikiRoot);
  let state = states.get(root);
  if (!state) {
    state = emptyState();
    states.set(root, state);
    try {
      // libuv's recursive Windows watcher can abort the process on valid
      // directory/case combinations instead of reporting an ordinary error.
      // Periodic reconciliation is already authoritative on this platform.
      if (process.platform === "win32") throw new Error("Use periodic reconciliation on Windows.");
      // `persistent: false` is stronger than relying only on `unref()` and ensures
      // the derived-index watcher cannot keep short-lived CLI/test processes alive.
      // In the MCP server the transport already keeps the event loop alive, so the
      // watcher continues to deliver invalidation events for the server lifetime.
      const watcher = watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
        if (filename?.toString().replace(/\\/g, "/").startsWith(".knowledge-rail/")) return;
        state!.dirty = true;
        state!.lastScanMs = 0;
      });
      watcher.on("error", () => {
        watcher.close();
        if (state!.watcher === watcher) state!.watcher = undefined;
        state!.watcherReliable = false;
        state!.dirty = true;
        state!.lastScanMs = 0;
      });
      state.watcher = watcher;
      state.watcherReliable = true;
    } catch {
      // Recursive watch is platform-dependent; periodic metadata scans remain the fallback.
    }
    registerWorkspaceState(root, "retrieval", () => {
      state!.watcher?.close();
      states.delete(root);
    });
  } else {
    touchWorkspaceState(root);
  }
  return state;
}

function countTerms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const normalized = normalizeSearchText(text);
  for (const token of normalized.match(/\/?[\p{L}\p{N}][\p{L}\p{N}_./:#-]*/gu) ?? []) {
    result.set(token, (result.get(token) ?? 0) + 1);
    for (const part of token.split(/[_./:#-]+/).filter((value) => value.length >= 2)) {
      if (part !== token) result.set(part, (result.get(part) ?? 0) + 1);
    }
  }
  return result;
}

function indexRecord(state: IndexState, record: WikiPageRecord): void {
  const title = countTerms(`${record.title} ${record.aliases.join(" ")}`);
  const metadata = countTerms([
    record.type,
    record.tags.join(" "),
    record.sources.join(" "),
    record.requestId ?? "",
    record.client ?? "",
    record.project ?? "",
    record.path,
    record.passages.map((passage) => passage.heading).join(" "),
  ].join(" "));
  const body = countTerms(record.body);
  const terms = new Set([...title.keys(), ...metadata.keys(), ...body.keys()]);
  for (const term of terms) {
    let byPath = state.postings.get(term);
    if (!byPath) {
      byPath = new Map();
      state.postings.set(term, byPath);
    }
    byPath.set(record.path, {
      body: body.get(term) ?? 0,
      title: title.get(term) ?? 0,
      metadata: metadata.get(term) ?? 0,
    });
  }
  state.records.set(record.path, record);
  state.totalTokenCount += record.tokenCount;
}

function removeRecord(state: IndexState, relPath: string): void {
  const existing = state.records.get(relPath);
  if (!existing) return;
  state.records.delete(relPath);
  state.totalTokenCount = Math.max(0, state.totalTokenCount - existing.tokenCount);
  for (const [term, byPath] of state.postings) {
    byPath.delete(relPath);
    if (byPath.size === 0) state.postings.delete(term);
  }
}

async function loadSnapshot(wikiRoot: string, state: IndexState): Promise<void> {
  if (state.loaded) return;
  state.loaded = true;
  const raw = await readFileSafe(snapshotFile(wikiRoot));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedRetrievalIndex;
      if (parsed.version === SNAPSHOT_VERSION && Array.isArray(parsed.records)) {
        for (const record of parsed.records) indexRecord(state, record);
      }
    } catch {
      // Derived snapshots are disposable; a filesystem scan repairs them.
    }
  }
  const deltas = await readFileSafe(deltaFile(wikiRoot));
  if (deltas) {
    for (const line of deltas.split(/\r?\n/).filter(Boolean)) {
      try {
        const delta = JSON.parse(line) as { path: string; record: WikiPageRecord | null };
        removeRecord(state, delta.path);
        if (delta.record) indexRecord(state, delta.record);
      } catch {
        // Ignore an incomplete trailing line; the next scan repairs it.
      }
    }
  }
}

async function persistSnapshot(wikiRoot: string, state: IndexState): Promise<void> {
  await enqueuePersistence(wikiRoot, async () => {
    await ensureDir(wikiMetaDir(wikiRoot));
    const snapshot: PersistedRetrievalIndex = {
      version: SNAPSHOT_VERSION,
      generatedAt: new Date().toISOString(),
      records: [...state.records.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
    await atomicWriteText(snapshotFile(wikiRoot), `${JSON.stringify(snapshot)}\n`);
    await fs.rm(deltaFile(wikiRoot), { force: true });
  });
}

export async function refreshRetrievalIndex(
  wikiRoot: string,
  options: { force?: boolean; persist?: boolean } = {}
): Promise<IndexState> {
  const state = stateFor(wikiRoot);
  await loadSnapshot(wikiRoot, state);
  const refreshMs = Number(process.env["KNOWLEDGE_RAIL_REFRESH_MS"] ?? DEFAULT_REFRESH_MS);
  const reconciliationMs = Number(
    process.env["KNOWLEDGE_RAIL_RECONCILIATION_MS"] ?? DEFAULT_RECONCILIATION_MS
  );
  const scanInterval = state.watcherReliable
    ? Math.max(refreshMs, reconciliationMs)
    : refreshMs;
  const fallbackDue = Date.now() - state.lastScanMs >= Math.max(0, scanInterval);
  if (!options.force && !state.dirty && !fallbackDue) return state;

  const paths = await listWikiPagePaths(wikiRoot);
  const seen = new Set(paths);
  let changed = false;
  for (const existing of [...state.records.keys()]) {
    if (!seen.has(existing)) {
      removeRecord(state, existing);
      changed = true;
    }
  }

  const stats = await Promise.all(paths.map(async (relPath) => {
    const stat = await fs.stat(nodePath.join(wikiRoot, relPath));
    return { relPath, stat };
  }));
  for (const { relPath, stat } of stats) {
    const cached = state.records.get(relPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    const record = await readWikiPageRecord(wikiRoot, relPath, stat);
    removeRecord(state, relPath);
    if (record) indexRecord(state, record);
    changed = true;
  }
  state.lastScanMs = Date.now();
  state.dirty = false;
  if (changed) {
    state.generation++;
    state.persistenceDirty = true;
  }
  if (options.persist !== false && state.persistenceDirty) {
    await persistSnapshot(wikiRoot, state);
    state.persistenceDirty = false;
  }
  return state;
}

export function getRetrievalIndexGeneration(wikiRoot: string): number {
  return stateFor(wikiRoot).generation;
}

export async function updateRetrievalPaths(wikiRoot: string, relPaths: readonly string[]): Promise<void> {
  const state = stateFor(wikiRoot);
  await loadSnapshot(wikiRoot, state);
  const deltas: Array<{ path: string; record: WikiPageRecord | null }> = [];
  for (const inputPath of new Set(relPaths)) {
    const relPath = inputPath.replace(/\\/g, "/");
    removeRecord(state, relPath);
    const record = await readWikiPageRecord(wikiRoot, relPath).catch(() => null);
    if (record) indexRecord(state, record);
    deltas.push({ path: relPath, record });
  }
  state.lastScanMs = Date.now();
  state.dirty = false;
  if (deltas.length > 0) state.generation++;
  if (state.persistenceDirty) {
    await persistSnapshot(wikiRoot, state);
    state.persistenceDirty = false;
    return;
  }
  await enqueuePersistence(wikiRoot, async () => {
    await ensureDir(wikiMetaDir(wikiRoot));
    await fs.appendFile(deltaFile(wikiRoot), `${deltas.map((delta) => JSON.stringify(delta)).join("\n")}\n`, "utf-8");
  });
}

function passageTokens(record: WikiPageRecord): ReadonlyArray<ReadonlySet<string>> {
  const cached = passageTokenCache.get(record);
  if (cached) return cached;
  const tokens = record.passages.map((passage) =>
    new Set(tokenizeSearchText(`${passage.heading} ${passage.text}`))
  );
  passageTokenCache.set(record, tokens);
  return tokens;
}

function bestPassage(record: WikiPageRecord, terms: readonly string[]): { heading: string; text: string } {
  let best = record.passages[0] ?? { heading: "Introduzione", text: record.body };
  let bestScore = -1;
  const cachedTokens = passageTokens(record);
  for (let index = 0; index < record.passages.length; index++) {
    const passage = record.passages[index]!;
    const tokens = cachedTokens[index] ?? new Set<string>();
    const score = terms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
    if (score > bestScore) {
      best = passage;
      bestScore = score;
    }
  }
  return { heading: best.heading, text: best.text.replace(/\s+/g, " ").trim().slice(0, 420) };
}

export async function searchRetrievalIndex(params: {
  wikiRoot: string;
  query?: string;
  maxResults?: number;
  pageTypes?: readonly string[];
  profile?: RetrievalProfile;
  forceRefresh?: boolean;
  /** Persist refreshed derived state. Read-only MCP operations set this to false. */
  persist?: boolean;
}): Promise<RetrievalHit[]> {
  const state = await refreshRetrievalIndex(params.wikiRoot, {
    force: params.forceRefresh,
    persist: params.persist,
  });
  const terms = tokenizeSearchText(params.query ?? "");
  const typeFilter = params.pageTypes ? new Set(params.pageTypes) : null;
  if (terms.length === 0) {
    return [...state.records.values()]
      .filter((record) => !typeFilter || typeFilter.has(record.type))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, params.maxResults ?? 50)
      .map((record) => ({
        path: record.path, title: record.title, type: record.type, tags: record.tags,
        sources: record.sources, requestId: record.requestId, score: 0, excerpt: "",
        heading: "", record,
      }));
  }

  const candidates = new Set<string>();
  for (const term of terms) for (const path of state.postings.get(term)?.keys() ?? []) candidates.add(path);
  const documentCount = Math.max(state.records.size, 1);
  const averageLength = state.totalTokenCount / documentCount;
  const profile = params.profile ?? "balanced";
  const k1 = profile === "precision" ? 1.0 : 1.4;
  const b = profile === "coverage" ? 0.55 : 0.75;
  const hits: RetrievalHit[] = [];
  for (const path of candidates) {
    const record = state.records.get(path);
    if (!record || (typeFilter && !typeFilter.has(record.type))) continue;
    let score = 0;
    let matchedTerms = 0;
    const normalizedRequestId = normalizeSearchText(record.requestId ?? "");
    const normalizedTitle = normalizeSearchText(record.title);
    for (const term of terms) {
      const byPath = state.postings.get(term);
      const posting = byPath?.get(path);
      if (!posting) continue;
      matchedTerms++;
      const df = byPath?.size ?? 0;
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
      const tf = posting.body + posting.metadata * 2.5 + posting.title * 5;
      const normalizedTf = (tf * (k1 + 1)) /
        (tf + k1 * (1 - b + b * record.tokenCount / Math.max(averageLength, 1)));
      score += idf * normalizedTf;
      if (normalizedRequestId === term || normalizedTitle === term) score += 8;
    }
    score *= 1 + matchedTerms / terms.length;
    const passage = bestPassage(record, terms);
    hits.push({
      path, title: record.title, type: record.type, tags: record.tags, sources: record.sources,
      requestId: record.requestId, score, excerpt: passage.text, heading: passage.heading, record,
    });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, params.maxResults ?? 10);
}

export async function getWikiPageRecords(
  wikiRoot: string,
  forceRefresh = false,
  options: { persist?: boolean } = {}
): Promise<WikiPageRecord[]> {
  const state = await refreshRetrievalIndex(wikiRoot, {
    force: forceRefresh,
    persist: options.persist,
  });
  return [...state.records.values()];
}

export function clearRetrievalIndexes(): void {
  for (const root of [...states.keys()]) evictWorkspaceState(root);
  for (const state of states.values()) state.watcher?.close();
  states.clear();
}
