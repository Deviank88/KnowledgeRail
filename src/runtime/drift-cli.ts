import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { DriftCliOptions } from "../cli.js";
import {
  detectCodeDrift,
  normalizeRepositoryPath,
  type DriftLedgerEntry,
} from "../core/drift-detection.js";
import { resolveWorkspace } from "../mcp/workspace.js";
import { canonicalizeExistingDirectory } from "../mcp/workspace-discovery.js";

type DriftResult = Awaited<ReturnType<typeof detectCodeDrift>>;

interface WritableText {
  write(value: string): unknown;
}

export interface DriftCliIo {
  stdout: WritableText;
  stderr: WritableText;
}

export interface DriftCliDependencies {
  resolve?: typeof resolveWorkspace;
  canonicalize?: typeof canonicalizeExistingDirectory;
  detect?: typeof detectCodeDrift;
}

const DEFAULT_IO: DriftCliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

const TEXT_ENTRY_LIMIT = 20;
const TEXT_LINE_LIMIT = 500;

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function boundedLine(value: string): string {
  const normalized = oneLine(value);
  return normalized.length <= TEXT_LINE_LIMIT
    ? normalized
    : `${normalized.slice(0, TEXT_LINE_LIMIT - 1)}…`;
}

function entryLine(entry: DriftLedgerEntry): string {
  const pages = entry.pagePaths.length > 0 ? entry.pagePaths.join(", ") : "(unlinked)";
  return boundedLine(
    `${entry.verdict} ${entry.anchor.path}:${entry.anchor.startLine}-${entry.anchor.endLine} ← ${pages}`
  );
}

export function formatDriftText(result: DriftResult): string {
  const nonFresh = result.entries.filter((entry) => entry.verdict !== "fresh");
  if (nonFresh.length === 0) return "";
  const summary = result.summary;
  const lines = [
    `drift: ${summary.fresh} fresh, ${nonFresh.length} stale, ` +
      `${summary.driftSuspected} drift_suspected, ${summary.anchorUnresolvable} unresolvable`,
    ...nonFresh.slice(0, TEXT_ENTRY_LIMIT).map(entryLine),
  ];
  if (nonFresh.length > TEXT_ENTRY_LIMIT) lines.push(`… +${nonFresh.length - TEXT_ENTRY_LIMIT} more`);
  return `${lines.join("\n")}\n`;
}

function pathOutsideRoot(relative: string): boolean {
  return relative === "" || relative === ".." || relative.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relative);
}

async function canonicalPathWithMissingLeaf(value: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = nodePath.resolve(value);
  while (true) {
    try {
      return nodePath.join(await fs.realpath(cursor), ...suffix.reverse());
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

export async function normalizeDriftCliPaths(
  repositoryRoot: string,
  values: readonly string[],
  rootAliases: readonly string[] = []
): Promise<string[]> {
  return Promise.all(values.map(async (value) => {
    if (!nodePath.isAbsolute(value)) return normalizeRepositoryPath(value);
    for (const root of [repositoryRoot, ...rootAliases]) {
      const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(value));
      if (!pathOutsideRoot(relative)) return normalizeRepositoryPath(relative.replace(/\\/gu, "/"));
    }
    const canonical = await canonicalPathWithMissingLeaf(value);
    const relative = nodePath.relative(repositoryRoot, canonical);
    if (!pathOutsideRoot(relative)) return normalizeRepositoryPath(relative.replace(/\\/gu, "/"));
    throw new Error("Drift --path must stay inside the project root.");
  }));
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message || "Drift check failed.");
}

type DetectionOutcome =
  | { kind: "result"; result: DriftResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

export async function runDriftCli(
  options: DriftCliOptions,
  io: DriftCliIo = DEFAULT_IO,
  dependencies: DriftCliDependencies = {}
): Promise<number> {
  const resolve = dependencies.resolve ?? resolveWorkspace;
  const canonicalize = dependencies.canonicalize ?? canonicalizeExistingDirectory;
  const detect = dependencies.detect ?? detectCodeDrift;
  try {
    const controller = new AbortController();
    const detection = Promise.resolve().then(async () => {
      const resolved = await resolve({ explicitRoot: options.root, automaticDiscovery: true });
      controller.signal.throwIfAborted();
      const repositoryRoot = await canonicalize(resolved.root);
      controller.signal.throwIfAborted();
      const paths = await normalizeDriftCliPaths(repositoryRoot, options.paths, [resolved.root]);
      controller.signal.throwIfAborted();
      return detect({
        repositoryRoot,
        wikiRoot: nodePath.join(repositoryRoot, "wiki"),
        ...(paths.length > 0 ? { paths } : {}),
        writeLedger: options.writeLedger,
        signal: controller.signal,
      });
    });
    const settled = detection.then<DetectionOutcome, DetectionOutcome>(
      (result) => ({ kind: "result", result }),
      (error: unknown) => ({ kind: "error", error })
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<DetectionOutcome>((resolveTimeout) => {
      timer = setTimeout(() => {
        controller.abort();
        resolveTimeout({ kind: "timeout" });
      }, options.timeoutMs);
    });
    const outcome = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === "timeout") {
      io.stderr.write(`drift check timed out after ${options.timeoutMs}ms\n`);
      return options.check ? 2 : 0;
    }
    if (outcome.kind === "error") throw outcome.error;

    if (options.format === "json") {
      io.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    } else {
      const text = formatDriftText(outcome.result);
      if (text) io.stdout.write(text);
    }
    const nonFresh = outcome.result.entries.some((entry) => entry.verdict !== "fresh");
    return options.check && nonFresh ? 2 : 0;
  } catch (error: unknown) {
    io.stderr.write(`${errorLine(error)}\n`);
    return 1;
  }
}
