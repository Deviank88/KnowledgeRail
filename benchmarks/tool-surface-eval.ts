import type { JSONRPCMessage, JSONRPCRequest, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

const ROUTING_STOP_WORDS = new Set([
  "and", "before", "for", "from", "into", "its", "one", "the", "this", "to", "with",
  "che", "come", "dei", "del", "della", "delle", "dopo", "gli", "il", "la", "le", "lo", "nel", "per", "una",
]);

const ROUTING_CONCEPTS: Record<string, string> = {
  caller: "callers",
  callers: "callers",
  contesto: "context",
  dependencies: "dependency",
  dependency: "dependency",
  evidenze: "evidence",
  elimina: "delete",
  files: "file",
  grafo: "graph",
  leggi: "read",
  elenca: "list",
  missing: "gaps",
  irrilevante: "irrelevant",
  cerca: "search",
  classifica: "classify",
  modifica: "edit",
  modificare: "modify",
  page: "page",
  pages: "page",
  pagine: "page",
  pagina: "page",
  processing: "ingest",
  rinnovo: "renewal",
  scrivi: "write",
  segmenti: "segment",
  segmento: "segment",
};

function tokens(text: string): Set<string> {
  const raw = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[_/=-]/g, " ").match(/[a-z0-9]+/g) ?? [];
  return new Set(raw
    .filter((token) => token.length > 2 && !ROUTING_STOP_WORDS.has(token))
    .map((token) => ROUTING_CONCEPTS[token] ?? token));
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

export interface ToolSurfaceBaseline {
  benchmarkSchemaVersion: number;
  previousToolCount: number;
  previousToolsArrayBytes: number;
  previousToolsListResultBytes: number;
  previousRoutingCallsPerWorkflow: number;
  currentRoutingCallsPerWorkflow: number;
  expectedToolCount: number;
  maximumModernCatalogBytes: number;
  maximumHeuristicCatalogTokens: number;
  minimumToolCountReductionPercent: number;
  minimumCatalogByteReductionPercent: number;
  minimumToolsListResultByteReductionPercent: number;
  minimumRoutingGoldenCount: number;
  minimumCatalogAffordanceAccuracy: number;
  minimumInvalidCallCount: number;
  minimumInvalidCallRejectionRate: number;
  minimumWorkflowTraceCount: number;
  minimumWorkflowCompletionRate: number;
  minimumRoutingRoundTripsSaved: number;
  minimumRoutingRoundTripReductionPercent: number;
  requiredToolNames: string[];
  forbiddenToolNames: string[];
}

export async function loadToolSurfaceBaseline(): Promise<ToolSurfaceBaseline> {
  const baselineUrl = new URL("./fixtures/tool-surface-baseline-v4.json", import.meta.url);
  return JSON.parse(await fs.readFile(fileURLToPath(baselineUrl), "utf8")) as ToolSurfaceBaseline;
}

interface ToolSurfaceLanguagePolicy {
  forbiddenItalianTerms: string[];
}

async function loadToolSurfaceLanguagePolicy(): Promise<ToolSurfaceLanguagePolicy> {
  const policyUrl = new URL("./fixtures/tool-surface-language-policy.json", import.meta.url);
  return JSON.parse(await fs.readFile(fileURLToPath(policyUrl), "utf8")) as ToolSurfaceLanguagePolicy;
}

function languageViolations(tools: readonly CatalogTool[], policy: ToolSurfaceLanguagePolicy): string[] {
  const catalogTokens = new Set(
    JSON.stringify(tools).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z]+/g) ?? []
  );
  return policy.forbiddenItalianTerms.filter((term) => catalogTokens.has(
    term.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  ));
}

const ROUTING_GOLDENS = [
  ["Before I change lease renewal, gather the relevant project evidence and tell me what is missing", "knowledge_context", "task"],
  ["Prima di modificare i lease, recupera il contesto utile e segnala ciò che non sappiamo", "knowledge_context", "task"],
  ["Show me the catalog of requirement pages already available", "knowledge_context", "list"],
  ["Elenca le pagine che descrivono requisiti e decisioni", "knowledge_context", "list"],
  ["Find passages that mention fencing after a lease expires", "knowledge_context", "search"],
  ["Cerca dove si parla del rinnovo dei lease", "knowledge_context", "search"],
  ["Show dependencies connecting this requirement to its implementation", "knowledge_context", "graph"],
  ["Create a new canonical page for the renewal policy", "knowledge_page", "write"],
  ["Modifica una frase nella pagina della decisione", "knowledge_page", "edit"],
  ["Rename the incident page while keeping incoming links valid", "knowledge_page", "move"],
  ["Elimina la pagina obsoleta dalla memoria del progetto", "knowledge_page", "delete"],
  ["Record this decision in the durable change log", "knowledge_page", "append_log"],
  ["Which controlled source files are waiting to be processed?", "knowledge_files", "list"],
  ["Convert this uploaded PDF into controlled Markdown", "knowledge_files", "normalize"],
  ["Leggi il file cliente senza modificarlo", "knowledge_files", "read"],
  ["Begin processing the normalized contract source", "knowledge_ingest", "start"],
  ["Integrate these extracted claims from the current segment", "knowledge_ingest", "apply_claims"],
  ["Classifica questo segmento come irrilevante e conserva il motivo", "knowledge_ingest", "record_segment"],
  ["Check source coverage before closing ingestion", "knowledge_ingest", "source_status"],
  ["Show unresolved evidence debt and claim contradictions", "knowledge_ingest", "evidence_status"],
  ["Locate the definition of renewLease in the repository", "knowledge_code", "symbol"],
  ["Find every caller of the selected symbol", "knowledge_code", "references"],
  ["Recreate the code index from the current source tree", "knowledge_code", "rebuild"],
  ["Design the outline for a technical architecture deliverable", "knowledge_document_context", "plan"],
  ["Gather evidence for the Security section of the document", "knowledge_document_context", "section"],
  ["Save this architecture proposal as a Markdown deliverable", "knowledge_document", "write"],
  ["Check whether the deliverable satisfies its required sections", "knowledge_document", "review"],
  ["Review an evidence-backed compliance note for final delivery readiness", "knowledge_document", "review"],
  ["Bootstrap KnowledgeRail in this repository", "knowledge_admin", "init"],
  ["Validate the knowledge base for broken links and orphan pages", "knowledge_admin", "lint"],
  ["Upgrade the stored knowledge format without losing project data", "knowledge_admin", "migrate"],
] as const;

