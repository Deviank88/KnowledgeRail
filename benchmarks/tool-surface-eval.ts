import type { JSONRPCMessage, JSONRPCRequest, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";

const MODERN_VERSION = "2026-07-28";
type RpcId = string | number;

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;
  private started = false;
  private closed = false;

  async start(): Promise<void> { this.started = true; }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || !this.peer?.started || this.peer.closed) {
      throw new Error("Memory transport is not open.");
    }
    const peer = this.peer;
    queueMicrotask(() => peer.onmessage?.(structuredClone(message)));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function linkedPair(): [MemoryTransport, MemoryTransport] {
  const left = new MemoryTransport();
  const right = new MemoryTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "knowledge-rail-agent-surface-eval", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function createHarness() {
  const [peer, wire] = linkedPair();
  const waiters = new Map<RpcId, (message: JSONRPCMessage) => void>();
  peer.onmessage = (message) => {
    if ("id" in message && message.id !== undefined) {
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  };
  await peer.start();
  const handle = serveStdio((context) => buildServer(context), { transport: wire, legacy: "serve" });
  let sequence = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> =>
    new Promise((resolve, reject) => {
      const id = `agent-surface-${++sequence}`;
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5_000);
      timeout.unref();
      waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      const message: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };
      void peer.send(message).catch(reject);
    });
  return {
    request,
    close: async () => { await handle.close(); await peer.close(); },
  };
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
  if (!("result" in message)) throw new Error(`Expected MCP result: ${JSON.stringify(message)}`);
  return (message as { result: Record<string, unknown> }).result;
}

function textOf(result: Record<string, unknown>): string {
  return (result.content as Array<{ type?: string; text?: string }> | undefined)
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n") ?? "";
}

function structuredOf(result: Record<string, unknown>): Record<string, unknown> {
  return result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown>
    : {};
}

function nextOf(result: Record<string, unknown>): Record<string, unknown> | null {
  const next = structuredOf(result).nextAction;
  return next && typeof next === "object" ? next as Record<string, unknown> : null;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[_/=-]/g, " ").match(/[a-z0-9]+/g) ?? []);
}

function overlap(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) if (right.has(token)) score++;
  return score;
}

interface CatalogTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, { enum?: string[]; description?: string }> };
}

const ROUTING_GOLDENS = [
  ["Retrieve bounded project knowledge with explicit coverage and gaps", "knowledge_context", "task"],
  ["Search project knowledge as a lexical diagnostic", "knowledge_context", "search"],
  ["Run a graph traceability diagnostic", "knowledge_context", "graph"],
  ["Write a canonical knowledge page", "knowledge_page", "write"],
  ["Append the durable page mutation log", "knowledge_page", "append_log"],
  ["List controlled source files in docs", "knowledge_files", "list"],
  ["Normalize a source file without changing the original", "knowledge_files", "normalize"],
  ["Start the guided source evidence integration loop", "knowledge_ingest", "start"],
  ["Apply evidence claims and synthesize agent memory", "knowledge_ingest", "apply"],
  ["Search deterministic code evidence", "knowledge_code", "search"],
  ["Rebuild the code index", "knowledge_code", "rebuild"],
  ["Plan an evidence backed typed document", "knowledge_document_context", "plan"],
  ["Compile the bounded context for a document section", "knowledge_document_context", "section"],
  ["Write a Markdown deliverable", "knowledge_document", "write"],
  ["Export a reviewed document to DOCX", "knowledge_document", "export"],
  ["Init KnowledgeRail storage", "knowledge_admin", "init"],
  ["Lint canonical knowledge", "knowledge_admin", "lint"],
  ["Plan a conservative data migrate operation", "knowledge_admin", "migrate"],
] as const;

function routeFromCatalog(task: string, tools: readonly CatalogTool[]): { tool: string; discriminator?: string } {
  const taskTokens = tokens(task);
  const ranked = tools.map((tool) => ({
    tool,
    score: overlap(taskTokens, tokens(`${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`)),
  })).sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
  const selected = ranked[0]!.tool;
  const property = selected.inputSchema.properties?.action ?? selected.inputSchema.properties?.mode;
  const discriminator = property?.enum?.map((value) => ({
    value,
    score: overlap(taskTokens, tokens([
      value,
      property.description?.split(";").find((segment) => segment.trim().startsWith(`${value}=`)) ?? "",
    ].join(" "))),
  })).sort((left, right) => right.score - left.score || left.value.localeCompare(right.value))[0]?.value;
  return { tool: selected.name, discriminator };
}

