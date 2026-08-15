import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

export type AutomaticWorkspaceSource =
  | "knowledge_rail_marker"
  | "project_marker"
  | "cwd";

export interface AutomaticWorkspaceResolution {
  root: string;
  source: AutomaticWorkspaceSource;
}

const PROJECT_MARKERS = [
  ".git",
  ".hg",
  ".svn",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
] as const;

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function ancestors(start: string): string[] {
  const result: string[] = [];
  let cursor = nodePath.resolve(start);
  while (true) {
    result.push(cursor);
    const parent = nodePath.dirname(cursor);
    if (parent === cursor) return result;
    cursor = parent;
  }
}

function comparable(candidate: string): string {
  const normalized = nodePath.resolve(candidate);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function unsafeAutomaticRootReason(candidate: string): string | null {
  const resolved = nodePath.resolve(candidate);
  if (nodePath.dirname(resolved) === resolved) return "filesystem root";
  if (comparable(resolved) === comparable(os.homedir())) return "user home directory";

  const components = resolved.split(nodePath.sep).map((part) => part.toLowerCase());
  const joined = components.join("/");
  if (joined.includes("/node_modules/.cache/") || joined.includes("/_npx/")) {
    return "package cache directory";
  }
  if (
    joined.includes("/application support/claude") ||
    joined.includes("/appdata/local/anthropicclaude") ||
    joined.includes("/appdata/roaming/claude")
  ) {
    return "desktop application directory";
  }
  return null;
}

async function hasKnowledgeRailMarker(candidate: string): Promise<boolean> {
  return (
    await exists(nodePath.join(candidate, "wiki", "SCHEMA.md")) ||
    await isDirectory(nodePath.join(candidate, "wiki", ".knowledge-rail"))
  );
}

async function hasProjectMarker(candidate: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if (await exists(nodePath.join(candidate, marker))) return true;
  }
  try {
    const entries = await fs.readdir(candidate);
    return entries.some((entry) => entry.toLowerCase().endsWith(".code-workspace"));
  } catch {
    return false;
  }
}

export async function canonicalizeExistingDirectory(candidate: string): Promise<string> {
  const resolved = nodePath.resolve(candidate);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error("Workspace root does not exist or is not a directory.");
  }
  return fs.realpath(resolved);
}

/**
 * Discover only below the cwd ancestry. This deliberately never scans a disk
 * or a home directory and therefore behaves the same on Windows, Linux/macOS,
 * containers and WSL.
 */
export async function discoverWorkspaceFromCwd(
  cwd = process.cwd()
): Promise<AutomaticWorkspaceResolution> {
  const canonicalCwd = await canonicalizeExistingDirectory(cwd);
  const chain = ancestors(canonicalCwd);

  for (const candidate of chain) {
    if (!unsafeAutomaticRootReason(candidate) && await hasKnowledgeRailMarker(candidate)) {
      return { root: candidate, source: "knowledge_rail_marker" };
    }
  }
  for (const candidate of chain) {
    if (!unsafeAutomaticRootReason(candidate) && await hasProjectMarker(candidate)) {
      return { root: candidate, source: "project_marker" };
    }
  }

  const unsafeReason = unsafeAutomaticRootReason(canonicalCwd);
  if (unsafeReason) {
    throw new Error(`Cannot infer a project from the ${unsafeReason}; launch KnowledgeRail from an opened project.`);
  }

  // A bare directory with no recognizable project content is too ambiguous.
  // Requiring at least one entry prevents accidental initialization in an
  // incidental application cwd while retaining language-agnostic projects.
  const entries = await fs.readdir(canonicalCwd);
  if (entries.length === 0) {
    throw new Error("Cannot infer a project from an empty directory; launch KnowledgeRail from the project root or use --root.");
  }
  return { root: canonicalCwd, source: "cwd" };
}
