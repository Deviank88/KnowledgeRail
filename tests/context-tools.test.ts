import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { registerContextTools } from "../src/tools/context-tools.js";

type ToolContent = {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
};

type ToolResponse = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const fake = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  return { server: fake as unknown as McpServer, tools };
}

async function writeFixture(projectRoot: string): Promise<void> {
  const wikiRoot = path.join(projectRoot, "wiki");
  const file = path.join(wikiRoot, "requirements", "REQ_42.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    'title: "REQ-42 Approvazione"',
    "type: requirement",
    "tags: [approval, audit]",
    "created: 2026-08-13",
    "updated: 2026-08-13",
    'sources: ["docs/client/spec.md"]',
    "---",
    "",
    "# Requisito",
    "",
    "Le fatture sopra soglia richiedono approvazione.",
    "",
    "## Audit obbligatorio",
    "",
    "Ogni approvazione deve registrare utente, ruolo, timestamp e motivazione.",
    "",
    "## Eccezioni",
    "",
    "Le note di credito seguono un flusso separato.",
  ].join("\n"), "utf8");
}

async function writeDecisionFixture(projectRoot: string): Promise<void> {
  const wikiRoot = path.join(projectRoot, "wiki");
  const pages = [
    {
      relPath: "implementations/PaymentRetryWorker.md",
      title: "Payment retry worker",
      type: "implementation",
      tags: ["payment-retry", "worker"],
      body: "# Current implementation\n\nThe PaymentRetryWorker retries failed charges with the original idempotency key.",
    },
    {
      relPath: "decisions/PaymentRetryIdempotency.md",
      title: "Payment retry idempotency decision",
      type: "decision",
      tags: ["decision", "payment-retry"],
      body: [
        "# Payment retry idempotency",
        "",
        "## Current decision",
        "",
        "Every PaymentRetryWorker attempt reuses the original idempotency key.",
        "",
        "## Rationale",
        "",
        "A stable key prevents duplicate charges while preserving safe retries.",
      ].join("\n"),
    },
  ];

  for (const page of pages) {
    const file = path.join(wikiRoot, page.relPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, [
      "---",
      `title: ${JSON.stringify(page.title)}`,
      `type: ${page.type}`,
      `tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
      "request_id: REQ-PAYMENT-RETRY",
      "created: 2026-08-22",
      "updated: 2026-08-22",
      "sources: []",
      "---",
      "",
      page.body,
    ].join("\n"), "utf8");
  }
}

const contextArgs = {
  intent: "modify",
  objective: "Aggiornare la tracciabilità delle approvazioni",
  query: "utente ruolo timestamp motivazione audit",
  retrieval_profile: "balanced",
  max_evidence: 4,
  heuristic_token_budget: 1500,
};

test("modern knowledge_context returns resource links without registering a redundant read tool", async () => {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-context-modern-"));
  clearRetrievalIndexes();

  try {
    await writeFixture(projectRoot);
    setWikiRoot(projectRoot);
    const { server, tools } = fakeServer();
    registerContextTools(server, "modern");
    assert.equal(tools.size, 1);
    assert.equal(tools.has("wiki_read_resource"), false);

    const context = await tools.get("knowledge_context")!(contextArgs);
    assert.equal(context.isError, undefined);
    assert.ok(context.structuredContent);
    assert.equal(context.structuredContent.version, 2);
    assert.deepEqual(context.structuredContent.task, {
      intent: "modify",
      objective: "Aggiornare la tracciabilità delle approvazioni",
    });
    const retrieval = context.structuredContent.retrieval as Record<string, unknown>;
    assert.equal(retrieval.strategy, "hybrid_progressive_widening");
    assert.equal(retrieval.coverageMode, "lexical");
    assert.equal(Array.isArray(retrieval.coverageWarnings), true);
    const requirements = context.structuredContent.requirements as Array<Record<string, unknown>>;
    assert.equal(requirements[0]?.path, "requirements/REQ_42.md");
    const evidence = context.structuredContent.evidence as Array<Record<string, unknown>>;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.heading, "Audit obbligatorio");

    const link = context.content.find((item) => item.type === "resource_link");
    assert.ok(link);
    assert.equal(link.uri, evidence[0]?.uri);
    assert.equal(link.mimeType, "text/markdown");
    assert.match(link.uri ?? "", /^knowledge-rail:\/\/page\/requirements\/REQ_42\.md\?passage=p-[0-9a-f]{16}$/);
    assert.doesNotMatch(context.content[0]?.text ?? "", /Decision candidates:/);
    await assert.rejects(
      fs.access(path.join(projectRoot, "wiki", ".knowledge-rail")),
      /ENOENT/,
      "a read-only context compilation must not create derived index files"
    );
  } finally {
    clearRetrievalIndexes();
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("legacy context emits the same resource links without a private read alias", async () => {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-context-legacy-"));
  clearRetrievalIndexes();

  try {
    await writeFixture(projectRoot);
    setWikiRoot(projectRoot);
    const { server, tools } = fakeServer();
    registerContextTools(server, "legacy");
    assert.equal(tools.size, 1);
    assert.equal(tools.has("wiki_read_resource"), false);

    const context = await tools.get("wiki_context")!(contextArgs);
    assert.equal(context.isError, undefined);
    assert.ok(context.structuredContent);
    assert.equal(context.structuredContent.version, 2);
    assert.equal(Array.isArray(context.structuredContent.unknowns), true);
    const evidence = context.structuredContent.evidence as Array<Record<string, unknown>>;
    assert.equal(evidence.length, 1);
    const link = context.content.find((item) => item.type === "resource_link");
    assert.ok(link);
    assert.equal(link.uri, evidence[0]?.uri);
    assert.match(link.uri ?? "", /^knowledge-rail:\/\/page\/requirements\/REQ_42\.md\?passage=p-[0-9a-f]{16}$/);
  } finally {
    clearRetrievalIndexes();
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compact task context exposes scoped decision references without embedding page bodies", async () => {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-context-decision-"));
  clearRetrievalIndexes();

  try {
    await writeDecisionFixture(projectRoot);
    setWikiRoot(projectRoot);
    const { server, tools } = fakeServer();
    registerContextTools(server, "modern");

    const context = await tools.get("knowledge_context")!({
      intent: "modify",
      objective: "Change PaymentRetryWorker without duplicating charges",
      query: "PaymentRetryWorker payment retry original idempotency key duplicate charges",
      changed_paths: ["implementations/PaymentRetryWorker.md"],
      retrieval_profile: "balanced",
      max_evidence: 8,
      heuristic_token_budget: 2_000,
      response_detail: "compact",
    });

    assert.equal(context.isError, undefined);
    const decisions = context.structuredContent?.decisions as Array<Record<string, unknown>>;
    const impact = context.structuredContent?.changeImpact as Record<string, unknown>;
    const impactDecisions = impact.decisions as Array<Record<string, unknown>>;
    assert.deepEqual(decisions.map((decision) => decision.path), [
      "decisions/PaymentRetryIdempotency.md",
    ]);
    assert.deepEqual(impactDecisions.map((decision) => decision.path), [
      "decisions/PaymentRetryIdempotency.md",
    ]);
    const decisionGuidance = (context.content[0]?.text ?? "")
      .split("\n")
      .find((line) => line.startsWith("Decision candidates:"));
    assert.ok(decisionGuidance);
    assert.equal(decisionGuidance.length <= 700, true);
    assert.match(decisionGuidance, /Decision candidates: 1/);
    assert.match(decisionGuidance, /materialize only an exact context match/i);
    assert.match(decisionGuidance, /never the whole decisions directory/i);
    assert.match(decisionGuidance, /read only its bounded page/i);
    assert.match(decisionGuidance, /never overwrite unread content/i);
    assert.match(decisionGuidance, /minimum conflicting set/i);

    const decisionLink = context.content.find((item) =>
      item.type === "resource_link" && item.uri?.includes("decisions/PaymentRetryIdempotency.md")
    );
    assert.ok(decisionLink);
    assert.match(decisionLink.uri ?? "", /\?passage=p-[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(context.structuredContent).includes("prevents duplicate charges"), false);
  } finally {
    clearRetrievalIndexes();
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("modern knowledge_context preserves existing derived index artifacts byte-for-byte", async () => {
  const previousRoot = getWikiRoot();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-context-readonly-"));
  clearRetrievalIndexes();

  try {
    await writeFixture(projectRoot);
    const metaRoot = path.join(projectRoot, "wiki", ".knowledge-rail");
    await fs.mkdir(metaRoot, { recursive: true });
    const sentinels = new Map([
      ["retrieval-index.json", "retrieval snapshot sentinel\n"],
      ["retrieval-delta.jsonl", "retrieval delta sentinel\n"],
      ["graph.json", "graph snapshot sentinel\n"],
      ["graph-report.md", "graph report sentinel\n"],
    ]);
    for (const [filename, content] of sentinels) {
      await fs.writeFile(path.join(metaRoot, filename), content, "utf8");
    }

    setWikiRoot(projectRoot);
    const { server, tools } = fakeServer();
    registerContextTools(server, "modern");
    const context = await tools.get("knowledge_context")!(contextArgs);
    assert.equal(context.isError, undefined);

    for (const [filename, content] of sentinels) {
      assert.equal(
        await fs.readFile(path.join(metaRoot, filename), "utf8"),
        content,
        `${filename} changed during a read-only retrieval`
      );
    }
  } finally {
    clearRetrievalIndexes();
    setWikiRoot(previousRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
