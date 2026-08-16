import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getActiveWorkspaceContext } from "./workspace-context.js";

let currentWikiRoot: string = process.cwd();
let wikiRootReady = true;

export class WikiWorkspacePendingError extends Error {
  constructor() {
    super("Wiki workspace resolution is still in progress. Retry the operation after workspace negotiation completes.");
    this.name = "WikiWorkspacePendingError";
  }
}

export class WorkspaceAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAuthorizationError";
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
  const requestWorkspace = getActiveWorkspaceContext();
  if (requestWorkspace) {
    if (!requestWorkspace.authorized) {
      throw new WorkspaceAuthorizationError(
        requestWorkspace.authorizationError ?? "Workspace access is not authorized."
      );
    }
    return requestWorkspace.paths.projectRoot;
  }
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

function isContained(root: string, target: string): boolean {
  const relative = nodePath.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

async function resolveFromDeepestExisting(absPath: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = nodePath.resolve(absPath);
  while (true) {
    try {
      const existingReal = await fs.realpath(cursor);
      return nodePath.join(existingReal, ...suffix.reverse());
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = nodePath.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(nodePath.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Resolve a caller-owned relative path through the deepest existing ancestor.
 * Existing symlinks are followed only for validation and must remain inside the
 * canonical root. Missing leaves are reconstructed below that validated parent.
 */
export async function resolveRealWithin(root: string, relPath: string): Promise<string> {
  const rootAbs = nodePath.resolve(root);
  const targetAbs = safeResolveWithin(rootAbs, relPath);
  try {
    const rootStat = await fs.lstat(rootAbs);
    if (rootStat.isSymbolicLink()) {
      throw new Error("Allowed directory has been replaced by a symbolic link.");
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const [rootReal, targetReal] = await Promise.all([
    resolveFromDeepestExisting(rootAbs),
    resolveFromDeepestExisting(targetAbs),
  ]);

  if (!isContained(rootReal, targetReal)) {
    throw new Error(`Path resolves outside allowed directory: ${relPath}`);
  }
  return targetReal;
}

export function validateGlobPattern(pattern: string): string {
  if (!pattern || pattern.trim() === "") throw new Error("Glob pattern must not be empty.");
  if (pattern.includes("\0")) throw new Error("Glob pattern must not contain null bytes.");
  if (pattern.startsWith("/") || pattern.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(pattern)) {
    throw new Error("Absolute glob patterns are not allowed.");
  }
  if (process.platform !== "win32" && pattern.includes("\\")) {
    throw new Error("Backslashes are not allowed in glob patterns on POSIX.");
  }
  // Reject any segment containing a parent token. This is intentionally a
  // little stricter than path normalization so brace/extglob syntax cannot
  // manufacture a parent segment after validation.
  if (pattern.split(/[\\/]/).some((segment) => segment.includes(".."))) {
    throw new Error("Parent-directory segments are not allowed in glob patterns.");
  }
  return pattern;
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

export async function docsCategoryDirReal(category: string): Promise<string> {
  const safeDocs = await resolveRealWithin(getWikiRoot(), "docs");
  return resolveRealWithin(safeDocs, category);
}

export async function docsCategoryFilePathReal(
  category: string,
  relPath: string
): Promise<string> {
  return resolveRealWithin(await docsCategoryDirReal(category), relPath);
}

export function wikiPagePath(relPath: string): string {
  return safeResolveWithin(wikiDir(), relPath);
}
