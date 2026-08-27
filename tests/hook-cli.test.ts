import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { runDriftCli } from "../src/runtime/drift-cli.js";
import { runHookCli } from "../src/runtime/hook-cli.js";

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: Readable.from([JSON.stringify({ tool_input: { file_path: "/project/src/a.ts" } })]),
      stdout: { write: (value: string) => { stdout += value; } },
      stderr: { write: (value: string) => { stderr += value; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

const drift = (async (options, io) => {
  assert.deepEqual(options.paths, ["/project/src/a.ts"]);
  io!.stdout.write("drift: 0 fresh, 1 stale\n");
  return 0;
}) satisfies typeof runDriftCli;

test("hook bridge translates post-edit drift into Codex and Cursor native context", async () => {
  const codex = output();
  assert.equal(await runHookCli("codex", "post-edit", codex.io, drift), 0);
  const codexJson = JSON.parse(codex.read().stdout);
  assert.equal(codexJson.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(codexJson.hookSpecificOutput.additionalContext, /1 stale/);

  const cursor = output();
  assert.equal(await runHookCli("cursor", "post-edit", cursor.io, drift), 0);
  assert.match(JSON.parse(cursor.read().stdout).additional_context, /1 stale/);
});

test("hook bridge emits session awareness even when drift is clean", async () => {
  const result = output();
  const clean = (async (_options, _io) => 0) satisfies typeof runDriftCli;
  await runHookCli("claude", "session", result.io, clean);
  const json = JSON.parse(result.read().stdout);
  assert.match(json.hookSpecificOutput.additionalContext, /knowledge_context mode=task/);
});

test("stop output stays advisory and cannot trigger a Cursor continuation loop", async () => {
  const finalDrift = (async (options, io) => {
    assert.deepEqual(options.paths, []);
    io!.stdout.write("drift: 0 fresh, 1 stale\n");
    return 0;
  }) satisfies typeof runDriftCli;
  const stopped = output();
  await runHookCli("codex", "stop", stopped.io, finalDrift);
  const codexJson = JSON.parse(stopped.read().stdout);
  assert.match(codexJson.systemMessage, /1 stale/);
  assert.equal(codexJson.hookSpecificOutput, undefined);

  const cursor = output();
  await runHookCli("cursor", "stop", cursor.io, finalDrift);
  assert.deepEqual(JSON.parse(cursor.read().stdout), {});
});
