import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { codeAnchorHash } from "./code-anchor.js";
import type { CodeAnchor } from "./types.js";

const execute = promisify(execFile);
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

async function git(root: string, args: string[]): Promise<string> {
  const result = await execute("git", ["--no-pager", "--literal-pathspecs", ...args], {
    cwd: root, timeout: 3_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}

async function ownRepository(root: string): Promise<boolean> {
  return await realpath(root) === await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim());
}

/** A revision describes the captured bytes only when the file agrees with that commit. */
export async function captureGitRevision(root: string, path: string, content: string): Promise<string | undefined> {
  try {
    if (!await ownRepository(root)) return undefined;
    const revision = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
    if (!REVISION.test(revision)) return undefined;
    return await git(root, ["show", "--no-ext-diff", "--no-textconv", `${revision}:${path}`]) === content ? revision : undefined;
  } catch { return undefined; }
}

/** Translate an untouched inclusive line range through zero-context unified hunks. */
export function mapUnchangedRange(start: number, end: number, diff: string): { startLine: number; endLine: number } | null {
  let shift = 0;
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const from = Number(match[1]);
    const removed = match[2] === undefined ? 1 : Number(match[2]);
    const added = match[4] === undefined ? 1 : Number(match[4]);
    if (removed === 0) {
      // An insertion at line N is after N in the old file.
      if (from < start) shift += added;
      else if (from < end) return null;
    } else if (from + removed <= start) shift += added - removed;
    else if (from <= end) return null;
  }
  return { startLine: start + shift, endLine: end + shift };
}

export async function relocateGitAnchor(root: string, anchor: CodeAnchor, content: string, checkedAt: string): Promise<CodeAnchor | null> {
  if (!anchor.revision || !REVISION.test(anchor.revision)) return null;
  try {
    if (!await ownRepository(resolve(root))) return null;
    const original = await git(root, ["show", "--no-ext-diff", "--no-textconv", `${anchor.revision}:${anchor.path}`]);
    if (codeAnchorHash(original, anchor.startLine, anchor.endLine) !== anchor.rangeHash) return null;
    // Include working-tree edits too: the final hash is checked against the same
    // confined file bytes that drift inspected, never just trusted from a diff.
    const diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", anchor.revision, "--", anchor.path]);
    const range = mapUnchangedRange(anchor.startLine, anchor.endLine, diff);
    if (!range || range.startLine === anchor.startLine || codeAnchorHash(content, range.startLine, range.endLine) !== anchor.rangeHash) return null;
    const revision = await captureGitRevision(root, anchor.path, content);
    const { history, ...previous } = anchor;
    const { revision: _revision, ...current } = previous;
    return { ...current, ...range, capturedAt: checkedAt, ...(revision ? { revision } : {}),
      history: [...(history ?? []), previous] };
  } catch { return null; }
}
