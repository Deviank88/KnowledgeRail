import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { codeQueryFixture } from "./code-query-fixture.js";

const argument = (name: string, fallback: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runtimeRoot = argument("runtime", "."), iterations = Number(argument("iterations", "40"));
assert.ok(Number.isInteger(iterations) && iterations >= 5);
const moduleUrl = (file: string) => pathToFileURL(resolve(runtimeRoot, `src/core/${file}.ts`)).href;
const { PersistentCodeEvidenceIndex, codeEvidenceIndexFile } = await import(moduleUrl("code-evidence/index")) as typeof import("../src/core/code-evidence/index.js");
const { CodeQueryRuntime } = await import(moduleUrl("code-evidence/query-runtime")) as typeof import("../src/core/code-evidence/query-runtime.js");
const { clearWorkspaceStates } = await import(moduleUrl("workspace-state")) as typeof import("../src/core/workspace-state.js");
const root = await fs.mkdtemp(join(tmpdir(), "kr-related-cost-"));
const originalRefresh = CodeQueryRuntime.prototype.refreshProjectStructure;
let refreshes = 0;
CodeQueryRuntime.prototype.refreshProjectStructure = async function (repositoryRoot) { refreshes++; return originalRefresh.call(this, repositoryRoot); };
const results = [];
try {
  for (const fragments of [1_000, 10_000]) {
    const repositoryRoot = join(root, String(fragments)), wikiRoot = join(repositoryRoot, "wiki");
    await fs.mkdir(join(wikiRoot, ".knowledge-rail"), { recursive: true });
    await fs.writeFile(codeEvidenceIndexFile(wikiRoot), JSON.stringify(codeQueryFixture(fragments)));
    await fs.writeFile(join(repositoryRoot, "tsconfig.json"), '{"compilerOptions":{"baseUrl":"."}}');
    const ids = Array.from({ length: 8 }, (_, i) => `fragment-${i + 5}`);
    const run = async () => {
      const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
      if (typeof index.relatedEvidenceBatch !== "function") {
        const proposals = [];
        for (const id of ids) proposals.push(await index.relatedEvidence(id));
        return proposals;
      }
      const batch = await index.relatedEvidenceBatch(ids);
      return ids.map((id) => { const item = batch.get(id)!; if (item.status === "rejected") throw item.reason; return item.value; });
    };
    clearWorkspaceStates();
    for (let warm = 0; warm < 3; warm++) await run();
    refreshes = 0;
    const samples: number[] = [], digest = createHash("sha256");
    for (let i = 0; i < iterations; i++) {
      const start = performance.now(), proposals = await run(); samples.push(performance.now() - start);
      assert.ok(proposals.every((p) => p.candidates.length === 2 && !p.truncated));
      digest.update(JSON.stringify(proposals));
    }
    samples.sort((a, b) => a - b); global.gc?.();
    results.push({ fragments, targets: ids.length, p50Ms: samples[Math.ceil(iterations * .5) - 1], p95Ms: samples[Math.ceil(iterations * .95) - 1],
      manifestRefreshesPerBatch: refreshes / iterations, resultDigest: digest.digest("hex"), warmHeapBytes: process.memoryUsage().heapUsed });
  }
  console.log(JSON.stringify({ node: process.version, iterations,
    scope: "Eight distinct anchored targets; persisted synthetic code-query fixture and real manifest freshness IO. Warm related proposals only; claim writes and source materialization excluded.", results }, null, 2));
} finally {
  CodeQueryRuntime.prototype.refreshProjectStructure = originalRefresh;
  clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true });
}
