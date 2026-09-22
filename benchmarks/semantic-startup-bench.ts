import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_PROTOCOL_VERSION } from "../src/product.js";
import { parseWikiPageRecord } from "../src/core/page-record.js";
import { OpenAiCompatibleEmbeddingProvider } from "../src/core/semantic/provider.js";

const argument = (name: string, fallback: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runtime = path.resolve(argument("runtime", ".")), scale = Number(argument("scale", "10000")), iterations = Number(argument("iterations", "3"));
const dtype = argument("dtype", "f32");
assert.ok(dtype === "f32" || dtype === "i8");
assert.ok(Number.isInteger(scale) && scale > 0 && scale <= 50000 && Number.isInteger(iterations) && iterations > 0 && iterations <= 20);
const dimensions = 1024, documentTexts = new Set<string>();
let documentCalls = 0, queryCalls = 0;
const vector = (text: string) => { const digest = createHash("sha256").update(text).digest(); return Array.from({ length: dimensions }, (_, i) => (digest[i % digest.length]! - 127.5) / 127.5); };
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
    const data = input.map((text, index) => { if (documentTexts.has(text)) documentCalls++; else queryCalls++; return { index, embedding: vector(text) }; });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data }));
  } catch { response.writeHead(400); response.end(); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const providerDescriptor = new OpenAiCompatibleEmbeddingProvider({ baseUrl, model: "startup-fixture", modelVersion: "1", dimensions }).descriptor;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-startup-")), wikiRoot = path.join(root, "wiki");
try {
  await fs.mkdir(path.join(wikiRoot, "pages"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}");
  const records = [];
  for (let page = 0; page < Math.ceil(scale / 32); page++) {
    const body = Array.from({ length: Math.min(32, scale - page * 32) }, (_, i) => `## Passage ${page * 32 + i}\n\nDocumentary fact ${page * 32 + i}: durable semantic evidence with page provenance.`).join("\n\n");
    const raw = `---\ntitle: Page ${page}\ntype: analysis\n---\n\n${body}`, file = `pages/p${page}.md`;
    await fs.writeFile(path.join(wikiRoot, file), raw);
    records.push(parseWikiPageRecord(file, raw, { mtimeMs: 1, size: Buffer.byteLength(raw) }));
  }
  const { PersistentSemanticIndex } = await import(pathToFileURL(path.join(runtime, "src/core/semantic/index.ts")).href);
  const index = new PersistentSemanticIndex(wikiRoot, { descriptor: providerDescriptor,
    async embedDocuments(texts: string[]) { for (const text of texts) documentTexts.add(text); return texts.map(vector); }, async embedQuery(text: string) { return vector(text); } }, undefined,
    runtime === path.resolve(".") ? { dtype } : true);
  await index.synchronize(records); index.dispose?.();
  const samples: Array<{ readyMs: number; contextMs: number; startupThroughContextMs: number; documentCalls: number; queryCalls: number; coverageMode?: string; evidenceDigest: string }> = [];
  for (let i = 0; i < iterations; i++) {
    documentCalls = 0; queryCalls = 0;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_"))) as Record<string, string>;
    Object.assign(env, { KNOWLEDGE_RAIL_EMBEDDING_BASE_URL: baseUrl, KNOWLEDGE_RAIL_EMBEDDING_MODEL: "startup-fixture", KNOWLEDGE_RAIL_EMBEDDING_MODEL_VERSION: "1", KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS: String(dimensions), KNOWLEDGE_RAIL_SEMANTIC_DTYPE: dtype, KNOWLEDGE_RAIL_LOG_LEVEL: "error" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(runtime, "dist/index.js")], cwd: root, env, stderr: "pipe" });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "semantic-startup-eval", version: "1" }, { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } });
    const start = performance.now();
    try {
      await client.connect(transport); await client.listTools();
      const readyMs = performance.now() - start, queryStart = performance.now();
      const result = await client.callTool({ name: "knowledge_context", arguments: { mode: "task", intent: "understand", objective: "durable semantic evidence", max_evidence: 4, response_detail: "compact" } });
      if (result.isError) throw new Error(JSON.stringify(result));
      const contextMs = performance.now() - queryStart;
      const structured = result.structuredContent as { retrieval?: { coverageMode?: string }; evidence?: Array<{ uri: string }> };
      samples.push({ readyMs, contextMs, startupThroughContextMs: performance.now() - start, documentCalls, queryCalls,
        coverageMode: structured?.retrieval?.coverageMode, evidenceDigest: createHash("sha256").update(JSON.stringify(structured?.evidence?.map((e) => e.uri))).digest("hex") });
      assert.equal(documentCalls, 0, "Persisted unchanged pages must never be embedded again");
      assert.equal(structured?.retrieval?.coverageMode, "semantic");
    } finally { await client.close(); }
  }
  const median = (name: "readyMs" | "contextMs" | "startupThroughContextMs") => samples.map((sample) => sample[name]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  console.log(JSON.stringify({ runtime, scale, dtype, iterations, samples, median: { readyMs: median("readyMs"), contextMs: median("contextMs"), startupThroughContextMs: median("startupThroughContextMs") },
    limitation: "Diagnostic only: fresh MCP processes with synthetic 1024-dimensional embeddings and a deterministic HTTP fixture. Does not measure real Ollama embedding computation; use ollama-lifecycle-bench.ts for end-to-end latency. Filesystem cache may be warm." }));
} finally {
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true });
}
