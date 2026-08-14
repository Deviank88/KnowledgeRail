import { createHash } from "node:crypto";

export type SourceSegmentKind =
  | "markdown_section"
  | "report_section"
  | "code_symbol"
  | "table_block"
  | "paragraph_group"
  | "bounded_chunk";

export interface SourceSegment {
  id: string;
  start: number;
  end: number;
  hash: string;
  kind: SourceSegmentKind;
  heading?: string;
  chars: number;
}

export interface SourceSegmentationOptions {
  sourceUri: string;
  maxChars?: number;
}

interface Boundary {
  position: number;
  priority: number;
}

const REPORT_SECTION = /^(contesto richiesta|modifiche funzionali|data model|automazioni|integrazioni\/api|ui\/ux|permessi\/sicurezza|test|changelog|impatto documentale|gap\/ambiguit[aà])$/i;
const CODE_SYMBOL = /^\s*(?:(?:export|public|private|protected|static|async|abstract|declare)\s+)*(?:class|interface|enum|type|function|def|func|fn|struct|trait|module|namespace)\s+[A-Za-z_$][\w$]*/;

export function sourceContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function lineStarts(content: string, start: number, end: number): number[] {
  const starts = [start];
  for (let index = start; index < end; index++) {
    if (content[index] === "\n" && index + 1 < end) starts.push(index + 1);
  }
  return starts;
}

function lineEnd(content: string, start: number, end: number): number {
  const newline = content.indexOf("\n", start);
  return newline < 0 || newline >= end ? end : newline + 1;
}

function preferredBoundaries(content: string, start: number, end: number): Boundary[] {
  const boundaries = new Map<number, number>();
  const add = (position: number, priority: number): void => {
    if (position <= start || position >= end) return;
    boundaries.set(position, Math.max(priority, boundaries.get(position) ?? 0));
  };
  let insideFence = false;
  let tableRun = false;

  for (const position of lineStarts(content, start, end)) {
    const finish = lineEnd(content, position, end);
    const line = content.slice(position, finish).replace(/\r?\n$/, "");
    const trimmed = line.trim();
    const isTable = /^\|.*\|$/.test(trimmed);

    if (/^```|^~~~/.test(trimmed)) {
      add(position, 5);
      insideFence = !insideFence;
      add(finish, 5);
    } else if (insideFence && CODE_SYMBOL.test(line)) {
      add(position, 5);
    }

    if (isTable && !tableRun) add(position, 4);
    if (!isTable && tableRun) add(position, 4);
    tableRun = isTable;

    if (trimmed === "") add(finish, 3);
    add(finish, 1);
  }

  return [...boundaries].map(([position, priority]) => ({ position, priority }));
}

function splitBoundedRange(
  content: string,
  start: number,
  end: number,
  maxChars: number
): Array<{ start: number; end: number; hardSplit: boolean }> {
  const result: Array<{ start: number; end: number; hardSplit: boolean }> = [];
  const boundaries = preferredBoundaries(content, start, end);
  let cursor = start;

  while (cursor < end) {
    const hardEnd = Math.min(end, cursor + maxChars);
    if (hardEnd === end) {
      result.push({ start: cursor, end, hardSplit: false });
      break;
    }

    const minimumUseful = cursor + Math.min(512, Math.floor(maxChars * 0.35));
    const candidates = boundaries.filter((boundary) =>
      boundary.position >= minimumUseful && boundary.position <= hardEnd
    );
    candidates.sort((a, b) => b.priority - a.priority || b.position - a.position);
    const selected = candidates[0]?.position ?? hardEnd;
    result.push({ start: cursor, end: selected, hardSplit: selected === hardEnd });
    cursor = selected;
  }
  return result;
}

function classifySegment(text: string, heading: string | undefined, hardSplit: boolean): SourceSegmentKind {
  if (heading && REPORT_SECTION.test(heading)) return "report_section";
  if (heading) return "markdown_section";
  if (/```|~~~/.test(text) || text.split(/\r?\n/).some((line) => CODE_SYMBOL.test(line))) {
    return "code_symbol";
  }
  const tableLines = text.split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line));
  if (tableLines.length >= 2) return "table_block";
  return hardSplit ? "bounded_chunk" : "paragraph_group";
}

function primarySections(content: string): Array<{ start: number; end: number; heading?: string }> {
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => ({
    start: match.index,
    heading: match[1].trim(),
  }));
  if (headings.length === 0) return content.length === 0 ? [] : [{ start: 0, end: content.length }];

  const sections: Array<{ start: number; end: number; heading?: string }> = [];
  if (headings[0].start > 0) sections.push({ start: 0, end: headings[0].start });
  headings.forEach((heading, index) => {
    sections.push({
      start: heading.start,
      end: headings[index + 1]?.start ?? content.length,
      heading: heading.heading,
    });
  });
  return sections;
}

export function segmentSource(
  content: string,
  options: SourceSegmentationOptions
): SourceSegment[] {
  const maxChars = Math.max(256, Math.floor(options.maxChars ?? 8_000));
  const occurrences = new Map<string, number>();
  const segments: SourceSegment[] = [];

  for (const section of primarySections(content)) {
    for (const range of splitBoundedRange(content, section.start, section.end, maxChars)) {
      const text = content.slice(range.start, range.end);
      const hash = sourceContentHash(text);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      const idHash = sourceContentHash(
        `source-segment-v1\0${options.sourceUri}\0${hash}\0${occurrence}`
      );
      segments.push({
        id: `seg-${idHash.slice(0, 24)}`,
        start: range.start,
        end: range.end,
        hash,
        kind: classifySegment(text, section.heading, range.hardSplit),
        ...(section.heading ? { heading: section.heading } : {}),
        chars: range.end - range.start,
      });
    }
  }
  return segments;
}

export function sourceSegmentAccountingIsComplete(
  content: string,
  segments: readonly SourceSegment[]
): boolean {
  if (content.length === 0) return segments.length === 0;
  if (segments.length === 0 || segments[0]?.start !== 0) return false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment.end <= segment.start || segment.chars !== segment.end - segment.start) return false;
    if (sourceContentHash(content.slice(segment.start, segment.end)) !== segment.hash) return false;
    if (index > 0 && segments[index - 1]!.end !== segment.start) return false;
  }
  return segments.at(-1)?.end === content.length;
}
