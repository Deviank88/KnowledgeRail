import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as current from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

// Source repositories are only read. Each runtime writes its index to a fresh
// temporary wiki. The aggregate report contains no source names or query text.
const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const repository = argument("repository"), oracle = argument("oracle"), baseline = argument("baseline");
assert.ok(repository && oracle, "Pass --repository and a pre-reviewed --oracle JSON file.");
const bytes = await fs.readFile(oracle);
const cases = JSON.parse(bytes.toString()) as Array<{ id: string; source: string; target: string; relation: string }>;
assert.ok(cases.length && cases.every((entry) => entry.id && entry.source && entry.target && ["import", "reference"].includes(entry.relation)));
const root = await fs.mkdtemp(join(tmpdir(), "kr-real-references-"));
const results = [];
let sharedTargets: Set<string> | undefined;
const stats = (values: number[]) => {
  values.sort((a, b) => a - b);
  return { p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] };
};
try {
  for (const label of baseline ? ["baseline", "current"] : ["current"]) {
    const runtime = label === "baseline" ? await import(pathToFileURL(resolve(baseline!, "src/core/code-evidence/index.ts")).href) as typeof current : current;
    const clear = label === "baseline" ? (await import(pathToFileURL(resolve(baseline!, "src/core/workspace-state.ts")).href)).clearWorkspaceStates as typeof clearWorkspaceStates : clearWorkspaceStates;
    const wikiRoot = join(root, label, "wiki");
    const index = new runtime.PersistentCodeEvidenceIndex({ repositoryRoot: resolve(repository), wikiRoot });
    const start = performance.now();
    const update = await index.rebuild();
    const rebuildMs = performance.now() - start;
    const snapshot = await index.snapshot();
    const modules = new Map(snapshot.fragments.filter((entry) => entry.kind === "module" && entry.path === entry.qualifiedName).map((entry) => [entry.path, entry]));
    sharedTargets ??= new Set(modules.keys());
    const before = await fs.readFile(runtime.codeEvidenceIndexFile(wikiRoot));
    global.gc?.();
    const heap = process.memoryUsage().heapUsed, samples: number[] = [], commonSamples: number[] = [], checks = [];
    let coldMs = 0, diagnostics;
    for (const entry of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
      const target = modules.get(entry.target);
      if (!target) { checks.push({ id: entry.id, passed: false, reason: "target_not_indexed" }); continue; }
      const started = performance.now();
      const found = await index.referencesWithDiagnostics(target.id, { maxResults: 100 });
      if (!coldMs) coldMs = performance.now() - started;
      diagnostics = found.importDiagnostics;
      checks.push({ id: entry.id, passed: found.references.some((hit) => hit.source.path === entry.source && hit.relation === entry.relation), returned: found.references.length });
      for (let iteration = 0; iteration < 5; iteration++) {
        const started = performance.now(); await index.referencesWithDiagnostics(target.id, { maxResults: 100 });
        const elapsed = performance.now() - started;
        samples.push(elapsed); if (sharedTargets.has(entry.target)) commonSamples.push(elapsed);
      }
    }
    await new Promise<void>((done) => setImmediate(done)); global.gc?.();
    assert.deepEqual(await fs.readFile(runtime.codeEvidenceIndexFile(wikiRoot)), before, "Queries must not mutate the snapshot.");
    results.push({ runtime: label, indexedFiles: snapshot.files.length, fragments: snapshot.fragments.length,
      reparsedFiles: update.reparsedFiles, rebuildMs, firstReferenceMs: coldMs, warmReferences: stats(samples),
      sharedTargetWarmReferences: stats(commonSamples), sharedTargetSamples: commonSamples.length,
      cache: runtime.getCodeQueryCacheDiagnostics(wikiRoot),
      retainedQueryHeapBytes: process.memoryUsage().heapUsed - heap,
      importInventory: diagnostics?.importResolutionCounts, reasons: diagnostics?.importReasonsByLanguage,
      checks, passed: checks.filter((check) => check.passed).length, total: checks.length });
    clear();
  }
  const report = { oracleSha256: createHash("sha256").update(bytes).digest("hex"),
    scope: "Whole local code inventory, pre-reviewed positive edge checks. Measures recall of these checks, not whole-repository precision or observed user fallback. Sources are read-only; index writes are temporary.", results };
  const output = argument("json");
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
