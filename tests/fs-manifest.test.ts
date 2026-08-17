import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { atomicWriteText } from "../src/core/fs-service.js";
import {
  invalidateManifestEntries,
  manifestFile,
  normalizeManifestPath,
  rebuildManifest,
  readManifest,
  saveManifest,
} from "../src/core/manifest-service.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

test("atomicWriteText writes complete content and manifest supports invalidation", async () => {
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-fs-"));
  const pagePath = path.join(wikiRoot, "concepts", "Atomic.md");

  await atomicWriteText(pagePath, "alpha");
  assert.equal(await fs.readFile(pagePath, "utf-8"), "alpha");

  const manifest = await rebuildManifest(wikiRoot);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0]?.path, "concepts/Atomic.md");
  await fs.access(manifestFile(wikiRoot));

  await invalidateManifestEntries(wikiRoot, ["concepts/Atomic.md"]);
  const updated = await readManifest(wikiRoot);
  assert.equal(updated?.version, 2);
  assert.equal(updated?.entries.length, 0);
});

test("manifest v2 is byte-identical across newline, Unicode path and timestamp variants", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-portable-manifest-"));
  const leftRoot = path.join(parent, "left");
  const rightRoot = path.join(parent, "right");
  const nfdName = "Cafe\u0301.md";
  const nfcName = "Caf\u00e9.md";
  const normalizedContent = "# Caf\u00e9\n\nPortable\nline\n";
  try {
    await Promise.all([
      fs.mkdir(path.join(leftRoot, "concepts"), { recursive: true }),
      fs.mkdir(path.join(rightRoot, "concepts"), { recursive: true }),
    ]);
    const leftFile = path.join(leftRoot, "concepts", nfdName);
    const rightFile = path.join(rightRoot, "concepts", nfcName);
    await fs.writeFile(leftFile, "# Caf\u00e9\r\n\r\nPortable\rline\r\n", "utf8");
    await fs.writeFile(rightFile, normalizedContent, "utf8");
    await fs.utimes(leftFile, new Date(0), new Date(0));
    await fs.utimes(rightFile, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"));

    const [left, right] = await Promise.all([
      rebuildManifest(leftRoot),
      rebuildManifest(rightRoot),
    ]);
    const [leftRaw, rightRaw] = await Promise.all([
      fs.readFile(manifestFile(leftRoot)),
      fs.readFile(manifestFile(rightRoot)),
    ]);

    assert.deepEqual(left, right);
    assert.deepEqual(leftRaw, rightRaw);
    assert.equal(sha256(leftRaw), sha256(rightRaw));
    assert.equal(left.version, 2);
    assert.equal(left.hashAlgorithm, "sha256");
    assert.equal(left.contentNormalization, "line-endings-lf");
    assert.equal(left.pathNormalization, "posix-unicode-nfc");
    assert.equal(left.entries[0]?.path, `concepts/${nfcName}`);
    assert.equal(left.entries[0]?.size, Buffer.byteLength(normalizedContent));
    assert.equal(left.entries[0]?.sha256, sha256(normalizedContent));
    assert.equal(leftRaw.includes(Buffer.from("generatedAt")), false);
    assert.equal(leftRaw.includes(Buffer.from("mtimeMs")), false);
    assert.equal(normalizeManifestPath(`concepts\\${nfdName}`), `concepts/${nfcName}`);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("invalidating a v1 manifest upgrades it to deterministic v2", async () => {
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-manifest-upgrade-"));
  const relPath = "concepts/Legacy.md";
  try {
    await fs.mkdir(path.join(wikiRoot, "concepts"), { recursive: true });
    await fs.mkdir(path.dirname(manifestFile(wikiRoot)), { recursive: true });
    const content = "# Legacy\r\n";
    const file = path.join(wikiRoot, relPath);
    await fs.writeFile(file, content, "utf8");
    const stat = await fs.stat(file);
    await fs.writeFile(manifestFile(wikiRoot), `${JSON.stringify({
      version: 1,
      generatedAt: "2026-07-31T10:59:32.156Z",
      entries: [{
        path: relPath,
        size: Buffer.byteLength(content),
        mtimeMs: stat.mtimeMs,
        sha256: sha256(content),
        logicalType: "wiki_page",
      }],
    }, null, 2)}\n`, "utf8");

    assert.equal((await readManifest(wikiRoot))?.version, 1);
    await invalidateManifestEntries(wikiRoot, [relPath]);

    const upgraded = await readManifest(wikiRoot);
    assert.equal(upgraded?.version, 2);
    assert.equal(upgraded?.entries.length, 0);
    const raw = await fs.readFile(manifestFile(wikiRoot), "utf8");
    assert.doesNotMatch(raw, /generatedAt|mtimeMs/);
  } finally {
    await fs.rm(wikiRoot, { recursive: true, force: true });
  }
});

test("manifest v2 rejects paths that collide on case-insensitive filesystems", async () => {
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-manifest-collision-"));
  const digest = sha256("same");
  try {
    await assert.rejects(
      saveManifest(wikiRoot, {
        version: 2,
        hashAlgorithm: "sha256",
        contentNormalization: "line-endings-lf",
        pathNormalization: "posix-unicode-nfc",
        entries: [
          { path: "concepts/Case.md", size: 4, sha256: digest, logicalType: "wiki_page" },
          { path: "concepts/case.md", size: 4, sha256: digest, logicalType: "wiki_page" },
        ],
      }),
      /invalid or non-portable entries/
    );
  } finally {
    await fs.rm(wikiRoot, { recursive: true, force: true });
  }
});
