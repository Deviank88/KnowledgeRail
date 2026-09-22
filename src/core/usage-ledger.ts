import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteText } from "./fs-service.js";
import { withWikiFileLock } from "./lock-service.js";
import { resolveRealWithin } from "./paths.js";
import { getActiveWorkspaceContext } from "./workspace-context.js";
import { registerWorkspaceState } from "./workspace-state.js";
import { tokenizeSearchText } from "./text-analysis.js";
import { wikiPageUri } from "../context/resource-uri.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const DAY = 86_400_000;
const FILE = ".knowledge-rail/usage-ledger.jsonl";
interface UsageEvent {
  version: 1;
  id: string;
  at: number;
  kind: "disclosed" | "materialized" | "fallback" | "succeeded" | "failed";
  terms: string[];
  resources: string[];
  gap: boolean;
}
interface ActiveUsage { id: string; at: number; resources: Set<string> }
const sessionStorage = new AsyncLocalStorage<string>();
const active = new Map<string, ActiveUsage>();
const cache = new Map<string, { stamp: string; events: UsageEvent[] }>();

export function withUsageSession<T>(session: string, operation: () => T): T {
  const binding = getActiveWorkspaceContext()?.binding;
  return sessionStorage.run(binding ? createHash("sha256").update(binding).digest("hex") : session, operation);
}
function key(wikiRoot: string): string | undefined {
  const session = sessionStorage.getStore();
  return session ? `${path.resolve(wikiRoot)}\0${session}` : undefined;
}
function terms(query: string): string[] {
  // Unordered bounded terms, never original task text, URLs, tokens or credentials.
  if (/bearer\s|api[_-]?key\s*[:=]|password\s*[:=]|sk-[a-z0-9]/i.test(query)) return [];
  return [...new Set(tokenizeSearchText(query).filter((t) => /^[\p{L}][\p{L}-]{2,39}$/u.test(t)))].sort().slice(0, 24);
}
function resource(value: string): string | undefined {
  try {
    const uri = new URL(value);
    if (!["knowledge-rail:", "code:"].includes(uri.protocol) || !["page", "repo"].includes(uri.hostname)) return undefined;
    const segments = decodeURIComponent(uri.pathname).split("/").filter(Boolean);
    if (!segments.length || segments.some((p) => p === ".." || p === "." || /[\u0000-\u001f\\]/.test(p))) return undefined;
    uri.search = ""; uri.hash = "";
    return uri.href;
  } catch { return undefined; }
}
function valid(value: unknown): value is UsageEvent {
  const e = value as UsageEvent;
  return !!e && e.version === 1 && /^[a-f0-9-]{36}$/.test(e.id) && Number.isFinite(e.at) &&
    ["disclosed", "materialized", "fallback", "succeeded", "failed"].includes(e.kind) && typeof e.gap === "boolean" &&
    Array.isArray(e.terms) && e.terms.length <= 24 && e.terms.every((t) => typeof t === "string" && /^[\p{L}][\p{L}-]{2,39}$/u.test(t)) &&
    Array.isArray(e.resources) && e.resources.length <= 64 && e.resources.every((r) => typeof r === "string" && resource(r) === r);
}
async function file(wikiRoot: string): Promise<string> {
  const metadata = await fs.lstat(path.join(wikiRoot, ".knowledge-rail")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error("Usage metadata directory must be a regular local directory.");
  const filename = await resolveRealWithin(wikiRoot, FILE);
  const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Usage ledger must be a regular local file.");
  return filename;
}
async function read(wikiRoot: string): Promise<UsageEvent[]> {
  const filename = await file(wikiRoot);
  const stat = await fs.stat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return [];
  if (stat.size > MAX_BYTES) throw new Error("Usage ledger exceeds its bounded size; inspect or reset it explicitly.");
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (cache.get(filename)?.stamp === stamp) return cache.get(filename)!.events;
  const raw = await fs.readFile(filename, "utf8");
  const events: UsageEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error("Usage ledger is malformed; inspect or reset it explicitly."); }
    if (!valid(parsed)) throw new Error("Usage ledger contains an unsupported record.");
    events.push(parsed);
  }
  if (events.length > MAX_EVENTS) throw new Error("Usage ledger exceeds its event limit.");
  cache.set(filename, { stamp, events });
  registerWorkspaceState(wikiRoot, "usage", () => {
    cache.delete(filename);
    for (const k of active.keys()) if (k.startsWith(`${path.resolve(wikiRoot)}\0`)) active.delete(k);
  });
  return events;
}
async function append(wikiRoot: string, event: UsageEvent): Promise<void> {
  const filename = await file(wikiRoot);
  await withWikiFileLock(wikiRoot, `${path.resolve(wikiRoot)}:usage`, async () => {
    const events = (await read(wikiRoot)).filter((e) => e.at >= event.at - 180 * DAY);
    events.push(event);
    while (events.length > MAX_EVENTS) events.shift();
    let lines = events.map((e) => JSON.stringify(e));
    let bytes = lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
    while (bytes > MAX_BYTES && lines.length > 1) bytes -= Buffer.byteLength(lines.shift()!) + 1;
    const existingSize = (await fs.stat(filename).catch(() => null))?.size ?? 0;
    const line = JSON.stringify(event) + "\n";
    if (events.length === lines.length && existingSize + Buffer.byteLength(line) === bytes) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.appendFile(filename, line, { encoding: "utf8", mode: 0o600 });
    } else await atomicWriteText(filename, lines.join("\n") + "\n", { durable: false });
    cache.delete(filename);
  }, { syncLockFile: false });
}

