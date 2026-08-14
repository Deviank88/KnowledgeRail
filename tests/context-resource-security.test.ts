import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readWikiResource } from "../src/context/resource-reader.js";
import { wikiPageUri } from "../src/context/resource-uri.js";

test("wiki resource reader rejects symlinks that resolve outside the wiki root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-resource-security-"));
  const wikiRoot = path.join(root, "wiki");
  const outside = path.join(root, "outside.md");
  const link = path.join(wikiRoot, "requirements", "escape.md");

  try {
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.writeFile(outside, "# Outside\n\nsecret evidence", "utf8");
    try {
      await fs.symlink(outside, link, "file");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        t.skip(`symlinks unavailable on this platform (${code})`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => readWikiResource({
        wikiRoot,
        resourceUri: wikiPageUri("requirements/escape.md"),
        maxCharacters: 6_000,
      }),
      /resolves outside the wiki root/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("wiki resource reader accepts regular Markdown pages inside the wiki root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-resource-valid-"));
  const wikiRoot = path.join(root, "wiki");
  const file = path.join(wikiRoot, "requirements", "REQ_SAFE.md");

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, [
      "---",
      'title: "Safe requirement"',
      "type: requirement",
      "---",
      "",
      "# Requirement",
      "",
      "Safe evidence.",
    ].join("\n"), "utf8");

    const result = await readWikiResource({
      wikiRoot,
      resourceUri: wikiPageUri("requirements/REQ_SAFE.md"),
      maxCharacters: 6_000,
    });
    assert.equal(result.title, "Safe requirement");
    assert.equal(result.text.includes("Safe evidence."), true);
    assert.equal(result.truncated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
