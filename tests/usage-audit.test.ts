import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { AuditEventSchema, summarizeUsageAudit, usageAudit, type AuditEvent } from "../src/core/usage-audit.js";
import { observeUsage } from "../src/runtime/usage-observer.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { isMutatingDomainCall } from "../src/http/request-workspace.js";

const now = Date.now();
const h = (n: number) => n.toString(16).padStart(32, "0");
function event(at: number, patch: Partial<AuditEvent> = {}): AuditEvent {
  return { version: 1, id: randomUUID(), at: now - 10_000 + at, client: "codex", session: h(1), actor: h(2),
    turn: h(3), correlation: "native_turn", phase: "turn", ...patch };
}
const retrieval = (at: number, patch: Partial<AuditEvent> = {}) => event(at, {
  phase: "finish", category: "retrieval", tool: "knowledge_context", action: "task", call: h(10), outcome: "success", ...patch,
});
const search = (at: number, patch: Partial<AuditEvent> = {}) => event(at, {
  phase: "start", category: "text_search", tool: "Bash", call: h(20), ...patch,
});
const summarize = (events: AuditEvent[], issues?: string[]) => summarizeUsageAudit(events, { now, days: 7, maxTurns: 20, issues });

test("audit attests completed retrieval before search start and preserves gaps separately", () => {
  const r = summarize([event(0), retrieval(5, { phase: "start" }), retrieval(10, { coverage: "insufficient", resources: [h(30)] }),
    event(20, { phase: "finish", category: "read", outcome: "success", call: h(11), resources: [h(30)] }),
    search(30), search(40, { phase: "finish" })]);
  assert.equal(r.summary.knowledgeBeforeSearch, 1);
  assert.equal(r.turns[0]!.searches[0]!.latestRetrieval?.coverage, "insufficient");
  assert.equal(r.turns[0]!.searches[0]!.priorSuccessfulReads, 1);
  assert.deepEqual(r.turns[0]!.resourceIds, [h(30)]);
});

test("completion order cannot conceal a search started before knowledge completed", () => {
  const r = summarize([event(0), search(10), retrieval(20), search(30, { phase: "finish" })]);
  assert.equal(r.summary.searchWithoutPriorKnowledge, 1);
  assert.equal(r.turns[0]!.searches[0]!.priorSuccessfulRetrievals, 0);
});

test("errors and admin calls do not qualify as successful retrieval", () => {
  const r = summarize([event(0), retrieval(5, { category: "knowledge_other", tool: "knowledge_admin", action: "usage", call: h(9) }),
    retrieval(10, { outcome: "error" }), search(20), search(30, { phase: "finish" })]);
  assert.equal(r.summary.searchWithoutPriorKnowledge, 1);
  assert.equal(r.turns[0]!.searches[0]!.priorFailedRetrievals, 1);
});

test("missing boundaries, missing completions, timestamp ties and opaque outcomes stay unverified", () => {
  for (const events of [
    [event(0), retrieval(10), search(20), search(30, { phase: "finish" })],
    [retrieval(10), search(20), search(30, { phase: "finish" })],
    [event(40), retrieval(10), search(20), search(30, { phase: "finish" })],
    [event(0), retrieval(10), search(20)],
    [event(0), retrieval(10), search(20, { phase: "finish" })],
    [event(0), retrieval(10), search(10), search(30, { phase: "finish" })],
    [event(0), retrieval(10, { outcome: "unknown" }), search(20), search(30, { phase: "finish" })],
    [event(0), retrieval(10, { phase: "start", outcome: undefined }), search(20), search(30, { phase: "finish" })],
  ]) assert.equal(summarize(events).summary.notVerifiable, 1);
});

test("session, client, actor and turn boundaries cannot borrow another retrieval", () => {
  for (const patch of [{ session: h(4) }, { client: "claude" as const }, { actor: h(5) }, { turn: h(6) }]) {
    const r = summarize([event(0), retrieval(10, patch), search(20), search(30, { phase: "finish" })]);
    assert.equal(r.summary.searchWithoutPriorKnowledge, 1);
    assert.equal(r.summary.knowledgeBeforeSearch, 0);
  }
  assert.equal(summarize([retrieval(10, { session: undefined }), search(20, { session: undefined })]).summary.uncorrelatedEvents, 2);
});

test("duplicates do not inflate counts; conflicting duplicates and corrupt streams prevent attestation", () => {
  const read = retrieval(10);
  const events = [event(0), retrieval(5, { phase: "start" }), read, { ...read, id: randomUUID(), at: read.at + 1 }, search(20), search(30, { phase: "finish" })];
  const r = summarize(events);
  assert.equal(r.duplicates, 1); assert.equal(r.summary.retrievals, 1); assert.equal(r.summary.knowledgeBeforeSearch, 1);
  assert.equal(summarize([...events, { ...read, outcome: "error" }]).summary.notVerifiable, 1);
  assert.equal(summarize(events, ["invalid_events"]).summary.notVerifiable, 1);
  assert.equal(summarize([]).observationStatus, "not_observed");
});

test("reordered duplicate starts and retrievals crossing turns cannot manufacture knowledge-first ordering", () => {
  const events = [event(0), retrieval(5, { phase: "start" }), search(10), retrieval(20), search(30, { phase: "finish" })];
  const reordered = [search(25), ...events];
  assert.equal(summarize(reordered).summary.searchWithoutPriorKnowledge, 1);
  const crossing = [event(0), retrieval(5, { phase: "start", turn: h(4) }), retrieval(10), search(20), search(30, { phase: "finish" })];
  assert.equal(summarize(crossing).summary.knowledgeBeforeSearch, 0);
  assert.equal(summarize(crossing).summary.notVerifiable, 1);
});

