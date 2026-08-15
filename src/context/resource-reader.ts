import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { parseWikiPageRecord, type WikiPageRecord } from "../core/page-record.js";
import { safeResolveWithin } from "../core/paths.js";
import { wikiPassageId } from "./passage-id.js";
import {
  parseWikiResourceUri,
  wikiPageUri,
  wikiPassageUri,
  type WikiResourceRef,
} from "./resource-uri.js";

export interface WikiResourceRead {
  uri: string;
  pageUri: string;
  path: string;
  passageId?: string;
  title: string;
  type: string;
  heading?: string;
  text: string;
  truncated: boolean;
  totalCharacters: number;
}

function truncateCharacters(text: string, maxCharacters?: number): {
  text: string;
  truncated: boolean;
  totalCharacters: number;
} {
  const chars = [...text];
  if (maxCharacters === undefined || chars.length <= maxCharacters) {
    return { text, truncated: false, totalCharacters: chars.length };
  }
  return {
    text: chars.slice(0, maxCharacters).join(""),
    truncated: true,
    totalCharacters: chars.length,
  };
}

export async function readValidatedWikiPageRecord(
  wikiRoot: string,
  relPath: string
): Promise<WikiPageRecord | null> {
  if (!relPath.toLowerCase().endsWith(".md")) {
    throw new Error(`Wiki resources must reference Markdown pages: ${relPath}`);
  }

  const lexicalTarget = safeResolveWithin(wikiRoot, relPath);
  let rootReal: string;
  let targetReal: string;
  try {
    [rootReal, targetReal] = await Promise.all([
      fs.realpath(wikiRoot),
      fs.realpath(lexicalTarget),
    ]);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }

  const relativeReal = nodePath.relative(rootReal, targetReal);
  if (
    relativeReal === "" ||
    relativeReal.startsWith("..") ||
    nodePath.isAbsolute(relativeReal)
  ) {
    throw new Error(`Wiki resource resolves outside the wiki root: ${relPath}`);
  }

  const [raw, stat] = await Promise.all([
    fs.readFile(targetReal, "utf8"),
    fs.stat(targetReal),
  ]);
  if (!stat.isFile()) throw new Error(`Wiki resource is not a regular file: ${relPath}`);
  return parseWikiPageRecord(relPath, raw, stat);
}

export async function readWikiResource(params: {
  wikiRoot: string;
  path?: string;
  resourceUri?: string;
  passageId?: string;
  maxCharacters?: number;
}): Promise<WikiResourceRead> {
  if ((params.path ? 1 : 0) + (params.resourceUri ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of path or resourceUri.");
  }
  if (params.maxCharacters !== undefined && (!Number.isInteger(params.maxCharacters) || params.maxCharacters <= 0)) {
    throw new Error("maxCharacters must be a positive integer.");
  }

  let ref: WikiResourceRef;
  if (params.resourceUri) {
    ref = parseWikiResourceUri(params.resourceUri);
    if (params.passageId && ref.passageId && params.passageId !== ref.passageId) {
      throw new Error("passageId conflicts with the passage encoded in resourceUri.");
    }
    if (params.passageId && !ref.passageId) ref = { ...ref, passageId: params.passageId };
  } else {
    ref = params.passageId === undefined
      ? { path: params.path! }
      : { path: params.path!, passageId: params.passageId };
  }

  const record = await readValidatedWikiPageRecord(params.wikiRoot, ref.path);
  if (!record) throw new Error(`Wiki page not found: ${ref.path}`);

  const pageUri = wikiPageUri(record.path);
  if (!ref.passageId) {
    const limited = truncateCharacters(record.raw, params.maxCharacters);
    return {
      uri: pageUri,
      pageUri,
      path: record.path,
      title: record.title,
      type: record.type,
      text: limited.text,
      truncated: limited.truncated,
      totalCharacters: limited.totalCharacters,
    };
  }

  const passage = record.passages.find((candidate) => wikiPassageId(candidate) === ref.passageId);
  if (!passage) {
    throw new Error(
      `Passage ${ref.passageId} no longer exists in ${record.path}. ` +
      "The page may have changed; retrieve a fresh context manifest before continuing."
    );
  }

  const limited = truncateCharacters(passage.text, params.maxCharacters);
  return {
    uri: wikiPassageUri(record.path, ref.passageId),
    pageUri,
    path: record.path,
    passageId: ref.passageId,
    title: record.title,
    type: record.type,
    heading: passage.heading,
    text: limited.text,
    truncated: limited.truncated,
    totalCharacters: limited.totalCharacters,
  };
}
