import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runHttpGateway, type HttpGatewayHandle } from "../http/gateway.js";
import {
  GatewayOwnershipError,
  GatewayStateStore,
  type GatewayRendezvous,
} from "../http/gateway-state.js";
import {
  BINDING_FORMAT_VERSION,
  MCP_PROTOCOL_VERSION,
  PRODUCT_VERSION,
  REGISTRY_SCHEMA_VERSION,
} from "../product.js";
import { buildDeferredDesktopProxyServer } from "./proxy-server.js";
import { logger } from "../core/logger.js";
import { WorkspaceBindingManager } from "../workspaces/bindings.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";
import { startupMark } from "../runtime/startup-timing.js";
import { setTimeout as delay } from "node:timers/promises";
import { RecoverableDesktopClientProvider } from "./connection-manager.js";

export interface DesktopRuntimeHandle {
  close(): Promise<void>;
}

interface DesktopGatewayConnection {
  client: Client;
  owned?: HttpGatewayHandle;
}

async function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

type GatewayHealth =
  | { status: "healthy" }
  | { status: "timeout" | "unreachable" | "unhealthy"; detail?: string };

const GATEWAY_HEALTH_TIMEOUT_MS = 350;
const CONCURRENT_GATEWAY_WAIT_MS = 750;

function configuredPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function compatible(record: GatewayRendezvous): boolean {
  return record.productVersion === PRODUCT_VERSION &&
    record.protocolVersion === MCP_PROTOCOL_VERSION &&
    record.bindingFormatVersion === BINDING_FORMAT_VERSION &&
    record.registrySchemaVersion === REGISTRY_SCHEMA_VERSION;
}

function assertLoopbackEndpoint(endpoint: URL): void {
  const hostname = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) {
    throw new Error("The KnowledgeRail gateway rendezvous endpoint must use HTTP on loopback.");
  }
}

async function gatewayHealth(record: GatewayRendezvous, signal: AbortSignal): Promise<GatewayHealth> {
  try {
    const endpoint = new URL(record.endpoint);
    assertLoopbackEndpoint(endpoint);
    signal.throwIfAborted();
    const response = await fetch(new URL("/healthz", endpoint), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(GATEWAY_HEALTH_TIMEOUT_MS)]),
    });
    if (!response.ok) return { status: "unhealthy", detail: `http_${response.status}` };
    return (await response.json() as { status?: unknown }).status === "ok"
      ? { status: "healthy" }
      : { status: "unhealthy", detail: "invalid_health_payload" };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return error instanceof Error && error.name === "TimeoutError"
      ? { status: "timeout" }
      : { status: "unreachable", detail: (error as NodeJS.ErrnoException).code };
  }
}

async function waitForConcurrentGateway(
  state: GatewayStateStore,
  signal: AbortSignal
): Promise<GatewayRendezvous | null> {
  const deadline = Date.now() + CONCURRENT_GATEWAY_WAIT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const record = await state.read();
    if (record) {
      const health = await gatewayHealth(record, signal);
      if (health.status === "healthy") return record;
    }
    await delay(25, undefined, { signal });
  }
  return null;
}

async function findOrStartGateway(
  state: GatewayStateStore,
  gatewayPort: number,
  signal: AbortSignal
): Promise<{ record: GatewayRendezvous; owned?: HttpGatewayHandle }> {
  startupMark("gateway_probe_started");
  signal.throwIfAborted();
  const existing = await state.read();
  const health = existing
    ? await gatewayHealth(existing, signal)
    : { status: "unreachable" as const, detail: "absent" };
  startupMark("gateway_probe_completed", {
    gatewayState: health.status,
    detail: "detail" in health ? health.detail : undefined,
  });
  if (existing && health.status === "healthy") {
    if (!compatible(existing)) {
      throw new Error("The running KnowledgeRail gateway is incompatible with this pinned desktop adapter version.");
    }
    startupMark("gateway_reused");
    return { record: existing };
  }
  try {
    await state.recoverStaleOwnership();
  } catch (error) {
    if (!(error instanceof GatewayOwnershipError)) throw error;
    const raced = await waitForConcurrentGateway(state, signal);
    if (!raced) {
      throw new GatewayOwnershipError("A live KnowledgeRail gateway owns the state directory but did not become healthy in time.");
    }
    if (!compatible(raced)) {
      throw new Error("The concurrently started KnowledgeRail gateway is incompatible with this pinned desktop adapter version.");
    }
    startupMark("gateway_concurrent_start_reused");
    return { record: raced };
  }
  signal.throwIfAborted();
  let owned: HttpGatewayHandle;
  try {
    owned = await runHttpGateway({
      transport: "http",
      host: "127.0.0.1",
      port: gatewayPort,
      httpPath: "/mcp",
      allowedHosts: [],
      allowedOrigins: [],
    }, { stateDirectory: state.directory });
  } catch (error) {
    if (!(error instanceof GatewayOwnershipError)) throw error;
    const raced = await waitForConcurrentGateway(state, signal);
    if (!raced) {
      throw new GatewayOwnershipError("A live KnowledgeRail gateway owns the state directory but did not become healthy in time.");
    }
    if (!compatible(raced)) {
      throw new Error("The concurrently started KnowledgeRail gateway is incompatible with this pinned desktop adapter version.");
    }
    startupMark("gateway_concurrent_start_reused");
    return { record: raced };
  }
  let record: GatewayRendezvous | null;
  try {
    record = await state.read();
  } catch (error) {
    await owned.close();
    throw error;
  }
  if (!record || !compatible(record)) {
    await owned.close();
    throw new Error("The local gateway did not publish a compatible rendezvous record.");
  }
  startupMark("gateway_started");
  return { record, owned };
}