test("observer keeps hashes and explicit results only, and isolates Claude prompt boundaries", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-audit-observe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = { session_id: "PRIVATE_SESSION", prompt: "PRIVATE_PROMPT", tool_use_id: "PRIVATE_CALL" };
  await observeUsage(root, "claude", "turn", payload);
  await observeUsage(root, "claude", "finish", { ...payload,
    tool_input: { objective: "PRIVATE_TASK" }, tool_response: { structuredContent: { state: "context_incomplete",
      retrieval: { coverageSufficient: false }, evidence: [{ uri: "code://repo/PRIVATE_FILE#PRIVATE_SYMBOL" }] },
      content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } }, { category: "knowledge", tool: "knowledge_context", action: "task" });
  await observeUsage(root, "claude", "turn", { ...payload, agent_id: "PRIVATE_CHILD" });
  await observeUsage(root, "claude", "start", { ...payload, agent_id: "PRIVATE_CHILD" }, { category: "text_search", tool: "Bash" });
  const directory = path.join(root, ".knowledge-rail/usage-audit");
  const raw = await fs.readFile(path.join(directory, new Date().toISOString().slice(0, 10) + ".jsonl"), "utf8");
  assert.doesNotMatch(raw, /PRIVATE/);
  const events = raw.trim().split("\n").map(line => AuditEventSchema.parse(JSON.parse(line)));
  assert.equal(events[0]!.turn, events[1]!.turn);
  assert.notEqual(events[0]!.actor, events[2]!.actor);
  assert.notEqual(events[0]!.turn, events[2]!.turn);
  assert.equal(events[1]!.coverage, "insufficient");
  assert.equal(events[1]!.outcome, "success");
  assert.equal(events[1]!.resources?.length, 1);
  await observeUsage(root, "claude", "session", payload);
  await observeUsage(root, "claude", "start", payload, { category: "text_search", tool: "Bash" });
  assert.equal((await usageAudit(root)).summary.uncorrelatedEvents, 1);
});

test("native turn ids, explicit MCP errors and text-only results retain correct semantics", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-audit-results-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = { category: "knowledge" as const, tool: "knowledge_code", action: "search" };
  for (const [id, output] of [["a", { isError: true, content: [] }], ["b", "success"], ["c", JSON.stringify({ structuredContent: { requestId: "private-id" }, content: [] })]] as const) {
    await observeUsage(root, "codex", "finish", { session_id: "session", turn_id: "native", tool_use_id: id, tool_response: output }, item);
  }
  const filename = path.join(root, ".knowledge-rail/usage-audit", new Date().toISOString().slice(0, 10) + ".jsonl");
  const events = (await fs.readFile(filename, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.outcome), ["error", "unknown", "success"]);
  assert.ok(events.every(e => e.correlation === "native_turn"));
});

test("reader is read-only, bounds data, exposes corruption and rejects symlinked stores", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-audit-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await usageAudit(root)).observationStatus, "not_observed");
  assert.deepEqual(await fs.readdir(root), []);
  const directory = path.join(root, ".knowledge-rail/usage-audit");
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, new Date().toISOString().slice(0, 10) + ".jsonl");
  await fs.writeFile(filename, "{broken\n" + JSON.stringify(event(0)) + "\n");
  const r = await usageAudit(root);
  assert.equal(r.observationStatus, "incomplete"); assert.ok(r.issues.includes("invalid_events"));
  await fs.rm(directory, { recursive: true }); await fs.symlink(os.tmpdir(), directory, process.platform === "win32" ? "junction" : "dir");
  assert.ok((await usageAudit(root)).issues.includes("observation_store_unavailable"));
  await assert.rejects(() => observeUsage(root, "codex", "session", {}), /regular local directory/);
});

test("public audit is available on the existing tool, validates options and leaves status unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-audit-tool-"));
  const previous = getWikiRoot(); setWikiRoot(root);
  t.after(async () => { setWikiRoot(previous); await fs.rm(root, { recursive: true, force: true }); });
  type Handler = (args: object, context: object) => Promise<{ isError?: boolean; structuredContent?: Record<string, any> }>;
  const handlers = new Map<string, Handler>();
  registerAgentTools({ registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler) } as unknown as McpServer);
  const admin = handlers.get("knowledge_admin")!;
  const r = await admin({ action: "usage", options: { action: "audit" } }, {});
  assert.equal(r.structuredContent?.state, "usage_audit_complete");
  assert.equal(r.structuredContent?.audit.observationStatus, "not_observed");
  assert.equal(isMutatingDomainCall("knowledge_admin", { action: "usage", options: { action: "audit" } }), false);
  for (const options of [{ action: "audit", days: 31 }, { action: "audit", max_turns: 0 }, { action: "audit", path: "/etc" }]) {
    assert.equal((await admin({ action: "usage", options }, {})).isError, true);
  }
  const status = await admin({ action: "usage", options: { action: "status" } }, {});
  assert.equal(status.structuredContent?.state, "usage_status_complete");
  assert.equal(status.structuredContent?.usage.events, 0);
  assert.equal(handlers.size, 8);
});
