import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";
import { resolveStateDirectory } from "../src/workspaces/state-paths.js";

test("state directory follows native Windows, macOS and Linux conventions", () => {
  assert.equal(resolveStateDirectory({
    platform: "win32",
    homeDir: "C:\\Users\\Ada",
    env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
  }), path.resolve("C:\\Users\\Ada\\AppData\\Local", "KnowledgeRail"));
  assert.equal(resolveStateDirectory({
    platform: "darwin",
    homeDir: "/Users/ada",
    env: {},
  }), path.join("/Users/ada", "Library", "Application Support", "KnowledgeRail"));
  assert.equal(resolveStateDirectory({
    platform: "linux",
    homeDir: "/home/ada",
    env: { XDG_STATE_HOME: "/state/ada" },
  }), path.resolve("/state/ada", "knowledge-rail"));
});

test("registry canonicalizes, deduplicates and returns only safe catalog metadata", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-state-"));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-secret-"));
  const registry = new WorkspaceRegistry(state);

  const first = await registry.register(project, "automatic");
  const second = await registry.register(path.join(project, "."), "operator");
  assert.equal(second.id, first.id);
  assert.equal(second.source, "operator");

  const safe = await registry.listSafe();
  assert.equal(safe.length, 1);
  assert.equal(safe[0]?.id, first.id);
  assert.equal(safe[0]?.displayName, path.basename(project));
  assert.equal(safe[0]?.availability, "available");
  assert.equal(JSON.stringify(safe).includes(project), false, "MCP-safe metadata must not disclose the root");

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(registry.filePath)).mode & 0o777, 0o600);
  }
});

test("concurrent registry mutations retain all workspaces", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-state-concurrent-"));
  const roots = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    fs.mkdtemp(path.join(os.tmpdir(), `knowledge-rail-workspace-${index}-`))
  ));
  const registry = new WorkspaceRegistry(state);
  await Promise.all(roots.map((root) => registry.register(root)));
  assert.equal((await registry.listSafe()).length, roots.length);
});

test("unregister removes only catalog metadata and preserves project contents", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-state-remove-"));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-preserved-"));
  const sentinel = path.join(project, "customer-data.txt");
  await fs.writeFile(sentinel, "preserve me");
  const registry = new WorkspaceRegistry(state);
  const entry = await registry.register(project);

  assert.equal(await registry.unregister(entry.id), true);
  assert.equal(await registry.unregister(entry.id), false);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve me");
});

test("registry recovers reads from its last valid backup", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-state-backup-"));
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-backup-a-"));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-backup-b-"));
  const registry = new WorkspaceRegistry(state);
  const first = await registry.register(firstRoot);
  await registry.register(secondRoot);
  await fs.writeFile(registry.filePath, "{corrupt", "utf8");

  const entries = await registry.listSafe();
  assert.equal(entries.some((entry) => entry.id === first.id), true);
});

test("registry fails closed when both primary and backup are unusable", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-state-corrupt-"));
  const registry = new WorkspaceRegistry(state);
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(registry.filePath, "{corrupt", "utf8");
  await assert.rejects(() => registry.listSafe(), /corrupt/);
});
