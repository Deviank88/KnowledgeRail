import * as path from "node:path";

const CONTROL_FILES = new Set(["schema.md", "index.md", "log.md"]);

export interface NormalizeWikiPagePathOptions {
  /**
   * Accept the common project-relative spelling (`wiki/...`) at API
   * boundaries and convert it to the canonical wiki-relative spelling.
   */
  allowWikiRootPrefix?: boolean;
  /** Control files are managed by dedicated services, not page CRUD. */
  allowControlFiles?: boolean;
}

/**
 * Return a normalized Markdown page path relative to the canonical wiki root.
 *
 * Page directories intentionally remain open-ended. The only directory names
 * rejected here are hidden/operational segments and `wiki`, because accepting
 * either would create content that normal indexing cannot safely distinguish
 * from canonical memory. At caller-facing boundaries a leading `wiki/` is
 * treated as a redundant project-relative root marker and removed.
 */
export function normalizeWikiPagePath(
  value: string,
  options: NormalizeWikiPagePathOptions = {}
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw new Error("Wiki page path must contain 1-1024 characters.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Wiki page path contains control characters: ${value}`);
  }

  const trimmed = value.trim();
  const slashes = trimmed.replace(/\\/g, "/");
  if (
    !slashes || path.posix.isAbsolute(slashes) || /^[A-Za-z]:\//u.test(slashes) ||
    slashes.startsWith("//")
  ) {
    throw new Error(`Wiki page path must be relative to the wiki root: ${value}`);
  }

  let parts = slashes.split("/");
  while (parts[0] === ".") parts = parts.slice(1);
  if (options.allowWikiRootPrefix) {
    while (parts[0]?.toLocaleLowerCase("en-US") === "wiki") parts = parts.slice(1);
  }

  if (parts.includes("..")) {
    throw new Error(`Path escapes allowed directory: ${value}`);
  }

  const normalized = parts.join("/");
  if (
    !normalized || path.posix.normalize(normalized) !== normalized ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Wiki page path must be normalized and relative to the wiki root: ${value}`);
  }
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error(`Wiki page path must reference a Markdown file: ${value}`);
  }

  const directoryParts = parts.slice(0, -1);
  if (directoryParts.some((part) => part.toLocaleLowerCase("en-US") === "wiki")) {
    throw new Error(
      `Nested wiki directories are not allowed; pass a path relative to the wiki root: ${value}`
    );
  }
  if (parts.some((part) => part.startsWith("."))) {
    throw new Error(`Hidden wiki page paths are reserved for operational state: ${value}`);
  }
  if (!options.allowControlFiles && CONTROL_FILES.has(normalized.toLocaleLowerCase("en-US"))) {
    throw new Error(`Wiki control files are managed internally: ${value}`);
  }

  return normalized;
}

export function isCanonicalWikiPagePath(value: string): boolean {
  try {
    return normalizeWikiPagePath(value) === value;
  } catch {
    return false;
  }
}

/**
 * Return the canonical destination for a legacy page stored below one or more
 * nested `wiki` directories. Invalid, unsafe, and already-canonical paths are
 * not repair candidates.
 */
export function nestedWikiPageRepairTarget(value: string): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const directoryParts = parts.slice(0, -1);
  if (!directoryParts.some((part) => part.toLocaleLowerCase("en-US") === "wiki")) {
    return null;
  }

  const target = [
    ...directoryParts.filter((part) => part.toLocaleLowerCase("en-US") !== "wiki"),
    parts.at(-1) ?? "",
  ].join("/");
  try {
    return normalizeWikiPagePath(target);
  } catch {
    return null;
  }
}
