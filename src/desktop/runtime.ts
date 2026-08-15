import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runHttpGateway, type HttpGatewayHandle } from "../http/gateway.js";
import { GatewayStateStore, type GatewayRendezvous } from "../http/gateway-state.js";
import {
  BINDING_FORMAT_VERSION,
  MCP_PROTOCOL_VERSION,
  PRODUCT_VERSION,
  REGISTRY_SCHEMA_VERSION,
} from "../product.js";
import { buildDesktopProxyServer, loadDesktopRemoteCatalog } from "./proxy-server.js";

export interface DesktopRuntimeHandle {
  close(): Promise<void>;
}

function compatible(record: GatewayRendezvous): boolean {
  return record.productVersion === PRODUCT_VERSION &&
    record.protocolVersion === MCP_PROTOCOL_VERSION &&
    record.bindingFormatVersion === BINDING_FORMAT_VERSION &&
    record.registrySchemaVersion === REGISTRY_SCHEMA_VERSION;
}

async function gatewayHealthy(record: GatewayRendezvous): Promise<boolean> {
  try {
    const endpoint = new URL(record.endpoint);
    const response = await fetch(new URL("/healthz", endpoint), { signal: AbortSignal.timeout(1_500) });
    return response.ok && (await response.json() as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

async function findOrStartGateway(
  state: GatewayStateStore,
  gatewayPort: number
): Promise<{ record: GatewayRendezvous; owned?: HttpGatewayHandle }> {
  const existing = await state.read();
  if (existing && await gatewayHealthy(existing)) {
    if (!compatible(existing)) {
      throw new Error("The running KnowledgeRail gateway is incompatible with this pinned desktop adapter version.");
    }
    return { record: existing };
  }
  await state.recoverStaleOwnership();
  const owned = await runHttpGateway({
    transport: "http",
    host: "127.0.0.1",
    port: gatewayPort,
    httpPath: "/mcp",
    allowedHosts: [],
    allowedOrigins: [],
  }, { stateDirectory: state.directory });
  const record = await state.read();
  if (!record || !compatible(record)) {
    await owned.close();
    throw new Error("The local gateway did not publish a compatible rendezvous record.");
  }
  return { record, owned };
}

export async function runDesktop(
  options: { stateDirectory?: string; gatewayPort?: number } = {}
): Promise<DesktopRuntimeHandle> {
  const state = new GatewayStateStore(options.stateDirectory);
  const configuredPort = Number(process.env["KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT"] ?? 3333);
  const gatewayPort = options.gatewayPort ?? configuredPort;
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    throw new Error("KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT must be an integer from 1 to 65535.");
  }
  const { record, owned } = await findOrStartGateway(state, gatewayPort);
  const credential = await state.credential();
  const client = new Client(
    { name: "knowledge-rail-desktop-adapter", version: PRODUCT_VERSION },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(record.endpoint), {
      authProvider: { token: async () => credential },
    }));
    const catalog = await loadDesktopRemoteCatalog(client);
    const stdio = serveStdio(
      () => buildDesktopProxyServer(client, catalog),
      {
        legacy: "serve",
        onerror: () => process.stderr.write("[knowledge-rail] Desktop MCP adapter request failed.\n"),
      }
    );
    process.stderr.write("[knowledge-rail] Desktop adapter connected to the local multi-workspace gateway.\n");

    let closing: Promise<void> | undefined;
    return {
      close: () => {
        if (closing) return closing;
        closing = (async () => {
          await stdio.close();
          await client.close();
          await owned?.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await owned?.close().catch(() => undefined);
    throw error;
  }
}
