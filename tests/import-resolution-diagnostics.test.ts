import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { createDefaultKnowledgeAdapterRegistry, KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { codeEvidenceIndexFile, getCodeQueryCacheDiagnostics, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import type { CodeImportContext, CodeImportDiagnostics, CodeReference } from "../src/core/code-evidence/types.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { registerCodeEvidenceTools } from "../src/tools/code-evidence-tools.js";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { compactStructuredContext } from "../src/tools/context-tools.js";

async function runtime(files: Record<string, string>, registry = createDefaultKnowledgeAdapterRegistry()) {
  const fragments = (await Promise.all(Object.entries(files).map(([path, content]) =>
    registry.resolve({ path })!.extract({ path, content, repositoryRoot: "/fixture" })))).flat();
  const snapshot = { version: 2 as const, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments };
  return { runtime: new CodeQueryRuntime(snapshot, registry), snapshot, registry };
}

async function project(t: TestContext, files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-import-diagnostics-")), wikiRoot = path.join(root, "wiki");
  const write = async (name: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  };
  for (const [name, content] of Object.entries(files)) await write(name, content);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index.rebuild();
  const snapshot = await index.snapshot();
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot, index, snapshot, write };
}

test("diagnostics count grouped specifiers once while preserving valid siblings and explicit groups", async () => {
  const p = await runtime({
    "A.php": "<?php\nnamespace Acme;\nclass A {}",
    "a/Dup.php": "<?php\nnamespace Acme;\nclass Dup {}",
    "b/Dup.php": "<?php\nnamespace Acme;\nclass Dup {}",
    "use.php": "<?php\nuse Acme\\{A, Dup, Missing};\nclass Consumer {\n public function run() {}\n}",
    "A.cs": "namespace Acme;\npublic class A {}",
    "B.cs": "namespace Acme;\npublic class B {}",
    "Use.cs": "using Acme;\npublic class Consumer {}",
  });
  const report = p.runtime.importResolutionDiagnostics();
  assert.deepEqual(report.byLanguage.php, { resolved: 0, ambiguous: 1, unresolved: 0, partial: 1 });
  assert.deepEqual(report.byLanguage.csharp, { resolved: 1, ambiguous: 0, unresolved: 0, partial: 0 });
  assert.deepEqual(report.diagnostics.unresolvedImports.map((issue) => [issue.matchedName, issue.status]),
    [["Acme\\Dup", "ambiguous"], ["Acme\\Missing", "unresolved"]]);
  assert.deepEqual(report.diagnostics.unresolvedImports[0]!.candidates, ["a/Dup.php", "b/Dup.php"]);
  const target = p.snapshot.fragments.find((f) => f.path === "A.php" && f.kind === "module")!;
  assert.ok(p.runtime.references(target.id, {}, 100).some((hit) => hit.relation === "import" && hit.source.path === "use.php"));
  assert.deepEqual(p.runtime.importResolutionDiagnostics(), report, "queries must not inflate inventory counts");
});

test("bounded diagnostics prioritize late ambiguity, truncate text/candidates and are stable across file order", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i++) files[`unknown${String(i).padStart(2, "0")}.ts`] =
    Array.from({ length: 10 }, (_, j) => `import 'vendor${j}';`).join("\n") + "\nexport function run() {}";
  for (const suffix of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]) files[`duplicate${suffix}`] = "export const value = 1;";
  const long = "z".repeat(700);
  files[`${long}.ts`] = `import './duplicate'; import '${long}';`;
  const p = await runtime(files);
  const report = p.runtime.importResolutionDiagnostics();
  assert.deepEqual(report.byLanguage["typescript-javascript"], { resolved: 0, ambiguous: 1, unresolved: 501, partial: 0 });
  assert.equal(report.diagnostics.unresolvedImports.length, 12);
  assert.equal(report.diagnostics.unresolvedImportsTruncated, true);
  const ambiguous = report.diagnostics.unresolvedImports[0]!;
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidateCount, 8);
  assert.equal(ambiguous.candidates.length, 4);
  assert.equal(ambiguous.textTruncated, true);
  assert.equal(ambiguous.sourcePath.length, 256);
  assert.ok(JSON.stringify(report.diagnostics).length < 8_000);
  const reordered = new CodeQueryRuntime({ ...p.snapshot, fragments: [...p.snapshot.fragments].reverse() }, p.registry);
  assert.deepEqual(reordered.importResolutionDiagnostics(), report);
});

