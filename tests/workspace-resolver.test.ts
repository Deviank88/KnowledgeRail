import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  getWikiRoot,
  isWikiRootReady,
  markWikiRootPending,
  setWikiRoot,
  wikiDir,
  WikiWorkspacePendingError,
} from "../src/core/paths.js";
import {
  resolveLegacyMcpWorkspace,
  resolveWorkspace,
} from "../src/mcp/workspace.js";

test("workspace resolver keeps explicit override above legacy Roots, env and cwd", async () => {
  const explicit = path.resolve("tmp-explicit");
  let legacyCalls = 0;
  const result = await resolveWorkspace({
    explicitRoot: explicit,
    legacyRootProvider: async () => {
      legacyCalls++;
      return path.resolve("tmp-roots");
    },
    envRoot: path.resolve("tmp-env"),
    cwd: path.resolve("tmp-cwd"),
  });

  assert.deepEqual(result, { root: explicit, source: "explicit" });
  assert.equal(legacyCalls, 0, "lower-priority provider must not be invoked");
});

test("pure workspace resolution does not mutate the active project", async () => {
  const original = getWikiRoot();
  const sentinel = path.resolve("tmp-active-project");
  setWikiRoot(sentinel);

  try {
    const result = await resolveWorkspace({
      explicitRoot: path.resolve("tmp-proposed-project"),
      envRoot: null,
      cwd: path.resolve("tmp-cwd"),
    });

    assert.equal(result.source, "explicit");
    assert.equal(getWikiRoot(), sentinel);
  } finally {
    setWikiRoot(original);
  }
});

test("workspace path access fails closed while a project negotiation is pending", () => {
  const original = getWikiRoot();
  setWikiRoot(path.resolve("tmp-safe-project"));

  try {
    markWikiRootPending();
    assert.equal(isWikiRootReady(), false);
    assert.throws(() => getWikiRoot(), WikiWorkspacePendingError);
    assert.throws(() => wikiDir(), WikiWorkspacePendingError);
  } finally {
    setWikiRoot(original);
  }

  assert.equal(isWikiRootReady(), true);
});

test("legacy Roots preserves v3 precedence over WIKI_ROOT when compatibility adapter is enabled", async () => {
  const legacy = path.resolve("tmp-roots");
  const result = await resolveWorkspace({
    legacyRootProvider: async () => legacy,
    envRoot: path.resolve("tmp-env"),
    cwd: path.resolve("tmp-cwd"),
  });

  assert.deepEqual(result, { root: legacy, source: "legacy_roots" });
});

test("modern workspace resolution omits Roots and uses WIKI_ROOT then cwd", async () => {
  const envRoot = path.resolve("tmp-env");
  const cwd = path.resolve("tmp-cwd");

  const fromEnv = await resolveWorkspace({ envRoot, cwd });
  assert.deepEqual(fromEnv, { root: envRoot, source: "env" });

  const fromCwd = await resolveWorkspace({ envRoot: null, cwd });
  assert.deepEqual(fromCwd, { root: cwd, source: "cwd" });
});

test("failed legacy Roots negotiation falls back safely instead of blocking workspace resolution", async () => {
  const envRoot = path.resolve("tmp-env");
  const result = await resolveWorkspace({
    legacyRootProvider: async () => {
      throw new Error("roots unsupported");
    },
    envRoot,
    cwd: path.resolve("tmp-cwd"),
  });

  assert.deepEqual(result, { root: envRoot, source: "env" });
});

test("legacy MCP adapter skips invalid root URI and activates the first usable project", async () => {
  const original = getWikiRoot();
  const usable = path.resolve("tmp-legacy-project");
  const server = {
    server: {
      listRoots: async () => ({
        roots: [
          { uri: "file://%zz" },
          { uri: pathToFileURL(usable).href },
        ],
      }),
    },
  };

  try {
    const result = await resolveLegacyMcpWorkspace(server, {
      envRoot: path.resolve("tmp-env"),
      cwd: path.resolve("tmp-cwd"),
    });
    assert.deepEqual(result, { root: usable, source: "legacy_roots" });
    assert.equal(getWikiRoot(), usable);
  } finally {
    setWikiRoot(original);
  }
});
