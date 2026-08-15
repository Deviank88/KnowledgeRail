import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  discoverWorkspaceFromCwd,
  unsafeAutomaticRootReason,
} from "../src/mcp/workspace-discovery.js";

test("automatic discovery prefers an existing KnowledgeRail root from a nested directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-discovery-"));
  const nested = path.join(root, "src", "feature");
  await fs.mkdir(path.join(root, "wiki"), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "wiki", "SCHEMA.md"), "# schema\n");
  await fs.writeFile(path.join(root, "package.json"), "{}\n");

  const resolution = await discoverWorkspaceFromCwd(nested);
  assert.deepEqual(resolution, { root: await fs.realpath(root), source: "knowledge_rail_marker" });
});

test("automatic discovery finds the nearest project marker without scanning outside ancestry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-project-"));
  const nested = path.join(root, "packages", "api", "lib");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "packages", "api", "pyproject.toml"), "[project]\nname='api'\n");

  const resolution = await discoverWorkspaceFromCwd(nested);
  assert.deepEqual(resolution, {
    root: await fs.realpath(path.join(root, "packages", "api")),
    source: "project_marker",
  });
});

test("automatic discovery fails closed for empty incidental directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-empty-"));
  await assert.rejects(() => discoverWorkspaceFromCwd(root), /empty directory/);
});

test("automatic root safety rejects filesystem and user-home roots on every platform", () => {
  assert.equal(unsafeAutomaticRootReason(path.parse(process.cwd()).root), "filesystem root");
  assert.equal(unsafeAutomaticRootReason(os.homedir()), "user home directory");
});
