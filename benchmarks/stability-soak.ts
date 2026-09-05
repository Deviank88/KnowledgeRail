import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import { codeEvidenceIndexFile, getCodeQueryCacheDiagnostics, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates, evictWorkspaceState } from "../src/core/workspace-state.js";
import { searchRetrievalIndex, updateRetrievalPaths } from "../src/core/retrieval-index.js";

const arg = (key: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const operations = Number(arg("operations", "10000"));
const durationMs = Number(arg("duration-ms", "300000"));
if (!Number.isInteger(operations) || operations < 100 || !Number.isFinite(durationMs) || durationMs < 0) throw new Error("Invalid soak parameters");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-soak-"));
const wikiRoot = path.join(root, "wiki");
const plan = { operations, minimumDurationMs: durationMs, cycle: { symbol: 40, search: 30, references: 20, restart: 1, internalWrite: 1, atomicReplacement: 1, deleteRecreate: 1, corruptCode: 1, oversized: 1, removeSource: 1, wikiWrite: 1, corruptRetrieval: 1, lazyMaps: 1 }, idleEveryOperations: 1000, idleMs: 2000, projectCount: 1, sourceFiles: 100, wikiPages: 100 };
console.error(JSON.stringify({ plan }));
const samples: Record<string, number[]> = {};
const checkpoints: unknown[] = [];
let peakHeap = 0, peakRss = 0;
const sampleMemory = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); return m; };
const timer = setInterval(sampleMemory, 5);
const source = (i: number, revision = 0) => `export function soakSymbol${i}() { return ${revision}; }\nexport function caller${i}() { return soakSymbol${i}(); }`;
const wikiPage = (i: number, revision = 0) => `---\ntitle: Page${i}\ntype: concept\nsources: []\n---\n# Evidence\nsoakneedle${i} revision${revision}`;
try {
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(wikiRoot, "concepts"), { recursive: true });
  for (let i = 0; i < 100; i++) {
    await fs.writeFile(path.join(root, `src/Source${i}.ts`), source(i));
    await fs.writeFile(path.join(wikiRoot, `concepts/Page${i}.md`), wikiPage(i));
  }
  const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index().rebuild();
  await searchRetrievalIndex({ wikiRoot, query: "soakneedle0" });
  const file = codeEvidenceIndexFile(wikiRoot);
  const target = async () => { const hits = await index().symbol("soakSymbol50", { maxResults: 1 }); assert.equal(hits[0]?.fragment.symbol, "soakSymbol50"); return hits[0]!.fragment.id; };
  let targetId = await target();
  global.gc?.();
  const baseline = sampleMemory();
  const started = performance.now();
  for (let operation = 0; operation < operations; operation++) {
    const slot = operation % 100;
    const start = performance.now();
    // Keep large fixture strings inside a completed async frame before sampling
    // release. V8 can otherwise retain stale loop locals across later awaits.
    const execute = async (): Promise<string> => {
      let name = slot < 50 ? "symbol" : slot < 80 ? "search" : "references";
    if (slot === 0) { name = "restart"; evictWorkspaceState(wikiRoot); targetId = await target(); }
    else if (slot === 1) { name = "internalWrite"; await fs.writeFile(path.join(root, "src/Source0.ts"), source(0, operation)); await index().updateFile("src/Source0.ts"); assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false); await target(); }
    else if (slot === 2) { name = "atomicReplacement"; const raw = await fs.readFile(file, "utf8"); await fs.writeFile(`${file}.next`, raw); await fs.rename(`${file}.next`, file); await target(); }
    else if (slot === 3) { name = "deleteRecreate"; const raw = await fs.readFile(file, "utf8"); await fs.unlink(file); assert.deepEqual(await index().symbol("soakSymbol50"), []); assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false); await fs.writeFile(file, raw); await target(); }
    else if (slot === 4) { name = "corruptCode"; await fs.writeFile(file, "{broken"); await target(); }
    else if (slot === 5) {
      name = "oversized";
      const raw = await fs.readFile(file, "utf8");
      const snapshot = JSON.parse(raw);
      snapshot.fragments[0].definition = "x".repeat(9 * 1024 * 1024);
      await fs.writeFile(file, JSON.stringify(snapshot));
      await target();
      assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false);
      // Exercise all lazy structures even when admission is refused.
      assert.ok((await index().references(targetId)).length > 0);
      sampleMemory();
      await fs.writeFile(file, raw);
      await target();
    }
    else if (slot === 6) { name = "removeSource"; await fs.unlink(path.join(root, "src/Source0.ts")); await index().removeFile("src/Source0.ts"); assert.deepEqual(await index().symbol("soakSymbol0"), []); await fs.writeFile(path.join(root, "src/Source0.ts"), source(0)); await index().updateFile("src/Source0.ts"); }
    else if (slot === 7) { name = "wikiWrite"; await fs.writeFile(path.join(wikiRoot, "concepts/Page0.md"), wikiPage(0, operation)); await updateRetrievalPaths(wikiRoot, ["concepts/Page0.md"]); assert.equal((await searchRetrievalIndex({ wikiRoot, query: "soakneedle0" }))[0]?.path, "concepts/Page0.md"); }
    else if (slot === 8) { name = "corruptRetrieval"; await fs.writeFile(path.join(wikiRoot, ".knowledge-rail/retrieval-index.json"), "{broken"); evictWorkspaceState(wikiRoot); assert.equal((await searchRetrievalIndex({ wikiRoot, query: "soakneedle0" }))[0]?.path, "concepts/Page0.md"); }
    else if (slot === 9) { name = "lazyMaps"; targetId = await target(); assert.ok((await index().references(targetId)).length > 0); }
    else if (name === "symbol") await target();
    else if (name === "search") assert.ok((await index().search("soakSymbol50")).some((hit) => hit.fragment.symbol === "soakSymbol50"));
    else assert.ok((await index().references(targetId)).length > 0);
      return name;
    };
    const name = await execute();
    (samples[name] ??= []).push(performance.now() - start);
    sampleMemory();
    if ((operation + 1) % 1000 === 0) {
      global.gc?.();
      const beforeIdle = sampleMemory();
      const admission = getCodeQueryCacheDiagnostics(wikiRoot);
      await new Promise((resolve) => setTimeout(resolve, plan.idleMs));
      global.gc?.();
      const afterIdle = sampleMemory();
      assert.deepEqual(getCodeQueryCacheDiagnostics(wikiRoot), admission);
      evictWorkspaceState(wikiRoot);
      await new Promise<void>((resolve) => setImmediate(resolve));
      global.gc?.();
      const released = sampleMemory();
      assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).estimatedBytes, 0);
      checkpoints.push({ operation: operation + 1, elapsedMs: performance.now() - started, admission, beforeIdle, afterIdle, released });
      console.error(`Completed ${operation + 1}/${operations} operations`);
    }
    const due = started + (operation + 1) * durationMs / operations;
    const remaining = due - performance.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  clearWorkspaceStates();
  await new Promise<void>((resolve) => setImmediate(resolve));
  global.gc?.();
  const distribution = (values: number[]) => { values.sort((a, b) => a - b); return { samples: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1], p99Ms: values[Math.ceil(values.length * .99) - 1], maxMs: values.at(-1) }; };
  const report = { plan, node: process.version, gcExposed: Boolean(global.gc), elapsedMs: performance.now() - started, baseline, released: sampleMemory(), peakHeap, peakRss, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, checkpoints, latency: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, distribution(values)])) };
  await fs.writeFile(arg("json", "benchmarks/results/274-stability.json"), JSON.stringify(report, null, 2) + "\n");
} finally { clearInterval(timer); clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
