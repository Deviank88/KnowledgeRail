import type { Paragraph, Table } from "docx";

export type MdInlineSpan = {
  fmt: "plain" | "bold" | "italic" | "bolditalic";
  text: string;
};

export type MdBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "h4"; text: string }
  | { kind: "para"; inline: MdInlineSpan[] }
  | { kind: "list"; depth: number; inline: MdInlineSpan[] }
  | { kind: "checkbox"; depth: number; checked: boolean; inline: MdInlineSpan[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "blank" };

export interface TocEntry {
  level: 1 | 2;
  text: string;
  approxPage: number;
}

export interface CoverParams {
  categoryLabel: string;
  title: string;
  subtitle: string;
  version: string;
  date: string;
  status: string;
}

export interface BuildDocumentParams {
  coverParagraphs: Paragraph[];
  contentChildren: Array<Paragraph | Table>;
  client: string;
  project: string;
}

export interface DocxExportStats {
  mermaidDiagramsRendered: number;
  legacyAsciiDiagrams: number;
}

export interface DocxExportResult {
  buffer: Buffer;
  stats: DocxExportStats;
}
