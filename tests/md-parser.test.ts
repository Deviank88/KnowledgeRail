import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "../src/docx/md-parser.js";

test("parseMarkdown preserves code blocks, links, checkboxes, and irregular tables", () => {
  const blocks = parseMarkdown(
    [
      "# Title",
      "",
      "- [x] Done with [docs](https://example.com)",
      "- [ ] Todo",
      "",
      "#### Deep heading",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      "| one |",
    ].join("\n")
  );

  assert.equal(blocks.some((block) => block.kind === "code"), true);
  assert.equal(blocks.some((block) => block.kind === "code" && block.language === "mermaid"), true);
  assert.equal(blocks.some((block) => block.kind === "h4" && block.text === "Deep heading"), true);
  assert.equal(blocks.some((block) => block.kind === "checkbox" && block.checked), true);
  const table = blocks.find((block) => block.kind === "table");
  assert.ok(table);
  assert.deepEqual(table.rows[0], ["one", ""]);
  const checkbox = blocks.find((block) => block.kind === "checkbox" && block.checked);
  assert.ok(checkbox);
  assert.equal(checkbox.inline.map((span) => span.text).join("").includes("https://example.com"), true);
});
