import type { MdBlock, MdInlineSpan } from "./types.js";

function parseInline(text: string): MdInlineSpan[] {
  const spans: MdInlineSpan[] = [];
  const expandedLinks = text.replace(
    /\[([^\]]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (_match, label: string, href: string) => `${label} (${href.split(/\s+/)[0]})`
  );
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(expandedLinks)) !== null) {
    if (match.index > last) {
      spans.push({ fmt: "plain", text: expandedLinks.slice(last, match.index) });
    }
    if (match[2] !== undefined) {
      spans.push({ fmt: "bolditalic", text: match[2] });
    } else if (match[3] !== undefined) {
      spans.push({ fmt: "bold", text: match[3] });
    } else if (match[6] !== undefined) {
      spans.push({ fmt: "plain", text: match[6] });
    } else {
      spans.push({ fmt: "italic", text: match[4] ?? match[5] ?? "" });
    }
    last = match.index + match[0].length;
  }

  if (last < expandedLinks.length) {
    spans.push({ fmt: "plain", text: expandedLinks.slice(last) });
  }
  return spans;
}

function parseMarkdownTable(tableLines: string[]): MdBlock | null {
  if (tableLines.length < 2) return null;

  const splitRow = (row: string): string[] =>
    row.split("|").slice(1, -1).map((c) => c.trim());

  const headers = splitRow(tableLines[0]);

  const separatorIdx = tableLines.findIndex(
    (l, idx) => idx > 0 && /^\|[-:\s|]+\|$/.test(l.trim())
  );
  if (separatorIdx === -1) return null;

  const rows = tableLines.slice(separatorIdx + 1).map((row) => {
    const cells = splitRow(row);
    while (cells.length < headers.length) cells.push("");
    return cells.slice(0, headers.length);
  });
  return { kind: "table", headers, rows };
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }

    if (/^(\-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const h1 = line.match(/^# (.+)$/);
    if (h1) { blocks.push({ kind: "h1", text: h1[1].trim() }); i++; continue; }

    const h2 = line.match(/^## (.+)$/);
    if (h2) { blocks.push({ kind: "h2", text: h2[1].trim() }); i++; continue; }

    const h3 = line.match(/^### (.+)$/);
    if (h3) { blocks.push({ kind: "h3", text: h3[1].trim() }); i++; continue; }

    const h4 = line.match(/^#### (.+)$/);
    if (h4) { blocks.push({ kind: "h4", text: h4[1].trim() }); i++; continue; }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith("```")) i++;
      blocks.push({ kind: "code", language, text: codeLines.join("\n") });
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = parseMarkdownTable(tableLines);
      if (parsed) blocks.push(parsed);
      continue;
    }

    const checkboxMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checkboxMatch) {
      const depth = Math.floor(checkboxMatch[1].length / 2);
      blocks.push({
        kind: "checkbox",
        depth,
        checked: checkboxMatch[2].toLowerCase() === "x",
        inline: parseInline(checkboxMatch[3]),
      });
      i++;
      continue;
    }

    const listMatch =
      line.match(/^(\s*)[-*+]\s+(.+)$/) ?? line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (listMatch) {
      const depth = Math.floor(listMatch[1].length / 2);
      blocks.push({ kind: "list", depth, inline: parseInline(listMatch[2]) });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      blocks.push({ kind: "para", inline: parseInline(line.replace(/^>\s?/, "")) });
      i++;
      continue;
    }

    blocks.push({ kind: "para", inline: parseInline(line) });
    i++;
  }

  return blocks;
}

export { parseInline };
