import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, posix, relative } from "node:path";
import { atomicWriteText } from "../fs-service.js";
import { withWikiFileLock } from "../lock-service.js";
import { wikiMetaDir } from "../manifest-service.js";

const LANGUAGES = ["typescript-javascript", "python", "java", "kotlin", "csharp", "php", "c", "cpp", "rust", "go", "ruby", "apex", "sfmeta", "unsupported", "mixed", "unknown"] as const;
type Language = typeof LANGUAGES[number];
export const FALLBACK_REASONS = ["no_match", "ambiguous", "unresolved_import", "unsupported_extension", "other"] as const;
type Reason = typeof FALLBACK_REASONS[number];
const WINDOW = 512;
const MAX_BYTES = 256 * 1024;
interface Counts { served: number; matched: number; fallbacks: number; reasons: Record<Reason, number> }
interface State {
  version: 1; startedAt: string; byLanguage: Partial<Record<Language, Counts>>;
  recent: Array<{ id: string; language: Language; fallback: boolean }>;
  unlinkedFallbacks: number;
  recovery?: { at: string; file: string };
}
const freshState = (): State => ({ version: 1, startedAt: new Date().toISOString(), byLanguage: {}, recent: [], unlinkedFallbacks: 0 });
const TELEMETRY_PATH = ".knowledge-rail/code-request-counts.json";
class CorruptTelemetry extends Error {
  constructor(readonly stamp: string) { super(`Corrupt ${TELEMETRY_PATH}; the next code request will archive it and start a new counting period.`); }
}
const fileStamp = (stat: import("node:fs").Stats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const emptyCounts = (): Counts => ({ served: 0, matched: 0, fallbacks: 0,
  reasons: { no_match: 0, ambiguous: 0, unresolved_import: 0, unsupported_extension: 0, other: 0 } });
export const codeRequestTelemetryFile = (wikiRoot: string): string => join(wikiMetaDir(wikiRoot), "code-request-counts.json");

export function codeRequestLanguage(paths: readonly string[]): Language {
  const extensionLanguage: Record<string, Language> = { ts: "typescript-javascript", tsx: "typescript-javascript", mts: "typescript-javascript", cts: "typescript-javascript",
    js: "typescript-javascript", jsx: "typescript-javascript", mjs: "typescript-javascript", cjs: "typescript-javascript", py: "python", pyi: "python", java: "java",
    kt: "kotlin", kts: "kotlin", cs: "csharp", php: "php", c: "c", h: "cpp", cpp: "cpp", hpp: "cpp", cc: "cpp", hh: "cpp", cxx: "cpp", hxx: "cpp",
    rs: "rust", go: "go", rb: "ruby", rake: "ruby", cls: "apex", trigger: "apex" };
  const languages = new Set<Language>();
  for (const path of paths) {
    const normalized = path.replace(/\\/gu, "/").toLowerCase();
    if (normalized.endsWith(".js-meta.xml")) languages.add("typescript-javascript");
    else if (normalized.endsWith("-meta.xml")) languages.add("sfmeta");
    else {
      const extension = posix.extname(normalized).slice(1);
      if (extension) languages.add(extensionLanguage[extension] ?? "unsupported");
    }
  }
  return languages.size > 1 ? "mixed" : [...languages][0] ?? "unknown";
}

function validate(value: unknown): State {
  const s = value as State;
  const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (!s || Object.keys(s).length !== (s.recovery ? 6 : 5) || s.version !== 1 || typeof s.startedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(s.startedAt) || !Number.isFinite(Date.parse(s.startedAt)) ||
      !integer(s.unlinkedFallbacks) || !s.byLanguage || typeof s.byLanguage !== "object" || Array.isArray(s.byLanguage) ||
      !Array.isArray(s.recent) || s.recent.length > WINDOW) throw new Error("Invalid code request telemetry.");
  if (s.recovery && (Object.keys(s.recovery).length !== 2 || typeof s.recovery.at !== "string" || typeof s.recovery.file !== "string" || !Number.isFinite(Date.parse(s.recovery.at)) ||
      !/^code-request-counts\.corrupt-[0-9TZ-]+-[a-f0-9-]{36}\.json$/u.test(s.recovery.file))) throw new Error("Invalid telemetry recovery metadata.");
  for (const [language, counts] of Object.entries(s.byLanguage)) {
    if (!LANGUAGES.includes(language as Language) || !counts || Object.keys(counts).length !== 4 || !integer(counts.served) || !integer(counts.matched) ||
        !integer(counts.fallbacks) || counts.matched > counts.served || counts.fallbacks > counts.served ||
        !counts.reasons || FALLBACK_REASONS.some((reason) => !integer(counts.reasons[reason])) ||
        Object.keys(counts.reasons).length !== FALLBACK_REASONS.length ||
        Object.values(counts.reasons).reduce((a, b) => a + b, 0) !== counts.fallbacks) throw new Error("Invalid code request counts.");
  }
  if (s.recent.some((r) => !r || Object.keys(r).length !== 3 || !/^[a-f0-9-]{36}$/u.test(r.id) || !LANGUAGES.includes(r.language) || !s.byLanguage[r.language] || typeof r.fallback !== "boolean") ||
      new Set(s.recent.map((r) => r.id)).size !== s.recent.length) throw new Error("Invalid code request window.");
  const recentCounts = new Map<Language, { served: number; fallbacks: number }>();
  for (const request of s.recent) {
    const counts = recentCounts.get(request.language) ?? { served: 0, fallbacks: 0 };
    counts.served++; if (request.fallback) counts.fallbacks++;
    recentCounts.set(request.language, counts);
  }
  for (const [language, counts] of recentCounts) if (counts.served > s.byLanguage[language]!.served || counts.fallbacks > s.byLanguage[language]!.fallbacks) {
    throw new Error("Inconsistent code request window.");
  }
  return s;
}

async function read(wikiRoot: string): Promise<State> {
  let handle: fs.FileHandle;
  try {
    const file = codeRequestTelemetryFile(wikiRoot);
    const [rootReal, fileReal] = await Promise.all([fs.realpath(wikiRoot), fs.realpath(file)]);
    if (relative(rootReal, fileReal).replace(/\\/gu, "/") !== ".knowledge-rail/code-request-counts.json") throw new Error("Code request telemetry is outside its workspace.");
    handle = await fs.open(fileReal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return freshState();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Invalid code request telemetry file.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > MAX_BYTES) throw new CorruptTelemetry(fileStamp(stat));
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw new CorruptTelemetry(fileStamp(stat)); }
    // A newer format is not corruption: an older binary must not reset it.
    if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "number" && parsed.version > 1) {
      throw new Error(`Unsupported version at ${TELEMETRY_PATH}; use a compatible runtime. File preserved.`);
    }
    try { return validate(parsed); }
    catch { throw new CorruptTelemetry(fileStamp(stat)); }
  } finally { await handle.close(); }
}

