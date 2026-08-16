import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  getWikiRoot,
  isWikiRootReady,
  setWikiRoot,
} from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const STATIC_CATALOG_TTL_MS = 5 * 60 * 1_000;

const modernEnvelope = () => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "knowledge-rail-test-client",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
});

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
    if (this.started) throw new Error("MemoryTransport already started");
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed) throw new Error("MemoryTransport is not open");
    const peer = this.peer;
    if (!peer?.started || peer.closed) throw new Error("MemoryTransport peer is not open");
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

type RpcId = string | number;

interface RawHarness {
  request(message: JSONRPCRequest): Promise<JSONRPCMessage>;
  notify(message: JSONRPCNotification): Promise<void>;
  serverRequests: JSONRPCRequest[];
  close(): Promise<void>;
}

async function createHarness(options: {
  roots?: string[];
  onFactoryEra?: (era: "legacy" | "modern") => void;
} = {}): Promise<RawHarness> {
  const [peer, wire] = linkedPair();
  const waiters = new Map<RpcId, (message: JSONRPCMessage) => void>();
  const serverRequests: JSONRPCRequest[] = [];
  let nextServerResponseId = 10_000;

  peer.onmessage = (message) => {
    if ("method" in message && "id" in message && message.id !== undefined) {
      const request = message as JSONRPCRequest;
      serverRequests.push(request);
      if (request.method === "roots/list") {
        const roots = (options.roots ?? []).map((root) => ({
          uri: pathToFileURL(root).href,
          name: path.basename(root),
        }));
        void peer.send({
          jsonrpc: "2.0",
          id: request.id ?? nextServerResponseId++,
          result: { roots },
        });
        return;
      }
    }

    if ("id" in message && message.id !== undefined) {
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  };

  await peer.start();
  const handle = serveStdio(
    (context) => {
      options.onFactoryEra?.(context.era);
      return buildServer(context);
    },
    { transport: wire, legacy: "serve" }
  );

  const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(message.id);
        reject(new Error(`Timed out waiting for MCP response ${String(message.id)} (${message.method})`));
      }, 3_000);
      timeout.unref();
      waiters.set(message.id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      void peer.send(message).catch((error: unknown) => {
        clearTimeout(timeout);
        waiters.delete(message.id);
        reject(error);
      });
    });

  return {
    request,
    notify: (message) => peer.send(message),
    serverRequests,
    close: async () => {
      await handle.close();
      await peer.close();
    },
  };
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
  assert.equal("result" in message, true, `Expected result response, got ${JSON.stringify(message)}`);
  return (message as { result: Record<string, unknown> }).result;
}

