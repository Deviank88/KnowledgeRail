import {
  AlignmentType,
  BorderStyle,
  ImageRun,
  LineRuleType,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import { DOCX_COLORS, DOCX_NUMBERING, DOCX_PAGE, DOCX_STYLES } from "./constants.js";
import { renderMermaidPng } from "./mermaid-renderer.js";
import { parseInline } from "./md-parser.js";
import { DOCX_CODE_FONT, DOCX_LANGUAGE, DOCX_TEXT_FONT, normalizeDocxText } from "./text.js";
import type { DocxExportStats, MdBlock, MdInlineSpan } from "./types.js";

function spansToRuns(
  spans: MdInlineSpan[],
  opts: { size: number; color: string }
): TextRun[] {
  return spans.map(
    (span) =>
      new TextRun({
        text: normalizeDocxText(span.text),
        font: DOCX_TEXT_FONT,
        language: DOCX_LANGUAGE,
        size: opts.size,
        color: opts.color,
        bold: span.fmt === "bold" || span.fmt === "bolditalic",
        italics: span.fmt === "italic" || span.fmt === "bolditalic",
      })
  );
}

function buildH1(text: string): Paragraph {
  return new Paragraph({
    style: DOCX_STYLES.heading1,
    outlineLevel: 0,
    spacing: { before: 360, after: 200, line: 300, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({ text: normalizeDocxText(text), font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 32, bold: true, color: DOCX_COLORS.darkBlue }),
    ],
  });
}

function buildH2(text: string): Paragraph {
  return new Paragraph({
    style: DOCX_STYLES.heading2,
    outlineLevel: 1,
    spacing: { before: 240, after: 160, line: 300, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({ text: normalizeDocxText(text), font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 26, bold: true, color: DOCX_COLORS.mediumBlue }),
    ],
  });
}

function buildH3(text: string): Paragraph {
  return new Paragraph({
    style: DOCX_STYLES.heading3,
    outlineLevel: 2,
    spacing: { before: 200, after: 120, line: 300, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({ text: normalizeDocxText(text), font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 24, bold: true, color: DOCX_COLORS.darkBlue }),
    ],
  });
}

function buildPara(spans: MdInlineSpan[], indent?: number): Paragraph {
  return new Paragraph({
    style: DOCX_STYLES.normal,
    spacing: { after: 120, line: 300, lineRule: LineRuleType.AUTO },
    indent: indent ? { left: indent } : undefined,
    children: spansToRuns(spans, { size: 22, color: DOCX_COLORS.body }),
  });
}

function buildListItem(spans: MdInlineSpan[], depth: number): Paragraph {
  const level = Math.min(depth, 8);
  return new Paragraph({
    style: DOCX_STYLES.listParagraph,
    numbering: { reference: DOCX_NUMBERING.bulletReference, level },
    spacing: { after: 60, line: 300, lineRule: LineRuleType.AUTO },
    children: spansToRuns(spans, { size: 22, color: DOCX_COLORS.body }),
  });
}

function buildCheckboxItem(spans: MdInlineSpan[], depth: number, checked: boolean): Paragraph {
  return new Paragraph({
    style: DOCX_STYLES.listParagraph,
    spacing: { after: 60, line: 300, lineRule: LineRuleType.AUTO },
    indent: { left: 360 * (depth + 1) },
    children: [
      new TextRun({ text: checked ? "☑ " : "☐ ", font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 22, color: DOCX_COLORS.body }),
      ...spansToRuns(spans, { size: 22, color: DOCX_COLORS.body }),
    ],
  });
}

function buildCodeBlock(language: string, text: string): Paragraph {
  const prefix = language ? `${language}\n` : "";
  return new Paragraph({
    style: DOCX_STYLES.normal,
    spacing: { before: 120, after: 120, line: 260, lineRule: LineRuleType.AUTO },
    shading: { fill: "F3F6F8", type: ShadingType.SOLID, color: "F3F6F8" },
    children: [
      new TextRun({
        text: normalizeDocxText(prefix + text, { typography: false }),
        font: DOCX_CODE_FONT,
        size: 18,
        color: DOCX_COLORS.body,
      }),
    ],
  });
}

function looksLikeDiagram(language: string, text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (language.toLowerCase() === "diagram") return true;
  if (lines.length < 3) return false;
  return /[─│├└→←]/.test(text) || lines.some((line) => /^\s{2,}[-└├]/.test(line));
}

async function buildMermaidBlock(text: string): Promise<Paragraph> {
  const image = await renderMermaidPng(text);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 180 },
    children: [
      new ImageRun({
        data: image.data,
        transformation: {
          width: image.width,
          height: image.height,
        },
      }),
    ],
  });
}

