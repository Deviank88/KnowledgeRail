import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mapConcurrent } from "../src/core/concurrent-map.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";
import { CppKnowledgeAdapter, CSharpKnowledgeAdapter, GoKnowledgeAdapter } from "../src/core/code-evidence/language-adapters.js";
import { RubyKnowledgeAdapter } from "../src/core/code-evidence/ruby-adapter.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import type { KnowledgeAdapter, KnowledgeFragment } from "../src/core/code-evidence/types.js";

const argument = (name: string, fallback: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scales = argument("scales", "1000,10000").split(",").map(Number);
const iterations = Number(argument("iterations", "30"));
const language = argument("language", "go");
const languages: Record<string, { adapter: () => KnowledgeAdapter; extension: string; source: (index: number, group: number) => string; importer: string; manifest?: [string, string] }> = {
  go: { adapter: () => new GoKnowledgeAdapter(), extension: "go", source: (i, group) => `package pkg${group}\nfunc Value${i}() {}`,
    importer: 'package main\nimport "example.com/bench/packages/pkg0"\nfunc main() {}', manifest: ["go.mod", "module example.com/bench\n"] },
  javascript: { adapter: () => new TypeScriptKnowledgeAdapter(), extension: "ts", source: (i) => `export function Value${i}() { return ${i}; }`,
    importer: 'import "@bench/pkg0/file0";\nexport function main() {}' },
  csharp: { adapter: () => new CSharpKnowledgeAdapter(), extension: "cs", source: (i, group) => `namespace Pkg${group};\npublic class Value${i} {}`,
    importer: 'using Pkg0;\npublic class Main {}', manifest: ["Bench.csproj", '<Project Sdk="Microsoft.NET.Sdk" />'] },
  ruby: { adapter: () => new RubyKnowledgeAdapter(), extension: "rb", source: (i) => `module Value${i}\nend\n`,
    importer: "require 'file0'\n", manifest: ["bench.gemspec", "Gem::Specification.new do |s|\ns.require_paths = ['packages/pkg0']\nend\n"] },
  cpp: { adapter: () => new CppKnowledgeAdapter(), extension: "hpp", source: (i) => `int value${i}();\n`,
    importer: '#include "file0.hpp"\n', manifest: ["compile_commands.json", JSON.stringify([{ directory: ".", file: "main.hpp", arguments: ["c++", "-Ipackages/pkg0"] }])] },
};
const definition = languages[language];
assert.ok(definition, `Unknown language: ${language}`);
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
    const adapter = definition.adapter();
    const registry = new KnowledgeAdapterRegistry([adapter]);
    const fileCount = Math.floor(scale / 2);
    const files: string[] = Array.from({ length: fileCount }, (_, i) => `packages/pkg${Math.floor(i / filesPerDirectory)}/file${i}.${definition.extension}`);
    await mapConcurrent([...new Set(files.map((file) => path.dirname(file)))], 16, (directory) => fs.mkdir(path.join(repositoryRoot, directory), { recursive: true }));
    if (definition.manifest) await fs.writeFile(path.join(repositoryRoot, definition.manifest[0]), definition.manifest[1]);
    else {
      await fs.mkdir(path.join(repositoryRoot, "settings"));
      await fs.writeFile(path.join(repositoryRoot, "tsconfig.json"), '{"extends":"./settings/base.json"}');
      await fs.writeFile(path.join(repositoryRoot, "settings/base.json"), '{"compilerOptions":{"paths":{"@bench/*":["../packages/*"]}}}');
    }
    const fragments: KnowledgeFragment[] = (await mapConcurrent(files, 16, (file, i) => adapter.extract({ repositoryRoot, path: file,
      content: definition.source(i, Math.floor(i / filesPerDirectory)) }))).flat();
    const importer = `main.${definition.extension}`;
    fragments.push(...await adapter.extract({ repositoryRoot, path: importer,
      content: definition.importer }));
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
    results.push({ fragments: fragments.length, files: fileCount + 1, directories: Math.ceil(fileCount / filesPerDirectory) + (definition.manifest ? 2 : 3),
      filesPerDirectory, coldMs, warmIncludingFreshness: stats(samples), warmLookupOnly: stats(lookupSamples), retainedHeapBytes,
      releasedHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap, resultDigest: hash.digest("hex") });
  }
  const report = { node: process.version, language, gcExposed: Boolean(global.gc), scope: "Manifest discovery, freshness and incoming-map cost; source extraction and persisted snapshot loading excluded", results };
  const output = argument("json", "");
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