test("manifest changes replace ambiguous diagnostics and edges without snapshot writes or cache-count inflation", async (t) => {
  const p = await project(t, {
    "tsconfig.json": '{"compilerOptions":{"paths":{"@unit":["./unit"]}}}',
    "unit.ts": "export const value = 1;", "unit.tsx": "export const value = 2;",
    "use.ts": "import '@unit';",
  });
  const target = p.snapshot.fragments.find((f) => f.path === "unit.ts" && f.kind === "module")!;
  const before = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8");
  const cacheBefore = getCodeQueryCacheDiagnostics(p.wikiRoot);
  const ambiguous = await p.index.referencesWithDiagnostics(target.id);
  assert.deepEqual(ambiguous.references, []);
  assert.equal(ambiguous.importDiagnostics.unresolvedImports[0]!.status, "ambiguous");
  assert.ok(getCodeQueryCacheDiagnostics(p.wikiRoot).estimatedBytes > cacheBefore.estimatedBytes, "derived diagnostics enter cache admission accounting");
  ambiguous.importDiagnostics.unresolvedImports[0]!.candidates.push("mutated.ts");
  assert.equal((await p.index.referencesWithDiagnostics(target.id)).importDiagnostics.unresolvedImports[0]!.candidateCount, 2);
  assert.ok(!(await p.index.referencesWithDiagnostics(target.id)).importDiagnostics.unresolvedImports[0]!.candidates.includes("mutated.ts"));
  await p.write("tsconfig.json", '{"compilerOptions":{"paths":{"@unit":["./unit.ts"]}}}');
  const resolved = await p.index.referencesWithDiagnostics(target.id);
  assert.deepEqual(resolved.references.map((hit) => hit.source.path), ["use.ts"]);
  assert.deepEqual(resolved.importDiagnostics.unresolvedImports, []);
  assert.equal(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8"), before);
});

test("custom resolver arrays retain declared multi-file behavior and optional diagnostics remain lazy", async () => {
  let builds = 0, resolutions = 0;
  class Custom extends TypeScriptKnowledgeAdapter {
    override readonly createImportResolver = (context: CodeImportContext) => {
      builds++;
      return (_source: string, specifier: string) => {
        resolutions++;
        if (specifier === "partial") context.reportIssue?.({ status: "ambiguous", matchedName: "choice",
          candidates: ["a.ts", "b.ts", "outside.ts"] });
        return ["a.ts", "b.ts", "outside.ts"];
      };
    };
  }
  const p = await runtime({ "a.ts": "export const a = 1;", "b.ts": "export const b = 1;",
    "use.ts": "import 'group'; import 'partial';\nexport function run() {}" }, new KnowledgeAdapterRegistry([new Custom()]));
  assert.equal(builds, 0);
  const report = p.runtime.importResolutionDiagnostics();
  assert.deepEqual({ builds, resolutions }, { builds: 1, resolutions: 2 });
  assert.deepEqual(report.byLanguage["typescript-javascript"], { resolved: 1, ambiguous: 1, unresolved: 0, partial: 1 });
  assert.deepEqual(report.diagnostics.unresolvedImports[0]!.candidates, ["a.ts", "b.ts"]);
  p.runtime.importResolutionDiagnostics();
  assert.equal(resolutions, 2);
});

test("MCP diagnostics describe their snapshot scope without altering hits or exporting internal counters", async (t) => {
  const p = await project(t, { "unit.ts": "export const value = 1;", "unit.tsx": "export const value = 2;",
    "use.ts": "import './unit'; import './unit.ts';" });
  const previous = getWikiRoot(); setWikiRoot(p.root); t.after(() => setWikiRoot(previous));
  const target = p.snapshot.fragments.find((f) => f.path === "unit.ts" && f.kind === "module")!;
  type Result = { structuredContent: CodeImportDiagnostics & { references: CodeReference[] }; content: Array<{ type: string; text?: string }> };
  let handler!: (args: Record<string, unknown>) => Promise<Result>;
  registerCodeEvidenceTools({ registerTool(_name: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as unknown as McpServer);
  const response = await handler({ action: "references", symbol_id: target.id, path_prefixes: ["use.ts"] });
  assert.equal(response.structuredContent.unresolvedImportsScope, "indexed_snapshot");
  assert.equal(response.structuredContent.unresolvedImports[0]!.status, "ambiguous");
  assert.deepEqual(response.structuredContent.references, await p.index.references(target.id, { paths: ["use.ts"] }));
  assert.equal("byLanguage" in response.structuredContent, false);
  assert.match(response.content[0]!.text!, /not target-specific/);
  assert.equal(response.content.filter((item) => item.type === "resource_link").length, 1);
});

test("task context surfaces incomplete import resolution as a warning, with compact parity and no rebuild GAP", async (t) => {
  const p = await project(t, { "unit.ts": "export const value = 1;", "unit.tsx": "export const value = 2;", "use.ts": "import './unit';" });
  const before = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8");
  const context = await compileTaskContext({ wikiRoot: p.wikiRoot, intent: "modify", objective: "Modificare il file", changedPaths: ["unit.ts"], heuristicTokenBudget: 4_000 });
  assert.ok(context.changeImpact.codeWarnings?.some((warning) => warning.includes("ambiguous or unresolved")));
  assert.ok(!context.gaps.some((gap) => /rebuild|not indexed|could not be read/.test(gap.description)));
  assert.deepEqual(compactStructuredContext(context).changeImpact.codeWarnings, context.changeImpact.codeWarnings);
  assert.equal(context.budget.withinHeuristicBudget, true);
  assert.equal(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8"), before);
});
