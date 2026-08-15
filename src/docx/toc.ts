import { LineRuleType, Paragraph, TabStopType, TextRun } from "docx";
import { DOCX_COLORS } from "./constants.js";
import type { MdBlock, TocEntry } from "./types.js";

export function extractTocEntries(blocks: MdBlock[]): TocEntry[] {
  const entries: TocEntry[] = [];
  let page = 2;

  for (const block of blocks) {
    if (block.kind === "h1") {
      entries.push({ level: 1, text: block.text, approxPage: page });
      page++;
    } else if (block.kind === "h2") {
      entries.push({ level: 2, text: block.text, approxPage: page });
    }
  }
  return entries;
}

export function buildTocParagraph(entry: TocEntry): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: 300, lineRule: LineRuleType.AUTO },
    indent: { left: entry.level === 2 ? 360 : 0 },
    tabStops: [{ type: TabStopType.RIGHT, position: 9000, leader: "dot" }],
    children: [
      new TextRun({
        text: `${entry.text}\t${entry.approxPage}`,
        font: "Arial",
        size: 22,
        color: DOCX_COLORS.body,
      }),
    ],
  });
}
