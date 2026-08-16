import {
  AlignmentType,
  BorderStyle,
  LineRuleType,
  Paragraph,
  TextRun,
} from "docx";
import { DOCX_COLORS } from "./constants.js";
import { DOCX_LANGUAGE, DOCX_TEXT_FONT, normalizeDocxText } from "./text.js";
import type { CoverParams } from "./types.js";

export function buildCoverParagraphs(params: CoverParams): Paragraph[] {
  const { categoryLabel, title, subtitle, version, date, status } = params;
  const titleLength = title.length;
  const titleSize = titleLength > 80 ? 36 : titleLength > 55 ? 40 : 44;
  const topSpacer = titleLength > 80 ? 1400 : titleLength > 55 ? 1700 : 2000;

  return [
    new Paragraph({ spacing: { after: topSpacer }, children: [] }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200, line: 300, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({
          text: normalizeDocxText(categoryLabel.toUpperCase()),
          font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 28, bold: true, color: DOCX_COLORS.mediumBlue,
        }),
      ],
    }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100, line: 340, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({
          text: normalizeDocxText(title),
          font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: titleSize, bold: true, color: DOCX_COLORS.darkBlue,
        }),
      ],
    }),

    new Paragraph({ spacing: { after: 200 }, children: [] }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 400 },
      border: {
        top: { style: BorderStyle.SINGLE, size: 6, color: DOCX_COLORS.mediumBlue, space: 1 },
      },
      children: [],
    }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100, line: 300, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({
          text: normalizeDocxText(subtitle),
          font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 24, color: DOCX_COLORS.subtitleGray,
        }),
      ],
    }),

    new Paragraph({ spacing: { after: 1200 }, children: [] }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({
          text: normalizeDocxText(`Version ${version}`),
          font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 22, color: DOCX_COLORS.metadataGray,
        }),
      ],
    }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({
          text: normalizeDocxText(date),
          font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 22, color: DOCX_COLORS.metadataGray,
        }),
      ],
    }),

    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80, line: 300, lineRule: LineRuleType.AUTO },
      children: [
        new TextRun({
          text: normalizeDocxText(`Status: ${status}`),
          font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 22, bold: true, color: DOCX_COLORS.mediumBlue,
        }),
      ],
    }),
  ];
}
