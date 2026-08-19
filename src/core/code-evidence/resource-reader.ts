import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { safeResolveWithin } from "../paths.js";
import { defaultParserVersionForPath } from "./adapter-registry.js";
import { readCodeEvidenceSnapshot } from "./index.js";
import { parseCodeResourceUri } from "./resource-uri.js";
import type { CodeResourceRead } from "./types.js";

const DEFAULT_MAX_CHARACTERS = 6_000;
const MAX_CHARACTERS = 50_000;

function truncateCharacters(text: string, maxCharacters: number): {
  text: string;
  truncated: boolean;
  totalCharacters: number;
} {
  const characters = [...text];
  if (characters.length <= maxCharacters) {
    return { text, truncated: false, totalCharacters: characters.length };
  }
  return {
    text: characters.slice(0, maxCharacters).join(""),
    truncated: true,
    totalCharacters: characters.length,
  };
}

export async function readCodeResource(params: {
  repositoryRoot: string;
  wikiRoot: string;
  resourceUri: string;
  maxCharacters?: number;
}): Promise<CodeResourceRead> {
  const maxCharacters = params.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > MAX_CHARACTERS) {
    throw new Error(`maxCharacters must be an integer between 1 and ${MAX_CHARACTERS}.`);
  }
  const ref = parseCodeResourceUri(params.resourceUri);
  const lexicalTarget = safeResolveWithin(params.repositoryRoot, ref.path);
  const [rootReal, targetReal] = await Promise.all([
    fs.realpath(params.repositoryRoot),
    fs.realpath(lexicalTarget),
  ]);
  const relativeReal = nodePath.relative(rootReal, targetReal);
  if (relativeReal === "" || relativeReal.startsWith("..") || nodePath.isAbsolute(relativeReal)) {
    throw new Error(`Code resource resolves outside the repository root: ${ref.path}`);
  }
  const snapshot = await readCodeEvidenceSnapshot(params.wikiRoot);
  const file = snapshot.files.find((record) => record.path === ref.path);
  const fragment = snapshot.fragments.find((candidate) =>
    candidate.id === ref.fragmentId && candidate.path === ref.path
  );
  if (!file || !fragment) throw new Error(`Code evidence symbol no longer exists: ${params.resourceUri}`);
  const currentParserVersion = defaultParserVersionForPath(ref.path);
  if (currentParserVersion && file.parserVersion !== currentParserVersion) {
    throw new Error(`Code evidence parser changed for ${ref.path}; rebuild the index before reading.`);
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) throw new Error(`Code resource is not a regular file: ${ref.path}`);
  const content = await fs.readFile(targetReal, "utf8");
  const currentHash = createHash("sha256").update(content).digest("hex");
  if (currentHash !== file.contentHash) {
    throw new Error(`Code evidence is stale for ${ref.path}; update the index before reading.`);
  }
  const lines = content.split(/\r?\n/);
  const body = fragment.kind === "module"
    ? fragment.definition
    : lines.slice(fragment.range.startLine - 1, fragment.range.endLine).join("\n");
  const limited = truncateCharacters(body, maxCharacters);
  return {
    uri: params.resourceUri,
    path: fragment.path,
    fragmentId: fragment.id,
    symbol: fragment.symbol,
    qualifiedName: fragment.qualifiedName,
    kind: fragment.kind,
    startLine: fragment.range.startLine,
    endLine: fragment.kind === "module" ? fragment.range.startLine : fragment.range.endLine,
    text: limited.text,
    truncated: limited.truncated,
    totalCharacters: limited.totalCharacters,
  };
}
