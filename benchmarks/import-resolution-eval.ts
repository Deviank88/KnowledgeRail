import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PersistentCodeEvidenceIndex, codeEvidenceIndexFile } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

export async function evaluateImportResolution(runtimeRoot?: string) {
  const runtime = runtimeRoot ? await import(pathToFileURL(path.resolve(runtimeRoot, "src/core/code-evidence/index.ts")).href) as typeof import("../src/core/code-evidence/index.js") : undefined;
  const state = runtimeRoot ? await import(pathToFileURL(path.resolve(runtimeRoot, "src/core/workspace-state.ts")).href) as typeof import("../src/core/workspace-state.js") : undefined;
  const Index = runtime?.PersistentCodeEvidenceIndex ?? PersistentCodeEvidenceIndex;
  const bytes = await fs.readFile(new URL("fixtures/import-resolution-golden.json", import.meta.url), "utf8");
  const fixture = JSON.parse(bytes) as { version: number; scope: string; cases: Array<{
    id: string; files: Record<string, string>; edges: string[][]; issues: string[][];
  }> };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-import-eval-"));
  const cases = [];
  try {
    for (const sample of fixture.cases) {
      const repositoryRoot = path.join(root, sample.id), wikiRoot = path.join(repositoryRoot, "wiki");
      for (const [name, content] of Object.entries(sample.files)) {
        await fs.mkdir(path.dirname(path.join(repositoryRoot, name)), { recursive: true });
        await fs.writeFile(path.join(repositoryRoot, name), content);
      }
      const index = new Index({ repositoryRoot, wikiRoot });
      await index.rebuild();
      const before = await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8");
      const snapshot = await index.snapshot();
      const edges = new Set<string>();
      let issues: string[] = [];
      for (const module of snapshot.fragments.filter((f) => f.kind === "module" && f.qualifiedName === f.path)) {
        const result = await index.referencesWithDiagnostics(module.id, { maxResults: 100 });
        for (const hit of result.references) if (hit.relation === "import") edges.add(`${hit.source.path} -> ${hit.target.path}`);
        issues = result.importDiagnostics?.unresolvedImports.map((issue) => [issue.sourcePath, issue.matchedName, issue.status].join(" | ")) ?? [];
      }
      const expected = sample.edges.map((edge) => edge.join(" -> "));
      const expectedIssues = sample.issues.map((issue) => issue.join(" | "));
      const missing = expected.filter((edge) => !edges.has(edge));
      const extra = [...edges].filter((edge) => !expected.includes(edge));
      const missingIssues = expectedIssues.filter((issue) => !issues.includes(issue));
      const extraIssues = issues.filter((issue) => !expectedIssues.includes(issue));
      assert.equal(await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8"), before, "reference diagnostics must not rewrite the snapshot");
      cases.push({ id: sample.id, expectedEdges: expected.length, actualEdges: edges.size, expectedIssues: expectedIssues.length,
        missing, extra, missingIssues, extraIssues });
      clearWorkspaceStates();
      state?.clearWorkspaceStates();
    }
    return { version: fixture.version, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), scope: fixture.scope,
      cases, pass: cases.every((sample) => !sample.missing.length && !sample.extra.length && !sample.missingIssues.length && !sample.extraIssues.length) };
  } finally { clearWorkspaceStates(); state?.clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await evaluateImportResolution(process.argv.find((arg) => arg.startsWith("--runtime="))?.slice(10));
  const output = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--gate")) assert.ok(report.pass, "Import edge/diagnostic oracle failed; see per-case differences.");
}
