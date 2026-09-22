import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_PROTOCOL_VERSION } from "../src/product.js";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";

// Every embedding request is forwarded to the configured provider, with no cache,
// substitute vectors or subtraction of provider time from end-to-end measurements.
const argument = (name: string, fallback: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
assert.ok(process.argv.includes("--live"), "Pass --live to run actual local embeddings.");
const configPath = argument("config", path.join(os.homedir(), ".claude.json"));
const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { mcpServers: Record<string, { env?: Record<string, string> }> };
const configuredEnv = config.mcpServers[argument("server", "knowledge-rail")]?.env;
assert.ok(configuredEnv, "Configured server environment is missing.");
const embeddingEnv = Object.fromEntries(Object.entries(configuredEnv).filter(([key]) => key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_")));
for (const key of Object.keys(process.env)) if (key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_")) delete process.env[key];
Object.assign(process.env, embeddingEnv);
const actualProvider = configuredEmbeddingProvider();
assert.ok(actualProvider && embeddingEnv.KNOWLEDGE_RAIL_EMBEDDING_BASE_URL, "An HTTP embedding provider must be configured.");
const upstream = new URL(`${embeddingEnv.KNOWLEDGE_RAIL_EMBEDDING_BASE_URL.replace(/\/+$/, "")}/embeddings`);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname), "This benchmark only forwards to a local provider.");
const baseline = path.resolve(argument("baseline", "/private/tmp/knowledgerail-290-baseline"));
const current = path.resolve(argument("runtime", "."));
const iterations = Number(argument("iterations", "3"));
assert.ok(Number.isInteger(iterations) && iterations > 0 && iterations <= 10);
const objective = argument("query", "Come vengono risolti gli import e i riferimenti tra file del progetto?");
const records = await getWikiPageRecords(path.resolve(argument("wiki", "wiki")), false, { persist: false });
const documentTexts = new Set(records.flatMap((record) => record.passages.map((p) => `${p.heading}\n${p.text}`.normalize("NFC").trim())));
type RequestSample = { phase: string; documents: number; queries: number; elapsedMs?: number; status?: number };
const requests: RequestSample[] = [];
let phase = "setup";
const proxy = createServer(async (request, response) => {
  const start = performance.now();
  const sample: RequestSample = { phase, documents: 0, queries: 0 };
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const { input } = JSON.parse(body.toString("utf8")) as { input: string[] };
    for (const text of input) documentTexts.has(text) ? sample.documents++ : sample.queries++;
    requests.push(sample);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (embeddingEnv.KNOWLEDGE_RAIL_EMBEDDING_API_KEY) headers.authorization = `Bearer ${embeddingEnv.KNOWLEDGE_RAIL_EMBEDDING_API_KEY}`;
    const result = await fetch(upstream, { method: "POST", headers, body,
      signal: AbortSignal.timeout(Number(embeddingEnv.KNOWLEDGE_RAIL_EMBEDDING_TIMEOUT_MS ?? 60_000)) });
    const bytes = Buffer.from(await result.arrayBuffer());
    sample.elapsedMs = performance.now() - start; sample.status = result.status;
    response.writeHead(result.status, { "content-type": "application/json" }); response.end(bytes);
  } catch (error) {
    sample.elapsedMs = performance.now() - start; sample.status = 502;
    response.writeHead(502); response.end();
    process.stderr.write(`Embedding proxy failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address(); assert.ok(address && typeof address !== "string");
const proxyBaseUrl = `http://127.0.0.1:${address.port}/v1`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-ollama-lifecycle-"));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshots = () => {
  const samples = requests.filter((request) => request.phase === phase);
  return { requests: samples.length, documents: samples.reduce((n, r) => n + r.documents, 0),
    queries: samples.reduce((n, r) => n + r.queries, 0),
    providerElapsedMs: samples.reduce((n, r) => n + (r.elapsedMs ?? 0), 0),
    unfinishedRequests: samples.filter((r) => r.elapsedMs === undefined).length,
    errors: samples.filter((r) => r.status !== undefined && r.status !== 200).length };
};
const cases = [{ label: "2.8.7", runtime: baseline, directory: path.join(root, "before"), modern: false, dtype: "f32" },
  { label: "2.9.0-f32", runtime: current, directory: path.join(root, "after-f32"), modern: true, dtype: "f32" },
  { label: "2.9.0-i8", runtime: current, directory: path.join(root, "after-i8"), modern: true, dtype: "i8" }];
const output: Record<string, unknown>[] = [];
async function connect(item: typeof cases[number]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_") && !key.startsWith("KNOWLEDGE_RAIL_STATIC_"))) as Record<string, string>;
  Object.assign(env, embeddingEnv, { KNOWLEDGE_RAIL_EMBEDDING_BASE_URL: proxyBaseUrl,
    KNOWLEDGE_RAIL_LOG_LEVEL: "error", KNOWLEDGE_RAIL_USAGE_RANKING: "0", KNOWLEDGE_RAIL_SEMANTIC_DTYPE: item.dtype });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(item.runtime, "dist/index.js")], cwd: item.directory, env, stderr: "pipe" });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "ollama-lifecycle-eval", version: "1" }, { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } });
  const start = performance.now();
  try { await client.connect(transport); await client.listTools(); return { client, start, readyMs: performance.now() - start }; }
  catch (error) { await client.close(); throw error; }
}
async function context(client: Client) {
  const start = performance.now();
  const result = await client.callTool({ name: "knowledge_context", arguments: { mode: "task", intent: "understand", objective,
    max_evidence: 4, response_detail: "compact" } }, { timeout: 180_000 });
  assert.ok(!result.isError, JSON.stringify(result));
  const structured = result.structuredContent as { retrieval?: { coverageMode?: string; coverageSufficient?: boolean; coverageWarnings?: string[] }; evidence?: Array<{ uri: string; passages?: unknown }> };
  const sample = { contextMs: performance.now() - start, ...snapshots(), coverage: structured.retrieval,
    evidenceUris: structured.evidence?.map((e) => e.uri), evidenceDigest: digest(structured.evidence?.map((e) => ({ uri: e.uri, passages: e.passages }))) };
  assert.equal(sample.errors, 0, "A failed provider must not be reported as a successful fast response.");
  return sample;
}
const record = (sample: Record<string, unknown>) => { output.push(sample); process.stdout.write(`${JSON.stringify(sample)}\n`); };
try {
  for (const item of cases) {
    await fs.mkdir(path.join(item.directory, "wiki"), { recursive: true });
    await fs.writeFile(path.join(item.directory, "package.json"), "{}");
    for (const page of records) {
      const file = path.join(item.directory, "wiki", page.path); await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, page.raw);
    }
  }
  // A common, explicit precondition; no shared model is unloaded behind the user's back.
  const warmupStart = performance.now(); await actualProvider.embedQuery(objective);
  record({ phase: "configuration", provider: actualProvider.descriptor, pages: records.length,
    passages: records.reduce((n, r) => n + r.passages.length, 0), corpusDigest: digest(records.map((r) => [r.path, r.raw])),
    objective, warmupMs: performance.now() - warmupStart,
    conditions: "Real configured Ollama, already loaded after this measured warmup. Temporary identical copies of the actual wiki. No response cache, no vector substitution. Initial indexes absent. Usage reranking disabled in both versions." });
  for (const item of cases) {
    phase = `${item.label}:first_use`;
    const connection = await connect(item);
    try {
      const sample = await context(connection.client);
      record({ phase, version: item.label, readyMs: connection.readyMs, startupThroughContextMs: performance.now() - connection.start, ...sample });
      if (item.modern) {
        const deadline = performance.now() + 180_000;
        while (true) {
          const status = await connection.client.callTool({ name: "knowledge_admin", arguments: { action: "status" } });
          assert.ok(!status.isError, JSON.stringify(status));
          const semantic = (status.structuredContent as { knowledgeRuntime?: { semantic?: { state?: string; pendingPages?: number } } })?.knowledgeRuntime?.semantic;
          if (semantic?.state === "ready" && semantic.pendingPages === 0) break;
          assert.notEqual(semantic?.state, "degraded", "Background indexing failed.");
          assert.ok(performance.now() < deadline, "Background index failed to become ready.");
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
      }
      record({ phase: `${phase}:index_ready`, version: item.label, elapsedSinceStartupMs: performance.now() - connection.start, ...snapshots() });
      phase = `${item.label}:same_process`;
      record({ phase, version: item.label, ...await context(connection.client) });
    } finally { await connection.client.close(); }
  }
  for (let run = 0; run < iterations; run++) for (const item of run % 2 ? [...cases].reverse() : cases) {
    phase = `${item.label}:restart:${run}`;
    const connection = await connect(item);
    try {
      const sample = await context(connection.client);
      assert.equal(sample.coverage?.coverageMode, "semantic", "Restart comparison requires full semantic coverage.");
      if (item.modern) assert.equal(sample.documents, 0, "Unchanged documents must be reused across processes.");
      record({ phase, version: item.label, readyMs: connection.readyMs, startupThroughContextMs: performance.now() - connection.start, ...sample });
    } finally { await connection.client.close(); }
  }
  for (const item of cases) {
    const samples = output.filter((s) => String(s.phase).startsWith(`${item.label}:restart:`));
    const median = (field: string) => samples.map((s) => Number(s[field])).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    record({ phase: "restart_summary", version: item.label, iterations, startupThroughContextMs: median("startupThroughContextMs"),
      contextMs: median("contextMs"), readyMs: median("readyMs"), providerElapsedMs: median("providerElapsedMs"),
      documentInputs: samples.map((s) => s.documents), queryInputs: samples.map((s) => s.queries), evidenceDigests: samples.map((s) => s.evidenceDigest) });
  }
} finally {
  proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
}
