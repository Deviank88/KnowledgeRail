import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

const DAY = 86_400_000;
export const AUDIT_DAILY_BYTES = 5 * 1024 * 1024;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_EVENTS = 30_000;
const hash = z.string().regex(/^[a-f0-9]{32}$/);
export const AuditEventSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  at: z.number().int().nonnegative(),
  client: z.enum(["codex", "claude"]),
  phase: z.enum(["session", "turn", "start", "finish"]),
  session: hash.optional(),
  actor: hash,
  turn: hash.optional(),
  correlation: z.enum(["native_turn", "prompt_boundary", "none"]),
  call: hash.optional(),
  category: z.enum(["retrieval", "read", "knowledge_other", "text_search", "file_listing", "shell_other", "edit"]).optional(),
  tool: z.string().regex(/^[a-zA-Z_]{1,64}$/).optional(),
  action: z.string().regex(/^[a-z_]{1,32}$/).optional(),
  outcome: z.enum(["success", "error", "unknown"]).optional(),
  coverage: z.enum(["sufficient", "insufficient", "unknown"]).optional(),
  request: hash.optional(),
  resources: z.array(hash).max(20).optional(),
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditClient = AuditEvent["client"];

/** Fixed project-local location. Neither a tool argument nor a hook payload selects a path. */
export async function usageAuditDirectory(root: string, create = false): Promise<string | undefined> {
  let directory = path.resolve(root);
  for (const component of [".knowledge-rail", "usage-audit"]) {
    directory = path.join(directory, component);
    if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Usage audit directory must be a regular local directory.");
  }
  return directory;
}

