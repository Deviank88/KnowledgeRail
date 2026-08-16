import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { runHttpGateway } from "../src/http/gateway.js";
import { GatewayStateStore } from "../src/http/gateway-state.js";
import { MCP_PROTOCOL_VERSION, PRODUCT_VERSION } from "../src/product.js";
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

async function filesystemSnapshot(root: string): Promise<Record<string, { size: number; mtimeMs: number }>> {
  const snapshot: Record<string, { size: number; mtimeMs: number }> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        snapshot[path.relative(root, absolute).replace(/\\/g, "/")] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
    }
  }
  await visit(root);
  return snapshot;
}

function rawHttpStatus(url: URL, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { host: hostHeader },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
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
    assert.equal(JSON.stringify(initializedA).includes(await fs.realpath(rootA)), false);
    assert.equal(JSON.stringify(initializedB).includes(await fs.realpath(rootB)), false);
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

    const document = await client.callTool({
      name: "knowledge_document",
      arguments: {
        action: "write",
        filename: "catalog.md",
        title: "Catalog",
        document_type: "custom",
        content: "# Catalog\n\nA bounded catalog document.",
        overwrite: true,
        workspace_binding: bindingA,
      },
    });
    assert.notEqual(document.isError, true, JSON.stringify(document));
    assert.equal(JSON.stringify(document).includes(await fs.realpath(rootA)), false);

    const beforeReadBinding = await filesystemSnapshot(rootA);
    const readContext = await client.callTool({
      name: "knowledge_context",
      arguments: {
        mode: "task",
        intent: "understand",
        objective: "Read Project A without writing derived state",
        query: "Project A isolation",
        workspace_binding: readOnlyBinding,
      },
    });
    assert.notEqual(readContext.isError, true, JSON.stringify(readContext));
    assert.deepEqual(await filesystemSnapshot(rootA), beforeReadBinding);

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
    allowedOrigins: ["http://allowed.local:4444"],
  }, { stateDirectory: state });
  try {
    const base = new URL(gateway.endpoint);
    const health = await fetch(new URL("/healthz", base));
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.version, PRODUCT_VERSION);
    assert.equal(healthBody.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(JSON.stringify(healthBody).includes(state), false);
    assert.notEqual(await rawHttpStatus(new URL("/healthz", base), "attacker.example"), 200);
    const missing = await fetch(new URL("/not-mcp", base));
    assert.equal(missing.status, 404);
    const rejectedLocalOrigin = await fetch(gateway.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:9999" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(rejectedLocalOrigin.status, 403);
    const unauthorized = await fetch(gateway.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://allowed.local:4444" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthorized.status, 401);
    const credential = await new GatewayStateStore(state).credential();
    const metrics = await fetch(new URL("/metrics", base), {
      headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(metrics.status, 200);
    const metricsBody = await metrics.json() as Record<string, unknown>;
    assert.equal(typeof metricsBody.requests, "number");
    assert.equal(JSON.stringify(metricsBody).includes(state), false);
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
