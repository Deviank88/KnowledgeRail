import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  BINDING_FORMAT_VERSION,
  MCP_PROTOCOL_VERSION,
  PRODUCT_VERSION,
  REGISTRY_SCHEMA_VERSION,
} from "../src/product.js";

type Scenario = "direct-stdio" | "desktop-cold" | "desktop-existing" | "desktop-stale" | "npx-desktop";

interface StartupSample {
  initializeMs: number;
  toolsListMs: number;
  totalReadyMs: number;
  firstStderrMs: number | null;
  shutdownMs: number;
  maxReportedRssMb: number | null;
  startupEvents: string[];
  phaseElapsedMs: Record<string, number>;
}

interface Distribution {
  iterations: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    iterations: sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
  };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not allocate a loopback benchmark port.");
  return port;
}

async function waitForJson(filePath: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

async function runClient(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<StartupSample> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
    stderr: "pipe",
  });
  const startedAt = performance.now();
  let firstStderrMs: number | null = null;
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    if (firstStderrMs === null) firstStderrMs = performance.now() - startedAt;
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "knowledge-rail-startup-bench", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
  );

  try {
    await withTimeout(client.connect(transport), 10_000, "MCP initialize");
    const initializedAt = performance.now();
    const tools = await withTimeout(client.listTools(), 10_000, "MCP tools/list");
    const readyAt = performance.now();
    if (tools.tools.length < 8) throw new Error(`Unexpected tool catalog size: ${tools.tools.length}.`);
    const shutdownStartedAt = performance.now();
    await withTimeout(client.close(), 5_000, "MCP shutdown");
    const shutdownMs = performance.now() - shutdownStartedAt;
    const records = stderr.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const startupRecords = records.filter((record) => record.subsystem === "startup");
    const rssValues = startupRecords
      .map((record) => record.rssMb)
      .filter((value): value is number => typeof value === "number");
    const phaseElapsedMs = Object.fromEntries(startupRecords.flatMap((record) =>
      typeof record.event === "string" && typeof record.elapsedMs === "number"
        ? [[record.event, record.elapsedMs] as const]
        : []));
    return {
      initializeMs: initializedAt - startedAt,
      toolsListMs: readyAt - initializedAt,
      totalReadyMs: readyAt - startedAt,
      firstStderrMs,
      shutdownMs,
      maxReportedRssMb: rssValues.length > 0 ? Math.max(...rssValues) : null,
      startupEvents: startupRecords
        .map((record) => record.event)
        .filter((value): value is string => typeof value === "string"),
      phaseElapsedMs,
    };
  } catch (error) {
    await withTimeout(client.close(), 2_500, "failed sample cleanup").catch(() => undefined);
    throw new Error(
      `Startup sample failed: ${error instanceof Error ? error.message : String(error)}\n${stderr}`
    );
  }
}

async function startGateway(serverPath: string, stateDirectory: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverPath, "--transport", "http", "--port", String(port)], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      KNOWLEDGE_RAIL_STATE_DIR: stateDirectory,
      KNOWLEDGE_RAIL_LOG_LEVEL: "error",
    },
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("error", (error) => { throw error; });
  try {
    await waitForJson(path.join(stateDirectory, "gateway.json"));
    return child;
  } catch (error) {
    await stopChild(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }
}