export async function readAuditFile(filename: string, maxBytes: number): Promise<string> {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("Unsafe or oversized usage audit file.");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Unsafe or oversized usage audit file.");
    // Bound the read even if another process appends after stat().
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 4096));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error("Oversized usage audit file.");
    if (bytesRead < stat.size) throw new Error("Incomplete usage audit read.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

type Verdict = "knowledge_before_search" | "search_without_prior_knowledge" | "not_verifiable" | "no_text_search";
function scope(event: AuditEvent): string | undefined {
  return event.session && event.turn ? [event.client, event.session, event.actor, event.turn].join(":") : undefined;
}
function callKey(event: AuditEvent): string | undefined {
  return event.session && event.call ? [event.client, event.session, event.actor, event.call].join(":") : undefined;
}

export function summarizeUsageAudit(events: AuditEvent[], options: {
  days: number; now: number; maxTurns: number; issues?: string[];
}) {
  const issues = new Set(options.issues ?? []);
  const seen = new Map<string, AuditEvent>();
  const unique: AuditEvent[] = [];
  let duplicates = 0;
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const key = callKey(event);
    const identity = key && ["start", "finish"].includes(event.phase) ? key + ":" + event.phase : event.id;
    const previous = seen.get(identity);
    if (previous) {
      duplicates++;
      // Duplicate delivery may have a different local observation timestamp/id.
      const comparable = ({ id: _id, at: _at, ...rest }: AuditEvent) => JSON.stringify(rest);
      if (comparable(previous) !== comparable(event)) issues.add("conflicting_duplicate_events");
      continue;
    }
    seen.set(identity, event); unique.push(event);
  }
  unique.sort((a, b) => a.at - b.at);
  const starts = new Map<string, AuditEvent>();
  const finishes = new Map<string, AuditEvent>();
  for (const e of unique) {
    const key = callKey(e);
    if (key && e.phase === "start") starts.set(key, e);
    if (key && e.phase === "finish") finishes.set(key, e);
  }
  const groups = new Map<string, AuditEvent[]>();
  let uncorrelatedEvents = 0;
  for (const e of unique) {
    if (e.phase === "session") continue;
    const key = scope(e);
    if (!key) { uncorrelatedEvents++; continue; }
    const group = groups.get(key) ?? []; group.push(e); groups.set(key, group);
  }
  const turns = [...groups.values()].map(group => {
    const first = group[0]!;
    const retrievals = group.filter(e => e.phase === "finish" && e.category === "retrieval");
    const reads = group.filter(e => e.phase === "finish" && e.category === "read");
    const searches = group.filter(e => e.phase === "start" && e.category === "text_search");
    const orphanSearches = group.filter(e => e.phase === "finish" && e.category === "text_search" && (!callKey(e) || !starts.has(callKey(e)!)));
    const results = searches.map(search => {
      const key = callKey(search);
      const finish = key ? finishes.get(key) : undefined;
      const reasons: string[] = [];
      if (!group.some(e => e.phase === "turn" && e.at <= search.at)) reasons.push("missing_turn_boundary");
      if (!finish) reasons.push("search_completion_not_observed");
      else if (scope(finish) !== scope(search) || finish.category !== search.category || finish.at < search.at) reasons.push("search_correlation_mismatch");
      if (issues.size) reasons.push("incomplete_or_conflicting_observations");
      const prior = retrievals.filter(e => e.at < search.at);
      const pairedRetrieval = (e: AuditEvent) => {
        const start = callKey(e) ? starts.get(callKey(e)!) : undefined;
        return start && start.category === "retrieval" && scope(start) === scope(e) && start.at <= e.at;
      };
      const successful = prior.filter(e => e.outcome === "success" && pairedRetrieval(e));
      const uncertain = prior.some(e => e.outcome === "unknown" || !e.outcome ||
        (e.outcome === "success" && !pairedRetrieval(e)));
      const unfinished = group.some(e => e.phase === "start" && e.category === "retrieval" && e.at <= search.at &&
        (!callKey(e) || !finishes.has(callKey(e)!)));
      const sameTime = retrievals.some(e => e.at === search.at);
      let verdict: Verdict = "not_verifiable";
      if (reasons.length === 0) {
        if (successful.length) verdict = "knowledge_before_search";
        else if (uncertain || unfinished || sameTime) reasons.push("retrieval_outcome_or_order_unknown");
        else verdict = "search_without_prior_knowledge";
      }
      const latest = successful.at(-1);
      return { call: search.call ?? null, startedAt: new Date(search.at).toISOString(), verdict,
        priorRetrievalAttempts: prior.length, priorSuccessfulRetrievals: successful.length,
        priorFailedRetrievals: prior.filter(e => e.outcome === "error").length,
        priorSuccessfulReads: reads.filter(e => e.outcome === "success" && e.at < search.at).length,
        latestRetrieval: latest ? { call: latest.call ?? null, request: latest.request ?? null,
          at: new Date(latest.at).toISOString(), coverage: latest.coverage ?? "unknown" } : null,
        reasons };
    });
    const verdict: Verdict = orphanSearches.length || results.some(r => r.verdict === "not_verifiable") ? "not_verifiable"
      : results.some(r => r.verdict === "search_without_prior_knowledge") ? "search_without_prior_knowledge"
      : results.length ? "knowledge_before_search" : "no_text_search";
    return { client: first.client, session: first.session!, actor: first.actor, turn: first.turn!,
      correlation: first.correlation, startedAt: new Date(first.at).toISOString(), verdict,
      retrievals: retrievals.length, successfulRetrievals: retrievals.filter(e => e.outcome === "success").length,
      successfulReads: reads.filter(e => e.outcome === "success").length,
      resourceIds: [...new Set(reads.filter(e => e.outcome === "success").flatMap(e => e.resources ?? []))].slice(0, 20),
      textSearches: searches.length + orphanSearches.length, orphanSearches: orphanSearches.length,
      searches: results.slice(0, 20), omittedSearches: Math.max(0, results.length - 20) };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const summary = {
    turns: turns.length,
    knowledgeBeforeSearch: turns.filter(t => t.verdict === "knowledge_before_search").length,
    searchWithoutPriorKnowledge: turns.filter(t => t.verdict === "search_without_prior_knowledge").length,
    notVerifiable: turns.filter(t => t.verdict === "not_verifiable").length,
    noTextSearch: turns.filter(t => t.verdict === "no_text_search").length,
    retrievals: unique.filter(e => e.phase === "finish" && e.category === "retrieval").length,
    reads: unique.filter(e => e.phase === "finish" && e.category === "read").length,
    uncorrelatedEvents,
  };
  return {
    version: 1, generatedAt: new Date(options.now).toISOString(), days: options.days,
    observationStatus: unique.length === 0 ? (issues.size ? "incomplete" : "not_observed")
      : issues.size || uncorrelatedEvents || summary.notVerifiable ? "incomplete" : "observed",
    source: "project_local_native_hooks", events: unique.length, duplicates,
    firstObservedAt: unique.length ? new Date(unique[0]!.at).toISOString() : null,
    lastObservedAt: unique.length ? new Date(unique.at(-1)!.at).toISOString() : null,
    summary, issues: [...issues], turns: turns.slice(0, options.maxTurns), omittedTurns: Math.max(0, turns.length - options.maxTurns),
    limits: [
      "Attests locally observed calls and ordering; not comprehension, quality, or tamper-proof certification.",
      "Scope is a native turn or observed prompt boundary, not a semantic task; context reused across turns is not inferred.",
      "Knowledge must complete successfully before a text search starts; incomplete/empty retrievals remain attempts with separate coverage.",
      "Text searches may be valid targeted checks or output filters; this report does not label them policy violations.",
      "Missing/disabled hooks, failures not emitted by the client and dynamic shell scripts may leave gaps; no events is not zero usage.",
      "Reads cover observed knowledge_page/code read calls; direct MCP resources/read outside those hooks is not attributed. Resource identifiers are hashed.",
      "No prompts, commands, source contents or outputs are retained. Admin/audit calls do not qualify as retrieval.",
    ],
  };
}

export async function usageAudit(root: string, options: { days?: number; maxTurns?: number; client?: AuditClient } = {}) {
  const days = options.days ?? 7, maxTurns = options.maxTurns ?? 20, now = Date.now();
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) {
    throw new Error("Usage audit requires days=1..30 and maxTurns=1..100.");
  }
  const events: AuditEvent[] = [], issues = new Set<string>();
  let bytes = 0;
  try {
    const directory = await usageAuditDirectory(root);
    if (directory) {
      const cutoff = now - days * DAY;
      const names = (await fs.readdir(directory)).filter(n => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n) &&
        n.slice(0, 10) >= new Date(cutoff).toISOString().slice(0, 10)).sort().reverse();
      for (const name of names) {
        if (bytes >= MAX_READ_BYTES || events.length >= MAX_EVENTS) { issues.add("read_limit_reached"); break; }
        let raw: string;
        try { raw = await readAuditFile(path.join(directory, name), Math.min(AUDIT_DAILY_BYTES, MAX_READ_BYTES - bytes)); }
        catch { issues.add("unreadable_or_oversized_file"); continue; }
        bytes += Buffer.byteLength(raw);
        for (const line of raw.split("\n").filter(Boolean)) {
          if (events.length >= MAX_EVENTS) { issues.add("read_limit_reached"); break; }
          let value: unknown;
          try { value = JSON.parse(line); } catch { issues.add("invalid_events"); continue; }
          const parsed = AuditEventSchema.safeParse(value);
          if (!parsed.success) { issues.add("invalid_events"); continue; }
          const event = parsed.data;
          if (event.at > now) { issues.add("future_event_timestamp"); continue; }
          if (event.at < cutoff || (options.client && event.client !== options.client)) continue;
          events.push(event);
        }
      }
    }
  } catch { issues.add("observation_store_unavailable"); }
  return summarizeUsageAudit(events, { days, now, maxTurns, issues: [...issues] });
}
