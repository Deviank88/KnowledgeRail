import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { runHttpGateway } from "../src/http/gateway.js";
import { GatewayStateStore } from "../src/http/gateway-state.js";
import { MCP_PROTOCOL_VERSION } from "../src/product.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";

async function connect(endpoint: string, token: string): Promise<Client> {
  const client = new Client(
    { name: "knowledge-rail-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: { token: async () => token },
  }));
  return client;
}

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

test("HTTP gateway serves nine-tool catalog and isolates two concurrent workspace bindings", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-http-state-"));
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-http-a-"));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-http-b-"));
  await fs.writeFile(path.join(rootA, "package.json"), "{}\n");
  await fs.writeFile(path.join(rootB, "package.json"), "{}\n");
  const registry = new WorkspaceRegistry(state);
  const [workspaceA, workspaceB] = await Promise.all([
    registry.register(rootA),
    registry.register(rootB),
  ]);
  const gateway = await runHttpGateway({
    transport: "http",
    host: "127.0.0.1",
    port: 0,
    httpPath: "/mcp",
    allowedHosts: [],
    allowedOrigins: [],
  }, { stateDirectory: state });
  const credential = await new GatewayStateStore(state).credential();
  const client = await connect(gateway.endpoint, credential);

  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.equal(tools.some((tool) => tool.name === "knowledge_workspace"), true);
    const admin = tools.find((tool) => tool.name === "knowledge_admin");
    assert.ok(admin);
    assert.equal(
      Boolean((admin.inputSchema as { properties?: Record<string, unknown> }).properties?.workspace_binding),
      true
    );

    const listed = await client.callTool({ name: "knowledge_workspace", arguments: { action: "list" } });
    assert.equal((structured(listed).workspaces as unknown[]).length, 2);

    const select = async (workspaceId: string): Promise<string> => {
      const selected = await client.callTool({
        name: "knowledge_workspace",
        arguments: { action: "select", workspace_id: workspaceId, scope: "write", confirmed: true },
      });
      return structured(selected).binding as string;
    };
    const [bindingA, bindingB] = await Promise.all([select(workspaceA.id), select(workspaceB.id)]);
    assert.notEqual(bindingA, bindingB);
    const readOnlySelection = await client.callTool({
      name: "knowledge_workspace",
      arguments: { action: "select", workspace_id: workspaceA.id, scope: "read", confirmed: true },
    });
    const readOnlyBinding = structured(readOnlySelection).binding as string;

    const unbound = await client.callTool({
      name: "knowledge_admin",
      arguments: { action: "init" },
    });
    assert.equal(unbound.isError, true);
    assert.equal(
      (unbound.structuredContent as { nextAction?: { tool?: string } }).nextAction?.tool,
      "knowledge_workspace"
    );
    const readOnlyWrite = await client.callTool({
      name: "knowledge_admin",
      arguments: { action: "init", workspace_binding: readOnlyBinding },
    });
    assert.equal(readOnlyWrite.isError, true);

    const [initializedA, initializedB] = await Promise.all([
      client.callTool({ name: "knowledge_admin", arguments: { action: "init", workspace_binding: bindingA } }),
      client.callTool({ name: "knowledge_admin", arguments: { action: "init", workspace_binding: bindingB } }),
    ]);
    assert.notEqual(initializedA.isError, true);
    assert.notEqual(initializedB.isError, true);
    assert.equal(await fs.readFile(path.join(rootA, "wiki", "SCHEMA.md"), "utf8").then(() => true), true);
    assert.equal(await fs.readFile(path.join(rootB, "wiki", "SCHEMA.md"), "utf8").then(() => true), true);

    const writes = await Promise.all([
      client.callTool({
        name: "knowledge_page",
        arguments: {
          action: "write",
          path: "requirements/A.md",
          content: "---\ntitle: A\ntype: requirement\ntags: [isolation]\ncreated: 2026-08-15\nupdated: 2026-08-15\nsources: []\n---\n\n# Project A\n",
          workspace_binding: bindingA,
        },
      }),
      client.callTool({
        name: "knowledge_page",
        arguments: {
          action: "write",
          path: "requirements/B.md",
          content: "---\ntitle: B\ntype: requirement\ntags: [isolation]\ncreated: 2026-08-15\nupdated: 2026-08-15\nsources: []\n---\n\n# Project B\n",
          workspace_binding: bindingB,
        },
      }),
    ]);
    assert.notEqual(writes[0].isError, true, JSON.stringify(writes[0]));
    assert.notEqual(writes[1].isError, true, JSON.stringify(writes[1]));
    assert.equal(await fs.readFile(path.join(rootA, "wiki", "requirements", "A.md"), "utf8").then(() => true), true);
    await assert.rejects(() => fs.access(path.join(rootA, "wiki", "requirements", "B.md")));
    assert.equal(await fs.readFile(path.join(rootB, "wiki", "requirements", "B.md"), "utf8").then(() => true), true);
    await assert.rejects(() => fs.access(path.join(rootB, "wiki", "requirements", "A.md")));

    const contextA = await client.callTool({
      name: "knowledge_context",
      arguments: {
        mode: "task",
        intent: "understand",
        objective: "Understand Project A isolation requirement",
        query: "Project A isolation",
        workspace_binding: bindingA,
      },
    });
    const link = contextA.content.find((item) => item.type === "resource_link");
    assert.ok(link && link.type === "resource_link");
    assert.equal(new URL(link.uri).searchParams.get("workspace_binding"), bindingA);
    const materialized = await client.readResource({ uri: link.uri });
    assert.equal(materialized.contents.some((item) => "text" in item && item.text.includes("Project A")), true);
  } finally {
    await client.close();
    await gateway.close();
  }
});

test("HTTP gateway protects MCP, validates routes and exposes path-free health only", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-http-security-"));
  const gateway = await runHttpGateway({
    transport: "http",
    host: "127.0.0.1",
    port: 0,
    httpPath: "/mcp",
    allowedHosts: [],
    allowedOrigins: [],
  }, { stateDirectory: state });
  try {
    const base = new URL(gateway.endpoint);
    const health = await fetch(new URL("/healthz", base));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const missing = await fetch(new URL("/not-mcp", base));
    assert.equal(missing.status, 404);
    const unauthorized = await fetch(gateway.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthorized.status, 401);
    await assert.rejects(
      () => runHttpGateway({
        transport: "http",
        host: "127.0.0.1",
        port: 0,
        httpPath: "/mcp",
        allowedHosts: [],
        allowedOrigins: [],
      }, { stateDirectory: state }),
      /already owns/
    );
  } finally {
    await gateway.close();
  }
});
