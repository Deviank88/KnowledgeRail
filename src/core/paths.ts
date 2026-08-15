import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

let currentWikiRoot: string = process.cwd();
let wikiRootReady = true;

export class WikiWorkspacePendingError extends Error {
  constructor() {
    super("Wiki workspace resolution is still in progress. Retry the operation after workspace negotiation completes.");
    this.name = "WikiWorkspacePendingError";
  }
}

export function isWikiRootReady(): boolean {
  return wikiRootReady;
}

/**
 * Close the workspace gate while a compatibility resolver is selecting the
 * active project. Path reads fail closed until `setWikiRoot()` completes.
 */
export function markWikiRootPending(): void {
  wikiRootReady = false;
}

export function getWikiRoot(): string {
  if (!wikiRootReady) throw new WikiWorkspacePendingError();
  return currentWikiRoot;
}

export function setWikiRoot(root: string): void {
  currentWikiRoot = nodePath.resolve(root);
  wikiRootReady = true;
}

export function uriToPath(uri: string): string | null {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  return nodePath.resolve(uri);
}

export function wikiDir(): string {
  return nodePath.join(getWikiRoot(), "wiki");
}

export function rawDir(): string {
  return nodePath.join(getWikiRoot(), "docs");
}

export function indexFile(): string {
  return nodePath.join(wikiDir(), "index.md");
}

export function logFile(): string {
  return nodePath.join(wikiDir(), "log.md");
}

export function schemaFile(): string {
  return nodePath.join(wikiDir(), "SCHEMA.md");
}

export function docsDir(): string {
  return nodePath.join(getWikiRoot(), "docs");
}

export function docsCategoryDir(category: string): string {
  return safeResolveWithin(docsDir(), category);
}

export function safeResolveWithin(
  root: string,
  relPath: string,
  opts: { basenameOnly?: boolean } = {}
): string {
  if (!relPath || relPath.trim() === "") {
    throw new Error("Path must not be empty.");
  }

  const input = opts.basenameOnly ? nodePath.basename(relPath) : relPath;
  if (nodePath.isAbsolute(input)) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }

  const rootAbs = nodePath.resolve(root);
  const target = nodePath.resolve(rootAbs, input);
  const relative = nodePath.relative(rootAbs, target);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    nodePath.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes allowed directory: ${relPath}`);
  }

  return target;
}

export function relativePathFrom(root: string, absPath: string): string {
  return nodePath.relative(root, absPath).replace(/\\/g, "/");
}

export function rawFilePath(relPath: string): string {
  return safeResolveWithin(rawDir(), relPath);
}

export function docsFilePath(filename: string): string {
  return safeResolveWithin(docsDir(), filename, { basenameOnly: true });
}

export function docsCategoryFilePath(category: string, relPath: string): string {
  return safeResolveWithin(docsCategoryDir(category), relPath);
}

export function wikiPagePath(relPath: string): string {
  return safeResolveWithin(wikiDir(), relPath);
}