async function writeStaleRendezvous(stateDirectory: string, endpointPort: number): Promise<void> {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDirectory, "gateway.json"), `${JSON.stringify({
    pid: 2_147_483_647,
    nonce: "stale-startup-benchmark",
    endpoint: `http://127.0.0.1:${endpointPort}/mcp`,
    productVersion: PRODUCT_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    bindingFormatVersion: BINDING_FORMAT_VERSION,
    registrySchemaVersion: REGISTRY_SCHEMA_VERSION,
    startedAt: new Date(0).toISOString(),
  })}\n`, { mode: 0o600 });
}

function summarize(scenario: Scenario, samples: readonly StartupSample[]): Record<string, unknown> {
  const presentFirstStderr = samples
    .map((sample) => sample.firstStderrMs)
    .filter((value): value is number => value !== null);
  const presentRss = samples
    .map((sample) => sample.maxReportedRssMb)
    .filter((value): value is number => value !== null);
  const phaseNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.phaseElapsedMs)))];
  return {
    scenario,
    initialize: distribution(samples.map((sample) => sample.initializeMs)),
    toolsList: distribution(samples.map((sample) => sample.toolsListMs)),
    totalReady: distribution(samples.map((sample) => sample.totalReadyMs)),
    firstStderr: presentFirstStderr.length > 0 ? distribution(presentFirstStderr) : null,
    shutdown: distribution(samples.map((sample) => sample.shutdownMs)),
    reportedRssMb: presentRss.length > 0 ? distribution(presentRss) : null,
    observedStartupEvents: [...new Set(samples.flatMap((sample) => sample.startupEvents))],
    phases: Object.fromEntries(phaseNames.map((name) => [
      name,
      distribution(samples.flatMap((sample) =>
        sample.phaseElapsedMs[name] === undefined ? [] : [sample.phaseElapsedMs[name]])),
    ])),
  };
}

function enforceStartupGate(reports: readonly Record<string, unknown>[], iterations: number): void {
  const byScenario = new Map(reports.map((report) => [report["scenario"] as Scenario, report]));
  for (const report of reports) {
    const scenario = report["scenario"] as Scenario;
    const totalReady = report["totalReady"] as Distribution;
    if (totalReady.iterations !== iterations || !Number.isFinite(totalReady.p95Ms) || totalReady.p95Ms <= 0) {
      throw new Error(`Startup gate for ${scenario} did not collect a valid distribution.`);
    }
    // Five seconds is a protocol-availability safety ceiling, not a claimed
    // performance target. Relative gates below catch desktop-path regressions
    // without pretending hosted Linux/macOS/Windows runners are identical.
    if (totalReady.p95Ms > 5_000) {
      throw new Error(`Startup gate for ${scenario} exceeded 5 s p95: ${totalReady.p95Ms} ms.`);
    }
  }
  const direct = byScenario.get("direct-stdio")?.["totalReady"] as Distribution | undefined;
  for (const scenario of ["desktop-cold", "desktop-existing", "desktop-stale"] as const) {
    const desktop = byScenario.get(scenario)?.["totalReady"] as Distribution | undefined;
    if (direct && desktop && desktop.p95Ms > direct.p95Ms * 3 + 250) {
      throw new Error(
        `Startup gate for ${scenario} regressed relative to direct stdio: ${desktop.p95Ms} vs ${direct.p95Ms} ms.`
      );
    }
  }
}

async function main(): Promise<void> {
  const iterations = positiveInteger(process.env["STARTUP_BENCH_ITERATIONS"], 30);
  const serverPath = path.resolve(process.env["STARTUP_BENCH_SERVER"] ?? "dist/index.js");
  await fs.access(serverPath);
  const scenarioValues = (process.env["STARTUP_BENCH_SCENARIOS"] ?? "direct-stdio,desktop-cold,desktop-existing")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as Scenario[];
  const allowed = new Set<Scenario>([
    "direct-stdio", "desktop-cold", "desktop-existing", "desktop-stale", "npx-desktop",
  ]);
  if (scenarioValues.some((scenario) => !allowed.has(scenario))) {
    throw new Error(`Unknown startup benchmark scenario: ${scenarioValues.find((scenario) => !allowed.has(scenario))}.`);
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-startup-bench-"));
  const projectDirectory = path.join(temporaryRoot, "project");
  await fs.mkdir(projectDirectory);
  await fs.writeFile(path.join(projectDirectory, "package.json"), "{}\n");
  const reports: Record<string, unknown>[] = [];

  try {
    for (const scenario of scenarioValues) {
      const samples: StartupSample[] = [];
      let sharedGateway: ChildProcess | undefined;
      let sharedState: string | undefined;
      try {
        if (scenario === "desktop-existing") {
          sharedState = path.join(temporaryRoot, "existing-gateway-state");
          sharedGateway = await startGateway(serverPath, sharedState, await availablePort());
        }
        for (let iteration = 0; iteration < iterations; iteration++) {
          const stateDirectory = sharedState ?? path.join(temporaryRoot, `${scenario}-${iteration}`);
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            KNOWLEDGE_RAIL_STATE_DIR: stateDirectory,
            KNOWLEDGE_RAIL_LOG_LEVEL: "info",
            KNOWLEDGE_RAIL_STARTUP_TIMINGS: "1",
          };
          let unresponsive: net.Server | undefined;
          const unresponsiveSockets = new Set<net.Socket>();
          try {
            if (scenario === "desktop-stale") {
              const stalePort = await availablePort();
              unresponsive = net.createServer((socket) => {
                unresponsiveSockets.add(socket);
                socket.once("close", () => unresponsiveSockets.delete(socket));
              });
              await new Promise<void>((resolve, reject) => {
                unresponsive!.once("error", reject);
                unresponsive!.listen(stalePort, "127.0.0.1", resolve);
              });
              await writeStaleRendezvous(stateDirectory, stalePort);
            }
            if (scenario !== "direct-stdio") {
              env["KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT"] = String(await availablePort());
            }
            const command = scenario === "npx-desktop" ? "npx" : process.execPath;
            const args = scenario === "npx-desktop"
              ? ["-y", `knowledge-rail@${process.env["STARTUP_BENCH_NPX_VERSION"] ?? PRODUCT_VERSION}`, "desktop"]
              : [serverPath, ...(scenario === "direct-stdio" ? [] : ["desktop"])];
            samples.push(await runClient({
              command,
              args,
              cwd: scenario === "direct-stdio" ? projectDirectory : os.tmpdir(),
              env,
            }));
          } finally {
            if (unresponsive) {
              for (const socket of unresponsiveSockets) socket.destroy();
              await new Promise<void>((resolve) => unresponsive!.close(() => resolve()));
            }
          }
        }
      } finally {
        if (sharedGateway) await stopChild(sharedGateway);
      }
      reports.push(summarize(scenario, samples));
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }

  if (/^(1|true|yes)$/i.test(process.env["STARTUP_BENCH_GATE"] ?? "")) {
    enforceStartupGate(reports, iterations);
  }

  process.stdout.write(`${JSON.stringify({
    productVersion: PRODUCT_VERSION,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    iterations,
    reports,
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
}