export async function recordUsageDisclosure(wikiRoot: string, query: string, resources: readonly string[], gap: boolean): Promise<void> {
  if (getActiveWorkspaceContext()?.scope === "read") return;
  const k = key(wikiRoot);
  if (!k) return;
  const normalized = [...new Set(resources.map(resource).filter((r): r is string => !!r))].slice(0, 64);
  const event: UsageEvent = { version: 1, id: randomUUID(), at: Date.now(), kind: "disclosed", terms: terms(query), resources: normalized, gap };
  await append(wikiRoot, event);
  active.set(k, { id: event.id, at: event.at, resources: new Set(normalized) });
  while (active.size > 256) active.delete(active.keys().next().value!);
}
export async function recordUsageMaterialization(wikiRoot: string, uri: string): Promise<void> {
  if (getActiveWorkspaceContext()?.scope === "read") return;
  const k = key(wikiRoot), normalized = resource(uri);
  const request = k ? active.get(k) : undefined;
  if (!request || !normalized || Date.now() - request.at > 15 * 60_000 || !request.resources.has(normalized)) return;
  await append(wikiRoot, { version: 1, id: request.id, at: Date.now(), kind: "materialized", terms: [], resources: [normalized], gap: false });
  request.resources.delete(normalized);
}
export async function recordUsageFallback(wikiRoot: string): Promise<void> {
  if (getActiveWorkspaceContext()?.scope === "read") return;
  const k = key(wikiRoot), request = k ? active.get(k) : undefined;
  if (!request || Date.now() - request.at > 15 * 60_000) return;
  await append(wikiRoot, { version: 1, id: request.id, at: Date.now(), kind: "fallback", terms: [], resources: [], gap: true });
  active.delete(k!);
}
export async function recordUsageOutcome(wikiRoot: string, outcome: "succeeded" | "failed"): Promise<boolean> {
  if (getActiveWorkspaceContext()?.scope === "read") return false;
  const k = key(wikiRoot), request = k ? active.get(k) : undefined;
  if (!request || Date.now() - request.at > 15 * 60_000) return false;
  await append(wikiRoot, { version: 1, id: request.id, at: Date.now(), kind: outcome, terms: [], resources: [], gap: outcome === "failed" });
  active.delete(k!); return true;
}
export async function usageStatus(wikiRoot: string, reset = false): Promise<Record<string, unknown>> {
  if (reset) {
    await withWikiFileLock(wikiRoot, `${path.resolve(wikiRoot)}:usage`, async () => {
      const filename = await file(wikiRoot);
      await atomicWriteText(filename, "", { durable: false }); cache.delete(filename);
    }, { syncLockFile: false });
    for (const k of active.keys()) if (k.startsWith(`${path.resolve(wikiRoot)}\0`)) active.delete(k);
  }
  const events = await read(wikiRoot);
  return { version: 1, events: events.length, disclosed: events.filter((e) => e.kind === "disclosed").length,
    materialized: events.filter((e) => e.kind === "materialized").length, fallbacks: events.filter((e) => e.kind === "fallback").length,
    outcomes: { succeeded: events.filter((e) => e.kind === "succeeded").length, failed: events.filter((e) => e.kind === "failed").length },
    retentionDays: 180, halfLifeDays: 90, maximumBoost: 0.15, reset };
}
export async function usageWindow(wikiRoot: string, days: number, now = Date.now()): Promise<{ observedSince: string | null; served: Set<string> }> {
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("Usage window must be 1-180 days.");
  const events = (await read(wikiRoot)).filter((event) => event.at <= now && event.at >= now - days * DAY);
  return { observedSince: events.length ? new Date(Math.min(...events.map((event) => event.at))).toISOString() : null,
    served: new Set(events.filter((event) => event.kind === "disclosed").flatMap((event) => event.resources)) };
}
export async function pageUtilities(wikiRoot: string, query: string, now = Date.now()): Promise<Map<string, number>> {
  const queryTerms = new Set(terms(query));
  if (!queryTerms.size) return new Map();
  const events = await read(wikiRoot);
  const disclosed = new Map(events.filter((e) => e.kind === "disclosed").map((e) => [e.id, e]));
  const fallback = new Set(events.filter((e) => e.kind === "fallback" || e.kind === "failed").map((e) => e.id));
  const values = new Map<string, { useful: number; negative: number }>();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== "materialized") continue;
    const request = disclosed.get(event.id);
    if (!request || request.at > now || !request.terms.some((t) => queryTerms.has(t))) continue;
    const overlap = request.terms.filter((t) => queryTerms.has(t)).length / queryTerms.size;
    const weight = overlap * 2 ** (-(now - request.at) / (90 * DAY));
    for (const uri of event.resources) {
      if (!request.resources.includes(uri) || seen.has(`${event.id}\0${uri}`)) continue;
      seen.add(`${event.id}\0${uri}`);
      const value = values.get(uri) ?? { useful: 0, negative: 0 };
      if (fallback.has(event.id)) value.negative += weight;
      else value.useful += weight * (request.gap ? 0.5 : 1);
      values.set(uri, value);
    }
  }
  return new Map([...values].map(([uri, value]) => [uri, Math.max(0, Math.min(1, (value.useful - 2 * value.negative) / 4))]));
}

