import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceBindingError, WorkspaceBindingManager } from "../src/workspaces/bindings.js";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";

test("opaque bindings isolate workspace, principal and scope", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-binding-state-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-binding-root-"));
  const registry = new WorkspaceRegistry(state);
  const registration = await registry.register(root);
  const bindings = new WorkspaceBindingManager(registry);

  const issued = await bindings.issue(registration.id, "read", "desktop-principal-a");
  assert.match(issued.binding, /^krb1_[A-Za-z0-9_-]+$/);
  assert.equal(issued.binding.includes(root), false);
  const context = await bindings.resolve(issued.binding, "desktop-principal-a");
  assert.equal(context.paths.projectRoot, await fs.realpath(root));
  assert.equal(context.scope, "read");

  await assert.rejects(
    () => bindings.resolve(issued.binding, "desktop-principal-b"),
    (error: unknown) => error instanceof WorkspaceBindingError && error.code === "principal"
  );
  await assert.rejects(
    () => bindings.resolve(issued.binding, "desktop-principal-a", true),
    (error: unknown) => error instanceof WorkspaceBindingError && error.code === "scope"
  );
});

test("release revokes one chat binding without affecting another", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-release-state-"));
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-release-a-"));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-release-b-"));
  const registry = new WorkspaceRegistry(state);
  const [workspaceA, workspaceB] = await Promise.all([registry.register(rootA), registry.register(rootB)]);
  const bindings = new WorkspaceBindingManager(registry);
  const [bindingA, bindingB] = await Promise.all([
    bindings.issue(workspaceA.id, "write", "desktop"),
    bindings.issue(workspaceB.id, "write", "desktop"),
  ]);

  assert.equal(bindings.release(bindingA.binding, "desktop"), true);
  await assert.rejects(() => bindings.resolve(bindingA.binding, "desktop"), /unknown or was released/);
  assert.equal((await bindings.resolve(bindingB.binding, "desktop")).paths.projectRoot, await fs.realpath(rootB));
});

test("expired binding fails closed and cannot silently select a recent workspace", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-expiry-state-"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-expiry-root-"));
  const registry = new WorkspaceRegistry(state);
  const workspace = await registry.register(root);
  let now = 1_000;
  const bindings = new WorkspaceBindingManager(registry, 100, 1_000, () => now);
  const issued = await bindings.issue(workspace.id, "write", "desktop");
  now = 1_101;
  await assert.rejects(
    () => bindings.resolve(issued.binding, "desktop"),
    (error: unknown) => error instanceof WorkspaceBindingError && error.code === "expired"
  );
});
