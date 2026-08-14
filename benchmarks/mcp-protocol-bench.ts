import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../src/mcp/server.js";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";

type RpcId = string | number;

interface LatencyStats {
  iterations: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

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
    if (!this.peer?.started || this.peer.closed) throw new Error("MemoryTransport peer is not open");
    const peer = this.peer;
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

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function latencyStats(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations: samples.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function modernMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "knowledge-rail-bench", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function createHarness(): Promise<{
  request(message: JSONRPCRequest): Promise<JSONRPCMessage>;
  notify(message: JSONRPCNotification): Promise<void>;
  close(): Promise<void>;
}> {
  const [peer, wire] = linkedPair();
  const waiters = new Map<RpcId, (message: JSONRPCMessage) => void>();

  peer.onmessage = (message) => {
    if ("method" in message && "id" in message && message.id !== undefined) {
      const request = message as JSONRPCRequest;
      if (request.method === "roots/list") {
        void peer.send({
          jsonrpc: "2.0",
          id: request.id,
          result: { roots: [{ uri: pathToFileURL(process.cwd()).href, name: "benchmark" }] },
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
  const handle = serveStdio((context) => buildServer(context), { transport: wire, legacy: "serve" });

  return {
    request: (message) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(message.id);
        reject(new Error(`Timed out waiting for ${message.method}`));
      }, 5_000);
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
    }),
    notify: (message) => peer.send(message),
    close: async () => {
      await handle.close();
      await peer.close();
    },
  };
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
  if (!("result" in message)) throw new Error(`Expected MCP result: ${JSON.stringify(message)}`);
  return (message as { result: Record<string, unknown> }).result;
}

async function measureEra(era: "modern" | "legacy", iterations: number) {
  const connectSamples: number[] = [];
  const listSamples: number[] = [];
  let catalogBytes = 0;
  let toolCount = 0;

  for (let index = 0; index < iterations; index++) {
    const harness = await createHarness();
    try {
      const connectStart = performance.now();
      if (era === "legacy") {
        await harness.request({
          jsonrpc: "2.0",
          id: `legacy-init-${index}`,
          method: "initialize",
          params: {
            protocolVersion: LEGACY_VERSION,
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: "knowledge-rail-bench", version: "1.0.0" },
          },
        });
        await harness.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
      }
      connectSamples.push(performance.now() - connectStart);

      const listStart = performance.now();
      const response = await harness.request({
        jsonrpc: "2.0",
        id: `${era}-list-${index}`,
        method: "tools/list",
        params: era === "modern" ? { _meta: modernMeta() } : {},
      });
      listSamples.push(performance.now() - listStart);

      const result = resultOf(response);
      const tools = result.tools as unknown[];
      toolCount = Array.isArray(tools) ? tools.length : 0;
      catalogBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    } finally {
      await harness.close();
    }
  }

  return {
    era,
    connect: latencyStats(connectSamples),
    listTools: latencyStats(listSamples),
    toolCount,
    catalogBytes,
  };
}

async function main(): Promise<void> {
  const iterations = positiveInteger(process.env["MCP_BENCH_ITERATIONS"], 30);
  const buildIterations = positiveInteger(process.env["MCP_BUILD_ITERATIONS"], 300);
  const buildSamples: number[] = [];

  for (let index = 0; index < buildIterations; index++) {
    const start = performance.now();
    buildServer({ era: "modern" });
    buildSamples.push(performance.now() - start);
  }

  const report = {
    serverBuild: latencyStats(buildSamples),
    modern: await measureEra("modern", iterations),
    legacy: await measureEra("legacy", iterations),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
