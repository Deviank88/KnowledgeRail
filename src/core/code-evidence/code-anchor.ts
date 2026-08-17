import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { safeResolveWithin } from "../paths.js";
import { readCodeEvidenceSnapshot } from "./index.js";
import { parseCodeResourceUri } from "./resource-uri.js";
import {
  TYPESCRIPT_ADAPTER_VERSION,
  type CodeAnchor,
} from "./types.js";

export function normalizedCodeRange(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(/[\t ]+$/u, ""))
    .join("\n")
    .normalize("NFC");
}

export function codeRangeHash(lines: readonly string[]): string {
  return createHash("sha256").update(normalizedCodeRange(lines), "utf8").digest("hex");
}

export function codeAnchorHash(content: string, startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("Code anchor line range is invalid.");
  }
  const lines = content.split(/\r?\n/u);
  if (startLine > lines.length || endLine > lines.length) {
    throw new Error("Code anchor line range is out of bounds.");
  }
  return codeRangeHash(lines.slice(startLine - 1, endLine));
}

async function readConfinedCodeFile(repositoryRoot: string, relativePath: string): Promise<string> {
  const lexicalTarget = safeResolveWithin(repositoryRoot, relativePath);
  const [rootReal, targetReal] = await Promise.all([
    fs.realpath(repositoryRoot),
    fs.realpath(lexicalTarget),
  ]);
  const relativeReal = nodePath.relative(rootReal, targetReal);
  if (relativeReal === "" || relativeReal.startsWith("..") || nodePath.isAbsolute(relativeReal)) {
    throw new Error(`Code anchor resolves outside the repository root: ${relativePath}`);
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) throw new Error(`Code anchor is not a regular file: ${relativePath}`);
  return fs.readFile(targetReal, "utf8");
}

export async function captureCodeAnchor(params: {
  repositoryRoot: string;
  wikiRoot: string;
  resourceUri: string;
  capturedAt?: string;
}): Promise<CodeAnchor> {
  const reference = parseCodeResourceUri(params.resourceUri, { allowWorkspaceBinding: false });
  const snapshot = await readCodeEvidenceSnapshot(params.wikiRoot, TYPESCRIPT_ADAPTER_VERSION);
  const file = snapshot.files.find((candidate) => candidate.path === reference.path);
  const fragment = snapshot.fragments.find((candidate) =>
    candidate.id === reference.fragmentId && candidate.path === reference.path
  );
  if (!file || !fragment) throw new Error(`Code evidence target is not indexed: ${params.resourceUri}`);
  const content = await readConfinedCodeFile(params.repositoryRoot, reference.path);
  const contentHash = createHash("sha256").update(content).digest("hex");
  if (file.contentHash !== contentHash) {
    throw new Error(`Code evidence target is stale: ${reference.path}`);
  }
  const capturedAt = params.capturedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error("Code anchor capturedAt must be ISO-8601 compatible.");
  return {
    path: fragment.path,
    startLine: fragment.range.startLine,
    endLine: fragment.range.endLine,
    rangeHash: codeAnchorHash(content, fragment.range.startLine, fragment.range.endLine),
    parserVersion: file.parserVersion,
    capturedAt,
  };
}