function buildTable(headers: string[], rows: string[][]): Table {
  const colCount = Math.max(headers.length, 1);
  const colWidths =
    colCount === 2
      ? [3000, DOCX_PAGE.contentWidth - 3000]
      : Array.from({ length: colCount }, () => Math.floor(DOCX_PAGE.contentWidth / colCount));

  const borderSpec = { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.tableBorder };
  const allBorders = {
    top: borderSpec, bottom: borderSpec, left: borderSpec, right: borderSpec,
    insideHorizontal: borderSpec, insideVertical: borderSpec,
  };
  const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h, colIndex) =>
        new TableCell({
          width: { size: colWidths[colIndex] ?? colWidths[0], type: WidthType.DXA },
          borders: allBorders,
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { fill: DOCX_COLORS.darkBlue, type: ShadingType.SOLID, color: DOCX_COLORS.darkBlue },
          children: [
            new Paragraph({
              style: DOCX_STYLES.normal,
              spacing: { line: 300, lineRule: LineRuleType.AUTO },
              alignment: AlignmentType.LEFT,
              children: [
                new TextRun({
                  text: normalizeDocxText(h),
                  font: DOCX_TEXT_FONT,
                  language: DOCX_LANGUAGE,
                  size: 20,
                  bold: true,
                  color: DOCX_COLORS.white,
                }),
              ],
            }),
          ],
        })
    ),
  });

  const contentRows = rows.map(
    (row) => {
      const normalizedRow = [...row];
      while (normalizedRow.length < colCount) normalizedRow.push("");
      return (
      new TableRow({
        children: normalizedRow.slice(0, colCount).map(
          (cell, colIndex) =>
            new TableCell({
              width: { size: colWidths[colIndex] ?? colWidths[0], type: WidthType.DXA },
              borders: allBorders,
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({
                  style: DOCX_STYLES.normal,
                  spacing: { line: 300, lineRule: LineRuleType.AUTO },
                  children: spansToRuns(parseInline(cell), { size: 20, color: DOCX_COLORS.body }),
                }),
              ],
            })
        ),
      })
      );
    }
  );

  return new Table({
    width: { size: DOCX_PAGE.contentWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    borders: allBorders,
    rows: [headerRow, ...contentRows],
  });
}

export async function blocksToDocxChildren(
  blocks: MdBlock[],
  stats: DocxExportStats = { mermaidDiagramsRendered: 0, legacyAsciiDiagrams: 0 }
): Promise<Array<Paragraph | Table>> {
  const result: Array<Paragraph | Table> = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "h1":
        result.push(buildH1(block.text));
        break;
      case "h2":
        result.push(buildH1(block.text));
        break;
      case "h3":
        result.push(buildH2(block.text));
        break;
      case "h4":
        result.push(buildH3(block.text));
        break;
      case "para":
        if (block.inline.length > 0) result.push(buildPara(block.inline));
        break;
      case "list":
        result.push(buildListItem(block.inline, block.depth));
        break;
      case "checkbox":
        result.push(buildCheckboxItem(block.inline, block.depth, block.checked));
        break;
      case "code":
        if (block.language.toLowerCase() === "mermaid") {
          result.push(await buildMermaidBlock(block.text));
          stats.mermaidDiagramsRendered++;
        } else if (looksLikeDiagram(block.language, block.text)) {
          stats.legacyAsciiDiagrams++;
          result.push(buildCodeBlock(block.language, block.text));
        } else {
          result.push(buildCodeBlock(block.language, block.text));
        }
        break;
      case "table":
        result.push(buildTable(block.headers, block.rows));
        result.push(new Paragraph({ spacing: { after: 100 }, children: [] }));
        break;
      case "hr":
        result.push(
          new Paragraph({
            spacing: { before: 120, after: 120 },
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 1, color: DOCX_COLORS.darkBlue, space: 1 },
            },
            children: [],
          })
        );
        break;
      case "blank":
        break;
    }
  }

  return result;
}
