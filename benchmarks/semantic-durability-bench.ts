import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { parseWikiPageRecord } from "../src/core/page-record.js";
import { SemanticStorage } from "../src/core/semantic/storage.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";

const argument = (name: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runtime = argument("runtime", path.resolve("."));
const scale = Number(argument("scale", "1000"));
const dtype = argument("dtype", "f32");
const dimensions = 1024;
const { PersistentSemanticIndex } = await import(pathToFileURL(path.join(runtime, "src/core/semantic/index.ts")).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-durability-"));
let documentInputs = 0;
const vector = (text: string): number[] => {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: dimensions }, (_, i) => (hash[i % hash.length]! - 127.5) / 127.5);
};
const provider: EmbeddingProvider = {
  descriptor: { id: "durability-bench", model: "deterministic", version: "1", dimensions },
  async embedDocuments(texts) { documentInputs += texts.length; return texts.map(vector); },
  async embedQuery(text) { return vector(text); },
};
const records = Array.from({ length: Math.ceil(scale / 32) }, (_, page) => {
  const body = Array.from({ length: Math.min(32, scale - page * 32) }, (_, i) =>
    `## Passage ${page * 32 + i}\n\nDocumentary fact ${page * 32 + i}: durable semantic evidence with page provenance.`).join("\n\n");
  return parseWikiPageRecord(`pages/p${page}.md`, `---\ntitle: Page ${page}\ntype: analysis\n---\n\n${body}`, { mtimeMs: 1, size: body.length });
});
const memory = () => { global.gc?.(); const m = process.memoryUsage(); return { heap: m.heapUsed, buffers: m.arrayBuffers, rss: m.rss }; };
// ArrayBuffer backing stores can be released by the concurrent sweeper after GC
// returns. Use the same fixed settling protocol for both runtimes, and retain the
// immediate sample so transient allocation is not confused with retained memory.
const settledMemory = async () => {
  memory();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return memory();
};
try {
  for (const record of records) {
    const file = path.join(root, record.path); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, record.raw);
  }
  const before = await settledMemory();
  const first = new PersistentSemanticIndex(root, provider, undefined, runtime === path.resolve(".") ? { dtype } : true);
  let start = performance.now();
  await first.synchronize(records);
  const buildMs = performance.now() - start;
  const peakBuildRss = process.resourceUsage().maxRSS * 1024;
  const builtImmediate = memory();
  const built = await settledMemory();
  let checkpoint;
  if (typeof first.checkpoint === "function") {
    const baseline = await settledMemory(); let peakHeapBuffers = baseline.heap + baseline.buffers, sampledPeakRss = baseline.rss;
    const sample = () => { const m = process.memoryUsage(); peakHeapBuffers = Math.max(peakHeapBuffers, m.heapUsed + m.arrayBuffers); sampledPeakRss = Math.max(sampledPeakRss, m.rss); };
    const timer = setInterval(sample, 5); const start = performance.now();
    try { await first.checkpoint(); sample(); } finally { clearInterval(timer); }
    checkpoint = { elapsedMs: performance.now() - start, baseline, peakHeapBuffers, sampledPeakRss,
      heapBuffersGrowthRatio: peakHeapBuffers / (baseline.heap + baseline.buffers) - 1, rssGrowthRatio: sampledPeakRss / baseline.rss - 1 };
  }
  const firstHits = await first.search("Documentary fact 12: durable semantic evidence with page provenance.", 10);
  const countBeforeRestart = documentInputs;
  const reloadSamples: Array<{ reloadMs: number; firstQueryMs: number; loadTimings: unknown }> = [];
  let identicalHits = true;
  for (let run = 0; run < Number(argument("reloads", "5")); run++) {
    global.gc?.();
    const restarted = new PersistentSemanticIndex(root, provider, undefined, runtime === path.resolve(".") ? { dtype } : true);
    start = performance.now();
    await restarted.synchronize(records);
    const reloadMs = performance.now() - start;
    start = performance.now();
    const secondHits = await restarted.search("Documentary fact 12: durable semantic evidence with page provenance.", 10);
    const firstQueryMs = performance.now() - start;
    identicalHits &&= JSON.stringify(firstHits) === JSON.stringify(secondHits);
    reloadSamples.push({ reloadMs, firstQueryMs, loadTimings: restarted.loadTimings });
    restarted.dispose?.();
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const reloadMs = median(reloadSamples.map((s) => s.reloadMs));
  const firstQueryMs = median(reloadSamples.map((s) => s.firstQueryMs));
  const files = await fs.readdir(path.join(root, ".knowledge-rail"));
  const bytes = (await Promise.all(files.filter((f) => f.startsWith("semantic-")).map(async (f) =>
    (await fs.stat(path.join(root, ".knowledge-rail", f))).size))).reduce((sum, n) => sum + n, 0);
  const peakRss = process.resourceUsage().maxRSS * 1024;
  const signatures = [];
  if (process.argv.includes("--signature-ablation")) {
    if (dtype !== "i8" && dtype !== "f32") throw new Error("Invalid dtype");
    const state = await new SemanticStorage(root, provider.descriptor, dtype).load();
    for (const mode of ["persisted", "missing", "changed-engine"] as const) for (let run = 0; run < 3; run++) {
      const engine = new LshAnnEngine({ dimensions, ...(mode === "changed-engine" ? { seed: "changed-seed" } : {}) });
      const entries = [...state.passages.values()].map((p) => mode === "persisted" ? p : { ...p, signatures: undefined });
      const start = performance.now(); engine.restore(entries, true); const restoreMs = performance.now() - start;
      const queryStart = performance.now(); const first = engine.search(vector("Documentary fact 12: durable semantic evidence with page provenance."), 10);
      const queryMs = performance.now() - queryStart; await engine.ready();
      signatures.push({ mode, run, restoreMs, queryMs, signatureReadyMs: performance.now() - start, firstSearchMode: first.diagnostics.indexMode,
        vectors: first.diagnostics.vectorCount, documentInputs: documentInputs - countBeforeRestart });
      engine.dispose();
    }
  }
  console.log(JSON.stringify({ runtime, scale, dtype, buildMs, reloadMs, firstQueryMs, bytes,
    reloadSamples, signatures, checkpoint,
    documentInputs, reusedOnRestart: documentInputs === countBeforeRestart,
    identicalHits,
    before, builtImmediate, built, stableBytesPerPassage: (built.heap + built.buffers - before.heap - before.buffers) / scale, peakBuildRss, peakRss }));
} finally { await fs.rm(root, { recursive: true, force: true }); }
