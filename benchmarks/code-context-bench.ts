import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { createDefaultKnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { codeEvidenceIndexFile, getCodeQueryCacheDiagnostics } from "../src/core/code-evidence/index.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import type { KnowledgeFragment } from "../src/core/code-evidence/types.js";

const argument = (name: string, fallback: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scales = argument("scales", "1000,10000").split(",").map(Number);
const iterations = Number(argument("iterations", "40"));
const baseline = argument("baseline", "");
const gate = process.argv.includes("--gate");
assert.ok(scales.every((scale) => Number.isInteger(scale) && scale >= 20) && Number.isInteger(iterations) && iterations >= 5);
const previous = baseline ? await import(pathToFileURL(path.resolve(baseline, "src/context/task-context-compiler.ts")).href) as typeof import("../src/context/task-context-compiler.js") : undefined;
const previousState = baseline ? await import(pathToFileURL(path.resolve(baseline, "src/core/workspace-state.ts")).href) as typeof import("../src/core/workspace-state.js") : undefined;
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1]!, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!, samples: samples.length };
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-code-context-bench-"));
const results = [];
try {
  for (const scale of scales) {
    const repositoryRoot = path.join(root, String(scale));
    const wikiRoot = path.join(repositoryRoot, "wiki");
    await fs.mkdir(path.join(wikiRoot, "implementations"), { recursive: true });
    await fs.mkdir(path.join(repositoryRoot, "components"));
    await fs.writeFile(path.join(wikiRoot, "implementations/Credit.md"), '---\ntitle: Credit limits\ntype: implementation\nsources: []\n---\n# Credit limits\nCredit limits protect the billing operation.');
    const adapter = new TypeScriptKnowledgeAdapter();
    const fragments: KnowledgeFragment[] = [];
    const files = [];
    for (let i = 0; i < Math.floor(scale / 2); i++) {
      const file = `components/unit${i}.ts`;
      const content = i < 3 ? `export function value${i}() { return ${i}; }` : `import "./unit${i % 3}.js";\nexport function use${i}() { return ${i}; }`;
      const extracted = await adapter.extract({ repositoryRoot, path: file, content });
      fragments.push(...extracted);
      files.push({ path: file, fragmentIds: extracted.map((fragment) => fragment.id), contentHash: createHash("sha256").update(content).digest("hex"), fingerprint: "fixture", parserVersion: adapter.parserVersion });
    }
    const snapshot = { version: 2, generatedAt: "2026-09-06T00:00:00.000Z", adapters: createDefaultKnowledgeAdapterRegistry().roster(), files, fragments };
    await fs.mkdir(path.dirname(codeEvidenceIndexFile(wikiRoot)), { recursive: true });
    await fs.writeFile(codeEvidenceIndexFile(wikiRoot), JSON.stringify(snapshot));
    for (const tokenBudget of [2_000, 4_000]) {
      const params = { wikiRoot, intent: "modify" as const, objective: "Modify the credit limits for billing", query: "credit limits billing", heuristicTokenBudget: tokenBudget };
      clearWorkspaceStates();
      previousState?.clearWorkspaceStates();
      const doc = await compileTaskContext(params);
      if (previous) assert.deepEqual(doc, await previous.compileTaskContext(params), "document-only task context must remain identical");
      clearWorkspaceStates();
      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const codeParams = { ...params, changedPaths: Array.from({ length: tokenBudget === 2_000 ? 1 : 3 }, (_, i) => `components/unit${i}.ts`) };
      const coldStart = performance.now();
      let code = await compileTaskContext(codeParams);
      const coldMs = performance.now() - coldStart;
      assert.ok(code.changeImpact.codeRoots?.length);
      assert.ok(code.changeImpact.codeRelations?.length, "the measured operation must actually disclose incoming code candidates");
      assert.ok(code.budget.withinHeuristicBudget);
      const docSamples: number[] = [], codeSamples: number[] = [], overhead: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const document = await compileTaskContext(params);
        const middle = performance.now();
        code = await compileTaskContext(codeParams);
        const end = performance.now();
        assert.deepEqual(document, doc);
        docSamples.push(middle - start); codeSamples.push(end - middle); overhead.push((end - middle) - (middle - start));
      }
      global.gc?.();
      const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
      const overheadStats = stats(overhead);
      if (gate) assert.ok(overheadStats.p50Ms <= 5, `Code expansion p50 overhead exceeds 5 ms: ${overheadStats.p50Ms}`);
      if (gate) assert.ok(overheadStats.p95Ms <= 5, `Code expansion p95 overhead exceeds 5 ms: ${overheadStats.p95Ms}`);
      results.push({ fragments: fragments.length, files: files.length, tokenBudget, coldMs,
        documentOnly: stats(docSamples), withCode: stats(codeSamples), pairedOverhead: overheadStats, retainedHeapBytes,
        codeRoots: code.changeImpact.codeRoots!.length, codeRelations: code.changeImpact.codeRelations!.length,
        heuristicTokens: code.size.heuristicTokens, withinBudget: code.budget.withinHeuristicBudget,
        cached: getCodeQueryCacheDiagnostics(wikiRoot), documentParity: previous ? "identical" : "not compared" });
    }
  }
  const report = { node: process.version, iterations, gate,
    scope: "Actual compileTaskContext, persisted 1k/10k-fragment snapshot and real TS adapter output; fixture extraction excluded. Warm paired delta against the same document-only task. Source bodies are materialized separately, not by context.", results };
  await fs.writeFile(argument("json", "benchmarks/results/280-code-context.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { clearWorkspaceStates(); previousState?.clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
