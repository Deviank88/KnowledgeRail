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
import {
  nestedWikiPageRepairTarget,
  normalizeWikiPagePath,
} from "../src/core/wiki-page-path.js";

test("safeResolveWithin rejects traversal and absolute paths", () => {
  const root = path.join(os.tmpdir(), "knowledge-rail-path-test");
  assert.equal(safeResolveWithin(root, "a/b.md"), path.resolve(root, "a/b.md"));
  assert.throws(() => safeResolveWithin(root, "../outside.md"), /escapes/);
  assert.throws(() => safeResolveWithin(root, path.resolve(root, "x.md")), /Absolute/);
});

test("wiki page paths collapse a redundant root prefix without restricting dynamic directories", () => {
  assert.equal(normalizeWikiPagePath("wiki/concepts/RAG.md", { allowWikiRootPrefix: true }), "concepts/RAG.md");
  assert.equal(normalizeWikiPagePath("wiki/wiki/custom-area/Page.md", { allowWikiRootPrefix: true }), "custom-area/Page.md");
  assert.equal(normalizeWikiPagePath("customer-specific/notes/Page.md", { allowWikiRootPrefix: true }), "customer-specific/notes/Page.md");
  assert.throws(
    () => normalizeWikiPagePath("customer-specific/wiki/Page.md", { allowWikiRootPrefix: true }),
    /Nested wiki directories/
  );
  assert.throws(() => normalizeWikiPagePath(".knowledge-rail/Page.md"), /operational state/);
  assert.throws(() => normalizeWikiPagePath("concepts/Page.txt"), /Markdown/);
  assert.throws(() => normalizeWikiPagePath("index.md"), /control files/);
});

test("nested wiki repair recognizes only safe legacy Markdown paths", () => {
  assert.equal(nestedWikiPageRepairTarget("wiki/legacy/Page.md"), "legacy/Page.md");
  assert.equal(nestedWikiPageRepairTarget("area/wiki/archive/wiki/Page.md"), "area/archive/Page.md");
  assert.equal(nestedWikiPageRepairTarget("area/Page.md"), null);
  assert.equal(nestedWikiPageRepairTarget("../wiki/Page.md"), null);
  assert.equal(nestedWikiPageRepairTarget("wiki/../Page.md"), null);
  assert.equal(nestedWikiPageRepairTarget("/wiki/Page.md"), null);
  assert.equal(nestedWikiPageRepairTarget("wiki/Page.txt"), null);
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

test("wiki page validation accepts only existing document files under docs/", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-validation-"));
  const project = path.join(base, "project");
  setWikiRoot(project);
  await fs.mkdir(path.join(project, "docs", "reference"), { recursive: true });
  await fs.mkdir(path.join(project, "src", "core"), { recursive: true });
  await fs.writeFile(path.join(project, "docs", "source.md"), "source", "utf-8");
  await fs.writeFile(path.join(project, "docs", "reference", "caf\u00e9.md"), "source", "utf-8");
  await fs.writeFile(path.join(project, "src", "core", "paths.ts"), "source", "utf-8");
  await fs.writeFile(path.join(base, "outside.md"), "outside", "utf-8");

  const validateSource = (source: string, checkSourceExists = true) => validateWikiPageContent(
    [
      "---",
      'title: "Source Page"',
      "type: summary",
      "tags: [valid]",
      "created: 2026-05-07",
      "updated: 2026-05-07",
      `sources: ["${source}"]`,
      "---",
      "",
      "# Source Page",
    ].join("\n"),
    { checkSourceExists }
  );

  try {
    for (const source of [
      "docs/source.md",
      "source.md",
      "docs\\reference\\caf\u00e9.md",
      "docs/reference/cafe\u0301.md",
    ]) {
      const result = await validateSource(source);
      assert.equal(hasErrors(result.issues), false, `${source} should be accepted`);
    }

    for (const source of [
      "docs/reference",
      "docs/missing.md",
      "src/core/paths.ts",
      "docs/../src/core/paths.ts",
      "../outside.md",
      path.join(project, "src", "core", "paths.ts"),
      "C:\\Windows\\system.ini",
      "src/\0invalid.ts",
    ]) {
      const result = await validateSource(source);
      assert.equal(hasErrors(result.issues), true, `${source} should be rejected`);
      assert.equal(
        result.issues.some((item) => item.code === "SOURCE_INVALID"),
        true,
        `${source} should produce SOURCE_INVALID`
      );
    }

    const uncheckedMissing = await validateSource("docs/missing.md", false);
    assert.equal(hasErrors(uncheckedMissing.issues), false);
    const codeSource = await validateSource("src/core/paths.ts");
    assert.match(
      codeSource.issues.find((item) => item.code === "SOURCE_INVALID")?.message ?? "",
      /under docs\/.*code:\/\/.*normalize/
    );
    const codeMessage = codeSource.issues.find((item) => item.code === "SOURCE_INVALID")?.message ?? "";
    assert.equal(codeMessage.includes(project), false, "validation messages must not disclose the project root");
    assert.match(codeMessage, /Source file does not exist\./);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("wiki page validation rejects source symlink escapes", {
  skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false,
}, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-symlink-"));
  const project = path.join(base, "project");
  setWikiRoot(project);
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  await fs.writeFile(path.join(base, "outside.md"), "outside", "utf-8");
  await fs.symlink(path.join(base, "outside.md"), path.join(project, "docs", "escape.md"), "file");

  try {
    const result = await validateWikiPageContent(
      [
        "---",
        'title: "Escaped Source"',
        "type: summary",
        "tags: [valid]",
        "created: 2026-05-07",
        "updated: 2026-05-07",
        'sources: ["docs/escape.md"]',
        "---",
      ].join("\n"),
      { checkSourceExists: true }
    );
    assert.equal(hasErrors(result.issues), true);
    assert.equal(result.issues.some((item) => item.code === "SOURCE_INVALID"), true);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("stakeholder frontmatter accepts domains but rejects complete addresses", async () => {
  const base = [
    "---",
    'title: "Jane Doe"',
    "type: stakeholder",
    "tags: [stakeholder]",
    "created: 2026-09-02",
    "updated: 2026-09-02",
    "sources: []",
    'role: "Approval lead"',
    'organization: "Customer Corp"',
  ];
  const valid = await validateWikiPageContent([
    ...base,
    'email_domain: "customer.example"',
    'affiliation: "client"',
    "---",
  ].join("\n"));
  assert.equal(hasErrors(valid.issues), false);

  const invalid = await validateWikiPageContent([
    ...base,
    'email_domain: "jane.doe@customer.example"',
    'affiliation: "client"',
    "---",
  ].join("\n"));
  assert.equal(hasErrors(invalid.issues), true);
  assert.equal(invalid.issues.some((issue) => issue.code === "STAKEHOLDER_EMAIL_DOMAIN_INVALID"), true);

  const unsupported = await validateWikiPageContent([
    ...base,
    "affiliation: client",
    "---",
  ].join("\n"));
  assert.equal(hasErrors(unsupported.issues), true);
  assert.match(
    unsupported.issues.find((issue) => issue.code === "STAKEHOLDER_AFFILIATION_UNSUPPORTED")?.message ?? "",
    /email_domain.*source.*explicitly declares.*unknown/i
  );

  const sourceDeclared = await validateWikiPageContent([
    ...base.filter((line) => !line.startsWith("sources:")),
    'sources: ["docs/transcripts/customer-call.md"]',
    "affiliation: client",
    "---",
  ].join("\n"));
  assert.equal(hasErrors(sourceDeclared.issues), false);
});