function textContent(result: Record<string, unknown>): string {
  const content = result.content;
  assert.equal(Array.isArray(content), true);
  return (content as Array<{ type?: string; text?: string }>)
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function waitForWorkspace(expectedRoot: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (isWikiRootReady()) {
      try {
        if (getWikiRoot() === expectedRoot) return;
      } catch {
        // Gate may have closed between readiness check and read; retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Workspace did not resolve to ${expectedRoot}`);
}

async function writeContextFixture(projectRoot: string): Promise<void> {
  const file = path.join(projectRoot, "wiki", "requirements", "REQ_CONTEXT.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    'title: "Context requirement"',
    "type: requirement",
    "tags: [approval, audit]",
    'sources: ["docs/context-spec.md"]',
    "---",
    "",
    "# Requirement",
    "",
    "General approval context.",
    "",
    "## Audit evidence",
    "",
    "Every approval records user role timestamp and motivation in an immutable audit trail.",
    "",
    "## Adjacent detail",
    "",
    "Credit notes follow a separate process.",
  ].join("\n"), "utf8");
}

test("2026-07-28 stdio leg uses resource links without legacy Roots negotiation", async () => {
  const originalRoot = getWikiRoot();
  const modernRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-mcp-modern-"));
  const eras: Array<"legacy" | "modern"> = [];
  setWikiRoot(modernRoot);
  const harness = await createHarness({ onFactoryEra: (era) => eras.push(era) });

  try {
    const list = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-list",
      method: "tools/list",
      params: { _meta: modernEnvelope() },
    }));

    assert.equal(list.resultType, "complete");
    assert.equal(list.ttlMs, STATIC_CATALOG_TTL_MS);
    assert.equal(list.cacheScope, "private");
    const tools = list.tools as Array<{ name: string }>;
    assert.equal(tools.length, 8);
    assert.equal(tools.some((tool) => tool.name === "knowledge_admin"), true);
    assert.equal(tools.some((tool) => tool.name === "knowledge_context"), true);
    assert.equal(tools.some((tool) => tool.name === "knowledge_code"), true);
    assert.equal(tools.some((tool) => tool.name === "knowledge_ingest"), true);
    assert.equal(tools.some((tool) => tool.name === "knowledge_menu"), false);
    assert.equal(tools.some((tool) => tool.name === "wiki_menu"), false);
    assert.equal(tools.some((tool) => tool.name === "wiki_read_resource"), false);
    assert.deepEqual(eras, ["modern"]);
    assert.equal(harness.serverRequests.some((request) => request.method === "roots/list"), false);

    const initialized = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-init-tool",
      method: "tools/call",
      params: {
        name: "knowledge_admin",
        arguments: { action: "init", force: false },
        _meta: modernEnvelope(),
      },
    }));
    assert.equal(textContent(initialized).includes("Wiki initialized: wiki/"), true);
    assert.equal(textContent(initialized).includes(modernRoot), false);
    assert.equal(getWikiRoot(), modernRoot);

    await writeContextFixture(modernRoot);
    const context = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-context",
      method: "tools/call",
      params: {
        name: "knowledge_context",
        arguments: {
          mode: "task",
          intent: "review",
          objective: "Review approval audit traceability",
          query: "user role timestamp motivation immutable audit",
          retrieval_profile: "balanced",
          max_evidence: 4,
          heuristic_token_budget: 1500,
        },
        _meta: modernEnvelope(),
      },
    }));
    const contextContent = context.content as Array<Record<string, unknown>>;
    const resourceLink = contextContent.find((item) => item.type === "resource_link");
    assert.ok(resourceLink);
    assert.equal(typeof resourceLink.uri, "string");
    assert.match(
      resourceLink.uri as string,
      /^knowledge-rail:\/\/page\/requirements\/REQ_CONTEXT\.md\?passage=p-[0-9a-f]{16}$/
    );

    const resource = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-resource-read",
      method: "resources/read",
      params: {
        uri: resourceLink.uri,
        _meta: modernEnvelope(),
      },
    }));
    assert.equal(resource.ttlMs, 0);
    assert.equal(resource.cacheScope, "private");
    const contents = resource.contents as Array<{ text?: string }>;
    assert.equal(contents.length, 1);
    const resourceText = contents[0]?.text ?? "";
    assert.equal(resourceText.includes("user role timestamp and motivation"), true);
    assert.equal(resourceText.includes("Credit notes"), false, "resource passage must not include adjacent sections");

    await fs.mkdir(path.join(modernRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(modernRoot, "src", "orders.ts"), [
      "/** Submit one order to durable storage. */",
      "export async function submitOrder(id: string): Promise<void> {",
      "  await saveOrder(id);",
      "}",
      "",
      "export function adjacentHelper(): string { return \"not requested\"; }",
      "",
    ].join("\n"), "utf8");
    const rebuilt = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-code-rebuild",
      method: "tools/call",
      params: {
        name: "knowledge_code",
        arguments: { action: "rebuild" },
        _meta: modernEnvelope(),
      },
    }));
    assert.equal(textContent(rebuilt).includes("Code evidence rebuilt"), true);
    const codeSearch = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-code-search",
      method: "tools/call",
      params: {
        name: "knowledge_code",
        arguments: { action: "symbol", symbol: "submitOrder" },
        _meta: modernEnvelope(),
      },
    }));
    const codeLink = (codeSearch.content as Array<Record<string, unknown>>)
      .find((item) => item.type === "resource_link");
    assert.ok(codeLink);
    assert.match(codeLink.uri as string, /^code:\/\/repo\/src\/orders\.ts#symbol-[0-9a-f]{20}$/);
    const codeResource = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-code-resource-read",
      method: "resources/read",
      params: { uri: codeLink.uri, _meta: modernEnvelope() },
    }));
    assert.equal(codeResource.ttlMs, 0);
    assert.equal(codeResource.cacheScope, "private");
    const codeText = (codeResource.contents as Array<{ text?: string }>)[0]?.text ?? "";
    assert.equal(codeText.includes("saveOrder(id)"), true);
    assert.equal(codeText.includes("not requested"), false);

    const recordedFallback = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-code-fallback",
      method: "tools/call",
      params: {
        name: "knowledge_code",
        arguments: {
          action: "record_fallback",
          query: "submitOrder legacy integration",
          fallback_reason: "Coverage remained insufficient after indexed lookup.",
          fallback_result_count: 1,
          recovered_evidence: [{
            evidence_ref: codeLink.uri,
            source_uri: codeLink.uri,
            expected_wiki_pages: ["implementations/OrderSubmission.md"],
          }],
        },
        _meta: modernEnvelope(),
      },
    }));
    assert.equal(textContent(recordedFallback).includes("Knowledge debt: 1 event(s), 1 pending"), true);
    const recoveryStatus = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "modern-recovery-status",
      method: "tools/call",
      params: {
        name: "knowledge_ingest",
        arguments: { action: "evidence_status" },
        _meta: modernEnvelope(),
      },
    }));
    assert.equal(textContent(recoveryStatus).includes("KnowledgeRecoveryPending: 1"), true);
  } finally {
    await harness.close();
    setWikiRoot(originalRoot);
    await fs.rm(modernRoot, { recursive: true, force: true });
  }
});

