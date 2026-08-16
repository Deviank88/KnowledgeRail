import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { ServeCliOptions } from "../cli.js";
import { createUnauthorizedWorkspaceContext, runWithWorkspaceContext } from "../core/workspace-context.js";
import { evictWorkspaceStateForProject } from "../core/workspace-state.js";
import { logger } from "../core/logger.js";
import { MCP_PROTOCOL_VERSION, PRODUCT_VERSION } from "../product.js";
import { buildServer } from "../mcp/server.js";
import { discoverWorkspaceFromCwd } from "../mcp/workspace-discovery.js";
import { WorkspaceBindingManager } from "../workspaces/bindings.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";
import { GatewayStateStore } from "./gateway-state.js";
import { qualifyWorkspaceResponse, resolveRequestWorkspace } from "./request-workspace.js";

const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
const DEFAULT_MAX_CONCURRENT_WORKSPACE_REQUESTS = 16;

export interface HttpGatewayHandle {
  endpoint: string;
  close(): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

function bearerMatches(request: Request, credential: string): boolean {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(value.slice(7)).digest();
  const expected = createHash("sha256").update(credential).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function limitedRequest(req: http.IncomingMessage, maxBytes: number): NodeIncomingMessageLike {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    async *[Symbol.asyncIterator]() {
      let received = 0;
      for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        received += bytes;
        if (received > maxBytes) throw new Error("Request body exceeds the configured limit.");
        yield chunk;
      }
    },
  };
}

