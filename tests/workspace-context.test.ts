import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { getWikiRoot, markWikiRootPending, setWikiRoot, wikiDir } from "../src/core/paths.js";
import {
  createWorkspaceContext,
  getActiveWorkspaceContext,
  runWithWorkspaceContext,
} from "../src/core/workspace-context.js";

test("workspace context isolates concurrent asynchronous operations", async () => {
  const fallback = path.join(os.tmpdir(), "knowledge-rail-default");
  const rootA = path.join(os.tmpdir(), "knowledge-rail-context-a");
  const rootB = path.join(os.tmpdir(), "knowledge-rail-context-b");
  setWikiRoot(fallback);

  const observed = await Promise.all([
    runWithWorkspaceContext(createWorkspaceContext(rootA), async () => {
      await delay(20);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      return [getWikiRoot(), wikiDir(), getActiveWorkspaceContext()?.paths.projectRoot];
    }),
    runWithWorkspaceContext(createWorkspaceContext(rootB), async () => {
      await delay(5);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return [getWikiRoot(), wikiDir(), getActiveWorkspaceContext()?.paths.projectRoot];
    }),
  ]);

  assert.deepEqual(observed, [
    [rootA, path.join(rootA, "wiki"), rootA],
    [rootB, path.join(rootB, "wiki"), rootB],
  ]);
  assert.equal(getWikiRoot(), fallback);
  assert.equal(getActiveWorkspaceContext(), undefined);
});

test("request workspace stays usable while an unrelated legacy connection is pending", async () => {
  const fallback = path.join(os.tmpdir(), "knowledge-rail-gated");
  const requestRoot = path.join(os.tmpdir(), "knowledge-rail-request");
  setWikiRoot(fallback);
  markWikiRootPending();

  try {
    assert.equal(
      await runWithWorkspaceContext(createWorkspaceContext(requestRoot), async () => {
        await delay(1);
        return getWikiRoot();
      }),
      requestRoot
    );
  } finally {
    setWikiRoot(fallback);
  }
});
