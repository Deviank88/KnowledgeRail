import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { PersistentCodeEvidenceIndex, codeEvidenceIndexFile, getCodeQueryCacheDiagnostics } from "../src/core/code-evidence/index.js";
import { CodeQueryRuntime, type CodeGenerationCache } from "../src/core/code-evidence/query-runtime.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { ApexKnowledgeAdapter } from "../src/core/code-evidence/language-adapters.js";
import { createSalesforceImportResolver, createSalesforceReferenceResolver } from "../src/core/code-evidence/import-resolution/salesforce.js";
import type { CodeImportContext, CodeImportIssue } from "../src/core/code-evidence/types.js";

async function fixture(t: TestContext, present: boolean) {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-generation-efficiency-"));
  const wikiRoot = join(root, "wiki");
  await fs.writeFile(join(root, "main.js"), 'import "./template.html"; export function work() {}');
  if (present) await fs.writeFile(join(root, "template.html"), "<template />");
  const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index().rebuild();
  const snapshot = await index().snapshot();
  const target = snapshot.fragments.find((f) => f.kind === "module")!.id;
  snapshot.fragments[0]!.definition = "x".repeat(Math.ceil(getCodeQueryCacheDiagnostics(wikiRoot).maxEstimatedBytes / 4) + 1024 * 1024);
  await fs.writeFile(codeEvidenceIndexFile(wikiRoot), JSON.stringify(snapshot));
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot, index, target };
}

for (const present of [false, true]) test(`oversized generations share unindexed probes (present=${present}) and invalidate explicitly`, async (t) => {
  const p = await fixture(t, present);
  const promises = (await import("node:fs/promises")).default;
  const original = promises.realpath;
  let probes = 0;
  t.mock.method(promises, "realpath", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === join(p.root, "template.html")) probes++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const query = () => p.index().referencesWithDiagnostics(p.target);
  const results = await Promise.all(Array.from({ length: 8 }, query));
  assert.ok(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])));
  assert.equal(probes, 1);
  assert.equal(getCodeQueryCacheDiagnostics(p.wikiRoot).cached, false);
  const reason = (await query()).importDiagnostics.unresolvedImports[0]!.reason;
  assert.equal(reason, present ? "not_indexed" : "not_indexed_or_unsupported");
  assert.equal(probes, 1, "even an empty probe result survives full-snapshot eviction");
  if (present) await fs.unlink(join(p.root, "template.html"));
  else await fs.writeFile(join(p.root, "template.html"), "<template />");
  assert.deepEqual(await query(), results[0], "source freshness is explicit");
  // Manifest updates publish a generation without reparsing unchanged sources.
  await fs.writeFile(join(p.root, "package.json"), "{}");
  await p.index().updateFile("package.json");
  assert.equal((await query()).importDiagnostics.unresolvedImports[0]!.reason, present ? "not_indexed_or_unsupported" : "not_indexed");
  assert.equal(probes, 2);
  clearWorkspaceStates();
  assert.equal(getCodeQueryCacheDiagnostics(p.wikiRoot).estimatedBytes, 0);
  await query();
  assert.equal(probes, 3);
});

test("concurrent oversized queries share snapshot parsing without retaining the snapshot", async (t) => {
  const p = await fixture(t, true);
  let parses = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text.includes('"fragments"')) parses++;
    return parse(text, reviver);
  });
  await Promise.all(Array.from({ length: 8 }, () => p.index().references(p.target)));
  assert.equal(parses, 1);
  assert.equal(getCodeQueryCacheDiagnostics(p.wikiRoot).cached, false);
  await p.index().references(p.target);
  assert.equal(parses, 2, "a later request must reload an oversized snapshot");
  const cache = getCodeQueryCacheDiagnostics(p.wikiRoot);
  assert.ok(cache.estimatedBytes > 0 && cache.estimatedBytes < cache.maxEstimatedBytes);
});

