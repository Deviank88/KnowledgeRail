import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { createDefaultKnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import type { KnowledgeFragment } from "../src/core/code-evidence/types.js";

const arg = (name: string, fallback: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runtimeRoot = arg("runtime", ".");
const { CodeQueryRuntime } = await import(pathToFileURL(path.resolve(runtimeRoot, "src/core/code-evidence/query-runtime.ts")).href) as typeof import("../src/core/code-evidence/query-runtime.js");
const iterations = Number(arg("iterations", "40"));
assert.ok(Number.isInteger(iterations) && iterations >= 5);
const percentile = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1]!, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!, samples: samples.length };
};
const rows = [];
for (const scale of [1000, 10000]) {
  const adapter = new TypeScriptKnowledgeAdapter(), fragments: KnowledgeFragment[] = [];
  for (let i = 0; i < scale / 2; i++) {
    const content = i === 0 ? "export function target() {}" : `import './unit0.ts'; import 'vendor${i}';\nexport function use${i}() {}`;
    fragments.push(...await adapter.extract({ repositoryRoot: "/fixture", path: `unit${i}.ts`, content }));
  }
  const snapshot = { version: 2 as const, adapters: createDefaultKnowledgeAdapterRegistry().roster(), generatedAt: "fixture", files: [], fragments };
  const target = fragments.find((fragment) => fragment.path === "unit0.ts" && fragment.kind === "module")!;
  const cold: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const runtime = new CodeQueryRuntime(snapshot);
    const start = performance.now(); runtime.references(target.id, {}, 12); cold.push(performance.now() - start);
  }
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const runtime = new CodeQueryRuntime(snapshot);
  const references = runtime.references(target.id, {}, 12);
  assert.equal(references.length, 12);
  const diagnostics = runtime.importResolutionDiagnostics?.();
  if (diagnostics) {
    assert.equal(diagnostics.diagnostics.unresolvedImports.length, 12);
    assert.equal(diagnostics.byLanguage["typescript-javascript"]!.unresolved, scale / 2 - 1);
    assert.equal(diagnostics.byLanguage["typescript-javascript"]!.resolved, scale / 2 - 1);
  }
  global.gc?.();
  const retainedHeapBytes = process.memoryUsage().heapUsed - before;
  const warm: number[] = [], disclosure: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let start = performance.now(); runtime.references(target.id, {}, 12); warm.push(performance.now() - start);
    if (diagnostics) {
      start = performance.now(); structuredClone(runtime.importResolutionDiagnostics().diagnostics); disclosure.push(performance.now() - start);
    }
  }
  rows.push({ fragments: fragments.length, coldIncomingMap: percentile(cold), warmReferences: percentile(warm),
    diagnosticDisclosure: disclosure.length ? percentile(disclosure) : null,
    retainedHeapBytes, diagnosticEstimatedBytes: runtime.projectStructureEstimatedBytes(),
    sampleIssues: diagnostics?.diagnostics.unresolvedImports.length ?? 0,
    digest: createHash("sha256").update(JSON.stringify(references)).digest("hex") });
}
const report = { node: process.version, runtimeRoot, scope: "Real TS extraction outside timed interval; cold incoming map only, without source extraction, manifest discovery or snapshot IO. Warm reference selection and bounded diagnostic cloning measured separately.", rows };
await fs.writeFile(arg("json", "benchmarks/results/280-import-diagnostics.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
