import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { readWikiResource } from "../src/context/resource-reader.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { AGENT_TOOL_NAMES } from "../src/mcp/tool-names.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";

type Schema = {
  safeParse(value: unknown): { success: boolean };
};

type OutputSchema = {
  "~standard": {
    validate(value: unknown): Promise<{ issues?: unknown[] }> | { issues?: unknown[] };
  };
};

type ToolResult = {
  content?: Array<{ type: string; text?: string; uri?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type Handler = (args: Record<string, unknown>, context: Record<string, never>) => Promise<ToolResult>;

interface Registered {
  config: {
    inputSchema: Schema;
    outputSchema?: OutputSchema;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
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

function text(result: ToolResult): string {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}

async function withProject(run: (projectRoot: string, tools: Map<string, Registered>) => Promise<void>): Promise<void> {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-agent-contract-"));
  try {
    setWikiRoot(projectRoot);
    const { server, tools } = capture();
    registerAgentTools(server, "modern");
    await tools.get("knowledge_admin")!.handler({ action: "init", force: false }, {});
    await run(projectRoot, tools);
  } finally {
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

test("all public tools advertise a permissive guided output envelope and conservative annotations", async () => {
  const { server, tools } = capture();
  registerAgentTools(server, "modern");
  assert.deepEqual([...tools.keys()].sort(), Object.values(AGENT_TOOL_NAMES).sort());

  for (const [name, tool] of tools) {
    assert.ok(tool.config.outputSchema, `${name} has no output schema`);
    const validation = await tool.config.outputSchema!["~standard"].validate({ state: "example", nextAction: null });
    assert.equal(validation.issues, undefined);
    assert.equal(tool.config.annotations?.openWorldHint, false, `${name} must advertise a closed knowledge domain`);
  }

  for (const name of ["knowledge_context", "knowledge_document_context"]) {
    assert.equal(tools.get(name)!.config.annotations?.readOnlyHint, true);
    assert.equal(tools.get(name)!.config.annotations?.destructiveHint, false);
  }
  for (const name of ["knowledge_page", "knowledge_files", "knowledge_ingest", "knowledge_code", "knowledge_document", "knowledge_admin"]) {
    assert.equal(tools.get(name)!.config.annotations?.readOnlyHint, false);
    assert.equal(tools.get(name)!.config.annotations?.destructiveHint, true);
  }
});

test("context separates bounded page listing from query-required search", () => {
  const { server, tools } = capture();
  registerAgentTools(server, "modern");
  const schema = tools.get("knowledge_context")!.config.inputSchema;
  assert.equal(schema.safeParse({ mode: "search" }).success, false);
  assert.equal(schema.safeParse({ mode: "search", query: "lease fencing" }).success, true);
  assert.equal(schema.safeParse({ mode: "list" }).success, true);
});

test("ingest validates compact advertised records with the full claim and recovery contracts", () => {
  const { server, tools } = capture();
  registerAgentTools(server, "modern");
  const schema = tools.get("knowledge_ingest")!.config.inputSchema;
  assert.equal(schema.safeParse({
    action: "apply_claims",
    normalized_filename: "source.md",
    segment_id: "seg-1",
    claims: [{ text: "A claim", kind: "not-a-kind", origin: "explicit", confidence: 1 }],
  }).success, false);
  assert.equal(schema.safeParse({
    action: "record_recovery",
    total_evidence_used: 1,
    recovery_events: [{ evidence_ref: "e", source_uri: "s", discovered_by: "unknown", reason: "r" }],
  }).success, false);
});

test("page, file and code reads preserve legacy-looking user bytes and page read remains editable", async () => {
  await withProject(async (projectRoot, tools) => {
    await fs.mkdir(path.join(projectRoot, "docs", "client"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "docs", "client", "literal.txt"),
      "Run wiki_lint before wiki_append_log.\n",
      "utf8"
    );
    const page = [
      "---",
      'title: "Literal references"',
      "type: analysis",
      "tags: [contract]",
      "created: 2026-08-15",
      "updated: 2026-08-15",
      'sources: ["docs/client/literal.txt"]',
      "---",
      "",
      "# Literal references",
      "",
      "Run wiki_lint before wiki_append_log.",
    ].join("\n");

    const write = await tools.get("knowledge_page")!.handler({
      action: "write",
      path: "analysis/LiteralReferences.md",
      content: page,
    }, {});
    assert.equal(write.isError, undefined);

    const read = await tools.get("knowledge_page")!.handler({
      action: "read",
      path: "analysis/LiteralReferences.md",
      max_chars: 6_000,
    }, {});
    const resource = await readWikiResource({
      wikiRoot: path.join(projectRoot, "wiki"),
      path: "analysis/LiteralReferences.md",
      maxCharacters: 6_000,
    });
    const expected = `# ${resource.title}\n\n${resource.text}`;
    assert.equal(text(read), expected);
    assert.equal(read.structuredContent?.resultText, expected);
    assert.match(text(read), /wiki_lint before wiki_append_log/);

    const edited = await tools.get("knowledge_page")!.handler({
      action: "edit",
      path: "analysis/LiteralReferences.md",
      old_string: "Run wiki_lint before wiki_append_log.",
      new_string: "Run wiki_lint exactly once before wiki_append_log.",
      replace_all: false,
    }, {});
    assert.equal(edited.isError, undefined, text(edited));
    assert.match(await fs.readFile(path.join(projectRoot, "wiki", "analysis", "LiteralReferences.md"), "utf8"), /wiki_lint exactly once/);

    const fileRead = await tools.get("knowledge_files")!.handler({
      action: "read",
      category: "client",
      path: "literal.txt",
    }, {});
    assert.equal(text(fileRead), "Run wiki_lint before wiki_append_log.\n");

    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "src", "literal.ts"),
      'export function legacyLiteral(): string { return "wiki_lint"; }\n',
      "utf8"
    );
    await tools.get("knowledge_code")!.handler({ action: "rebuild" }, {});
    const found = await tools.get("knowledge_code")!.handler({ action: "symbol", symbol: "legacyLiteral" }, {});
    const hits = found.structuredContent?.hits as Array<{ resourceUri: string }>;
    assert.equal(hits.length, 1);
    const codeRead = await tools.get("knowledge_code")!.handler({
      action: "read",
      resource_uri: hits[0]!.resourceUri,
      max_chars: 6_000,
    }, {});
    assert.match(text(codeRead), /return "wiki_lint"/);
  });
});

test("ingest guidance derives queue and coverage transitions from structured fields", async () => {
  await withProject(async (projectRoot, tools) => {
    await fs.writeFile(
      path.join(projectRoot, "docs", "normalized", "queue.md"),
      "This source is intentionally irrelevant to the project.\n",
      "utf8"
    );
    const ingest = tools.get("knowledge_ingest")!;
    const started = await ingest.handler({ action: "start", normalized_filename: "queue.md" }, {});
    assert.equal(started.structuredContent?.state, "ingest_started");

    const next = await ingest.handler({ action: "next", normalized_filename: "queue.md" }, {});
    assert.equal(next.structuredContent?.state, "segment_ready");
    assert.equal(next.structuredContent?.queueEmpty, false);
    const segment = next.structuredContent?.segment as { id?: string };
    assert.ok(segment.id);
    assert.equal((next.structuredContent?.nextAction as { action?: string }).action, "apply_claims");

    const recorded = await ingest.handler({
      action: "record_segment",
      normalized_filename: "queue.md",
      segment_id: segment.id,
      segment_status: "irrelevant",
      reason: "No project knowledge is present.",
    }, {});
    assert.equal(recorded.structuredContent?.state, "segment_classified");

    const empty = await ingest.handler({ action: "next", normalized_filename: "queue.md" }, {});
    assert.equal(empty.structuredContent?.state, "source_queue_empty");
    assert.equal(empty.structuredContent?.queueEmpty, true);
    assert.equal((empty.structuredContent?.nextAction as { action?: string }).action, "source_status");

    const coverage = await ingest.handler({ action: "source_status", normalized_filename: "queue.md" }, {});
    assert.equal(coverage.structuredContent?.state, "coverage_complete");
    assert.equal(coverage.structuredContent?.readyForFinalization, true);
    assert.equal((coverage.structuredContent?.nextAction as { action?: string }).action, "finalize");
  });
});

test("evidence status retains both structured payloads and empty code lookup has a distinct state", async () => {
  await withProject(async (_projectRoot, tools) => {
    const status = await tools.get("knowledge_ingest")!.handler({ action: "evidence_status" }, {});
    assert.equal(status.structuredContent?.state, "evidence_status_ready");
    assert.equal(typeof status.structuredContent?.evidence, "object");
    assert.equal(typeof status.structuredContent?.recovery, "object");

    const missing = await tools.get("knowledge_code")!.handler({
      action: "search",
      query: "symbol that cannot possibly exist",
    }, {});
    assert.equal(missing.structuredContent?.state, "code_no_matches");
    assert.match(text(missing), /Guidance: No indexed match was found/);
  });
});

test("dry-run page move reports a preview and does not request lint", async () => {
  await withProject(async (projectRoot, tools) => {
    await fs.mkdir(path.join(projectRoot, "docs", "client"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "docs", "client", "move.md"), "source", "utf8");
    const content = [
      "---",
      'title: "Move preview"',
      "type: analysis",
      "tags: [preview]",
      "created: 2026-08-15",
      "updated: 2026-08-15",
      'sources: ["docs/client/move.md"]',
      "---",
      "",
      "# Move preview",
      "",
      "No mutation should occur.",
    ].join("\n");
    await tools.get("knowledge_page")!.handler({ action: "write", path: "analysis/Move.md", content }, {});
    const preview = await tools.get("knowledge_page")!.handler({
      action: "move",
      old_path: "analysis/Move.md",
      new_path: "analysis/Moved.md",
      dry_run: true,
    }, {});
    assert.equal(preview.structuredContent?.state, "page_move_preview");
    assert.equal(preview.structuredContent?.nextAction, null);
    await fs.access(path.join(projectRoot, "wiki", "analysis", "Move.md"));
    await assert.rejects(fs.access(path.join(projectRoot, "wiki", "analysis", "Moved.md")), /ENOENT/);
  });
});

test("public page, file and graph actions retain their domain states", async () => {
  await withProject(async (projectRoot, tools) => {
    await fs.writeFile(path.join(projectRoot, "docs", "client", "raw.md"), "# Raw source\n\nVerified input.\n", "utf8");
    const normalized = await tools.get("knowledge_files")!.handler({
      action: "normalize",
      category: "client",
      path: "raw.md",
      overwrite: true,
    }, {});
    assert.equal(normalized.structuredContent?.state, "source_normalized");
    assert.equal((normalized.structuredContent?.nextAction as { action?: string }).action, "start");
    await fs.access(path.join(projectRoot, "docs", "normalized", "client_raw.md"));

    const page = [
      "---",
      'title: "Graph node"',
      "type: analysis",
      "tags: [graph]",
      "created: 2026-08-15",
      "updated: 2026-08-15",
      'sources: ["docs/client/raw.md"]',
      "---",
      "",
      "# Graph node",
      "",
      "A verified graph node.",
    ].join("\n");
    await tools.get("knowledge_page")!.handler({ action: "write", path: "analysis/GraphNode.md", content: page }, {});
    const graph = await tools.get("knowledge_context")!.handler({
      mode: "graph",
      query: "verified graph node",
      max_nodes: 4,
      max_depth: 1,
      view: "subgraph",
    }, {});
    assert.equal(graph.structuredContent?.state, "graph_complete");

    const moved = await tools.get("knowledge_page")!.handler({
      action: "move",
      old_path: "analysis/GraphNode.md",
      new_path: "analysis/MovedGraphNode.md",
      dry_run: false,
    }, {});
    assert.equal(moved.structuredContent?.state, "page_updated");
    const logged = await tools.get("knowledge_page")!.handler({
      action: "append_log",
      entry: "Moved the graph-node fixture.",
      level: "ACTION",
    }, {});
    assert.equal(logged.structuredContent?.state, "page_updated");
    assert.match(await fs.readFile(path.join(projectRoot, "wiki", "log.md"), "utf8"), /Moved the graph-node fixture/);
    const deleted = await tools.get("knowledge_page")!.handler({
      action: "delete",
      path: "analysis/MovedGraphNode.md",
    }, {});
    assert.equal(deleted.structuredContent?.state, "page_updated");
    await assert.rejects(fs.access(path.join(projectRoot, "wiki", "analysis", "MovedGraphNode.md")), /ENOENT/);
  });
});

test("public report, recovery and document actions preserve guidance through completion", async () => {
  await withProject(async (projectRoot, tools) => {
    const sections = [
      ["Contesto richiesta", "A verified request defines the intended behavior."],
      ["Modifiche funzionali", "The behavior is updated and independently verifiable."],
      ["Data model", "Nessuna modifica al data model."],
      ["Automazioni", "Nessuna modifica alle automazioni."],
      ["Integrazioni/API", "Nessuna modifica a integrazioni o API."],
      ["UI/UX", "Nessuna modifica UI/UX."],
      ["Permessi/Sicurezza", "Nessuna modifica a permessi o sicurezza."],
      ["Test", "Regression test executed in the isolated fixture with PASS result."],
      ["Changelog", "Nessun changelog richiesto per questa fixture verificata."],
      ["Impatto documentale", "Nessun impatto documentale oltre alla fixture corrente."],
      ["Gap/Ambiguità", "Nessun gap noto dopo la verifica automatizzata."],
    ];
    const report = [
      "# Development Report - TEST-1",
      "",
      "> **Cliente:** Test",
      "> **Progetto:** KnowledgeRail",
      "> **Request ID:** TEST-1",
      "",
      ...sections.flatMap(([heading, body]) => [`## ${heading}`, body, ""]),
    ].join("\n");
    await fs.writeFile(path.join(projectRoot, "docs", "reports", "TEST-1.md"), report, "utf8");
    const prepared = await tools.get("knowledge_ingest")!.handler({
      action: "report",
      report_filename: "TEST-1.md",
    }, {});
    assert.equal(prepared.structuredContent?.state, "report_prepared");
    assert.equal((prepared.structuredContent?.nextAction as { tool?: string }).tool, "knowledge_page");

    const recovery = await tools.get("knowledge_ingest")!.handler({
      action: "record_recovery",
      total_evidence_used: 1,
      recovery_events: [{
        evidence_ref: "code://repo/src/late.ts",
        source_uri: "code://repo/src/late.ts",
        discovered_by: "source_fallback",
        reason: "The fact was found outside the represented wiki context.",
      }],
    }, {});
    assert.equal(recovery.structuredContent?.state, "recovery_updated", text(recovery));
    const event = (recovery.structuredContent?.events as Array<{ id: string }>)[0]!;
    const resolved = await tools.get("knowledge_ingest")!.handler({
      action: "resolve_recovery",
      recovery_event_id: event.id,
      recovery_resolution: "intentionally_ignored",
      recovery_reason: "Fixture event has no durable project value.",
    }, {});
    assert.equal(resolved.structuredContent?.state, "recovery_updated");

    const content = "# Contract fixture\n\n## Purpose\n\nThis document verifies the complete public document workflow.";
    const written = await tools.get("knowledge_document")!.handler({
      action: "write",
      filename: "contract-fixture.md",
      title: "Contract fixture",
      document_type: "custom",
      required_sections: ["Purpose"],
      diagram_mode: "none",
      content,
      overwrite: true,
    }, {});
    assert.equal(written.structuredContent?.state, "document_written");
    assert.deepEqual(
      (written.structuredContent?.nextAction as { suggestedArguments?: Record<string, unknown> }).suggestedArguments?.required_sections,
      ["Purpose"]
    );
    const reviewed = await tools.get("knowledge_document")!.handler({
      action: "review",
      filename: "contract-fixture.md",
      document_type: "custom",
      required_sections: ["Purpose"],
      diagram_mode: "none",
      include_wiki_update_plan: false,
    }, {});
    assert.equal(reviewed.structuredContent?.state, "document_reviewed");
    assert.equal(reviewed.structuredContent?.nextAction, null);
    assert.match(String(reviewed.structuredContent?.contentSha256), /^[a-f0-9]{64}$/);
    await assert.rejects(
      fs.access(path.join(projectRoot, "docs", "deliverables", "contract-fixture.docx"))
    );
  });
});
