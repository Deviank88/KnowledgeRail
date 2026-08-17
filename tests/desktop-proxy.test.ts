import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildDesktopProxyServer, loadDesktopRemoteCatalog } from "../src/desktop/proxy-server.js";
import { runHttpGateway } from "../src/http/gateway.js";
import { GatewayStateStore } from "../src/http/gateway-state.js";
import { MCP_PROTOCOL_VERSION } from "../src/product.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;
  private started = false;

  async start(): Promise<void> {
    if (this.started) throw new Error("Memory transport already started");
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || !this.peer?.started) throw new Error("Memory transport is not connected");
    queueMicrotask(() => this.peer?.onmessage?.(structuredClone(message)));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function memoryPair(): [MemoryTransport, MemoryTransport] {
  const left = new MemoryTransport();
  const right = new MemoryTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

for (const desktopProtocolVersion of [MCP_PROTOCOL_VERSION, "2025-11-25"] as const) {
test(`desktop adapter exposes portable per-chat bindings over ${desktopProtocolVersion}`, async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-desktop-state-"));
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-desktop-a-"));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-desktop-b-"));
  const registry = new WorkspaceRegistry(state);
  const [workspaceA, workspaceB] = await Promise.all([registry.register(rootA), registry.register(rootB)]);
  const gateway = await runHttpGateway({
    transport: "http", host: "127.0.0.1", port: 0, httpPath: "/mcp",
    allowedHosts: [], allowedOrigins: [],
  }, { stateDirectory: state });
  const credential = await new GatewayStateStore(state).credential();
  const remoteClient = new Client(
    { name: "desktop-proxy-remote", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
  );
  await remoteClient.connect(new StreamableHTTPClientTransport(new URL(gateway.endpoint), {
    authProvider: { token: async () => credential },
  }));

  const catalog = await loadDesktopRemoteCatalog(remoteClient);
  const [localWire, proxyWire] = memoryPair();
  const proxy = serveStdio(
    () => buildDesktopProxyServer(remoteClient, catalog),
    { transport: proxyWire, legacy: "serve" }
  );
  const desktopClient = new Client(
    { name: "claude-desktop-simulation", version: "1.0.0" },
    {
      versionNegotiation: {
        mode:
          desktopProtocolVersion === MCP_PROTOCOL_VERSION
            ? { pin: MCP_PROTOCOL_VERSION }
            : "legacy",
      },
    }
  );
  try {
    await desktopClient.connect(localWire);
    const tools = (await desktopClient.listTools()).tools;
    assert.equal(tools.length, 9);
    assert.ok(tools.find((tool) => tool.name === "knowledge_workspace")?.outputSchema);
    const templates = (await desktopClient.listResourceTemplates()).resourceTemplates;
    assert.equal(templates.length, 4);
    assert.equal(templates.every((item) => item.uriTemplate.includes("workspace_binding")), true);

    const choose = async (workspaceId: string): Promise<string> => {
      const selected = await desktopClient.callTool({
        name: "knowledge_workspace",
        arguments: { action: "select", workspace_id: workspaceId, scope: "write", confirmed: true },
      });
      const structuredBinding = (selected.structuredContent as { binding: string }).binding;
      const textBlock = selected.content.find((item) => item.type === "text");
      assert.ok(textBlock && textBlock.type === "text");
      const textBinding = textBlock.text.match(/^workspace_binding: (krb[0-9]+_[A-Za-z0-9_-]+)$/m)?.[1];
      assert.equal(textBinding, structuredBinding);
      return textBinding!;
    };
    const [bindingA, bindingB] = await Promise.all([choose(workspaceA.id), choose(workspaceB.id)]);
    await Promise.all([
      desktopClient.callTool({ name: "knowledge_admin", arguments: { action: "init", workspace_binding: bindingA } }),
      desktopClient.callTool({ name: "knowledge_admin", arguments: { action: "init", workspace_binding: bindingB } }),
    ]);

    assert.equal(await fs.access(path.join(rootA, "wiki", "SCHEMA.md")).then(() => true), true);
    assert.equal(await fs.access(path.join(rootB, "wiki", "SCHEMA.md")).then(() => true), true);
    assert.notEqual(bindingA, bindingB);
  } finally {
    await desktopClient.close();
    await proxy.close();
    await remoteClient.close();
    await gateway.close();
    await Promise.all([
      fs.rm(state, { recursive: true, force: true }),
      fs.rm(rootA, { recursive: true, force: true }),
      fs.rm(rootB, { recursive: true, force: true }),
    ]);
  }
});
}
