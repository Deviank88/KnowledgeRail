import type {
  JSONRPCMessage,
  JSONRPCRequest,
  Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GUIDED_WORKFLOWS,
  MENU_AREAS,
  MENU_OPERATIONS,
  resolveWorkflowTransition,
  type MenuArea,
  type WorkflowOutcome,
} from "../src/mcp/workflows.js";
import { buildServer } from "../src/mcp/server.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

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

  async start(): Promise<void> {
    this.started = true;
  }

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
    "io.modelcontextprotocol/clientInfo": { name: "knowledge-rail-tool-surface-eval", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

interface GoldenCheckpoint {
  completedStepId?: string;
  outcome?: WorkflowOutcome;
  coverageSufficient?: boolean;
  evidenceGaps?: readonly string[];
  expectedNext?: string;
  complete?: true;
}

interface GoldenAgentTrace {
  area: MenuArea;
  operation: string;
  checkpoints: readonly GoldenCheckpoint[];
}

const GOLDEN_AGENT_TRACES: readonly GoldenAgentTrace[] = [
  {
    area: "read",
    operation: "modify",
    checkpoints: [
      { expectedNext: "compile_context" },
      { completedStepId: "compile_context", expectedNext: "read_selected_resources" },
      {
        completedStepId: "read_selected_resources",
        outcome: "coverage_insufficient",
        coverageSufficient: false,
        evidenceGaps: ["truncated_frontier"],
        expectedNext: "widen_context",
      },
      { completedStepId: "widen_context", expectedNext: "read_selected_resources" },
      {
        completedStepId: "read_selected_resources",
        outcome: "coverage_sufficient",
        coverageSufficient: true,
        evidenceGaps: [],
        complete: true,
      },
    ],
  },
  {
    area: "ingest",
    operation: "normalized_source",
    checkpoints: [
      { expectedNext: "plan_source" },
      { completedStepId: "plan_source", expectedNext: "next_segment" },
      { completedStepId: "next_segment", outcome: "more_items", expectedNext: "record_claims" },
      { completedStepId: "record_claims", expectedNext: "link_claims" },
      { completedStepId: "link_claims", expectedNext: "plan_synthesis" },
      { completedStepId: "plan_synthesis", expectedNext: "synthesize" },
      { completedStepId: "synthesize", expectedNext: "next_segment" },
      { completedStepId: "next_segment", outcome: "no_more_items", expectedNext: "check_coverage" },
      {
        completedStepId: "check_coverage",
        outcome: "coverage_insufficient",
        expectedNext: "next_segment",
      },
      { completedStepId: "next_segment", outcome: "no_more_items", expectedNext: "check_coverage" },
      {
        completedStepId: "check_coverage",
        outcome: "coverage_sufficient",
        expectedNext: "finalize_source",
      },
      { completedStepId: "finalize_source", complete: true },
    ],
  },
  {
    area: "code",
    operation: "search",
    checkpoints: [
      { expectedNext: "check_code_index" },
      { completedStepId: "check_code_index", outcome: "blocked", expectedNext: "rebuild_code_index" },
      { completedStepId: "rebuild_code_index", expectedNext: "find_code_evidence" },
      { completedStepId: "find_code_evidence", expectedNext: "read_code_resources" },
      {
        completedStepId: "read_code_resources",
        outcome: "coverage_insufficient",
        expectedNext: "record_code_fallback",
      },
      { completedStepId: "record_code_fallback", complete: true },
    ],
  },
  {
    area: "document",
    operation: "create",
    checkpoints: [
      { expectedNext: "plan_document" },
      { completedStepId: "plan_document", expectedNext: "compile_section_context" },
      { completedStepId: "compile_section_context", expectedNext: "read_section_resources" },
      { completedStepId: "read_section_resources", outcome: "more_items", expectedNext: "compile_section_context" },
      { completedStepId: "read_section_resources", outcome: "no_more_items", expectedNext: "write_document" },
      { completedStepId: "write_document", expectedNext: "review_document" },
      { completedStepId: "review_document", outcome: "findings", expectedNext: "compile_section_context" },
      { completedStepId: "review_document", outcome: "no_findings", complete: true },
    ],
  },
  {
    area: "admin",
    operation: "migrate",
    checkpoints: [
      { expectedNext: "plan_migration" },
      { completedStepId: "plan_migration", outcome: "success", expectedNext: "apply_migration" },
      { completedStepId: "apply_migration", expectedNext: "verify_admin_operation" },
      { completedStepId: "verify_admin_operation", complete: true },
    ],
  },
];

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
  if (!("result" in message)) throw new Error(`Expected MCP result: ${JSON.stringify(message)}`);
  return (message as { result: Record<string, unknown> }).result;
}

