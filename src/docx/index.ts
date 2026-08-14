import { Packer } from "docx";
import { blocksToDocxChildren } from "./builders.js";
import { buildCoverParagraphs } from "./cover.js";
import { buildDocument } from "./document.js";
import { parseMarkdown } from "./md-parser.js";
import type { CoverParams, DocxExportResult, DocxExportStats, MdBlock } from "./types.js";

export type {
  BuildDocumentParams,
  CoverParams,
  DocxExportResult,
  DocxExportStats,
  MdBlock,
  MdInlineSpan,
  TocEntry,
} from "./types.js";
export { blocksToDocxChildren } from "./builders.js";
export { buildCoverParagraphs } from "./cover.js";
export { buildDocument } from "./document.js";
export { parseMarkdown } from "./md-parser.js";
export { buildTocParagraph, extractTocEntries } from "./toc.js";

function removeCoverOnlyFrontMatter(blocks: MdBlock[]): MdBlock[] {
  const firstContentIndex = blocks.findIndex((block) => block.kind !== "blank");
  if (firstContentIndex === -1 || blocks[firstContentIndex].kind !== "h1") {
    return blocks;
  }

  let start = firstContentIndex + 1;
  while (start < blocks.length) {
    const block = blocks[start];
    if (block.kind === "blank" || block.kind === "hr") {
      start++;
      continue;
    }

    if (
      block.kind === "para" &&
      /^(versione|data|stato)\s*:/i.test(block.inline.map((span) => span.text).join("").trim())
    ) {
      start++;
      continue;
    }

    break;
  }

  return blocks.slice(0, firstContentIndex).concat(blocks.slice(start));
}

export async function exportDocxFromMarkdownWithStats(params: {
  markdownBody: string;
  coverParams: CoverParams;
  client: string;
  project: string;
}): Promise<DocxExportResult> {
  const { markdownBody, coverParams, client, project } = params;

  const blocks = removeCoverOnlyFrontMatter(parseMarkdown(markdownBody));
  const stats: DocxExportStats = { mermaidDiagramsRendered: 0, legacyAsciiDiagrams: 0 };
  const contentChildren = await blocksToDocxChildren(blocks, stats);
  const coverParagraphs = buildCoverParagraphs(coverParams);

  const document = buildDocument({ coverParagraphs, contentChildren, client, project });
  const buffer = await Packer.toBuffer(document);
  return { buffer, stats };
}

export async function exportDocxFromMarkdown(params: {
  markdownBody: string;
  coverParams: CoverParams;
  client: string;
  project: string;
}): Promise<Buffer> {
  const result = await exportDocxFromMarkdownWithStats(params);
  return result.buffer;
}
