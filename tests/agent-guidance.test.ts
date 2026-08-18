import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { DEFAULT_SCHEMA_MD } from "../src/config/templates.js";
import {
  MCP_AGENT_INSTRUCTIONS,
  USER_OUTPUT_LANGUAGE_POLICY,
} from "../src/mcp/server.js";
import { AGENT_TOOL_NAMES } from "../src/mcp/tool-names.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";

type Handler = (args: Record<string, unknown>, context: Record<string, never>) => Promise<{
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

interface Registered {
  config: { inputSchema: { safeParse(value: unknown): { success: boolean } } };
  handler: Handler;
}

function capture(): { server: McpServer; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Handler) {
      tools.set(name, { config, handler });
      return {};
    },
  } as unknown as McpServer;
  return { server, tools };
}

test("public catalog exposes exactly eight domain tools and no menu or operation aliases", () => {
  const { server, tools } = capture();
  registerAgentTools(server, "modern");
  assert.deepEqual([...tools.keys()].sort(), Object.values(AGENT_TOOL_NAMES).sort());
  assert.equal(tools.size, 8);
  assert.equal(tools.has("knowledge_menu"), false);
  assert.equal([...tools.keys()].some((name) => name.startsWith("wiki_")), false);
});

test("English MCP metadata does not force English wiki output", () => {
  for (const policy of [DEFAULT_SCHEMA_MD, USER_OUTPUT_LANGUAGE_POLICY, MCP_AGENT_INSTRUCTIONS]) {
    assert.match(policy, /language of the user(?:'s current request|'s request)/i);
    assert.match(policy, /preserve (?:its|the existing page) language/i);
    assert.match(policy, /ask before writing/i);
  }
  assert.doesNotMatch(DEFAULT_SCHEMA_MD, /Write all wiki pages in English by default/i);
  assert.match(USER_OUTPUT_LANGUAGE_POLICY, /tool names, schemas, control files, and operational messages in English/i);
});

test("action schemas reject incomplete calls before an operation can mutate state", () => {
  const { server, tools } = capture();
  registerAgentTools(server, "modern");
  const page = tools.get("knowledge_page")!.config.inputSchema;
  const ingest = tools.get("knowledge_ingest")!.config.inputSchema;
  const code = tools.get("knowledge_code")!.config.inputSchema;
  const taskContext = tools.get("knowledge_context")!.config.inputSchema;
  const documentContext = tools.get("knowledge_document_context")!.config.inputSchema;
  const document = tools.get("knowledge_document")!.config.inputSchema;
  const admin = tools.get("knowledge_admin")!.config.inputSchema;

  assert.equal(page.safeParse({ action: "edit", path: "a.md" }).success, false);
  assert.equal(page.safeParse({ action: "read", path: "a.md", resource_uri: "knowledge-rail://page/a.md" }).success, false);
  assert.equal(document.safeParse({ action: "review", filename: "report.docx", document_type: "custom" }).success, false);
  assert.equal(ingest.safeParse({ action: "apply_claims", normalized_filename: "a.md", segment_id: "seg-x" }).success, false);
  assert.equal(ingest.safeParse({ action: "record_segment", normalized_filename: "a.md", segment_id: "seg-x" }).success, false);
  assert.equal(code.safeParse({ action: "record_fallback", query: "x" }).success, false);
  assert.equal(admin.safeParse({ action: "drift", scope: "paths" }).success, false);
  assert.equal(admin.safeParse({ action: "drift", scope: "paths", paths: ["src"] }).success, true);
  assert.equal(page.safeParse({ action: "delete", path: "a.md" }).success, true);
  assert.equal(taskContext.safeParse({ mode: "task", objective: "Explain OrderService" }).success, true);
  assert.equal(taskContext.safeParse({ mode: "task", objective: "x".repeat(4_097) }).success, false);
  assert.equal(documentContext.safeParse({
    action: "plan",
    document_type: "custom",
    objective: "x".repeat(4_097),
  }).success, false);
});

test("tool results provide one machine-readable next action without a menu round trip", async () => {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-agent-guidance-"));
  try {
    setWikiRoot(projectRoot);
    const { server, tools } = capture();
    registerAgentTools(server, "modern");
    const emptyContext = {};

    const initialized = await tools.get("knowledge_admin")!.handler(
      { action: "init", force: false },
      emptyContext
    );
    assert.equal(initialized.isError, undefined);
    assert.deepEqual(initialized.structuredContent?.nextAction, {
      tool: "knowledge_context",
      requiredArguments: ["mode", "objective"],
      suggestedArguments: { mode: "task" },
    });
    const drift = await tools.get("knowledge_admin")!.handler({ action: "drift" }, emptyContext);
    assert.equal(drift.structuredContent?.state, "drift_complete");
    assert.equal(drift.structuredContent?.nextAction, null);
    assert.deepEqual(
      (drift.structuredContent?.summary as { checkedAnchors?: number; driftSuspected?: number }),
      {
        checkedAt: (drift.structuredContent?.summary as { checkedAt?: string }).checkedAt,
        scope: "all",
        paths: [],
        totalAnchors: 0,
        checkedAnchors: 0,
        fresh: 0,
        driftSuspected: 0,
        anchorUnresolvable: 0,
        topDrifted: [],
        recommendedClaimIds: [],
      }
    );
    await fs.writeFile(path.join(projectRoot, "docs", "client", "source.md"), "verified source", "utf8");

    const page = [
      "---",
      'title: "Agent guidance"',
      "type: analysis",
      "tags: [agent]",
      "created: 2026-08-15",
      "updated: 2026-08-15",
      'sources: ["docs/client/source.md"]',
      "---",
      "",
      "# Agent guidance",
      "",
      "KnowledgeRail returns a deterministic next action after mutations.",
    ].join("\n");
    const written = await tools.get("knowledge_page")!.handler(
      { action: "write", path: "analysis/AgentGuidance.md", content: page },
      emptyContext
    );
    assert.equal(written.isError, undefined);
    assert.deepEqual(written.structuredContent?.nextAction, {
      tool: "knowledge_admin",
      action: "lint",
      requiredArguments: ["action"],
      suggestedArguments: { action: "lint" },
    });
    const text = written.content?.map((item) => item.text ?? "").join("\n") ?? "";
    assert.equal(text.includes("wiki_"), false);
    assert.match(text, /Next: knowledge_admin action=lint/);

    const read = await tools.get("knowledge_page")!.handler(
      { action: "read", path: "analysis/AgentGuidance.md", max_chars: 6_000 },
      emptyContext
    );
    assert.equal(read.isError, undefined);
    assert.match(String(read.structuredContent?.resultText), /deterministic next action/);

    const incomplete = await tools.get("knowledge_context")!.handler(
      {
        mode: "task",
        intent: "understand",
        objective: "Explain a missing quantum spacecraft subsystem",
        query: "quantum spacecraft subsystem",
        retrieval_profile: "coverage",
        max_evidence: 8,
        heuristic_token_budget: 12_000,
        response_detail: "compact",
      },
      emptyContext
    );
    assert.equal(incomplete.structuredContent?.state, "context_incomplete");
    assert.equal(incomplete.structuredContent?.nextAction, null);
    assert.match(String(incomplete.structuredContent?.guidance), /report those gaps/);
    assert.match(incomplete.content?.map((item) => item.text ?? "").join("\n") ?? "", /Guidance: .*report those gaps/);
  } finally {
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
