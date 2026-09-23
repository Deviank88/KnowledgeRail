import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteText } from "../core/fs-service.js";
import { AUDIT_DAILY_BYTES, AuditEventSchema, readAuditFile, usageAuditDirectory,
  type AuditClient, type AuditEvent } from "../core/usage-audit.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function response(value: unknown): RecordValue | undefined {
  if (typeof value === "string" && value.length <= 4 * 1024 * 1024) {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return record(value);
}
function category(item: ObservationClassification): AuditEvent["category"] {
  if (item.category !== "knowledge") return item.category;
  if ((item.tool === "knowledge_context" && ["task", "search", "graph"].includes(item.action ?? "task")) ||
    (item.tool === "knowledge_code" && ["search", "symbol", "references"].includes(item.action ?? ""))) return "retrieval";
  if (["knowledge_page", "knowledge_code"].includes(item.tool) && item.action === "read") return "read";
  return "knowledge_other";
}
export interface ObservationClassification {
  category: "knowledge" | "text_search" | "file_listing" | "shell_other" | "edit";
  tool: string;
  action?: string;
}

/** Called by native hooks, never by a model-facing "I used knowledge" operation. */
export async function observeUsage(root: string, client: AuditClient, phase: AuditEvent["phase"],
  payload: RecordValue, item?: ObservationClassification): Promise<void> {
  const directory = (await usageAuditDirectory(root, true))!;
  const digest = (value: string) => createHash("sha256").update(client + ":" + value).digest("hex").slice(0, 32);
  const string = (key: string) => typeof payload[key] === "string" && payload[key] ? payload[key] as string : undefined;
  const session = string("session_id") ? digest(string("session_id")!) : undefined;
  const actor = digest(string("agent_id") ?? "main");
  const at = Date.now();
  const event: AuditEvent = { version: 1, id: randomUUID(), at, client, phase, session, actor, correlation: "none" };
  const boundary = session ? path.join(directory, `.boundary-${session}-${actor}.json`) : undefined;
  if (string("turn_id")) {
    event.turn = digest(string("turn_id")!); event.correlation = "native_turn";
  } else if (phase === "turn") {
    event.turn = digest(randomUUID()); event.correlation = "prompt_boundary";
  } else if (boundary && phase !== "session") {
    try {
      const saved = JSON.parse(await readAuditFile(boundary, 4096)) as { turn?: unknown; at?: unknown };
      if (typeof saved.turn === "string" && /^[a-f0-9]{32}$/.test(saved.turn) && typeof saved.at === "number" &&
        saved.at <= at && at - saved.at <= 24 * 60 * 60_000) {
        event.turn = saved.turn; event.correlation = "prompt_boundary";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (phase === "session" && boundary) await fs.unlink(boundary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (phase === "turn" && boundary) await atomicWriteText(boundary, JSON.stringify({ at, turn: event.turn }), { durable: false });
  if (item) {
    event.category = category(item); event.tool = item.tool;
    if (item.action) event.action = item.action;
    if (string("tool_use_id")) event.call = digest(string("tool_use_id")!);
    if (phase === "finish" && item.category === "knowledge") {
      // Only explicit MCP structure is interpreted. Opaque/text-only results stay unknown.
      const result = response(payload.tool_response);
      const data = record(result?.structuredContent) ?? (typeof result?.state === "string" ? result : undefined);
      event.outcome = result?.isError === true || data?.state === "blocked" ? "error"
        : result && (Array.isArray(result.content) || data) ? "success" : "unknown";
      const retrieval = record(data?.retrieval);
      event.coverage = retrieval?.coverageSufficient === true ? "sufficient"
        : retrieval?.coverageSufficient === false ? "insufficient" : "unknown";
      if (typeof data?.requestId === "string") event.request = digest(data.requestId);
      const resources: string[] = [];
      const add = (value: unknown) => {
        if (typeof value === "string" && /^(code:\/\/repo\/|knowledge-rail:\/\/page\/)/.test(value)) resources.push(digest(value));
      };
      for (const list of [data?.evidence, data?.hits, data?.references, result?.content]) {
        if (Array.isArray(list)) for (const candidate of list.slice(0, 20)) {
          const r = record(candidate); add(r?.uri ?? r?.resourceUri);
        }
      }
      if (event.category === "read" && event.outcome === "success") {
        const input = record(payload.tool_input);
        add(record(data?.read)?.uri ?? input?.resource_uri);
        if (item.tool === "knowledge_page" && typeof input?.path === "string") add("knowledge-rail://page/" + input.path);
      }
      event.resources = [...new Set(resources)].slice(0, 20);
    }
  }
  const line = JSON.stringify(AuditEventSchema.parse(event)) + "\n";
  const filename = path.join(directory, new Date(at).toISOString().slice(0, 10) + ".jsonl");
  const existing = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Usage audit file must be a regular local file.");
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size + Buffer.byteLength(line) > AUDIT_DAILY_BYTES) throw new Error("Usage audit daily limit reached.");
    await handle.writeFile(line);
  } finally { await handle.close(); }
  if (phase === "session") {
    const cutoff = at - 30 * 86_400_000;
    for (const name of await fs.readdir(directory)) {
      if ((/^\d{4}-\d\d-\d\d\.jsonl$/.test(name) && name.slice(0, 10) < new Date(cutoff).toISOString().slice(0, 10)) ||
        (/^\.boundary-[a-f0-9]{32}-[a-f0-9]{32}\.json$/.test(name) && (await fs.lstat(path.join(directory, name))).mtimeMs < cutoff)) {
        await fs.unlink(path.join(directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    }
  }
}