export async function runHttpGateway(
  options: ServeCliOptions,
  dependencies: { stateDirectory?: string; bodyLimit?: number } = {}
): Promise<HttpGatewayHandle> {
  if (!isLoopbackHost(options.host)) {
    throw new Error("Non-loopback HTTP binding is disabled in the local self-hosted release; use loopback or a separately secured future deployment.");
  }

  const nonce = randomBytes(18).toString("base64url");
  const state = new GatewayStateStore(dependencies.stateDirectory);
  await state.recoverStaleOwnership();
  const ownership = await state.acquire(nonce);
  let server: http.Server | undefined;
  let mcp: ReturnType<typeof createMcpHandler> | undefined;
  try {
    const credential = await state.credential();
    const principalId = `local_${createHash("sha256").update(credential).digest("base64url")}`;
    const registry = new WorkspaceRegistry(state.directory);
    const bindings = new WorkspaceBindingManager(
      registry,
      undefined,
      undefined,
      undefined,
      async (workspaceId) => {
        const registration = await registry.get(workspaceId);
        if (registration) evictWorkspaceStateForProject(registration.canonicalRoot);
      }
    );
    let activeRequests = 0;
    const activeByWorkspace = new Map<string, number>();
    const startedAt = Date.now();
    let requestCount = 0;
    const responseCounts = new Map<number, number>();
    const recentLatenciesMs: number[] = [];
    const finish = (response: Response, requestStartedAt: number, requestId?: string): Response => {
      requestCount++;
      responseCounts.set(response.status, (responseCounts.get(response.status) ?? 0) + 1);
      recentLatenciesMs.push(Date.now() - requestStartedAt);
      if (recentLatenciesMs.length > 1_000) recentLatenciesMs.shift();
      if (!requestId) return response;
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
    mcp = createMcpHandler(
      (context) => buildServer(context, {
        profile: { kind: "catalog", bindings, principalId },
      }),
      {
        legacy: "stateless",
        responseMode: "auto",
        onerror: (error) => logger.error("gateway", "mcp_request_failed", {}, error),
      }
    );

    const allowedHosts = [...new Set([...localhostAllowedHostnames(), ...options.allowedHosts])];
    const explicitOrigins = options.allowedOrigins.map((origin) => new URL(origin).origin.toLowerCase());
    const allowedOriginHosts = [...new Set(
      explicitOrigins.length > 0
        ? explicitOrigins.map((origin) => new URL(origin).hostname)
        : localhostAllowedOrigins()
    )];
    const route = {
      fetch: async (request: Request): Promise<Response> => {
        const requestStartedAt = Date.now();
        const requestId = randomUUID();
        const url = new URL(request.url);
        const rejectedHost = hostHeaderValidationResponse(request, allowedHosts);
        if (rejectedHost) return finish(rejectedHost, requestStartedAt, requestId);
        if (url.pathname === "/healthz" && request.method === "GET") {
          const registeredWorkspaces = (await registry.listSafe()).length;
          return new Response(JSON.stringify({
            status: "ok",
            version: PRODUCT_VERSION,
            protocolVersion: MCP_PROTOCOL_VERSION,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
            workspaces: { registered: registeredWorkspaces, active: bindings.activeWorkspaceCount() },
            bindings: bindings.activeBindingCount(),
          }), {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        const metricsRequest = url.pathname === "/metrics" && request.method === "GET";
        if (url.pathname !== options.httpPath && !metricsRequest) {
          return finish(new Response("Not found", { status: 404 }), requestStartedAt, requestId);
        }

        const rejectedOrigin = originValidationResponse(request, allowedOriginHosts);
        if (rejectedOrigin) return finish(rejectedOrigin, requestStartedAt, requestId);
        if (request.headers.has("origin") && explicitOrigins.length > 0) {
          const suppliedOrigin = request.headers.get("origin");
          let normalizedOrigin = "";
          try {
            normalizedOrigin = suppliedOrigin ? new URL(suppliedOrigin).origin.toLowerCase() : "";
          } catch {
            normalizedOrigin = "";
          }
          if (!explicitOrigins.includes(normalizedOrigin)) {
            return finish(new Response("Forbidden", { status: 403 }), requestStartedAt, requestId);
          }
        }
        if (!bearerMatches(request, credential)) {
          return finish(new Response("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
          }), requestStartedAt, requestId);
        }

        if (metricsRequest) {
          const sortedLatencies = [...recentLatenciesMs].sort((left, right) => left - right);
          const percentile = (ratio: number) => sortedLatencies.length === 0
            ? 0
            : sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * ratio))]!;
          return finish(new Response(JSON.stringify({
            requests: requestCount,
            responses: Object.fromEntries([...responseCounts.entries()].map(([status, count]) => [String(status), count])),
            activeRequests,
            activeWorkspaces: activeByWorkspace.size,
            latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
          }), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }), requestStartedAt, requestId);
        }

        if (activeRequests >= DEFAULT_MAX_CONCURRENT_REQUESTS) {
          return finish(
            new Response("Gateway busy", { status: 503, headers: { "retry-after": "1" } }),
            requestStartedAt,
            requestId
          );
        }

        const resolution = await resolveRequestWorkspace(request, bindings, principalId);
        const context = resolution.context ?? createUnauthorizedWorkspaceContext();
        const workspaceKey = context.authorized ? context.workspaceId : undefined;
        const workspaceActive = workspaceKey ? activeByWorkspace.get(workspaceKey) ?? 0 : 0;
        if (workspaceKey && workspaceActive >= DEFAULT_MAX_CONCURRENT_WORKSPACE_REQUESTS) {
          return finish(
            new Response("Workspace busy", { status: 429, headers: { "retry-after": "1" } }),
            requestStartedAt,
            requestId
          );
        }
        activeRequests++;
        if (workspaceKey) activeByWorkspace.set(workspaceKey, workspaceActive + 1);
        try {
          const response = await runWithWorkspaceContext(context, () => mcp!.fetch(request));
          return finish(
            await qualifyWorkspaceResponse(response, context.authorized ? resolution.binding : undefined),
            requestStartedAt,
            requestId
          );
        } finally {
          activeRequests--;
          if (workspaceKey) {
            const remaining = (activeByWorkspace.get(workspaceKey) ?? 1) - 1;
            if (remaining > 0) activeByWorkspace.set(workspaceKey, remaining);
            else activeByWorkspace.delete(workspaceKey);
          }
        }
      },
    };
    const nodeHandler = toNodeHandler(route, {
      onerror: (error) => logger.error("gateway", "http_adapter_failed", {}, error),
    });

    server = http.createServer((req, res) => {
      const contentLength = Number(req.headers["content-length"] ?? 0);
      const bodyLimit = dependencies.bodyLimit ?? DEFAULT_BODY_LIMIT;
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > bodyLimit) {
        res.writeHead(413, { "content-type": "text/plain", connection: "close" });
        res.end("Request too large");
        return;
      }
      void nodeHandler(limitedRequest(req, bodyLimit), res).catch((error: unknown) => {
        logger.error("gateway", "node_handler_failed", {}, error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal server error");
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      const listenHost = options.host === "[::1]" ? "::1" : options.host;
      server!.listen(options.port, listenHost, () => {
        server!.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP gateway did not expose a TCP address.");
    const endpointHost = options.host.includes(":") && !options.host.startsWith("[")
      ? `[${options.host}]`
      : options.host;
    const endpoint = `http://${endpointHost}:${address.port}${options.httpPath}`;
    await state.publish(endpoint, nonce);

    void discoverWorkspaceFromCwd().then((workspace) => registry.register(workspace.root, "automatic")).catch(() => undefined);
    logger.info("gateway", "ready", { host: options.host, port: address.port, path: options.httpPath });

    let closing: Promise<void> | undefined;
    return {
      endpoint,
      close: () => {
        if (closing) return closing;
        closing = (async () => {
          bindings.revokeAll();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
          await mcp!.close();
          await state.release(nonce, ownership);
        })();
        return closing;
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await mcp?.close().catch(() => undefined);
    await state.release(nonce, ownership);
    throw error;
  }
}