test("concurrent callers with different same-roster registries never attach to each other's generation", async (t) => {
  const p = await fixture(t, true);
  class CustomAdapter extends TypeScriptKnowledgeAdapter {
    readonly projectManifests = [{ fileName: "routes.json", parse: () => ({ enabled: this.enabled }) }];
    constructor(private readonly enabled: boolean) { super(); }
    override readonly createImportResolver = (context: CodeImportContext) => {
      const config = context.structure?.manifests.get("routes.json")?.value as { enabled?: boolean } | undefined;
      return () => config?.enabled ? ["main.js"] : [];
    };
  }
  await fs.writeFile(join(p.root, "routes.json"), "{}");
  const yes = new PersistentCodeEvidenceIndex({ repositoryRoot: p.root, wikiRoot: p.wikiRoot, adapter: new CustomAdapter(true) });
  const no = new PersistentCodeEvidenceIndex({ repositoryRoot: p.root, wikiRoot: p.wikiRoot, adapter: new CustomAdapter(false) });
  await yes.rebuild();
  const snapshot = await yes.snapshot();
  snapshot.fragments[0]!.definition = "x".repeat(Math.ceil(getCodeQueryCacheDiagnostics(p.wikiRoot).maxEstimatedBytes / 4) + 1024 * 1024);
  await fs.writeFile(codeEvidenceIndexFile(p.wikiRoot), JSON.stringify(snapshot));
  const results = await Promise.all([yes.importDiagnostics(), no.importDiagnostics(), yes.importDiagnostics(), no.importDiagnostics()]);
  assert.equal(results[0]!.importResolutionCounts?.["typescript-javascript"]?.resolved, 1);
  assert.equal(results[1]!.importResolutionCounts?.["typescript-javascript"]?.resolved ?? 0, 0);
  assert.deepEqual(results[2], results[0]);
  assert.deepEqual(results[3], results[1]);
});

test("failed generation preparation can be retried by the same runtime and its peers", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-generation-retry-"));
  await fs.rm(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fragments = await new TypeScriptKnowledgeAdapter().extract({ repositoryRoot: root, path: "main.js", content: 'import "./file.html";' });
  const snapshot = { version: 2 as const, adapters: [], files: [], generatedAt: "fixture", fragments };
  const cache: CodeGenerationCache = { estimatedBytes: 0 };
  const first = new CodeQueryRuntime(snapshot, undefined, cache), second = new CodeQueryRuntime(snapshot, undefined, cache);
  const failures = await Promise.allSettled([first.refreshProjectStructure(root), second.refreshProjectStructure(root)]);
  assert.ok(failures.every((result) => result.status === "rejected"));
  await fs.mkdir(root);
  await fs.writeFile(join(root, "file.html"), "<template />");
  await Promise.all([first.refreshProjectStructure(root), second.refreshProjectStructure(root)]);
  assert.equal(first.importResolutionDiagnostics().diagnostics.unresolvedImports[0]?.reason, "not_indexed");
  assert.deepEqual(first.importResolutionDiagnostics(), second.importResolutionDiagnostics());
});

test("shared Salesforce preparation preserves each resolver's diagnostic callback and boundaries", async () => {
  const adapter = new ApexKnowledgeAdapter();
  const paths = new Set(["a/Controller.cls", "b/Controller.cls", "use.js"]);
  const fragmentsByPath = new Map(await Promise.all([...paths].map(async (path) => [path, await adapter.extract({ repositoryRoot: "/unused", path, content: "public class Controller {\n public static void run() {}\n}" })] as const)));
  const first: CodeImportIssue[] = [], second: CodeImportIssue[] = [];
  const context: CodeImportContext = { paths, fragmentsByPath, reportIssue: (issue) => first.push(issue) };
  const imports = createSalesforceImportResolver(context);
  const references = createSalesforceReferenceResolver({ ...context, reportIssue: undefined });
  const other = createSalesforceImportResolver({ ...context, reportIssue: (issue) => second.push(issue) });
  assert.deepEqual(imports("use.js", "@salesforce/apex/Controller.run"), []);
  assert.equal(first.length, 1);
  assert.deepEqual(references("use.js", "Controller"), []);
  assert.equal(first.length, 1, "reference preparation must not capture import diagnostics");
  assert.deepEqual(other("use.js", "@salesforce/apex/Controller.run"), []);
  assert.equal(second.length, 1);
  assert.deepEqual(first, second);
  const restricted = createSalesforceImportResolver({ ...context, structure: { identity: "changed", warnings: [], manifests: new Map([
    ["sfdx-project.json", { path: "sfdx-project.json", fileName: "sfdx-project.json", value: { packages: ["a"] } }],
  ]) } });
  assert.deepEqual(restricted("use.js", "@salesforce/apex/Controller.run"), []);
  assert.deepEqual(restricted("a/Controller.cls", "@salesforce/apex/Controller.run"), ["a/Controller.cls"]);
});