test("legacy stdio leg preserves Roots precedence while keeping the same eight domain tools", async () => {
  const originalRoot = getWikiRoot();
  const fallbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-mcp-fallback-"));
  const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-mcp-legacy-"));
  const eras: Array<"legacy" | "modern"> = [];
  setWikiRoot(fallbackRoot);
  const harness = await createHarness({
    roots: [legacyRoot],
    onFactoryEra: (era) => eras.push(era),
  });

  try {
    const init = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: LEGACY_VERSION,
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "legacy-knowledge-rail-test", version: "1.0.0" },
      },
    }));
    assert.equal(init.protocolVersion, LEGACY_VERSION);

    await harness.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await waitForWorkspace(legacyRoot);

    assert.deepEqual(eras, ["legacy"]);
    assert.equal(harness.serverRequests.some((request) => request.method === "roots/list"), true);

    const legacyList = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "legacy-list",
      method: "tools/list",
      params: {},
    }));
    assert.equal(Array.isArray(legacyList.tools), true);
    const legacyTools = legacyList.tools as Array<{ name: string }>;
    assert.equal(legacyTools.length, 8);
    assert.equal(legacyTools.some((tool) => tool.name === "wiki_read_resource"), false);
    assert.equal(legacyTools.some((tool) => tool.name === "knowledge_admin"), true);
    assert.equal("resultType" in legacyList, false);
    assert.equal("ttlMs" in legacyList, false);
    assert.equal("cacheScope" in legacyList, false);

    const result = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "legacy-wiki-init",
      method: "tools/call",
      params: {
        name: "knowledge_admin",
        arguments: { action: "init", force: false },
      },
    }));
    const text = textContent(result);
    assert.equal(text.includes("Wiki initialized: wiki/"), true);
    assert.equal(text.includes(legacyRoot), false);
    assert.equal(text.includes(path.join(fallbackRoot, "wiki")), false);
    assert.equal(getWikiRoot(), legacyRoot);
  } finally {
    await harness.close();
    setWikiRoot(originalRoot);
    await fs.rm(fallbackRoot, { recursive: true, force: true });
    await fs.rm(legacyRoot, { recursive: true, force: true });
  }
});

test("domain tools guide read tasks without a menu round trip", async () => {
  const originalRoot = getWikiRoot();
  const readRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-mcp-menu-"));
  setWikiRoot(readRoot);
  const harness = await createHarness();

  try {
    await writeContextFixture(readRoot);
    const context = resultOf(await harness.request({
      jsonrpc: "2.0",
      id: "read-compact-context",
      method: "tools/call",
      params: {
        name: "knowledge_context",
        arguments: {
          mode: "task",
          intent: "review",
          objective: "Review approval audit traceability",
          query: "user role timestamp motivation immutable audit",
          max_evidence: 4,
          heuristic_token_budget: 1500,
          response_detail: "compact",
        },
        _meta: modernEnvelope(),
      },
    }));
    const structured = context.structuredContent as Record<string, unknown>;
    assert.equal(structured.version, 2);
    assert.equal(Array.isArray(structured.evidence), true);
    assert.equal(Array.isArray(structured.gaps), true);
    assert.equal("currentState" in structured, false, "compact reads must omit verbose compatibility views");
    assert.equal(typeof structured.state, "string");
    assert.equal("nextAction" in structured, true);
    assert.equal(
      (context.content as Array<Record<string, unknown>>).some((item) => item.type === "resource_link"),
      true
    );
  } finally {
    await harness.close();
    setWikiRoot(originalRoot);
    await fs.rm(readRoot, { recursive: true, force: true });
  }
});
