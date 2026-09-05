import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  clearRetrievalIndexes,
  refreshRetrievalIndex,
  searchRetrievalIndex,
  updateRetrievalPaths,
} from "../src/core/retrieval-index.js";

function page(body: string): string {
  return `---\ntitle: Freshness\ntype: concept\nsources: []\n---\n\n${body}\n`;
}

async function fixture(t: TestContext) {
  clearRetrievalIndexes();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-freshness-"));
  t.after(async () => {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "concepts"));
  await fs.writeFile(path.join(root, "concepts/A.md"), page("original"));
  await fs.writeFile(path.join(root, "concepts/B.md"), page("original"));
  const state = await refreshRetrievalIndex(root);
  // Disable real watcher delivery; inject notifications explicitly below so
  // these interleavings are reproducible on polling-only platforms too.
  state.watcher?.close();
  state.watcherReliable = false;
  state.dirty = false;
  return { root, state };
}

test("a targeted update preserves a pending notification for another page", async (t) => {
  const { root, state } = await fixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await fs.writeFile(path.join(root, "concepts/B.md"), page("externalneedle"));
  state.dirty = true; // The watcher has observed the external write.
  await fs.writeFile(path.join(root, "concepts/A.md"), page("targeted update"));
  await updateRetrievalPaths(root, ["concepts/A.md"]);
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "externalneedle", persist: false });
  assert.deepEqual(hits.map((hit) => hit.path), ["concepts/B.md"]);
});

test("targeted updates cannot postpone the polling reconciliation deadline", async (t) => {
  const { root, state } = await fixture(t);
  const previousRefresh = process.env["KNOWLEDGE_RAIL_REFRESH_MS"];
  process.env["KNOWLEDGE_RAIL_REFRESH_MS"] = "2000";
  t.after(() => {
    if (previousRefresh === undefined) delete process.env["KNOWLEDGE_RAIL_REFRESH_MS"];
    else process.env["KNOWLEDGE_RAIL_REFRESH_MS"] = previousRefresh;
  });
  const now = state.lastScanMs + 2001;
  t.mock.method(Date, "now", () => now);
  await fs.writeFile(path.join(root, "concepts/B.md"), page("pollingneedle"));
  await fs.writeFile(path.join(root, "concepts/A.md"), page("targeted update"));
  await updateRetrievalPaths(root, ["concepts/A.md"]);
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "pollingneedle", persist: false });
  assert.deepEqual(hits.map((hit) => hit.path), ["concepts/B.md"]);
});

test("a notification received during reconciliation survives until the next search", async (t) => {
  const { root, state } = await fixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const metadata = state.fileMetadata;
  const getMetadata = metadata.get.bind(metadata);
  let changed = false;
  t.mock.method(metadata, "get", (relativePath: string) => {
    if (relativePath === "concepts/B.md" && !changed) {
      // A was already verified when this later file is examined.
      writeFileSync(path.join(root, "concepts/A.md"), page("concurrentneedle"));
      state.dirty = true;
      changed = true;
    }
    return getMetadata(relativePath);
  });
  await refreshRetrievalIndex(root, { force: true, persist: false });
  assert.equal(changed, true);
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "concurrentneedle", persist: false });
  assert.deepEqual(hits.map((hit) => hit.path), ["concepts/A.md"]);
});

test("scan errors reject without publishing a partial generation and the next query recovers", async (t) => {
  const { root, state } = await fixture(t);
  await fs.writeFile(path.join(root, "concepts/A.md"), page("pendingneedle"));
  const previousRecord = state.records.get("concepts/A.md");
  const metadata = state.fileMetadata;
  const getMetadata = metadata.get.bind(metadata);
  const failure = Object.assign(new Error("permission denied during scan"), { code: "EACCES" });
  t.mock.method(metadata, "get", (relativePath: string) => {
    if (relativePath === "concepts/B.md") throw failure;
    return getMetadata(relativePath);
  });
  await assert.rejects(refreshRetrievalIndex(root, { force: true, persist: false }), (error) => error === failure);
  assert.equal(state.records.get("concepts/A.md"), previousRecord);
  t.mock.restoreAll();
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "pendingneedle", persist: false });
  assert.deepEqual(hits.map((hit) => hit.path), ["concepts/A.md"]);
});

test("a deletion during scan rejects the incomplete generation then reconciles removal", async (t) => {
  const { root, state } = await fixture(t);
  const { unlinkSync } = await import("node:fs");
  const metadata = state.fileMetadata;
  const getMetadata = metadata.get.bind(metadata);
  let deleted = false;
  t.mock.method(metadata, "get", (relativePath: string) => {
    if (relativePath === "concepts/B.md" && !deleted) {
      unlinkSync(path.join(root, relativePath));
      deleted = true;
      return undefined; // Require a strict content read for the vanished page.
    }
    return getMetadata(relativePath);
  });
  await assert.rejects(refreshRetrievalIndex(root, { force: true, persist: false }), { code: "ENOENT" });
  assert.equal(state.records.has("concepts/B.md"), true, "failed scan never publishes a partial candidate");
  t.mock.restoreAll();
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "original", persist: false });
  assert.deepEqual(hits.map((hit) => hit.path), ["concepts/A.md"]);
});
