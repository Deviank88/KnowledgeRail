import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import {
  clearWorkspaceStates,
  evictWorkspaceStateForProject,
  registerWorkspaceState,
  touchWorkspaceState,
  workspaceStateCount,
} from "../src/core/workspace-state.js";
import { WorkspaceBindingManager } from "../src/workspaces/bindings.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";
import { codeEvidenceIndexFile, getCodeQueryCacheDiagnostics, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";

async function workspaceFixture(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const pageDir = path.join(root, "wiki", "concepts");
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(path.join(pageDir, "Page.md"), [
    "---",
    "title: Page",
    "type: concept",
    "tags: [state]",
    "created: 2026-08-16",
    "updated: 2026-08-16",
    "sources: []",
    "---",
    "",
    "# Page",
  ].join("\n"));
  return fs.realpath(root);
}

test("workspace state uses an LRU cap and evicts on the final binding release", async () => {
  const previousCap = process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
  process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"] = "2";
  clearWorkspaceStates();
  const roots = await Promise.all([
    workspaceFixture("knowledge-rail-state-a-"),
    workspaceFixture("knowledge-rail-state-b-"),
    workspaceFixture("knowledge-rail-state-c-"),
  ]);
  try {
    for (const root of roots) {
      await getWikiPageRecords(path.join(root, "wiki"), false, { persist: false });
    }
    assert.equal(workspaceStateCount(), 2);

    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-binding-state-"));
    const registry = new WorkspaceRegistry(stateDirectory);
    const registration = await registry.register(roots[2]!);
    const bindings = new WorkspaceBindingManager(
      registry,
      undefined,
      undefined,
      undefined,
      (workspaceId) => {
        if (workspaceId === registration.id) evictWorkspaceStateForProject(registration.canonicalRoot);
      }
    );
    const binding = await bindings.issue(registration.id, "read", "desktop");
    assert.equal(bindings.release(binding.binding, "desktop"), true);
    assert.equal(workspaceStateCount(), 1);
  } finally {
    clearWorkspaceStates();
    if (previousCap === undefined) delete process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
    else process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"] = previousCap;
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
});

test("LRU eviction follows access order when timestamps tie or the clock moves backward", (t) => {
  const previousCap = process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
  process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"] = "2";
  clearWorkspaceStates();
  // The current LRU does not read the clock. This mock prevents a future
  // timestamp-based implementation from passing under ties or clock rollback.
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const evicted: string[] = [];
  const register = (name: string): void => registerWorkspaceState(
    path.join(os.tmpdir(), name), "test", () => { evicted.push(name); }
  );
  try {
    register("a");
    register("b");
    touchWorkspaceState(path.join(os.tmpdir(), "a"));
    register("c");
    assert.deepEqual(evicted, ["b"], "the recently touched workspace must survive timestamp ties");

    now = 500;
    register("a");
    register("d");
    assert.deepEqual(evicted, ["b", "c"], "registration also updates recency independently of wall time");
    assert.equal(workspaceStateCount(), 2);
  } finally {
    clearWorkspaceStates();
    if (previousCap === undefined) delete process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
    else process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"] = previousCap;
  }
});

test("the default retains five projects and reopens an evicted project's persisted code", async () => {
  const previousCap = process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
  delete process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
  clearWorkspaceStates();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kr-five-projects-"));
  const projects = Array.from({ length: 6 }, (_, i) => {
    const repositoryRoot = path.join(directory, `project-${i}`), wikiRoot = path.join(repositoryRoot, "wiki");
    return new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
  });
  try {
    for (const [i, project] of projects.entries()) {
      await fs.mkdir(project.repositoryRoot);
      await fs.writeFile(path.join(project.repositoryRoot, "source.ts"), `export function projectValue${i}() { return ${i}; }`);
    }
    for (const project of projects.slice(0, 5)) await project.rebuild();
    const expected = await projects[1]!.symbol("projectValue1");
    const persisted = await fs.readFile(codeEvidenceIndexFile(projects[1]!.wikiRoot));
    for (const [i, project] of projects.slice(0, 5).entries()) {
      assert.equal((await project.symbol(`projectValue${i}`))[0]?.fragment.symbol, `projectValue${i}`);
    }
    assert.equal(workspaceStateCount(), 5);
    assert.ok(projects.slice(0, 5).every((p) => getCodeQueryCacheDiagnostics(p.wikiRoot).cached));
    await projects[0]!.symbol("projectValue0");
    await projects[5]!.rebuild();
    assert.equal((await projects[5]!.symbol("projectValue5"))[0]?.fragment.symbol, "projectValue5");
    assert.equal(workspaceStateCount(), 5);
    assert.equal(getCodeQueryCacheDiagnostics(projects[0]!.wikiRoot).cached, true, "recently used project stays warm");
    assert.equal(getCodeQueryCacheDiagnostics(projects[1]!.wikiRoot).estimatedBytes, 0, "least recently used code cache is released");
    assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(projects[1]!.wikiRoot)), persisted, "eviction does not delete or rewrite the index");
    assert.deepEqual(await projects[1]!.symbol("projectValue1"), expected, "reopening restores the same evidence");
    assert.equal(workspaceStateCount(), 5);
  } finally {
    clearWorkspaceStates();
    if (previousCap === undefined) delete process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"];
    else process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"] = previousCap;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