async function connectDesktopGateway(
  state: GatewayStateStore,
  gatewayPort: number,
  signal: AbortSignal
): Promise<DesktopGatewayConnection> {
  const { record, owned } = await findOrStartGateway(state, gatewayPort, signal);
  let client: Client | undefined;
  try {
    signal.throwIfAborted();
    const credential = await state.credential();
    signal.throwIfAborted();
    client = new Client(
      { name: "knowledge-rail-desktop-adapter", version: PRODUCT_VERSION },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
    );
    await waitForAbort(
      client.connect(new StreamableHTTPClientTransport(new URL(record.endpoint), {
        authProvider: { token: async () => credential },
      })),
      signal
    );
    startupMark("gateway_mcp_connected");
    return { client, owned };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await owned?.close().catch(() => undefined);
    throw error;
  }
}

export async function runDesktop(
  options: { stateDirectory?: string; gatewayPort?: number } = {}
): Promise<DesktopRuntimeHandle> {
  startupMark("desktop_runtime_started");
  const state = new GatewayStateStore(options.stateDirectory);
  const configuredPort = Number(process.env["KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT"] ?? 3333);
  const gatewayPort = options.gatewayPort ?? configuredPort;
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    throw new Error("KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT must be an integer from 1 to 65535.");
  }
  const lifecycleAbort = new AbortController();
  let ownedGateway: HttpGatewayHandle | undefined;
  const clients = new RecoverableDesktopClientProvider({
    lifecycleSignal: lifecycleAbort.signal,
    attemptTimeoutMs: configuredPositiveInteger(
      "KNOWLEDGE_RAIL_DESKTOP_CONNECT_ATTEMPT_TIMEOUT_MS",
      process.platform === "win32" ? 8_000 : 5_000
    ),
    connectionBudgetMs: configuredPositiveInteger("KNOWLEDGE_RAIL_DESKTOP_CONNECT_BUDGET_MS", 15_000),
    maxAttempts: configuredPositiveInteger("KNOWLEDGE_RAIL_DESKTOP_CONNECT_MAX_ATTEMPTS", 3),
    connect: async (signal) => {
      const connection = await connectDesktopGateway(state, gatewayPort, signal);
      if (connection.owned) ownedGateway = connection.owned;
      return {
        client: connection.client,
        close: async () => {
          await connection.client.close().catch(() => undefined);
        },
      };
    },
  });
  void clients.preconnect().then(() => {
    logger.info("desktop", "gateway_connected");
  }).catch((error: unknown) => {
    if (lifecycleAbort.signal.aborted) return;
    logger.error("desktop", "gateway_connection_failed", {}, error);
  });

  // These objects supply the exact catalog profile only. Data-bearing calls
  // are replaced by the deferred proxy handlers and execute on the gateway.
  const catalogRegistry = new WorkspaceRegistry(state.directory);
  const catalogBindings = new WorkspaceBindingManager(catalogRegistry);
  const stdio = serveStdio(
    (context) => buildDeferredDesktopProxyServer(
      context,
      clients,
      { bindings: catalogBindings, principalId: "desktop-local-catalog" }
    ),
    {
      legacy: "serve",
      onerror: (error) => logger.error("desktop", "mcp_adapter_request_failed", {}, error),
    }
  );
  logger.info("desktop", "protocol_ready");
  startupMark("protocol_transport_ready", { transport: "desktop" });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    lifecycleAbort.abort(new Error("KnowledgeRail desktop adapter closed during gateway startup."));
    process.stdin.off("end", closeOnInputEnd);
    process.stdin.off("close", closeOnInputEnd);
    closing = (async () => {
      await stdio.close();
      catalogBindings.revokeAll();
      await clients.close();
      await ownedGateway?.close().catch(() => undefined);
      ownedGateway = undefined;
    })();
    return closing;
  };
  function closeOnInputEnd(): void {
    void close().catch((error: unknown) => {
      logger.error("desktop", "stdin_shutdown_failed", {}, error);
    });
  }
  process.stdin.once("end", closeOnInputEnd);
  process.stdin.once("close", closeOnInputEnd);
  return { close };
}