async function materializeContextFixture(projectRoot: string): Promise<void> {
  const pages = [
    {
      path: "requirements/ApprovalAudit.md",
      title: "Approval Audit Requirement",
      type: "requirement",
      body: "Every approval records user role, timestamp and motivation in an immutable audit trail. See [[Approval Audit Decision]].",
    },
    {
      path: "decisions/ApprovalAuditDecision.md",
      title: "Approval Audit Decision",
      type: "decision",
      body: "The audit trail is append-only and retained for seven years. See [[Approval Audit Implementation]].",
    },
    {
      path: "implementations/ApprovalAuditImplementation.md",
      title: "Approval Audit Implementation",
      type: "implementation",
      body: "ApprovalAuditWriter persists actor role, UTC timestamp and motivation before acknowledging approval.",
    },
  ];
  await Promise.all(pages.map(async (page) => {
    const target = path.join(projectRoot, "wiki", page.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, [
      "---",
      `title: \"${page.title}\"`,
      `type: ${page.type}`,
      "tags: [approval, audit]",
      "created: 2026-08-14",
      "updated: 2026-08-14",
      "sources: [\"docs/client/approval.md\"]",
      "---",
      "",
      `# ${page.title}`,
      "",
      page.body,
      "",
    ].join("\n"), "utf8");
  }));
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
  return {
    request: (message: JSONRPCRequest) => new Promise<JSONRPCMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(message.id);
        reject(new Error(`Timed out waiting for ${message.method}`));
      }, 5_000);
      timeout.unref();
      waiters.set(message.id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      void peer.send(message).catch(reject);
    }),
    close: async () => {
      await handle.close();
      await peer.close();
    },
  };
}

export interface ToolSurfaceReport {
  modernCatalogBytes: number;
  heuristicCatalogTokens: number;
  reductionVsBaselinePercent: number;
  toolCount: number;
  menuAreaCount: number;
  operationCount: number;
  workflowStepCount: number;
  workflowToolCoverage: number;
  invalidTransitions: number;
  initialChoiceReductionPercent: number;
  guidedChoiceReductionPercent: number;
  maximumOperationChoices: number;
  maximumGuidanceHeuristicTokens: number;
  maximumNextActionCount: number;
  goldenTraceCount: number;
  goldenTraceCheckpointCount: number;
  goldenTraceAccuracy: number;
  branchingOutcomeCheckpointCount: number;
  fullContextResponseBytes: number;
  compactContextResponseBytes: number;
  compactContextReductionPercent: number;
  compactContextEvidenceParity: boolean;
  compactContextGapParity: boolean;
  officialInstructionsAdvertised: boolean;
  menuReadOnly: boolean;
  contextOutputSchemaAdvertised: boolean;
  toolNames: string[];
}

