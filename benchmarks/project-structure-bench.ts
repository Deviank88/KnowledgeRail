import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mapConcurrent } from "../src/core/concurrent-map.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";
import { GoKnowledgeAdapter } from "../src/core/code-evidence/language-adapters.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import type { KnowledgeAdapter, KnowledgeFragment } from "../src/core/code-evidence/types.js";

const argument = (name: string, fallback: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scales = argument("scales", "1000,10000").split(",").map(Number);
const iterations = Number(argument("iterations", "30"));
const language = argument("language", "go");
assert.ok(language === "go" || language === "javascript");
assert.ok(scales.every((scale) => Number.isInteger(scale) && scale >= 20) && Number.isInteger(iterations) && iterations >= 5);
function stats(values: number[]) {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] };
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-structure-bench-"));
const results = [];
try {
  for (const scale of scales) for (const filesPerDirectory of [50, 1]) {
    const repositoryRoot = path.join(root, `${scale}-${filesPerDirectory}`);
    const adapter: KnowledgeAdapter = language === "go" ? new GoKnowledgeAdapter() : new TypeScriptKnowledgeAdapter();
    const registry = new KnowledgeAdapterRegistry([adapter]);
    const fileCount = Math.floor(scale / 2);
    const files: string[] = Array.from({ length: fileCount }, (_, i) => `packages/pkg${Math.floor(i / filesPerDirectory)}/file${i}.${language === "go" ? "go" : "ts"}`);
    await mapConcurrent([...new Set(files.map((file) => path.dirname(file)))], 16, (directory) => fs.mkdir(path.join(repositoryRoot, directory), { recursive: true }));
    if (language === "go") await fs.writeFile(path.join(repositoryRoot, "go.mod"), "module example.com/bench\n");
    else {
      await fs.mkdir(path.join(repositoryRoot, "settings"));
      await fs.writeFile(path.join(repositoryRoot, "tsconfig.json"), '{"extends":"./settings/base.json"}');
      await fs.writeFile(path.join(repositoryRoot, "settings/base.json"), '{"compilerOptions":{"paths":{"@bench/*":["../packages/*"]}}}');
    }
    const fragments: KnowledgeFragment[] = (await mapConcurrent(files, 16, (file, i) => adapter.extract({ repositoryRoot, path: file,
      content: language === "go" ? `package pkg${Math.floor(i / filesPerDirectory)}\nfunc Value${i}() {}` : `export function Value${i}() { return ${i}; }` }))).flat();
    const importer = language === "go" ? "main.go" : "main.ts";
    fragments.push(...await adapter.extract({ repositoryRoot, path: importer,
      content: language === "go" ? 'package main\nimport "example.com/bench/packages/pkg0"\nfunc main() {}' : 'import "@bench/pkg0/file0";\nexport function main() {}' }));
    const snapshot = { version: 2 as const, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments };
    global.gc?.();
    const beforeHeap = process.memoryUsage().heapUsed;
    let runtime: CodeQueryRuntime | undefined = new CodeQueryRuntime(snapshot, registry);
    const target = fragments[0]!;
    assert.equal(target.kind, "module");
    const coldStart = performance.now();
    await runtime.refreshProjectStructure(repositoryRoot);
    const expected = runtime.references(target.id, {}, 12);
    const coldMs = performance.now() - coldStart;
    assert.ok(expected.some((reference) => reference.source.path === importer && reference.relation === "import"));
    const samples = [], lookupSamples = [];
    const hash = createHash("sha256");
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await runtime.refreshProjectStructure(repositoryRoot);
      const lookupStart = performance.now();
      const result: ReturnType<CodeQueryRuntime["references"]> = runtime.references(target.id, {}, 12);
      lookupSamples.push(performance.now() - lookupStart);
      samples.push(performance.now() - start);
      assert.deepEqual(result, expected);
      hash.update(JSON.stringify(result));
    }
    global.gc?.();
    const retainedHeapBytes = process.memoryUsage().heapUsed - beforeHeap;
    runtime = undefined;
    await new Promise<void>((done) => setImmediate(done));
    global.gc?.();
    results.push({ fragments: fragments.length, files: fileCount + 1, directories: Math.ceil(fileCount / filesPerDirectory) + (language === "go" ? 2 : 3),
      filesPerDirectory, coldMs, warmIncludingFreshness: stats(samples), warmLookupOnly: stats(lookupSamples), retainedHeapBytes,
      releasedHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap, resultDigest: hash.digest("hex") });
  }
  const report = { node: process.version, language, gcExposed: Boolean(global.gc), scope: "Manifest discovery, freshness and incoming-map cost; source extraction and persisted snapshot loading excluded", results };
  const output = argument("json", "");
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
