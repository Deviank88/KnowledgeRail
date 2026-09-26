/** Cross-platform measurements; existing model services remain operator-managed. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { configuredSemanticIndex, clearSemanticIndexes, warmSemanticIndex, semanticIndexStatus } from "../src/core/semantic/index.js";
import { configuredReranker } from "../src/core/reranker.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

const arg = (name: string, fallback?: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = arg("output");
assert.ok(output, "--output=<new JSON file> is required");
const slots = Number(arg("slots", "1"));
assert.ok([1, 4].includes(slots), "--slots labels the operator's external configuration (1 or 4)");
const servicePids = (arg("service-pids", "")!).split(",").filter(Boolean).map(Number);
assert.ok(servicePids.every((pid) => Number.isInteger(pid) && pid > 0));
const samples = Number(arg("queries", "10"));
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 100);
const iterations = Number(arg("iterations", "1"));
assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 10);
const fixtureBytes = await fs.readFile(new URL("./fixtures/semantic-rescoring-292.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  pages: Array<{ path: string; title: string; type: string; body: string }>;
  queries: Array<{ id: string; query: string; language: string; split: string; answerable: boolean; relevant: Array<{ path: string }> }>;
};
const translations = JSON.parse(await fs.readFile(new URL("./fixtures/coverage-diagnostics-292.json", import.meta.url), "utf8")).translations as Record<string, string>;
const queries = fixture.queries.filter((q) => q.answerable).slice(0, samples).map((q) => ({ ...q, query: q.language === "en" ? q.query : translations[q.id]! }));
assert.ok(queries.length && queries.every((q) => q.query));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-runtime-294-"));
const wiki = path.join(root, "wiki");
async function memory() {
  const services = await Promise.all(servicePids.map(async (pid) => {
    try {
      const result = await promisify(execFile)("ps", ["-o", "rss=", "-p", String(pid)]);
      return { pid, rssBytes: Number(result.stdout.trim()) * 1024 };
    } catch { return { pid, unavailable: true }; }
  }));
  return { processRssBytes: process.memoryUsage().rss, services };
}
try {
  for (const page of fixture.pages) {
    const file = path.join(wiki, page.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: ${JSON.stringify(page.title)}\ntype: ${page.type}\n---\n\n${page.body}`);
  }
  const memoryBefore = await memory();
  const setupStarted = performance.now();
  const index = await configuredSemanticIndex(wiki);
  const initialIndexingMs = performance.now() - setupStarted;
  const embeddingProvider = index?.descriptor.provider;
  clearSemanticIndexes(); clearRetrievalIndexes();
  const preparationStarted = performance.now();
  await warmSemanticIndex(wiki);
  const preparationMs = performance.now() - preparationStarted;
  const preparationStatus = semanticIndexStatus(wiki);
  const rows = [];
  for (const [queryIndex, query] of queries.entries()) for (let iteration = 0; iteration < iterations; iteration++) {
    for (const pool of (queryIndex + iteration) % 2 ? [32, 24] : [24, 32]) {
      const started = performance.now();
      const result = await retrieveWikiHybrid({ wikiRoot: wiki, query: query.query, maxResults: 8,
        semanticEnabled: true, rerankPoolSize: pool, persistDerivedIndexes: false });
      rows.push({ id: query.id, split: query.split, pool, iteration, firstQueryAfterPreparation: rows.length === 0, wallMs: performance.now() - started,
        recovered: query.relevant.filter((r) => result.hits.some((hit) => hit.path === r.path)).length,
        expected: query.relevant.length, semantic: result.semantic, rerank: result.rerank,
        hitPaths: result.hits.map((hit) => hit.path), scores: result.coverageHits.map((hit) => ({ path: hit.path, score: hit.channels.rerankScore })),
        memory: await memory() });
    }
  }
  const display = [];
  for (const query of queries.slice(0, 5)) for (const responseDetail of ["full", "compact"] as const) {
    const context = await compileTaskContext({ wikiRoot: wiki, intent: "understand", objective: query.query,
      query: query.query, responseDetail });
    display.push({ id: query.id, responseDetail, selected: context.evidence.length, tokens: context.size.heuristicTokens,
      recovered: query.relevant.filter((r) => context.evidence.some((e) => e.path === r.path)).length,
      remaining: context.budget.omittedEvidenceCount, withinBudget: context.budget.withinHeuristicBudget });
  }
  const report = { generatedAt: new Date().toISOString(), platform: `${os.platform()}/${os.arch()}`, cpu: os.cpus()[0]?.model,
    totalMemoryBytes: os.totalmem(), node: process.version, fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
    declaredSlots: slots, iterations, embeddingProvider, reranker: configuredReranker()?.descriptor,
    initialIndexingMs, preparationMs, preparationStatus, memoryBefore, memoryAfter: await memory(), rows, display,
    limitations: ["Slots are declared, not changed or verified by this script. Record the server command alongside the report.",
      "Fresh temporary corpus indexing and subsequent persisted-index restoration are timed separately. OS caches and external models may already be warm.",
      "Process RSS samples do not measure GPU allocations or unique unified-memory usage. Do not sum shared RSS as physical memory.",
      "This sample does not validate new defaults. Run the complete development/holdout protocol and missing-service scenarios before acceptance."] };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, queries: queries.length, initialIndexingMs, preparationMs, display }, null, 2));
} finally { clearSemanticIndexes(); clearRetrievalIndexes(); await fs.rm(root, { recursive: true, force: true }); }
