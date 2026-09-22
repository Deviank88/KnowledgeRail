import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11);
const output = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
const oracleBytes = await fs.readFile(new URL("fixtures/efficiency-self-oracle-v1.json", import.meta.url));
const oracle = JSON.parse(oracleBytes.toString()) as Array<{ id: string; target: string; source: string; negative: string; relation: string }>;
const root = await fs.mkdtemp(join(tmpdir(), "kr-self-oracle-")), cases = [];
try {
  for (const runtime of [...(baseline ? [{ name: "baseline", root: resolve(baseline) }] : []), { name: "current", root: resolve(".") }]) {
    const module = (path: string) => import(pathToFileURL(join(runtime.root, "src", path)).href);
    const api = await module("core/code-evidence/index.ts") as typeof import("../src/core/code-evidence/index.js");
    const resources = await module("core/code-evidence/resource-reader.ts") as typeof import("../src/core/code-evidence/resource-reader.js");
    const state = await module("core/workspace-state.ts") as typeof import("../src/core/workspace-state.js");
    const repositoryRoot = resolve("."), wikiRoot = join(root, runtime.name, "wiki");
    try {
      const index = new api.PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
      await index.rebuild();
      const snapshot = await index.snapshot();
      for (const entry of oracle) {
        const target = snapshot.fragments.find((f) => f.path === entry.target && f.kind === "module")!;
        assert.ok(target, entry.id);
        const unscoped = await index.references(target.id, { maxResults: 100 });
        // Keep failures visible in both scopes. Lexical references can mask an
        // import or fill the bounded result list before an import is returned.
        const result = await index.referencesWithDiagnostics(target.id, { maxResults: 100, paths: ["src/"] });
        const refs = result.references;
        const positive = refs.find((r) => r.source.path === entry.source && r.relation === entry.relation);
        const source = snapshot.fragments.find((f) => f.path === entry.source && f.kind === "module");
        assert.ok(source, entry.id);
        // Resource freshness is independently testable even if the references
        // result fails the reviewed edge oracle. It does not turn that into a pass.
        const resource = await resources.readCodeResource({ repositoryRoot, wikiRoot, resourceUri: api.codeResourceUri(source) });
        assert.equal(resource.path, entry.source);
        const negativeRejected = !refs.some((r) => r.source.path === entry.negative);
        cases.push({ runtime: runtime.name, id: entry.id, pathScope: "src/", positive: !!positive, negativeRejected, resourceFresh: true,
          observedRelations: [...new Set(refs.filter((r) => r.source.path === entry.source).map((r) => r.relation))],
          targetDatabaseRefs: target.databaseRefs,
          unscoped: { results: unscoped.length, reviewedImportVisible: unscoped.some((r) => r.source.path === entry.source && r.relation === entry.relation) } });
      }
    } finally { state.clearWorkspaceStates(); }
  }
  const passed = (c: { positive: boolean; negativeRejected: boolean; unscoped: { reviewedImportVisible: boolean } }) =>
    c.positive && c.negativeRejected && c.unscoped.reviewedImportVisible;
  const pass = cases.filter((c) => c.runtime === "current").every(passed);
  const report = { oracleSha256: createHash("sha256").update(oracleBytes).digest("hex"), cases, pass,
    ...(baseline ? { baselinePass: cases.filter((c) => c.runtime === "baseline").every(passed) } : {}),
    scope: "One reviewed real TypeScript import within src/, plus negative control and independent resource freshness. Unscoped top-100 visibility is reported separately; not repository-wide precision. Indexes stay outside the checkout. Failed edge checks stay failed." };
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exitCode = 1;
} finally { await fs.rm(root, { recursive: true, force: true }); }