async function mutate<T>(wikiRoot: string, update: (state: State) => T): Promise<T> {
  const file = codeRequestTelemetryFile(wikiRoot);
  return withWikiFileLock(wikiRoot, file, async () => {
    let state: State;
    try { state = await read(wikiRoot); }
    catch (error) {
      if (!(error instanceof CorruptTelemetry)) throw error;
      const [rootReal, fileReal, stat] = await Promise.all([fs.realpath(wikiRoot), fs.realpath(file), fs.lstat(file)]);
      if (relative(rootReal, fileReal).replace(/\\/gu, "/") !== TELEMETRY_PATH || !stat.isFile() || fileStamp(stat) !== error.stamp) {
        throw new Error(`Cannot recover changed or redirected ${TELEMETRY_PATH}; retry after checking this workspace file.`);
      }
      state = freshState();
      const archive = `code-request-counts.corrupt-${state.startedAt.replace(/[.:]/gu, "-")}-${randomUUID()}.json`;
      await fs.rename(file, join(wikiMetaDir(wikiRoot), archive));
      state.recovery = { at: state.startedAt, file: archive };
    }
    const result = update(state);
    const serialized = JSON.stringify(state) + "\n";
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Code request telemetry exceeds its size limit.");
    // Diagnostic counters need atomicity and process isolation, not a power-loss
    // durability barrier on every read query. Canonical knowledge keeps fsync.
    await atomicWriteText(file, serialized, { durable: false });
    return result;
  }, { syncLockFile: false });
}

/** Successful public responses only, including empty results. No query text,
 * source path, symbol, body or stable content hash is persisted. */
export async function recordCodeRequest(wikiRoot: string, paths: readonly string[], matched: boolean): Promise<string> {
  const id = randomUUID(), language = codeRequestLanguage(paths);
  return mutate(wikiRoot, (state) => {
    const counts = state.byLanguage[language] ??= emptyCounts();
    counts.served++; if (matched) counts.matched++;
    state.recent.push({ id, language, fallback: false });
    if (state.recent.length > WINDOW) state.recent.shift();
    return id;
  });
}

export async function recordCodeRequestFallback(wikiRoot: string, requestId: string | undefined, reason: string): Promise<{ linked: boolean; duplicate: boolean }> {
  return mutate(wikiRoot, (state) => {
    const request = requestId ? state.recent.find((r) => r.id === requestId) : undefined;
    if (!request) { state.unlinkedFallbacks++; return { linked: false, duplicate: false }; }
    if (request.fallback) return { linked: true, duplicate: true };
    request.fallback = true;
    const counts = state.byLanguage[request.language]!;
    counts.fallbacks++;
    counts.reasons[FALLBACK_REASONS.includes(reason as Reason) ? reason as Reason : "other"]++;
    return { linked: true, duplicate: false };
  });
}

export async function codeRequestSummary(wikiRoot: string) {
  const state = await read(wikiRoot);
  return { version: 1, startedAt: state.startedAt, scope: "workspace_public_code_requests", correlationWindow: WINDOW,
    ...(state.recovery ? { recovery: { ...state.recovery, file: `.knowledge-rail/${state.recovery.file}` } } : {}),
    unlinkedFallbacks: state.unlinkedFallbacks,
    rateDefinition: "distinct linked fallback requests / served responses; unlinked fallbacks excluded; unreported fallback use is unknown",
    byLanguage: Object.fromEntries(Object.entries(state.byLanguage).sort(([a], [b]) => a.localeCompare(b)).map(([language, counts]) =>
      [language, { ...counts, fallbackRate: counts.served ? counts.fallbacks / counts.served : null }])) };
}
