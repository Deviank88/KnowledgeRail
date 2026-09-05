import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { clearRetrievalIndexes, refreshRetrievalIndex, searchRetrievalIndex, updateRetrievalPaths } from "../src/core/retrieval-index.js";

function raw(revision: number): string {
  return `---\ntitle: Title${revision}\ntype: concept\naliases: [Alias${revision}]\ntags: [Tag${revision}]\nsources: []\nrequest_id: REQ-${revision}\n---\n# Heading${revision}\nshared body${revision} compound_${revision}\n`;
}

test("repeated edits, deletion, reinsertion and journal replay preserve postings and full rebuild parity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-update-parity-"));
  try {
    await fs.mkdir(path.join(root, "concepts"));
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(root, `concepts/Page${i}.md`), raw(i));
    await refreshRetrievalIndex(root);
    const page = "concepts/Page0.md";
    for (const revision of [50, 51, 52]) {
      await fs.writeFile(path.join(root, page), raw(revision));
      await updateRetrievalPaths(root, [page]);
    }
    await fs.unlink(path.join(root, page));
    await updateRetrievalPaths(root, [page]);
    let state = await refreshRetrievalIndex(root);
    assert.equal(state.postings.has("body52"), false);
    assert.equal(state.postings.has("title52"), false);
    assert.equal(state.postings.get("shared")?.size, 19);
    await fs.writeFile(path.join(root, page), raw(53));
    await updateRetrievalPaths(root, [page]);
    clearRetrievalIndexes();
    state = await refreshRetrievalIndex(root, { persist: false });
    const snapshot = (data: typeof state) => ({
      totalTokenCount: data.totalTokenCount,
      corpusRevision: data.corpusRevision,
      postings: [...data.postings].map(([term, paths]) => [term, [...paths].sort()] as const).sort(),
    });
    const replayed = snapshot(state);
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "Alias53 Heading53 body53", persist: false });
    assert.equal(hits[0]?.path, page);
    clearRetrievalIndexes();
    await fs.rm(path.join(root, ".knowledge-rail/retrieval-index.json"));
    await fs.rm(path.join(root, ".knowledge-rail/retrieval-delta.jsonl"), { force: true });
    state = await refreshRetrievalIndex(root, { persist: false });
    assert.deepEqual(snapshot(state), replayed);
    assert.deepEqual(JSON.parse(JSON.stringify(await searchRetrievalIndex({ wikiRoot: root, query: "Alias53 Heading53 body53", persist: false }))), JSON.parse(JSON.stringify(hits)));
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});
