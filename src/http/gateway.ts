import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
    const bindings = new WorkspaceBindingManager(registry);
    let activeRequests = 0;
    const activeByWorkspace = new Map<string, number>();
    mcp = createMcpHandler(
      (context) => buildServer(context, {
        profile: { kind: "catalog", bindings, principalId },
      }),
      {
        legacy: "stateless",
        responseMode: "auto",
        onerror: () => process.stderr.write("[knowledge-rail] MCP HTTP request failed.\n"),
      }
    );

    const allowedHosts = [...new Set([...localhostAllowedHostnames(), ...options.allowedHosts])];
    const allowedOriginHosts = [...new Set([
      ...localhostAllowedOrigins(),
      ...options.allowedOrigins.map((origin) => new URL(origin).hostname),
    ])];
    const route = {
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (url.pathname === "/healthz" && request.method === "GET") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        if (url.pathname !== options.httpPath) return new Response("Not found", { status: 404 });

        const rejectedHost = hostHeaderValidationResponse(request, allowedHosts);
        if (rejectedHost) return rejectedHost;
        const rejectedOrigin = originValidationResponse(request, allowedOriginHosts);
        if (rejectedOrigin) return rejectedOrigin;
        if (request.headers.has("origin") && options.allowedOrigins.length > 0) {
          const origin = request.headers.get("origin")?.toLowerCase();
          const defaultLocal = origin ? localhostAllowedOrigins().includes(new URL(origin).hostname) : false;
          if (!defaultLocal && (!origin || !options.allowedOrigins.includes(origin))) {
            return new Response("Forbidden", { status: 403 });
          }
        }
        if (!bearerMatches(request, credential)) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
          });
        }

        if (activeRequests >= DEFAULT_MAX_CONCURRENT_REQUESTS) {
          return new Response("Gateway busy", { status: 503, headers: { "retry-after": "1" } });
        }

        const resolution = await resolveRequestWorkspace(request, bindings, principalId);
        const context = resolution.context ?? createUnauthorizedWorkspaceContext();
        const workspaceKey = context.authorized ? context.workspaceId : undefined;
        const workspaceActive = workspaceKey ? activeByWorkspace.get(workspaceKey) ?? 0 : 0;
        if (workspaceKey && workspaceActive >= DEFAULT_MAX_CONCURRENT_WORKSPACE_REQUESTS) {
          return new Response("Workspace busy", { status: 429, headers: { "retry-after": "1" } });
        }
        activeRequests++;
        if (workspaceKey) activeByWorkspace.set(workspaceKey, workspaceActive + 1);
        try {
          const response = await runWithWorkspaceContext(context, () => mcp!.fetch(request));
          return await qualifyWorkspaceResponse(response, context.authorized ? resolution.binding : undefined);
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
      onerror: () => process.stderr.write("[knowledge-rail] HTTP adapter request failed.\n"),
    });

    server = http.createServer((req, res) => {
      const contentLength = Number(req.headers["content-length"] ?? 0);
      const bodyLimit = dependencies.bodyLimit ?? DEFAULT_BODY_LIMIT;
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > bodyLimit) {
        res.writeHead(413, { "content-type": "text/plain", connection: "close" });
        res.end("Request too large");
        return;
      }
      void nodeHandler(limitedRequest(req, bodyLimit), res).catch(() => {
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
    process.stderr.write(`[knowledge-rail] Local HTTP gateway ready on ${options.host}:${address.port}${options.httpPath}.\n`);

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
