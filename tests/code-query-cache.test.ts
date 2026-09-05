import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { codeEvidenceIndexFile, getCodeQueryCacheDiagnostics, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { clearWorkspaceStates, evictWorkspaceState } from "../src/core/workspace-state.js";

async function fixture(t: TestContext) {
  clearWorkspaceStates();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-code-cache-"));
  const wikiRoot = path.join(root, "wiki");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/cache.ts"), [
    "export function cacheFixtureAlpha() { return 1; }",
    "export function cacheFixtureCaller() { return cacheFixtureAlpha(); }",
  ].join("\n"));
  const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index().rebuild();
  t.after(async () => {
    clearWorkspaceStates();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, wikiRoot, file: codeEvidenceIndexFile(wikiRoot), index };
}

function countSnapshotParses(t: TestContext): () => number {
  let count = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text.includes("cacheFixture")) count++;
    return parse(text, reviver);
  });
  return () => count;
}

test("concurrent queries and new MCP index instances share one validated snapshot", async (t) => {
  const { index, wikiRoot } = await fixture(t);
  const parses = countSnapshotParses(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => index().symbol("cacheFixtureAlpha")));
  assert.ok(results.every((hits) => hits[0]?.fragment.symbol === "cacheFixtureAlpha"));
  assert.equal(parses(), 1);
  const target = results[0]![0]!.fragment.id;
  await index().references(target);
  await index().search("cacheFixtureAlpha");
  assert.equal(parses(), 1, "search and references reuse the same generation");
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, true);
  evictWorkspaceState(wikiRoot);
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).estimatedBytes, 0);
  await index().symbol("cacheFixtureAlpha");
  assert.equal(parses(), 2, "workspace eviction releases the generation");
});

test("same-size external edits with restored mtime invalidate cached code evidence", async (t) => {
  const { index, file } = await fixture(t);
  const fixedTime = new Date("2026-01-01T00:00:00Z");
  await fs.utimes(file, fixedTime, fixedTime);
  assert.equal((await index().symbol("cacheFixtureAlpha"))[0]?.fragment.symbol, "cacheFixtureAlpha");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replaceAll("cacheFixtureAlpha", "cacheFixtureBravo"));
  await fs.utimes(file, fixedTime, fixedTime);
  assert.deepEqual(await index().symbol("cacheFixtureAlpha"), []);
  assert.equal((await index().symbol("cacheFixtureBravo"))[0]?.fragment.symbol, "cacheFixtureBravo");
});

test("atomic replacement, deletion and recreation never resurrect a cached snapshot", async (t) => {
  const { index, file, wikiRoot } = await fixture(t);
  await index().symbol("cacheFixtureAlpha");
  const original = await fs.readFile(file, "utf8");
  const replacement = `${file}.replacement`;
  await fs.writeFile(replacement, original.replaceAll("cacheFixtureAlpha", "cacheFixtureBravo"));
  await fs.rename(replacement, file);
  assert.equal((await index().symbol("cacheFixtureBravo"))[0]?.fragment.symbol, "cacheFixtureBravo");
  await fs.unlink(file);
  assert.deepEqual(await index().symbol("cacheFixtureBravo"), []);
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).estimatedBytes, 0);
  await fs.writeFile(file, original);
  assert.equal((await index().symbol("cacheFixtureAlpha"))[0]?.fragment.symbol, "cacheFixtureAlpha");
});

test("a snapshot replaced during parsing is reverified before cache publication", async (t) => {
  const { index, file } = await fixture(t);
  const original = await fs.readFile(file, "utf8");
  const parse = JSON.parse;
  let replaced = false;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const parsed = parse(text, reviver);
    if (!replaced && text.includes("cacheFixtureAlpha")) {
      replaced = true;
      writeFileSync(file, original.replaceAll("cacheFixtureAlpha", "cacheFixtureBravo"));
    }
    return parsed;
  });
  assert.equal((await index().symbol("cacheFixtureBravo"))[0]?.fragment.symbol, "cacheFixtureBravo");
  assert.deepEqual(await index().symbol("cacheFixtureAlpha"), []);
  assert.equal(replaced, true);
});

