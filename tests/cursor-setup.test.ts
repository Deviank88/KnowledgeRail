import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PRODUCT_VERSION } from "../src/product.js";
import { installCursorSetup } from "../src/runtime/cursor-setup-cli.js";

async function projectFixture(): Promise<{ root: string; nested: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-cursor-setup-"));
  const nested = path.join(root, "packages", "app", "src");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  return { root: await fs.realpath(root), nested };
}

test("Cursor setup discovers the project and writes a deterministic project-scoped server", async () => {
  const fixture = await projectFixture();
  try {
    const result = await installCursorSetup(fixture.nested);
    assert.equal(result.root, fixture.root);
    assert.equal(result.changed, true);
    assert.equal(result.configPath, path.join(fixture.root, ".cursor", "mcp.json"));
    assert.deepEqual(JSON.parse(await fs.readFile(result.configPath, "utf8")), {
      mcpServers: {
        "knowledge-rail": {
          type: "stdio",
          command: "npx",
          args: ["-y", `knowledge-rail@${PRODUCT_VERSION}`, "--root", "${workspaceFolder}"],
        },
      },
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Cursor setup preserves unrelated values and is idempotent", async () => {
  const fixture = await projectFixture();
  const configPath = path.join(fixture.root, ".cursor", "mcp.json");
  try {
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(configPath, `${JSON.stringify({
      customTopLevel: { enabled: true },
      mcpServers: {
        unrelated: { command: "other", args: ["--safe"] },
        "knowledge-rail": {
          command: "old",
          url: "https://old.example/mcp",
          headers: { Authorization: "remove remote-only fields" },
          auth: { CLIENT_ID: "remove-me" },
          env: { KEEP_ME: "yes" },
        },
      },
    }, null, 2)}\n`, "utf8");

    const first = await installCursorSetup(fixture.root);
    assert.equal(first.changed, true);
    const firstRaw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(firstRaw);
    assert.deepEqual(parsed.customTopLevel, { enabled: true });
    assert.deepEqual(parsed.mcpServers.unrelated, { command: "other", args: ["--safe"] });
    assert.deepEqual(parsed.mcpServers["knowledge-rail"].env, { KEEP_ME: "yes" });
    assert.equal(parsed.mcpServers["knowledge-rail"].type, "stdio");
    assert.equal("url" in parsed.mcpServers["knowledge-rail"], false);
    assert.equal("headers" in parsed.mcpServers["knowledge-rail"], false);
    assert.equal("auth" in parsed.mcpServers["knowledge-rail"], false);

    const second = await installCursorSetup(fixture.root);
    assert.equal(second.changed, false);
    assert.equal(await fs.readFile(configPath, "utf8"), firstRaw);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Cursor setup refuses malformed or structurally conflicting configuration", async () => {
  for (const raw of ["{broken\n", "[]\n", '{"mcpServers":[]}\n', '{"mcpServers":{"knowledge-rail":false}}\n']) {
    const fixture = await projectFixture();
    const configPath = path.join(fixture.root, ".cursor", "mcp.json");
    try {
      await fs.mkdir(path.dirname(configPath));
      await fs.writeFile(configPath, raw, "utf8");
      await assert.rejects(installCursorSetup(fixture.root), /mcp\.json/);
      assert.equal(await fs.readFile(configPath, "utf8"), raw);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Cursor setup rejects empty directories and file targets without writing configuration", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-cursor-empty-"));
  const file = path.join(empty, "not-a-project");
  try {
    await assert.rejects(installCursorSetup(empty), /empty directory/);
    await fs.writeFile(file, "content", "utf8");
    await assert.rejects(installCursorSetup(file), /not exist or is not a directory/);
    await assert.rejects(fs.access(path.join(empty, ".cursor", "mcp.json")));
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});