export async function rerankWithUsage<T extends { path: string; title: string; score: number; channels?: { lexicalRank?: number } }>(
  wikiRoot: string, query: string, hits: T[]
): Promise<void> {
  if (process.env["KNOWLEDGE_RAIL_USAGE_RANKING"] === "0") return;
  const utilities = await pageUtilities(wikiRoot, query).catch(() => new Map<string, number>());
  if (!utilities.size) return;
  const normalized = query.normalize("NFKC").toLowerCase().trim();
  const protectedHit = (hit: T) => hit.channels?.lexicalRank === 1 ||
    hit.title.normalize("NFKC").toLowerCase().includes(normalized) || normalized.includes(hit.path.toLowerCase());
  const movable = hits.filter((hit) => !protectedHit(hit)).map((hit, ordinal) => {
    const utility = utilities.get(wikiPageUri(hit.path)) ?? 0;
    return { hit, ordinal, score: hit.score * (1 + 0.15 * utility), utility };
  }).sort((a, b) => b.score - a.score || a.ordinal - b.ordinal);
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) if (!protectedHit(hits[i]!)) {
    const entry = movable[cursor++]!;
    hits[i] = entry.hit;
    if (entry.utility > 0) Object.assign(hits[i]!, { usageReason: "Previously materialized for similar requests", usageBoost: 0.15 * entry.utility });
  }
}
