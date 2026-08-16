import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  rawDir,
  resolveRealWithin,
  safeResolveWithin,
  setWikiRoot,
  validateGlobPattern,
} from "../src/core/paths.js";
import { parseFrontmatter } from "../src/core/utils.js";
import { errorResult } from "../src/tools/helpers.js";
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

test("glob validation rejects traversal, absolute, null and POSIX backslash patterns", () => {
  assert.equal(validateGlobPattern("**/*.md"), "**/*.md");
  assert.throws(() => validateGlobPattern("../../**/*"), /Parent-directory/);
  assert.throws(() => validateGlobPattern("/etc/hosts"), /Absolute/);
  assert.throws(() => validateGlobPattern("C:\\Windows\\*"), /Absolute/);
  assert.throws(() => validateGlobPattern("**/\0secret"), /null/);
  if (process.platform !== "win32") {
    assert.throws(() => validateGlobPattern("nested\\*.md"), /Backslashes/);
  }
});

test("resolveRealWithin rejects existing file and directory symlink escapes", {
  skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-realpath-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.md"), "secret");
  await fs.symlink(outside, path.join(allowed, "linked-dir"), "dir");
  await fs.symlink(path.join(outside, "secret.md"), path.join(allowed, "linked-file.md"), "file");

  await assert.rejects(() => resolveRealWithin(allowed, "linked-dir/new.md"), /outside/);
  await assert.rejects(() => resolveRealWithin(allowed, "linked-file.md"), /outside/);
  assert.equal(
    await resolveRealWithin(allowed, "new/deep/page.md"),
    path.join(await fs.realpath(allowed), "new", "deep", "page.md")
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("frontmatter parsing uses a null prototype and rejects prototype keys", () => {
  const parsed = parseFrontmatter("---\ntitle: Safe\n---\n");
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.title, "Safe");
  assert.throws(
    () => parseFrontmatter("---\n__proto__: [polluted]\n---\n"),
    /Unsafe frontmatter key/
  );
});

test("tool errors redact the active workspace root", () => {
  const root = path.join(os.tmpdir(), "knowledge-rail-redaction");
  setWikiRoot(root);
  const result = errorResult(new Error(`ENOENT: ${path.join(root, "docs", "missing.md")}`));
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.match(result.content[0].text, /<workspace>/);
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
