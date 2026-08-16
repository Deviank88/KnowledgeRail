import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setWikiRoot } from "../src/core/paths.js";
import { ensureWikiStructure } from "../src/core/wiki-structure-service.js";

function runWorker(root: string, oldString: string, newString: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "tests/fixtures/edit-page-worker.ts",
      root,
      oldString,
      newString,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`edit worker failed (${code ?? signal}): ${stderr}`));
    });
  });
}

test("two processes serialize editPage without losing either update", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-cross-process-"));
  setWikiRoot(root);
  await ensureWikiStructure();
  const pagePath = path.join(root, "wiki", "concepts", "Concurrent.md");
  await fs.mkdir(path.dirname(pagePath), { recursive: true });
  await fs.writeFile(pagePath, [
    "---",
    "title: Concurrent",
    "type: concept",
    "tags: [locking]",
    "created: 2026-08-16",
    "updated: 2026-08-16",
    "sources: []",
    "---",
    "",
    "# Concurrent",
    "FIRST_TOKEN SECOND_TOKEN",
  ].join("\n"));

  await Promise.all([
    runWorker(root, "FIRST_TOKEN", "FIRST_UPDATED"),
    runWorker(root, "SECOND_TOKEN", "SECOND_UPDATED"),
  ]);

  const content = await fs.readFile(pagePath, "utf8");
  assert.match(content, /FIRST_UPDATED/);
  assert.match(content, /SECOND_UPDATED/);
  assert.doesNotMatch(content, /FIRST_TOKEN|SECOND_TOKEN/);
  await fs.rm(root, { recursive: true, force: true });
});
