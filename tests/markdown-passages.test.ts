import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { segmentMarkdown } from "../src/core/page-record.js";
import { clearRetrievalIndexes, getRetrievalIndexDiagnostics, searchRetrievalIndex } from "../src/core/retrieval-index.js";

for (const [name, code] of [
  ["backticks", "```python\n# internalneedle\nprint(1)\n```"],
  ["tildes and longer closing fence", "   ~~~~python\n# internalneedle\n~~~\n# still code\n  ~~~~~"],
  ["shorter and mixed fences do not close", "````python\n```\n~~~\n# internalneedle\n`````"],
  ["closing fence cannot have an info string", "```\n``` extra\n# internalneedle\n```"],
  ["indented code", "    # internalneedle\n\t# still code\n    ```\n"],
] as const) {
  test(`Markdown keeps code content under its external heading: ${name}`, () => {
    const passages = segmentMarkdown(`# Example\n${code}\n## Outside\nordinary text`);
    assert.deepEqual(passages.map((p) => p.heading), ["Example", "Outside"]);
    assert.ok(passages[0]!.text.includes("# internalneedle"));
    assert.equal(passages[1]!.text, "ordinary text");
  });
}

test("unclosed fences survive passage size boundaries", () => {
  const passages = segmentMarkdown("# Example\n```python\n# internalneedle\n" + "print(1)\n".repeat(20) + "# still code", 40);
  assert.ok(passages.length > 1);
  assert.ok(passages.every((p) => p.heading === "Example"));
  assert.ok(passages.some((p) => p.text.includes("# internalneedle")));
});

test("backticks in the opening info string prevent a fence", () => {
  assert.deepEqual(segmentMarkdown("```bad`info\n# Outside\ntext").map((p) => p.heading), ["Introduzione", "Outside"]);
});

test("unchanged Markdown rebuilds old persisted passages and restores the corrected evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-markdown-"));
  try {
    await fs.mkdir(path.join(root, "concepts"));
    const raw = "---\ntitle: Python example\ntype: concept\nsources: []\n---\n# Example\n```python\n# internalneedle\nprint(1)\n```\n## Outside\nordinary text";
    const page = path.join(root, "concepts/Example.md");
    await fs.writeFile(page, raw);
    await searchRetrievalIndex({ wikiRoot: root, query: "internalneedle" });
    const checkpoint = path.join(root, ".knowledge-rail/retrieval-index.json");
    const old = JSON.parse(await fs.readFile(checkpoint, "utf8"));
    old.payload.builderVersion = "global-flat-v2-merkle";
    old.payload.records[0].record.passages = [{ id: "p0", heading: "internalneedle", text: "print(1)", charStart: 0 }];
    old.payloadChecksum = createHash("sha256").update(JSON.stringify(old.payload)).digest("hex");
    await fs.writeFile(checkpoint, JSON.stringify(old));
    clearRetrievalIndexes();
    const rebuilt = await searchRetrievalIndex({ wikiRoot: root, query: "internalneedle" });
    assert.equal(getRetrievalIndexDiagnostics(root).fallbackReason, "snapshot_builder_mismatch");
    assert.equal(rebuilt[0]?.heading, "Example");
    assert.match(rebuilt[0]!.excerpt, /# internalneedle/);
    clearRetrievalIndexes();
    const restored = await searchRetrievalIndex({ wikiRoot: root, query: "internalneedle", persist: false });
    assert.equal(getRetrievalIndexDiagnostics(root).recovery, "restored");
    assert.deepEqual(restored[0]?.record.passages, rebuilt[0]?.record.passages);
    assert.equal(await fs.readFile(page, "utf8"), raw);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});