function routeFromCatalog(task: string, tools: readonly CatalogTool[]): { tool: string; discriminator?: string } {
  const taskTokens = tokens(task);
  const ranked = tools.map((tool, index) => ({
    tool,
    index,
    score: overlap(taskTokens, tokens([
      tool.name,
      tool.title ?? "",
      tool.description ?? "",
      ...Object.values(tool.inputSchema.properties ?? {}).flatMap((property) => [
        property.description ?? "",
        ...(property.enum ?? []),
      ]),
    ].join(" "))),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0]!.tool;
  const property = selected.inputSchema.properties?.action ?? selected.inputSchema.properties?.mode;
  const discriminator = property?.enum?.map((value, index) => ({
    value,
    index,
    score: overlap(taskTokens, tokens([
      value,
      property.description?.split(";").find((segment) => segment.trim().startsWith(`${value}=`)) ?? "",
    ].join(" "))),
  })).sort((left, right) => right.score - left.score || left.index - right.index)[0]?.value;
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
  toolsListResultBytes: number;
  heuristicCatalogTokens: number;
  previousToolCount: number;
  previousToolsArrayBytes: number;
  previousToolsListResultBytes: number;
  toolCountReductionPercent: number;
  catalogByteReductionPercent: number;
  toolsListResultByteReductionPercent: number;
  routingRoundTripsSaved: number;
  routingRoundTripReductionPercent: number;
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
  catalogLanguageViolations: string[];
}

export async function evaluateToolSurface(
  suppliedBaseline?: ToolSurfaceBaseline
): Promise<ToolSurfaceReport> {
  const baseline = suppliedBaseline ?? await loadToolSurfaceBaseline();
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
    const catalogLanguageViolations = languageViolations(tools, await loadToolSurfaceLanguagePolicy());
    const toolsListResultBytes = Buffer.byteLength(JSON.stringify(listed), "utf8");
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
      ["knowledge_ingest", { action: "apply_claims", normalized_filename: "source.md", segment_id: "seg-missing" }],
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
    const segment = structuredOf(first).segment as { id?: string } | undefined;
    const segmentId = segment?.id;
    let ingestComplete = nextOf(started)?.action === "next" && Boolean(segmentId);
    if (segmentId) {
      const applied = await call("knowledge_ingest", {
        action: "apply_claims",
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
      const status = await call("knowledge_ingest", { action: "source_status", normalized_filename: "lease.md" });
      const finalized = await call("knowledge_ingest", { action: "finalize", normalized_filename: "lease.md" });
      ingestComplete = ingestComplete && nextOf(applied)?.action === "next" &&
        nextOf(after)?.action === "source_status" && nextOf(status)?.action === "finalize" &&
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
      nextOf(reviewed) === null && structuredOf(reviewed).state === "document_reviewed");

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
      toolsListResultBytes,
      heuristicCatalogTokens: Math.ceil(modernCatalogBytes / 3),
      previousToolCount: baseline.previousToolCount,
      previousToolsArrayBytes: baseline.previousToolsArrayBytes,
      previousToolsListResultBytes: baseline.previousToolsListResultBytes,
      toolCountReductionPercent: Number(((1 - tools.length / baseline.previousToolCount) * 100).toFixed(2)),
      catalogByteReductionPercent: Number(((1 - modernCatalogBytes / baseline.previousToolsArrayBytes) * 100).toFixed(2)),
      toolsListResultByteReductionPercent: Number(
        ((1 - toolsListResultBytes / baseline.previousToolsListResultBytes) * 100).toFixed(2)
      ),
      routingRoundTripsSaved:
        (baseline.previousRoutingCallsPerWorkflow - baseline.currentRoutingCallsPerWorkflow) * traces.length,
      routingRoundTripReductionPercent: Number(
        ((1 - baseline.currentRoutingCallsPerWorkflow / baseline.previousRoutingCallsPerWorkflow) * 100).toFixed(2)
      ),
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
      catalogLanguageViolations,
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