test("returned snapshots, symbols, searches and references cannot mutate cached evidence", async (t) => {
  const { index } = await fixture(t);
  const symbol = (await index().symbol("cacheFixtureAlpha"))[0]!;
  const targetId = symbol.fragment.id;
  symbol.fragment.symbol = "poisoned";
  symbol.fragment.range.startLine = 999;
  const search = (await index().search("cacheFixtureAlpha"))[0]!;
  search.fragment.calls.push("poisoned");
  const references = await index().references(targetId);
  assert.ok(references.length > 0);
  references[0]!.target.qualifiedName = "poisoned";
  references[0]!.source.calls.length = 0;
  const snapshot = await index().snapshot();
  snapshot.fragments.length = 0;
  const fresh = (await index().symbol("cacheFixtureAlpha"))[0]!;
  assert.equal(fresh.fragment.symbol, "cacheFixtureAlpha");
  assert.equal(fresh.fragment.range.startLine, 1);
  assert.equal(fresh.fragment.calls.includes("poisoned"), false);
  assert.equal((await index().references(targetId)).length, references.length);
  assert.equal((await index().references(targetId))[0]!.target.qualifiedName, "cacheFixtureAlpha");
});

test("warm caches detect corrupt snapshots and check each caller's adapter roster", async (t) => {
  const { index, root, wikiRoot, file } = await fixture(t);
  await index().symbol("cacheFixtureAlpha");
  const otherRoster = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, adapter: new TypeScriptKnowledgeAdapter() });
  await assert.rejects(otherRoster.symbol("cacheFixtureAlpha"), /adapter roster changed/);
  await fs.writeFile(file, "{truncated");
  assert.equal((await index().symbol("cacheFixtureAlpha"))[0]?.fragment.symbol, "cacheFixtureAlpha");
  await index().removeFile("src/cache.ts");
  assert.deepEqual(await index().symbol("cacheFixtureAlpha"), []);
});

test("each project has its own cache budget and oversized snapshots remain searchable", async (t) => {
  const { index, root } = await fixture(t);
  const snapshot = await index().snapshot();
  snapshot.fragments[0]!.definition = "x".repeat(6 * 1024 * 1024);
  const serialized = JSON.stringify(snapshot);
  const roots: string[] = [];
  for (let workspace = 0; workspace < 3; workspace++) {
    const wikiRoot = path.join(root, `workspace-${workspace}`, "wiki");
    roots.push(wikiRoot);
    const file = codeEvidenceIndexFile(wikiRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serialized);
    const reader = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
    assert.equal((await reader.symbol("cacheFixtureAlpha"))[0]?.fragment.symbol, "cacheFixtureAlpha");
    const diagnostics = getCodeQueryCacheDiagnostics(wikiRoot);
    assert.ok(diagnostics.estimatedBytes <= diagnostics.maxEstimatedBytes);
  }
  assert.ok(roots.every((wikiRoot) => getCodeQueryCacheDiagnostics(wikiRoot).cached), "one project's admission must not evict other projects");
  const oversizedRoot = path.join(root, "oversized", "wiki");
  await fs.mkdir(path.dirname(codeEvidenceIndexFile(oversizedRoot)), { recursive: true });
  snapshot.fragments[0]!.definition = "x".repeat(9 * 1024 * 1024);
  await fs.writeFile(codeEvidenceIndexFile(oversizedRoot), JSON.stringify(snapshot));
  const oversized = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: oversizedRoot });
  assert.equal((await oversized.symbol("cacheFixtureAlpha"))[0]?.fragment.symbol, "cacheFixtureAlpha");
  assert.equal(getCodeQueryCacheDiagnostics(oversizedRoot).cached, false);
  assert.ok(roots.every((wikiRoot) => getCodeQueryCacheDiagnostics(wikiRoot).cached));
  clearWorkspaceStates();
  assert.ok(roots.every((wikiRoot) => getCodeQueryCacheDiagnostics(wikiRoot).estimatedBytes === 0));
});

