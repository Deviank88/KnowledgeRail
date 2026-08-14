import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { atomicWriteText } from "../src/core/fs-service.js";
import {
  invalidateManifestEntries,
  manifestFile,
  rebuildManifest,
  readManifest,
} from "../src/core/manifest-service.js";

test("atomicWriteText writes complete content and manifest supports invalidation", async () => {
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-fs-"));
  const pagePath = path.join(wikiRoot, "concepts", "Atomic.md");

  await atomicWriteText(pagePath, "alpha");
  assert.equal(await fs.readFile(pagePath, "utf-8"), "alpha");

  const manifest = await rebuildManifest(wikiRoot);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0]?.path, "concepts/Atomic.md");
  await fs.access(manifestFile(wikiRoot));

  await invalidateManifestEntries(wikiRoot, ["concepts/Atomic.md"]);
  const updated = await readManifest(wikiRoot);
  assert.equal(updated?.entries.length, 0);
});