export async function evaluateToolSurface(baselineCatalogBytes = 26_080): Promise<ToolSurfaceReport> {
  const harness = await createHarness();
  const originalRoot = getWikiRoot();
  const contextRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-tool-surface-context-"));
  try {
    const discoverResult = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "tool-surface-discover",
      method: "server/discover",
      params: { _meta: modernMeta() },
    }));
    const listResult = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "tool-surface-list",
      method: "tools/list",
      params: { _meta: modernMeta() },
    }));
    const tools = listResult.tools as Array<{
      name: string;
      outputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }>;
    const toolNames = tools.map((tool) => tool.name).sort();
    const toolNameSet = new Set(toolNames);
    const modernCatalogBytes = Buffer.byteLength(JSON.stringify(listResult), "utf8");
    let workflowStepCount = 0;
    let coveredToolSteps = 0;
    let toolSteps = 0;
    let invalidTransitions = 0;
    let maximumGuidanceBytes = 0;
    let maximumNextActionCount = 0;
    let goldenTraceCheckpointCount = 0;
    let goldenTraceCheckpointMatches = 0;
    let branchingOutcomeCheckpointCount = 0;

    const rootMenu = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "tool-surface-menu-root",
      method: "tools/call",
      params: { name: "knowledge_menu", arguments: {}, _meta: modernMeta() },
    }));
    maximumGuidanceBytes = Buffer.byteLength(JSON.stringify(rootMenu), "utf8");
    const rootStructured = rootMenu.structuredContent as {
      areas?: unknown[];
      next?: { tool?: string; arguments?: { area?: string } };
    } | undefined;
    if (
      rootStructured?.areas?.length !== MENU_AREAS.length ||
      rootStructured.next?.tool !== "knowledge_menu" ||
      rootStructured.next.arguments?.area !== "<chosen area>"
    ) {
      invalidTransitions++;
    }

    for (const workflow of Object.values(GUIDED_WORKFLOWS)) {
      workflowStepCount += workflow.steps.length;
      const reachableStepIds = new Set<string>();
      const pendingStepIds = workflow.steps[0] ? [workflow.steps[0].id] : [];
      let reachableTerminalCount = 0;
      while (pendingStepIds.length > 0) {
        const stepId = pendingStepIds.shift()!;
        if (reachableStepIds.has(stepId)) continue;
        reachableStepIds.add(stepId);
        const transition = resolveWorkflowTransition(workflow, stepId, undefined);
        if (transition.allowedOutcomes.length > 0) {
          for (const outcome of transition.allowedOutcomes) {
            const branch = resolveWorkflowTransition(workflow, stepId, outcome);
            if (branch.complete) reachableTerminalCount++;
            if (branch.next) pendingStepIds.push(branch.next.id);
          }
        } else if (transition.complete) {
          reachableTerminalCount++;
        } else if (transition.next) {
          pendingStepIds.push(transition.next.id);
        }
      }
      if (reachableStepIds.size !== workflow.steps.length || reachableTerminalCount === 0) {
        invalidTransitions++;
      }
      for (const step of workflow.steps) {
        if (step.tool) {
          toolSteps++;
          if (toolNameSet.has(step.tool)) coveredToolSteps++;
        }
        try {
          const transition = resolveWorkflowTransition(workflow, step.id, undefined);
          for (const outcome of transition.allowedOutcomes) {
            const branch = resolveWorkflowTransition(workflow, step.id, outcome);
            if (!branch.complete && !branch.next) invalidTransitions++;
          }
        } catch {
          invalidTransitions++;
        }
      }
    }

    for (const area of MENU_AREAS) {
      const menuResult = resultOf(await harness.request({
        jsonrpc: "2.0",
        id: `tool-surface-menu-${area}`,
        method: "tools/call",
        params: {
          name: "knowledge_menu",
          arguments: { area },
          _meta: modernMeta(),
        },
      }));
      maximumGuidanceBytes = Math.max(
        maximumGuidanceBytes,
        Buffer.byteLength(JSON.stringify(menuResult), "utf8")
      );
      const structured = menuResult.structuredContent as {
        operations?: unknown[];
        next?: { tool?: string; arguments?: { area?: string; operation?: string } };
      } | undefined;
      if (
        structured?.operations?.length !== MENU_OPERATIONS[area].length ||
        structured.next?.tool !== "knowledge_menu" ||
        structured.next.arguments?.area !== area ||
        structured.next.arguments.operation !== "<chosen operation id>"
      ) {
        invalidTransitions++;
      }

      for (const operation of MENU_OPERATIONS[area]) {
        const stepResult = resultOf(await harness.request({
          jsonrpc: "2.0",
          id: `tool-surface-step-${area}-${operation.id}`,
          method: "tools/call",
          params: {
            name: "knowledge_menu",
            arguments: { area, operation: operation.id },
            _meta: modernMeta(),
          },
        }));
        maximumGuidanceBytes = Math.max(
          maximumGuidanceBytes,
          Buffer.byteLength(JSON.stringify(stepResult), "utf8")
        );
        const stepStructured = stepResult.structuredContent as { next?: unknown } | undefined;
        const nextActionCount = stepStructured?.next ? 1 : 0;
        maximumNextActionCount = Math.max(maximumNextActionCount, nextActionCount);
        if (nextActionCount !== 1) invalidTransitions++;
      }
    }

    for (const trace of GOLDEN_AGENT_TRACES) {
      for (const checkpoint of trace.checkpoints) {
        const traceResult = resultOf(await harness.request({
          jsonrpc: "2.0",
          id: `tool-surface-trace-${trace.area}-${trace.operation}-${goldenTraceCheckpointCount}`,
          method: "tools/call",
          params: {
            name: "knowledge_menu",
            arguments: {
              area: trace.area,
              operation: trace.operation,
              ...(checkpoint.completedStepId ? { completed_step_id: checkpoint.completedStepId } : {}),
              ...(checkpoint.outcome ? { outcome: checkpoint.outcome } : {}),
              ...(checkpoint.coverageSufficient !== undefined
                ? { coverage_sufficient: checkpoint.coverageSufficient }
                : {}),
              ...(checkpoint.evidenceGaps ? { evidence_gaps: checkpoint.evidenceGaps } : {}),
            },
            _meta: modernMeta(),
          },
        }));
        const structured = traceResult.structuredContent as {
          next?: { id?: string } | null;
          complete?: boolean;
        } | undefined;
        const matched = checkpoint.complete
          ? structured?.complete === true && structured.next === null
          : structured?.complete === false && structured.next?.id === checkpoint.expectedNext;
        goldenTraceCheckpointCount++;
        if (matched) goldenTraceCheckpointMatches++;
        if (checkpoint.outcome) branchingOutcomeCheckpointCount++;
      }
    }

    await materializeContextFixture(contextRoot);
    clearRetrievalIndexes();
    setWikiRoot(contextRoot);
    const contextArguments = {
      intent: "review",
      objective: "Review approval audit traceability",
      query: "approval audit user role timestamp motivation immutable trail",
      max_evidence: 6,
      heuristic_token_budget: 2_000,
    };
    const fullContext = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "tool-surface-context-full",
      method: "tools/call",
      params: {
        name: "knowledge_context",
        arguments: { ...contextArguments, response_detail: "full" },
        _meta: modernMeta(),
      },
    }));
    const compactContext = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "tool-surface-context-compact",
      method: "tools/call",
      params: {
        name: "knowledge_context",
        arguments: { ...contextArguments, response_detail: "compact" },
        _meta: modernMeta(),
      },
    }));
    const fullContextResponseBytes = Buffer.byteLength(JSON.stringify(fullContext), "utf8");
    const compactContextResponseBytes = Buffer.byteLength(JSON.stringify(compactContext), "utf8");
    const fullStructured = fullContext.structuredContent as {
      evidence?: Array<{ uri?: string }>;
      gaps?: unknown[];
    } | undefined;
    const compactStructured = compactContext.structuredContent as {
      evidence?: Array<{ uri?: string }>;
      gaps?: unknown[];
    } | undefined;
    const fullEvidenceUris = (fullStructured?.evidence ?? []).map((evidence) => evidence.uri).sort();
    const compactEvidenceUris = (compactStructured?.evidence ?? []).map((evidence) => evidence.uri).sort();

    const menu = tools.find((tool) => tool.name === "knowledge_menu");
    const context = tools.find((tool) => tool.name === "knowledge_context");
    return {
      modernCatalogBytes,
      heuristicCatalogTokens: Math.ceil(modernCatalogBytes / 3),
      reductionVsBaselinePercent: ((baselineCatalogBytes - modernCatalogBytes) / baselineCatalogBytes) * 100,
      toolCount: tools.length,
      menuAreaCount: MENU_AREAS.length,
      operationCount: Object.values(MENU_OPERATIONS).reduce((sum, operations) => sum + operations.length, 0),
      workflowStepCount,
      workflowToolCoverage: toolSteps === 0 ? 1 : coveredToolSteps / toolSteps,
      invalidTransitions,
      initialChoiceReductionPercent: ((22 - MENU_AREAS.length) / 22) * 100,
      guidedChoiceReductionPercent: ((22 - 1) / 22) * 100,
      maximumOperationChoices: Math.max(...Object.values(MENU_OPERATIONS).map((items) => items.length)),
      maximumGuidanceHeuristicTokens: Math.ceil(maximumGuidanceBytes / 3),
      maximumNextActionCount,
      goldenTraceCount: GOLDEN_AGENT_TRACES.length,
      goldenTraceCheckpointCount,
      goldenTraceAccuracy: goldenTraceCheckpointCount === 0
        ? 0
        : goldenTraceCheckpointMatches / goldenTraceCheckpointCount,
      branchingOutcomeCheckpointCount,
      fullContextResponseBytes,
      compactContextResponseBytes,
      compactContextReductionPercent: fullContextResponseBytes === 0
        ? 0
        : ((fullContextResponseBytes - compactContextResponseBytes) / fullContextResponseBytes) * 100,
      compactContextEvidenceParity: JSON.stringify(fullEvidenceUris) === JSON.stringify(compactEvidenceUris),
      compactContextGapParity:
        JSON.stringify(fullStructured?.gaps ?? []) === JSON.stringify(compactStructured?.gaps ?? []),
      officialInstructionsAdvertised:
        typeof discoverResult.instructions === "string" && discoverResult.instructions.includes("knowledge_menu"),
      menuReadOnly: menu?.annotations?.readOnlyHint === true,
      contextOutputSchemaAdvertised: context?.outputSchema !== undefined,
      toolNames,
    };
  } finally {
    setWikiRoot(originalRoot);
    clearRetrievalIndexes();
    await fs.rm(contextRoot, { recursive: true, force: true });
    await harness.close();
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await evaluateToolSurface(), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
