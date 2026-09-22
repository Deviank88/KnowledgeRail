import assert from "node:assert/strict";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { buildServer } from "../src/mcp/server.js";

/** Release versions differ legitimately in MCP envelope metadata. Compare all
 * evidence/diagnostics and the remaining envelope without masking payload fields. */
export function mcpResultForParity<T>(result: T): T {
  const copy = structuredClone(result);
  const meta = (copy as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const info = meta?.["io.modelcontextprotocol/serverInfo"];
  if (info && typeof info === "object") delete (info as { version?: unknown }).version;
  return copy;
}

/** Actual MCP dispatch with JSON serialization in both directions. Deliberately
 * excludes OS pipes, a host client and model calls; report those as unobserved. */
export async function codeEfficiencyHarness(build: typeof buildServer) {
  let nextId = 0;
  let requestBytes = 0, responseBytes = 0;
  const waiting = new Map<number, (message: JSONRPCMessage) => void>();
  const wire: Transport = {
    async start() {},
    async close() { wire.onclose?.(); },
    async send(message) {
      const text = JSON.stringify(message);
      responseBytes += Buffer.byteLength(text);
      const decoded = JSON.parse(text) as JSONRPCMessage;
      if ("id" in decoded && typeof decoded.id === "number") waiting.get(decoded.id)?.(decoded);
    },
  };
  const handle = serveStdio((context) => build(context), { transport: wire, legacy: "serve" });
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "code-efficiency-bench", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } });
    requestBytes += Buffer.byteLength(text);
    const message = await new Promise<JSONRPCMessage>((resolve, reject) => {
      const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 30_000);
      waiting.set(id, (value) => { clearTimeout(timeout); waiting.delete(id); resolve(value); });
      try { wire.onmessage?.(JSON.parse(text)); }
      catch (error) { clearTimeout(timeout); waiting.delete(id); reject(error); }
    });
    assert.ok("result" in message, `MCP returned an error: ${JSON.stringify(message)}`);
    const result = message.result as { isError?: boolean; structuredContent?: Record<string, unknown>; contents?: unknown[] };
    assert.ok(!result.isError, `Public operation failed: ${JSON.stringify(result)}`);
    return result;
  };
  return {
    request,
    bytes: () => ({ requestBytes, responseBytes }),
    close: () => handle.close(),
  };
}
