import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PersistentCodeEvidenceIndex, codeEvidenceIndexFile } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { codeRequestLanguage } from "../src/core/code-evidence/request-telemetry.js";

export async function evaluateImportResolution(runtimeRoot?: string, fixtureContent?: string) {
  const runtime = runtimeRoot ? await import(pathToFileURL(path.resolve(runtimeRoot, "src/core/code-evidence/index.ts")).href) as typeof import("../src/core/code-evidence/index.js") : undefined;
  const state = runtimeRoot ? await import(pathToFileURL(path.resolve(runtimeRoot, "src/core/workspace-state.ts")).href) as typeof import("../src/core/workspace-state.js") : undefined;
  const Index = runtime?.PersistentCodeEvidenceIndex ?? PersistentCodeEvidenceIndex;
  const bytes = fixtureContent ?? await fs.readFile(new URL("fixtures/import-resolution-golden.json", import.meta.url), "utf8");
  const fixture = JSON.parse(bytes) as { version: number; scope: string; cases: Array<{
    id: string; split?: string; files: Record<string, string>; edges: string[][]; issues: string[][];
    reasons?: string[][]; counts?: Record<string, Record<string, number>>;
  }> };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-import-eval-"));
  const cases = [];
  const fallbackByLanguage: Record<string, { served: number; fallbacks: number }> = {};
  const byLanguage: Record<string, { expectedEdges: number; actualEdges: number; usefulEdges: number }> = {};
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
      let reasons: string[] = [];
      let inventory: Record<string, import("../src/core/code-evidence/types.js").CodeImportResolutionCounts> = {};
      for (const module of snapshot.fragments.filter((f) => f.kind === "module" && f.qualifiedName === f.path)) {
        const result = await index.referencesWithDiagnostics(module.id, { maxResults: 100 });
        const observed = [...new Set(result.references.filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
        const wanted = [...new Set(sample.edges.filter((edge) => edge[1] === module.path).map((edge) => edge[0]!))].sort();
        const language = codeRequestLanguage([module.path]);
        const counts = fallbackByLanguage[language] ??= { served: 0, fallbacks: 0 };
        counts.served++;
        if (JSON.stringify(observed) !== JSON.stringify(wanted)) counts.fallbacks++;
        for (const hit of result.references) if (hit.relation === "import") edges.add(`${hit.source.path} -> ${hit.target.path}`);
        issues = result.importDiagnostics?.unresolvedImports.map((issue) => [issue.sourcePath, issue.matchedName, issue.status].join(" | ")) ?? [];
        reasons = result.importDiagnostics?.unresolvedImports.map((issue) => [issue.sourcePath, issue.matchedName, issue.status, issue.reason].join(" | ")) ?? [];
        inventory = result.importDiagnostics?.importResolutionCounts ?? {};
      }
      const expected = sample.edges.map((edge) => edge.join(" -> "));
      const expectedIssues = sample.issues.map((issue) => issue.join(" | "));
      const missing = expected.filter((edge) => !edges.has(edge));
      const extra = [...edges].filter((edge) => !expected.includes(edge));
      const missingIssues = expectedIssues.filter((issue) => !issues.includes(issue));
      const extraIssues = issues.filter((issue) => !expectedIssues.includes(issue));
      const missingReasons = (sample.reasons ?? []).map((reason) => reason.join(" | ")).filter((reason) => !reasons.includes(reason));
      const wrongCounts = Object.entries(sample.counts ?? {}).flatMap(([language, counts]) => Object.entries(counts)
        .filter(([key, value]) => ((inventory[language] as unknown as Record<string, number> | undefined)?.[key] ?? 0) !== value)
        .map(([key, expected]) => ({ language, key, expected, actual: (inventory[language] as unknown as Record<string, number> | undefined)?.[key] ?? 0 })));
      for (const edge of expected) {
        const counts = byLanguage[codeRequestLanguage([edge.split(" -> ")[0]!])] ??= { expectedEdges: 0, actualEdges: 0, usefulEdges: 0 };
        counts.expectedEdges++; if (edges.has(edge)) counts.usefulEdges++;
      }
      for (const edge of edges) (byLanguage[codeRequestLanguage([edge.split(" -> ")[0]!])] ??= { expectedEdges: 0, actualEdges: 0, usefulEdges: 0 }).actualEdges++;
      assert.equal(await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8"), before, "reference diagnostics must not rewrite the snapshot");
      cases.push({ id: sample.id, split: sample.split ?? "development", expectedEdges: expected.length, actualEdges: edges.size, expectedIssues: expectedIssues.length,
        missing, extra, missingIssues, extraIssues, missingReasons, wrongCounts });
      clearWorkspaceStates();
      state?.clearWorkspaceStates();
    }
    return { version: fixture.version, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), scope: fixture.scope,
      byLanguage: Object.fromEntries(Object.entries(byLanguage).map(([language, counts]) => [language, { ...counts,
        precision: counts.actualEdges ? counts.usefulEdges / counts.actualEdges : 1, recall: counts.expectedEdges ? counts.usefulEdges / counts.expectedEdges : 1 }])),
      fallbackEvaluation: { scope: "offline reference requests; oracle requests fallback for missing or extra file-level import edges; not historical user telemetry",
        byLanguage: Object.fromEntries(Object.entries(fallbackByLanguage).map(([language, counts]) => [language, { ...counts, fallbackRate: counts.fallbacks / counts.served }])) },
      cases, pass: cases.every((sample) => !sample.missing.length && !sample.extra.length && !sample.missingIssues.length && !sample.extraIssues.length && !sample.missingReasons.length && !sample.wrongCounts.length) };
  } finally { clearWorkspaceStates(); state?.clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await evaluateImportResolution(process.argv.find((arg) => arg.startsWith("--runtime="))?.slice(10));
  const output = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--gate")) assert.ok(report.pass, "Import edge/diagnostic oracle failed; see per-case differences.");
}