test("homonymous symbols, concurrent queries and mutations remain isolated to their own project", async (t) => {
  const { index, root, wikiRoot } = await fixture(t);
  const otherRoot = path.join(root, "other-project");
  const otherWiki = path.join(otherRoot, "wiki");
  await fs.mkdir(path.join(otherRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(otherRoot, "src/cache.ts"), [
    "export function cacheFixtureAlpha(otherProject: string) { return otherProject; }",
    "export function otherProjectCaller() { return cacheFixtureAlpha('other'); }",
  ].join("\n"));
  const other = () => new PersistentCodeEvidenceIndex({ repositoryRoot: otherRoot, wikiRoot: otherWiki });
  await other().rebuild();
  const [first, second] = await Promise.all([index().symbol("cacheFixtureAlpha"), other().symbol("cacheFixtureAlpha")]);
  assert.equal(first[0]!.fragment.definition.includes("otherProject"), false);
  assert.equal(second[0]!.fragment.definition.includes("otherProject"), true);
  const firstReferences = await index().references(first[0]!.fragment.id);
  const secondReferences = await other().references(second[0]!.fragment.id);
  assert.ok(firstReferences.some((reference) => reference.source.symbol === "cacheFixtureCaller"));
  assert.equal(firstReferences.some((reference) => reference.source.symbol === "otherProjectCaller"), false);
  assert.ok(secondReferences.some((reference) => reference.source.symbol === "otherProjectCaller"));
  assert.equal(secondReferences.some((reference) => reference.source.symbol === "cacheFixtureCaller"), false);
  const parses = countSnapshotParses(t);
  await fs.writeFile(path.join(root, "src/cache.ts"), "export function renamedInFirstProject() { return 2; }");
  await index().updateFile("src/cache.ts");
  const beforeOtherQuery = parses();
  assert.deepEqual(await other().symbol("cacheFixtureAlpha"), second);
  assert.equal(parses(), beforeOtherQuery, "an update in the first project does not invalidate the second");
  assert.deepEqual(await index().symbol("cacheFixtureAlpha"), []);
  assert.ok((await index().symbol("renamedInFirstProject")).length > 0);
  evictWorkspaceState(wikiRoot);
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false);
  assert.equal(getCodeQueryCacheDiagnostics(otherWiki).cached, true);
  assert.deepEqual(await other().symbol("cacheFixtureAlpha"), second);
});


test("deletion during parsing ends retries and recreation loads a new generation", async (t) => {
  const { index, file, wikiRoot } = await fixture(t);
  const original = await fs.readFile(file, "utf8");
  const parse = JSON.parse;
  let reads = 0;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const parsed = parse(text, reviver);
    if (text.includes("cacheFixtureAlpha")) {
      reads++;
      unlinkSync(file);
    }
    return parsed;
  });
  // Count reads as well as parses: absent reads never invoke JSON.parse.
  const promises = (await import("node:fs/promises")).default;
  const read = promises.readFile;
  let fileReads = 0;
  t.mock.method(promises, "readFile", (...args: Parameters<typeof read>) => {
    if (String(args[0]) === file) fileReads++;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await index().symbol("cacheFixtureAlpha"), []);
  assert.equal(reads, 1);
  assert.equal(fileReads, 1);
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false);
  await fs.writeFile(file, original.replaceAll("cacheFixtureAlpha", "cacheFixtureBravo"));
  assert.equal((await index().symbol("cacheFixtureBravo"))[0]?.fragment.symbol, "cacheFixtureBravo");
});

test("continuous snapshot replacements exhaust retries without caching mismatched bytes", async (t) => {
  const { index, file, wikiRoot } = await fixture(t);
  const original = await fs.readFile(file, "utf8");
  const parse = JSON.parse;
  let replacements = 0;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const parsed = parse(text, reviver);
    if (text.includes("cacheFixture")) {
      replacements++;
      writeFileSync(file, original.replaceAll("cacheFixtureAlpha", `cacheFixtureVersion${replacements}`));
    }
    return parsed;
  });
  assert.ok((await index().symbol("cacheFixture" )).length > 0);
  assert.equal(replacements, 4);
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false);
  t.mock.restoreAll();
  assert.equal((await index().symbol("cacheFixtureVersion4"))[0]?.fragment.symbol, "cacheFixtureVersion4");
});

test("permission failures during snapshot reads propagate without discarding the generation", async (t) => {
  const { index, file, wikiRoot } = await fixture(t);
  const original = await fs.readFile(file, "utf8");
  const promises = (await import("node:fs/promises")).default;
  const read = promises.readFile;
  const failure = Object.assign(new Error("read denied"), { code: "EACCES" });
  t.mock.method(promises, "readFile", (...args: Parameters<typeof read>) => {
    if (String(args[0]) === file) return Promise.reject(failure);
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(index().symbol("cacheFixtureAlpha"), (error) => error === failure);
  assert.equal(getCodeQueryCacheDiagnostics(wikiRoot).cached, false);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.equal((await index().symbol("cacheFixtureAlpha"))[0]?.fragment.symbol, "cacheFixtureAlpha");
});
