import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { GoldenEmbeddingProvider } from "./semantic-retrieval-eval.js";
import { loadHybridFixture, materializeHybridFixture } from "./hybrid-retrieval-quality-eval.js";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { compactStructuredContext, stableContextPayload } from "../src/tools/context-tools.js";
import { clearSemanticIndexes, configuredSemanticIndex, PersistentSemanticIndex } from "../src/core/semantic/index.js";
import { getWikiPageRecords, clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";

// Deterministic functional acceptance. Real-provider latency is measured separately.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-lifecycle-"));
const golden = new GoldenEmbeddingProvider();
const fixture = JSON.parse(await fs.readFile("benchmarks/fixtures/semantic-retrieval-golden.json", "utf8"));
const base = await loadHybridFixture(path.resolve("benchmarks/fixtures", fixture.baseFixture));
const queries: Array<{ id: string; query: string; expectedPaths: string[] }> = [...base.queries.map((q) => ({ id: q.id, query: q.query, expectedPaths: [...new Set(q.relevant.map((r) => r.path))] })), ...fixture.semanticOnlyQueries];
const documents = new Set<string>(); let documentInputs = 0;
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
    const docs = input.filter((text) => documents.has(text)).length; documentInputs += docs;
    if (docs) await new Promise<void>((resolve) => setTimeout(resolve, 120));
    const data = await Promise.all(input.map(async (text, index) => ({ index, embedding: documents.has(text) ? (await golden.embedDocuments([text]))[0]! : await golden.embedQuery(text) })));
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data }));
  } catch { response.writeHead(500); response.end(); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const oldEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("KNOWLEDGE_RAIL_EMBEDDING_")) delete process.env[key];
process.env.KNOWLEDGE_RAIL_USAGE_RANKING = "0";
const context = async (query: string) => stableContextPayload(await compileTaskContext({ wikiRoot: root, intent: "understand", objective: query, maxEvidence: 8 }));
const snapshot = async (query: string) => { const full = await context(query); return { full, compact: compactStructuredContext(full) }; };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  await materializeHybridFixture(root, base);
  for (const page of fixture.semanticPages) {
    const file = path.join(root, page.path); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: ${page.title}\ntype: ${page.type}\n---\n\n${page.body}`);
  }
  const probe = queries[queries.length - 1]!;
  const lexical = await context(probe.query);
  await fs.writeFile(path.join(root, "zz-background.md"), "---\ntitle: Zeta\ntype: analysis\n---\n\n" + Array.from({ length: 1000 }, (_, i) => `## Zeta ${i}\n\nOpaque zeta value ${i}.`).join("\n\n"));
  clearRetrievalIndexes();
  for (const record of await getWikiPageRecords(root, true, { persist: false })) for (const p of record.passages) documents.add(`${p.heading}\n${p.text}`.normalize("NFC").trim());
  Object.assign(process.env, { KNOWLEDGE_RAIL_EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`, KNOWLEDGE_RAIL_EMBEDDING_MODEL: "golden-lifecycle", KNOWLEDGE_RAIL_EMBEDDING_MODEL_VERSION: "1", KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS: "8" });
  const start = performance.now(); const partial = await context(probe.query); const firstContextMs = performance.now() - start;
  assert.equal(partial.retrieval.coverageMode, "semantic-partial");
  assert.ok(firstContextMs < 2500, `Controlled first-context budget exceeded: ${firstContextMs}`);
  const index = await configuredSemanticIndex(root, { background: true }); assert.ok(index); await index.idle();
  assert.equal(index.descriptor.state, "ready");
  const ready = await context(probe.query);
  const recall = (c: typeof ready) => probe.expectedPaths.filter((p) => c.evidence.some((e) => e.path === p)).length / probe.expectedPaths.length;
  assert.equal(recall(ready), 1, "The ready semantic-only control must recover its independently labeled page.");
  assert.ok(recall(partial) >= recall(lexical) && recall(partial) <= recall(ready));
  // Restore the unmodified golden corpus for complete ready/restart parity.
  await fs.unlink(path.join(root, "zz-background.md")); clearRetrievalIndexes();
  await configuredSemanticIndex(root);
  const expected = []; for (const query of queries) expected.push(await snapshot(query.query));
  const count = documentInputs; const restarts = [];
  for (let run = 0; run < 2; run++) {
    clearWorkspaceStates();
    const actual = []; for (const query of queries) actual.push(await snapshot(query.query));
    assert.deepEqual(actual, expected, "Entire compact context, including evidence and gaps, must survive reload unchanged.");
    assert.equal(documentInputs, count);
    restarts.push({ run, digest: digest(actual), documentInputs: documentInputs - count });
  }
  console.log(JSON.stringify({ phase: "context", goldenQueries: queries.length, firstContextMs, partialMode: partial.retrieval.coverageMode,
    recall: { lexical: recall(lexical), partial: recall(partial), ready: recall(ready) }, expectedDigest: digest(expected), restarts,
    limitation: "Deterministic provider and controlled delay; tests lifecycle/parity, not Ollama latency or model accuracy." }));
  clearWorkspaceStates();
  const loadRoot = path.join(root, "load"); await fs.mkdir(loadRoot);
  const raw = "---\ntitle: Load\ntype: analysis\n---\n\n" + Array.from({ length: 1000 }, (_, i) => `## Load ${i}\n\nUnique load fact ${i}.`).join("\n\n");
  await fs.writeFile(path.join(loadRoot, "load.md"), raw);
  const loadRecords = await getWikiPageRecords(loadRoot, true, { persist: false });
  let calls = 0; const seen = new Set<string>();
  const provider: EmbeddingProvider = { descriptor: golden.descriptor,
    async embedDocuments(texts) { calls += texts.length; texts.forEach((text) => { assert.ok(!seen.has(text), "Duplicate embedding"); seen.add(text); }); await new Promise<void>((resolve) => setTimeout(resolve, 40)); return golden.embedDocuments(texts); },
    async embedQuery(text) { await new Promise<void>((resolve) => setTimeout(resolve, 2)); return golden.embedQuery(text); } };
  const loadIndex = new PersistentSemanticIndex(loadRoot, provider); await loadIndex.startBackground(loadRecords);
  const latencies: number[] = []; const loadStart = performance.now(); let completed = false;
  const done = loadIndex.idle().then(() => { completed = true; });
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (!completed) {
      assert.ok(performance.now() - loadStart < 10000, "Query traffic starved background work");
      const start = performance.now(); await loadIndex.search("Maintain responsiveness amid sudden popularity surges", 5); latencies.push(performance.now() - start);
    }
  }));
  await done; assert.equal(loadIndex.descriptor.state, "ready"); assert.equal(calls, 1000); assert.ok(Math.max(...latencies) < 1000);
  console.log(JSON.stringify({ phase: "continuous-queries", passages: calls, uniqueInputs: seen.size, queries: latencies.length, elapsedMs: performance.now() - loadStart, maxQueryMs: Math.max(...latencies), state: loadIndex.descriptor.state }));
  loadIndex.dispose();
} finally {
  clearSemanticIndexes(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv);
  await fs.rm(root, { recursive: true, force: true });
}
