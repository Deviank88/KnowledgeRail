import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import fg from "fast-glob";
import {
  frontmatterArray,
  frontmatterString,
  parseFrontmatter,
  readFileSafe,
  stripFrontmatter,
} from "./utils.js";
import { tokenizeSearchText } from "./text-analysis.js";
import { resolveRealWithin } from "./paths.js";

export interface WikiPassage {
  id: string;
  heading: string;
  text: string;
  charStart: number;
}

export interface WikiPageRecord {
  path: string;
  mtimeMs: number;
  size: number;
  title: string;
  type: string;
  tags: string[];
  aliases: string[];
  sources: string[];
  requestId?: string;
  client?: string;
  project?: string;
  updated?: string;
  body: string;
  raw: string;
  passages: WikiPassage[];
  tokenCount: number;
}

const CONTROL_FILES = new Set(["SCHEMA.md", "index.md", "log.md"]);

export function segmentMarkdown(body: string, maxChars = 1600): WikiPassage[] {
  const lines = body.split(/\r?\n/);
  const passages: WikiPassage[] = [];
  let heading = "Introduzione";
  let buffer: string[] = [];
  let start = 0;
  let offset = 0;

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text) passages.push({ id: `p${passages.length}`, heading, text, charStart: start });
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
      start = offset + line.length + 1;
    } else {
      const candidateLength = buffer.reduce((sum, value) => sum + value.length + 1, 0) + line.length;
      if (candidateLength > maxChars && buffer.length > 0) {
        flush();
        start = offset;
      }
      buffer.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return passages.length > 0 ? passages : [{ id: "p0", heading, text: body, charStart: 0 }];
}

export function parseWikiPageRecord(
  path: string,
  raw: string,
  stat: { mtimeMs: number; size: number }
): WikiPageRecord {
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw);
  return {
    path: path.replace(/\\/g, "/"),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    title: frontmatterString(fm, "title") ?? path,
    type: frontmatterString(fm, "type") ?? "unknown",
    tags: frontmatterArray(fm, "tags") ?? [],
    aliases: frontmatterArray(fm, "aliases") ?? [],
    sources: frontmatterArray(fm, "sources") ?? [],
    requestId: frontmatterString(fm, "request_id"),
    client: frontmatterString(fm, "client"),
    project: frontmatterString(fm, "project"),
    updated: frontmatterString(fm, "updated"),
    body,
    raw,
    passages: segmentMarkdown(body),
    tokenCount: Math.max(tokenizeSearchText(body).length, 1),
  };
}

export async function readWikiPageRecord(
  wikiRoot: string,
  relPath: string,
  knownStat?: { mtimeMs: number; size: number }
): Promise<WikiPageRecord | null> {
  const absPath = await resolveRealWithin(wikiRoot, relPath);
  const raw = await readFileSafe(absPath);
  if (raw === null) return null;
  const stat = knownStat ?? await fs.stat(absPath);
  return parseWikiPageRecord(relPath, raw, stat);
}

export async function listWikiPagePaths(wikiRoot: string): Promise<string[]> {
  const safeWikiRoot = await resolveRealWithin(
    nodePath.dirname(wikiRoot),
    nodePath.basename(wikiRoot)
  );
  const files = await fg("**/*.md", {
    cwd: safeWikiRoot,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [".knowledge-rail/**"],
  }).catch(() => [] as string[]);
  return files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => !CONTROL_FILES.has(file))
    .sort();
}
