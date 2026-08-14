import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { clearSearchIndexes, searchWikiIndex } from "../src/core/search-index.js";

async function writePage(root: string, rel: string, title: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    [
      "---",
      `title: "${title}"`,
      "type: concept",
      "tags: [test]",
      "created: 2026-05-07",
      "updated: 2026-05-07",
      "sources: []",
      "---",
      "",
      body,
    ].join("\n"),
    "utf-8"
  );
}

test("search index ranks, caches, and invalidates changed files", async () => {
  clearSearchIndexes();
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-search-"));
  await writePage(wikiRoot, "concepts/Alpha.md", "Alpha", "needle needle topic");
  await writePage(wikiRoot, "concepts/Beta.md", "Beta", "needle topic");

  const first = await searchWikiIndex({ wikiRoot, query: "needle", maxResults: 2 });
  assert.equal(first.length, 2);
  assert.equal(first[0].path, "concepts/Alpha.md");

  await writePage(wikiRoot, "concepts/Beta.md", "Beta Needle", "needle ".repeat(20));
  const second = await searchWikiIndex({ wikiRoot, query: "needle", maxResults: 2 });
  assert.equal(second[0].path, "concepts/Beta.md");
});
