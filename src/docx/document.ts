import {
  AlignmentType,
  Document,
  Footer,
  Header,
  LevelFormat,
  LevelSuffix,
  LineRuleType,
  NumberFormat,
  PageBreak,
  PageNumber,
  Paragraph,
  SectionType,
  TableOfContents,
  TextRun,
} from "docx";
import { DOCX_COLORS, DOCX_NUMBERING, DOCX_PAGE, DOCX_STYLES } from "./constants.js";
import { DOCX_LANGUAGE, DOCX_TEXT_FONT, normalizeDocxText } from "./text.js";
import type { BuildDocumentParams } from "./types.js";

export function buildDocument(params: BuildDocumentParams): Document {
  const { coverParagraphs, contentChildren, client, project } = params;

  const contentHeader = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: normalizeDocxText(`${project} | Validation Document`),
            font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 16, color: DOCX_COLORS.gray,
          }),
        ],
      }),
    ],
  });

  const contentFooter = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "Page ", font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 16, color: DOCX_COLORS.gray }),
          new TextRun({ children: [PageNumber.CURRENT], font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 16, color: DOCX_COLORS.gray }),
        ],
      }),
    ],
  });

  const tocTitle = new Paragraph({
    style: DOCX_STYLES.heading1,
    outlineLevel: 0,
    spacing: { before: 0, after: 240, line: 300, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({ text: "Contents", font: DOCX_TEXT_FONT, language: DOCX_LANGUAGE, size: 32, bold: true, color: DOCX_COLORS.darkBlue }),
    ],
  });

  const toc = new TableOfContents("Contents", {
    headingStyleRange: "1-3",
    hyperlink: true,
  });

  const tocPageBreak = new Paragraph({
    spacing: { after: 0 },
    children: [new PageBreak()],
  });

  const pageProps = {
    size: { width: DOCX_PAGE.width, height: DOCX_PAGE.height },
    margin: {
      top:    DOCX_PAGE.margin,
      right:  DOCX_PAGE.margin,
      bottom: DOCX_PAGE.margin,
      left:   DOCX_PAGE.margin,
    },
  };

  return new Document({
    features: {
      updateFields: true,
    },
    styles: {
      default: {
        document: {
          run: { font: DOCX_TEXT_FONT, size: 22, color: DOCX_COLORS.body, language: DOCX_LANGUAGE },
        },
      },
      paragraphStyles: [
        {
          id: DOCX_STYLES.normal,
          name: "Normal",
          quickFormat: true,
          run: { font: DOCX_TEXT_FONT, size: 22, color: DOCX_COLORS.body, language: DOCX_LANGUAGE },
        },
        {
          id: DOCX_STYLES.heading1,
          name: "heading 1",
          basedOn: DOCX_STYLES.normal,
          next: DOCX_STYLES.normal,
          quickFormat: true,
          paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
          run: { font: DOCX_TEXT_FONT, size: 32, bold: true, color: DOCX_COLORS.darkBlue, language: DOCX_LANGUAGE },
        },
        {
          id: DOCX_STYLES.heading2,
          name: "heading 2",
          basedOn: DOCX_STYLES.normal,
          next: DOCX_STYLES.normal,
          quickFormat: true,
          paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 },
          run: { font: DOCX_TEXT_FONT, size: 26, bold: true, color: DOCX_COLORS.mediumBlue, language: DOCX_LANGUAGE },
        },
        {
          id: DOCX_STYLES.heading3,
          name: "heading 3",
          basedOn: DOCX_STYLES.normal,
          next: DOCX_STYLES.normal,
          quickFormat: true,
          paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 },
          run: { font: DOCX_TEXT_FONT, size: 24, bold: true, color: DOCX_COLORS.darkBlue, language: DOCX_LANGUAGE },
        },
        {
          id: DOCX_STYLES.listParagraph,
          name: "List Paragraph",
          basedOn: DOCX_STYLES.normal,
          quickFormat: true,
          run: { font: DOCX_TEXT_FONT, size: 22, color: DOCX_COLORS.body, language: DOCX_LANGUAGE },
        },
        {
          id: "Sommario1",
          name: "toc 1",
          basedOn: DOCX_STYLES.normal,
          next: DOCX_STYLES.normal,
          paragraph: { spacing: { after: 100 } },
          run: { font: DOCX_TEXT_FONT, size: 22, color: DOCX_COLORS.body, language: DOCX_LANGUAGE },
        },
        {
          id: "Sommario2",
          name: "toc 2",
          basedOn: DOCX_STYLES.normal,
          next: DOCX_STYLES.normal,
          paragraph: { spacing: { after: 100 }, indent: { left: 220 } },
          run: { font: DOCX_TEXT_FONT, size: 22, color: DOCX_COLORS.body, language: DOCX_LANGUAGE },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: DOCX_NUMBERING.bulletReference,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: level % 3 === 0 ? "•" : level % 3 === 1 ? "○" : "■",
            alignment: AlignmentType.LEFT,
            suffix: LevelSuffix.TAB,
            style: {
              paragraph: {
                indent: {
                  left: 720 * (level + 1),
                  hanging: 360,
                },
              },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: pageProps,
        },
        children: coverParagraphs,
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            ...pageProps,
            pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
          },
        },
        headers: { default: contentHeader },
        footers: { default: contentFooter },
        children: [tocTitle, toc, tocPageBreak, ...contentChildren],
      },
    ],
  });
}