async function materializeContextFixture(projectRoot: string): Promise<void> {
  const file = path.join(projectRoot, "wiki", "requirements", "ApprovalAudit.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "docs", "client"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "docs", "client", "approval.md"), "approved source", "utf8");
  await fs.writeFile(file, [
    "---",
    'title: "Approval audit"',
    "type: requirement",
    "tags: [approval, audit]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    'sources: ["docs/client/approval.md"]',
    "---",
    "",
    "# Approval audit",
    "",
    "Every approval records user role, timestamp and motivation in an immutable audit trail.",
  ].join("\n"), "utf8");
}

export interface ToolSurfaceReport {
  toolCount: number;
  toolNames: string[];
  modernCatalogBytes: number;
  heuristicCatalogTokens: number;
  previousToolCount: number;
  previousCatalogBytes: number;
  toolCountReductionPercent: number;
  catalogByteReductionPercent: number;
  menuRemoved: boolean;
  legacyAliasesRemoved: boolean;
  officialInstructionsAdvertised: boolean;
  routingGoldenCount: number;
  catalogAffordanceAccuracy: number;
  routingFailures: string[];
  invalidCallCount: number;
  invalidCallRejectionRate: number;
  workflowTraceCount: number;
  workflowCompletionRate: number;
  compactContextEvidenceParity: boolean;
  compactContextGapParity: boolean;
  defaultContextIsCompact: boolean;
}

export async function evaluateToolSurface(): Promise<ToolSurfaceReport> {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-agent-surface-"));
  clearRetrievalIndexes();
  setWikiRoot(projectRoot);
  const harness = await createHarness();
  const call = async (name: string, args: Record<string, unknown>) => resultOf(await harness.request("tools/call", {
    name,
    arguments: args,
    _meta: modernMeta(),
  }));
  try {
    const listed = resultOf(await harness.request("tools/list", { _meta: modernMeta() }));
    const tools = listed.tools as CatalogTool[];
    const modernCatalogBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    const toolNames = tools.map((tool) => tool.name).sort();
    const discover = resultOf(await harness.request("server/discover", { _meta: modernMeta() }));
    const instructions = String(discover.instructions ?? "");

    const routingFailures: string[] = [];
    const routed = ROUTING_GOLDENS.filter(([task, expectedTool, expectedDiscriminator]) => {
      const actual = routeFromCatalog(task, tools);
      const correct = actual.tool === expectedTool && actual.discriminator === expectedDiscriminator;
      if (!correct) {
        routingFailures.push(`${task}: expected ${expectedTool}/${expectedDiscriminator}, got ${actual.tool}/${actual.discriminator ?? "none"}`);
      }
      return correct;
    }).length;

    const invalidCalls = [
      ["knowledge_page", { action: "edit", path: "analysis/A.md" }],
      ["knowledge_ingest", { action: "apply", normalized_filename: "source.md", segment_id: "seg-missing" }],
      ["knowledge_code", { action: "record_fallback", query: "raw lookup" }],
      ["knowledge_document", { action: "export", filename: "x", document_type: "custom" }],
      ["knowledge_admin", { action: "migrate", migration_action: "rollback" }],
    ] as const;
    let rejected = 0;
    for (const [name, args] of invalidCalls) {
      const response = await harness.request("tools/call", { name, arguments: args, _meta: modernMeta() });
      if ("error" in response || ("result" in response && (response.result as { isError?: boolean }).isError)) rejected++;
    }

    const traces: boolean[] = [];
    const initialized = await call("knowledge_admin", { action: "init" });
    traces.push(nextOf(initialized)?.tool === "knowledge_context");
    await materializeContextFixture(projectRoot);

    const pageContent = [
      "---",
      'title: "Agent surface"',
      "type: analysis",
      "tags: [agent-surface]",
      "created: 2026-08-15",
      "updated: 2026-08-15",
      'sources: ["docs/client/approval.md"]',
      "---",
      "",
      "# Agent surface",
      "",
      "The public surface guides agents through one deterministic next action.",
    ].join("\n");
    const page = await call("knowledge_page", {
      action: "write", path: "analysis/AgentSurface.md", content: pageContent,
    });
    traces.push(nextOf(page)?.tool === "knowledge_admin" && nextOf(page)?.action === "lint");

    const normalized = "Lease renewal requires explicit approval and an audit timestamp.";
    await fs.writeFile(path.join(projectRoot, "docs", "normalized", "lease.md"), normalized, "utf8");
    const started = await call("knowledge_ingest", { action: "start", normalized_filename: "lease.md" });
    const first = await call("knowledge_ingest", { action: "next", normalized_filename: "lease.md" });
    const segmentId = textOf(first).match(/Segmento: `([^`]+)`/)?.[1];
    let ingestComplete = nextOf(started)?.action === "next" && Boolean(segmentId);
    if (segmentId) {
      const applied = await call("knowledge_ingest", {
        action: "apply",
        normalized_filename: "lease.md",
        segment_id: segmentId,
        claims: [{
          text: normalized,
          kind: "requirement",
          origin: "explicit",
          confidence: 1,
          target: { page_path: "requirements/LeaseRenewal.md", page_title: "Lease renewal", page_type: "requirement" },
        }],
      });
      const after = await call("knowledge_ingest", { action: "next", normalized_filename: "lease.md" });
      const status = await call("knowledge_ingest", { action: "status", normalized_filename: "lease.md" });
      const finalized = await call("knowledge_ingest", { action: "finalize", normalized_filename: "lease.md" });
      ingestComplete = ingestComplete && nextOf(applied)?.action === "next" &&
        nextOf(after)?.action === "status" && nextOf(status)?.action === "finalize" &&
        structuredOf(finalized).state === "source_finalized";
    }
    traces.push(ingestComplete);

    const plan = await call("knowledge_document_context", { action: "plan", document_type: "custom" });
    const written = await call("knowledge_document", {
      action: "write",
      filename: "agent-surface.md",
      title: "Agent surface",
      document_type: "custom",
      content: "# Agent surface\n\n## Purpose\n\nThis reviewed document explains the agent-oriented tool surface with enough concrete detail for maintainers and users.",
    });
    const reviewed = await call("knowledge_document", {
      action: "review", filename: "agent-surface.md", document_type: "custom",
    });
    traces.push(nextOf(plan)?.action === "section" && nextOf(written)?.action === "review" &&
      ["write", "export"].includes(String(nextOf(reviewed)?.action)));

    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "lease.ts"), "export function renewLease(): boolean { return true; }\n", "utf8");
    const rebuilt = await call("knowledge_code", { action: "rebuild" });
    const codeStatus = await call("knowledge_code", { action: "status" });
    traces.push(nextOf(rebuilt)?.action === "status" && structuredOf(codeStatus).state === "code_status_complete");

    const contextArgs = {
      mode: "task",
      intent: "review",
      objective: "Review approval audit traceability",
      query: "user role timestamp motivation immutable audit",
      max_evidence: 4,
      heuristic_token_budget: 1_500,
    };
    const compact = await call("knowledge_context", contextArgs);
    const full = await call("knowledge_context", { ...contextArgs, response_detail: "full" });
    const compactStructured = structuredOf(compact);
    const fullStructured = structuredOf(full);
    const compactEvidence = (compactStructured.evidence as Array<{ path?: string }> | undefined)?.map((item) => item.path) ?? [];
    const fullEvidence = (fullStructured.evidence as Array<{ path?: string }> | undefined)?.map((item) => item.path) ?? [];

    return {
      toolCount: tools.length,
      toolNames,
      modernCatalogBytes,
      heuristicCatalogTokens: Math.ceil(modernCatalogBytes / 3),
      previousToolCount: 24,
      previousCatalogBytes: 19_926,
      toolCountReductionPercent: Number(((1 - tools.length / 24) * 100).toFixed(2)),
      catalogByteReductionPercent: Number(((1 - modernCatalogBytes / 19_926) * 100).toFixed(2)),
      menuRemoved: !toolNames.includes("knowledge_menu"),
      legacyAliasesRemoved: !toolNames.some((name) => name.startsWith("wiki_")),
      officialInstructionsAdvertised: instructions.includes("eight KnowledgeRail domain tools") &&
        instructions.includes("knowledge_context mode=task") && instructions.includes("nextAction"),
      routingGoldenCount: ROUTING_GOLDENS.length,
      catalogAffordanceAccuracy: routed / ROUTING_GOLDENS.length,
      routingFailures,
      invalidCallCount: invalidCalls.length,
      invalidCallRejectionRate: rejected / invalidCalls.length,
      workflowTraceCount: traces.length,
      workflowCompletionRate: traces.filter(Boolean).length / traces.length,
      compactContextEvidenceParity: JSON.stringify(compactEvidence) === JSON.stringify(fullEvidence),
      compactContextGapParity: JSON.stringify(compactStructured.gaps ?? []) === JSON.stringify(fullStructured.unknowns ?? []),
      defaultContextIsCompact: !("currentState" in compactStructured),
    };
  } finally {
    await harness.close();
    clearRetrievalIndexes();
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await evaluateToolSurface(), null, 2)}\n`);
}

if (process.argv[1]?.endsWith("tool-surface-eval.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
