import { createHash } from "node:crypto";
import { defaultParserVersionForPath } from "./adapter-registry.js";
import { readCodeEvidenceSnapshot } from "./index.js";
import { readConfinedRepositoryFile } from "./confined-reader.js";
import { parseCodeResourceUri } from "./resource-uri.js";
import type { CodeAnchor } from "./types.js";

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

export async function captureCodeAnchor(params: {
  repositoryRoot: string;
  wikiRoot: string;
  resourceUri: string;
  capturedAt?: string;
}): Promise<CodeAnchor> {
  const reference = parseCodeResourceUri(params.resourceUri, { allowWorkspaceBinding: false });
  const snapshot = await readCodeEvidenceSnapshot(params.wikiRoot);
  const file = snapshot.files.find((candidate) => candidate.path === reference.path);
  const fragment = snapshot.fragments.find((candidate) =>
    candidate.id === reference.fragmentId && candidate.path === reference.path
  );
  if (!file || !fragment) throw new Error(`Code evidence target is not indexed: ${params.resourceUri}`);
  const currentParserVersion = defaultParserVersionForPath(reference.path);
  if (currentParserVersion && file.parserVersion !== currentParserVersion) {
    throw new Error(`Code evidence parser changed for ${reference.path}; rebuild before capturing an anchor.`);
  }
  const content = await readConfinedRepositoryFile({
    repositoryRoot: params.repositoryRoot,
    relativePath: reference.path,
    missing: "throw",
    label: "Code anchor",
  });
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
