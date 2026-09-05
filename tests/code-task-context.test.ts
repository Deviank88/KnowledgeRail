import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { taskCodePaths } from "../src/context/code-impact.js";
import { codeEvidenceIndexFile, codeResourceUri, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";
import { detectCodeDrift } from "../src/core/drift-detection.js";
import { mutateEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { applyEvidenceSynthesis } from "../src/core/ingestion/evidence-synthesis.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { compactStructuredContext, registerContextTools } from "../src/tools/context-tools.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";

async function project(t: TestContext, extra: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-code-context-"));
  const wikiRoot = path.join(root, "wiki");
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };
  await fs.mkdir(wikiRoot);
  for (const [file, content] of Object.entries({
    "odd/ledger.ts": "export function applyCredit() {\n  return 5;\n}\n",
    "callers/web.ts": 'import { applyCredit } from "../odd/ledger.js";\nexport function dispatch() { return applyCredit(); }',
    "callers/start.ts": 'import "../odd/ledger.js";',
    "callers/external.ts": 'import "@vendor/ledger";',
    ...extra,
  })) await write(file, content);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index.rebuild();
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  const context = (extra: Partial<Parameters<typeof compileTaskContext>[0]> = {}) => compileTaskContext({
    wikiRoot, intent: "modify", objective: "Valutare gli effetti della modifica", heuristicTokenBudget: 12_000, ...extra,
  });
  return { root, wikiRoot, index, write, context };
}

async function diskState(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file, { bigint: true });
        entries[path.relative(root, file)] = `${stat.mtimeNs}:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
      }
    }
  };
  await visit(root);
  return entries;
}

test("task source paths preserve quoted spaces and reject URLs, absolute paths and inferred directory guesses", () => {
  assert.deepEqual(taskCodePaths('Modifica `odd folder/unit.ts` e callers/web.ts:12-17. Vedi https://host/a.ts /outside.ts ../escape.py plainSymbol wiki/notes.md'),
    ["callers/web.ts", "odd folder/unit.ts"]);
});

test("one source-path context returns module importers and declaration callers as readable candidates without writes", async (t) => {
  const p = await project(t);
  const before = await diskState(p.root);
  t.mock.method(PersistentCodeEvidenceIndex.prototype, "rebuild", async () => { throw new Error("Context must never rebuild"); });
  const context = await p.context({ changedPaths: ["odd/ledger.ts"] });
  assert.equal(context.changeImpact.mode, "explicit");
  assert.deepEqual(context.changeImpact.requestedPaths, ["odd/ledger.ts"]);
  assert.deepEqual(context.changeImpact.codeRoots?.map((root) => [root.path, root.origin]), [["odd/ledger.ts", "changed_path"]]);
  const relations = context.changeImpact.codeRelations!;
  assert.ok(relations.some((relation) => relation.path === "callers/web.ts" && relation.relation === "call"));
  assert.ok(relations.some((relation) => relation.path === "callers/start.ts" && relation.relation === "import"));
  assert.equal(relations.some((relation) => relation.path === "callers/external.ts"), false);
  assert.equal(context.retrieval.fallbackUsed, false);
  for (const ref of [...context.changeImpact.codeRoots!, ...relations]) {
    const resource = await readCodeResource({ repositoryRoot: p.root, wikiRoot: p.wikiRoot, resourceUri: ref.uri, maxCharacters: 1000 });
    assert.equal(resource.path, ref.path);
  }
  assert.deepEqual(await diskState(p.root), before);
  const mentioned = await p.context({ objective: "Che cosa usa `odd/ledger.ts`?" });
  assert.equal(mentioned.changeImpact.codeRoots?.[0]?.origin, "task_path");
});

test("code context uses current declared aliases and reuses the persisted snapshot", async (t) => {
  const p = await project(t, {
    "tsconfig.json": '{"compilerOptions":{"paths":{"@ledger":["odd/ledger.ts"]}}}',
    "callers/alias.ts": 'import "@ledger";',
  });
  const snapshot = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8");
  assert.ok((await p.context({ changedPaths: ["odd/ledger.ts"] })).changeImpact.codeRelations?.some((ref) => ref.path === "callers/alias.ts"));
  await p.write("tsconfig.json", '{"compilerOptions":{"paths":{"@ledger":["missing.ts"]}}}');
  assert.equal((await p.context({ changedPaths: ["odd/ledger.ts"] })).changeImpact.codeRelations?.some((ref) => ref.path === "callers/alias.ts"), false);
  assert.equal(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8"), snapshot);
});

test("selected active claims supply code roots and related wiki pages; stale and superseded anchors do not", async (t) => {
  const p = await project(t);
  const sourceUri = "docs/normalized/credit.md";
  const sourceContent = "Il limite degli storni commerciali è cinque. La console fatture utilizza la regola.";
  const plan = await sourceCompilePlan({ wikiRoot: p.wikiRoot, sourceUri, content: sourceContent });
  const credit = (await p.index.symbol("applyCredit"))[0]!;
  const caller = (await p.index.symbol("dispatch"))[0]!;
  const recorded = await recordEvidenceClaims({ wikiRoot: p.wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id,
    claims: [
      { text: "Il limite degli storni commerciali è cinque.", kind: "behavior", origin: "explicit", confidence: 1,
        target: { pagePath: "implementations/Storni.md", pageTitle: "Limite storni commerciali", pageType: "implementation", codeResourceUri: credit.resourceUri } },
      { text: "La console fatture utilizza la regola.", kind: "behavior", origin: "explicit", confidence: 1,
        target: { pagePath: "implementations/Console.md", pageTitle: "Console fatture", pageType: "implementation", codeResourceUri: caller.resourceUri } },
    ],
  });
  await resolveEvidenceClaims({ wikiRoot: p.wikiRoot });
  await applyEvidenceSynthesis({ wikiRoot: p.wikiRoot });
  clearWorkspaceStates();
  const context = await p.context({ objective: "Modificare il limite degli storni commerciali", maxEvidence: 1 });
  assert.equal(context.evidence[0]?.path, "implementations/Storni.md");
  assert.equal(context.changeImpact.codeRoots?.[0]?.origin, "claim");
  assert.equal(context.changeImpact.codeRoots?.[0]?.claimId, recorded.claims[0]!.id);
  assert.ok(context.changeImpact.codeRelations?.some((ref) => ref.path === "callers/web.ts"));
  assert.ok(context.changeImpact.codeWikiPages?.some((page) => page.path === "implementations/Console.md" && page.claimId === recorded.claims[1]!.id));
  assert.equal(context.implementationEvidence.some((entry) => entry.path === "implementations/Console.md"), false, "related metadata must not pretend to satisfy wiki coverage");
  for (const status of ["superseded", "contradicted", "ambiguous"] as const) {
    await mutateEvidenceIrStore(p.wikiRoot, async (store) => { store.claims.find((claim) => claim.id === recorded.claims[0]!.id)!.status = status; });
    const excluded = await p.context({ objective: "Modificare il limite degli storni commerciali", maxEvidence: 1 });
    assert.equal(excluded.changeImpact.codeRoots, undefined);
  }
  await mutateEvidenceIrStore(p.wikiRoot, async (store) => { store.claims.find((claim) => claim.id === recorded.claims[0]!.id)!.status = "active"; });
  await p.write("odd/ledger.ts", "export function applyCredit() {\n  return 99;\n}\n");
  await detectCodeDrift({ repositoryRoot: p.root, wikiRoot: p.wikiRoot });
  const stale = await p.context({ objective: "Modificare il limite degli storni commerciali", maxEvidence: 1 });
  assert.equal(stale.evidence[0]?.stale, true);
  assert.equal(stale.changeImpact.codeRoots, undefined);
});

test("code impact observes root, relation and total token budgets in full and compact contexts", async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    files[`roots/r${i}.ts`] = `export function f${i}() { return ${i}; }`;
    for (let j = 0; j < 25; j++) files[`consumers/r${i}-${j}.ts`] = `import "../roots/r${i}.js";`;
  }
  const p = await project(t, files);
  const changedPaths = Array.from({ length: 5 }, (_, i) => `roots/r${i}.ts`);
  const full = await p.context({ changedPaths });
  assert.equal(full.changeImpact.codeRoots?.length, 3);
  assert.equal(full.changeImpact.codeRelations?.length, 36);
  assert.equal(full.changeImpact.codeTruncated, true);
  for (const root of full.changeImpact.codeRoots!) assert.equal(full.changeImpact.codeRelations!.filter((relation) => relation.rootUri === root.uri).length, 12);
  const bounded = await p.context({ changedPaths, heuristicTokenBudget: 2_000 });
  assert.ok(bounded.size.heuristicTokens <= 2_000);
  assert.equal(bounded.budget.withinHeuristicBudget, true);
  assert.ok(bounded.changeImpact.codeRelations!.length < full.changeImpact.codeRelations!.length);
  assert.ok(bounded.gaps.some((gap) => gap.kind === "budget_limited"));
  const compact = compactStructuredContext(bounded);
  assert.deepEqual(compact.changeImpact.codeRoots, bounded.changeImpact.codeRoots);
  assert.deepEqual(compact.changeImpact.codeRelations, bounded.changeImpact.codeRelations);
  const roots = new Set(bounded.changeImpact.codeRoots!.map((root) => root.uri));
  assert.ok(bounded.changeImpact.codeRelations!.every((relation) => roots.has(relation.rootUri)));
});

test("missing, corrupt and incompatible code indexes produce bounded gaps without recovery writes", async (t) => {
  const p = await project(t);
  const file = codeEvidenceIndexFile(p.wikiRoot);
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  t.mock.method(PersistentCodeEvidenceIndex.prototype, "rebuild", async () => { throw new Error("Forbidden rebuild"); });
  for (const content of [null, "{invalid", JSON.stringify({ ...original, adapters: [{ extensionClaims: [".ts"], parserVersion: "old" }] })]) {
    if (content === null) await fs.unlink(file);
    else await fs.writeFile(file, content);
    const before = await diskState(p.root);
    const context = await p.context({ changedPaths: ["odd/ledger.ts"] });
    assert.deepEqual(context.changeImpact.codeRoots, []);
    assert.ok(context.gaps.some((gap) => gap.kind === "missing_evidence" && /[Cc]ode/.test(gap.description)));
    assert.deepEqual(await diskState(p.root), before);
  }
  await fs.unlink(file);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "kr-foreign-index-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "index.json"), JSON.stringify(original));
  await fs.symlink(path.join(outside, "index.json"), file);
  assert.deepEqual((await p.context({ changedPaths: ["odd/ledger.ts"] })).changeImpact.codeRoots, []);
});

test("document-only tasks do not read the code index or evidence store and reject unsafe explicit paths", async (t) => {
  const p = await project(t);
  await p.write("wiki/concepts/Policy.md", "---\ntitle: Policy\ntype: concept\nsources: []\n---\nPolicy for holiday approval.");
  await p.write("wiki/.knowledge-rail/code-evidence-index.json", "broken code index");
  await p.write("docs/evidence-ir/store.json", "broken evidence store");
  const before = await diskState(p.root);
  const context = await p.context({ objective: "Explain holiday approval policy", intent: "understand" });
  assert.ok(context.evidence.some((item) => item.path === "concepts/Policy.md"));
  assert.equal(context.changeImpact.codeRoots, undefined);
  assert.deepEqual(await diskState(p.root), before);
  for (const invalid of ["../escape.ts", "/tmp/escape.ts", "C:\\outside.ts", "src/../odd/ledger.ts", "odd/ledger.ts\0"]) {
    await assert.rejects(p.context({ changedPaths: [invalid] }), /Changed path must/);
  }
  await assert.rejects(p.context({ changedPaths: Array(21).fill("odd/ledger.ts") }), /At most 20/);
});

test("MCP context exposes the same code candidates and resource links in both response details", async (t) => {
  const p = await project(t);
  const previous = getWikiRoot();
  setWikiRoot(p.root);
  t.after(() => setWikiRoot(previous));
  let handler: (args: Record<string, unknown>) => Promise<any>;
  registerContextTools({ registerTool(_name: string, _config: unknown, callback: typeof handler) { handler = callback; } } as unknown as McpServer);
  const args = { intent: "modify", objective: "Modifica regola", changed_paths: ["odd/ledger.ts"], max_evidence: 8, heuristic_token_budget: 12_000, retrieval_profile: "balanced" };
  const full = await handler!({ ...args, response_detail: "full" });
  const compact = await handler!({ ...args, response_detail: "compact" });
  assert.equal(full.isError, undefined);
  assert.deepEqual(compact.structuredContent.changeImpact.codeRelations, full.structuredContent.changeImpact.codeRelations);
  assert.match(full.content[0].text, /Code impact candidates/);
  const uris = full.content.filter((item: { type: string }) => item.type === "resource_link").map((item: { uri: string }) => item.uri);
  for (const ref of [...full.structuredContent.changeImpact.codeRoots, ...full.structuredContent.changeImpact.codeRelations]) assert.ok(uris.includes(ref.uri));
});

test("public context widening preserves source scope and stops at fixed code expansion limits", async (t) => {
  const p = await project(t, Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`callers/extra${i}.ts`, 'import "../odd/ledger.js";'])));
  const previous = getWikiRoot();
  setWikiRoot(p.root);
  t.after(() => setWikiRoot(previous));
  let handler: (args: Record<string, unknown>, context: Record<string, never>) => Promise<any>;
  registerAgentTools({ registerTool(name: string, _config: unknown, callback: typeof handler) {
    if (name === "knowledge_context") handler = callback;
  } } as unknown as McpServer, "modern");
  const args = { mode: "task", intent: "modify", objective: "Modifica regola", query: "Verifica dipendenze",
    changed_paths: ["odd/ledger.ts"], page_types: ["implementation"], max_evidence: 8,
    heuristic_token_budget: 2_000, retrieval_profile: "balanced", response_detail: "compact" };
  const limited = await handler!(args, {});
  assert.equal(limited.isError, undefined);
  const suggestion = limited.structuredContent.nextAction.suggestedArguments;
  assert.deepEqual(suggestion.changed_paths, args.changed_paths);
  assert.deepEqual(suggestion.page_types, args.page_types);
  assert.equal(suggestion.query, args.query);
  const fixedLimit = await handler!({ ...args, heuristic_token_budget: 6_000 }, {});
  assert.ok(fixedLimit.structuredContent.gaps.some((gap: { kind: string; widenable?: boolean }) => gap.kind === "budget_limited" && gap.widenable === false));
  assert.equal(fixedLimit.structuredContent.nextAction, null);
});
