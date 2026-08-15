import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { rawDir, safeResolveWithin, setWikiRoot } from "../src/core/paths.js";
import {
  hasErrors,
  validateWikiPageContent,
} from "../src/core/wiki-validation.js";

test("safeResolveWithin rejects traversal and absolute paths", () => {
  const root = path.join(os.tmpdir(), "knowledge-rail-path-test");
  assert.equal(safeResolveWithin(root, "a/b.md"), path.resolve(root, "a/b.md"));
  assert.throws(() => safeResolveWithin(root, "../outside.md"), /escapes/);
  assert.throws(() => safeResolveWithin(root, path.resolve(root, "x.md")), /Absolute/);
});

test("wiki page validation requires frontmatter and valid raw sources", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-validation-"));
  setWikiRoot(dir);
  await fs.mkdir(rawDir(), { recursive: true });
  await fs.writeFile(path.join(rawDir(), "source.md"), "source", "utf-8");

  const valid = await validateWikiPageContent(
    [
      "---",
      'title: "Valid Page"',
      "type: summary",
      "tags: [valid]",
      "created: 2026-05-07",
      "updated: 2026-05-07",
      'sources: ["docs/source.md"]',
      "---",
      "",
      "# Valid",
    ].join("\n"),
    { checkSourceExists: true }
  );
  assert.equal(hasErrors(valid.issues), false);

  const invalid = await validateWikiPageContent(
    [
      "---",
      'title: "Invalid Page"',
      "type: invalid",
      "tags: []",
      "created: yesterday",
      "updated: 2026-05-07",
      'sources: ["../outside.md"]',
      "---",
    ].join("\n"),
    { checkSourceExists: true }
  );
  assert.equal(hasErrors(invalid.issues), true);
});
