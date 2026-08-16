import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import {
  clearWorkspaceStates,
  evictWorkspaceStateForProject,
  workspaceStateCount,
} from "../src/core/workspace-state.js";
import { WorkspaceBindingManager } from "../src/workspaces/bindings.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";

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
