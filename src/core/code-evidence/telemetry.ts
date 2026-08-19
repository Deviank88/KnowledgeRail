import * as nodePath from "node:path";
import { appendTextWithLock } from "../fs-service.js";
import { wikiMetaDir } from "../manifest-service.js";
import { readFileSafe } from "../utils.js";
import type { CodeGrepFallbackEvent } from "./types.js";

const TELEMETRY_FILE_NAME = "code-evidence-grep-fallback.jsonl";

export function codeGrepFallbackTelemetryFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), TELEMETRY_FILE_NAME);
}

export async function recordCodeGrepFallback(params: {
  wikiRoot: string;
  query: string;
  reason: string;
  resultCount: number;
  resultPaths?: readonly string[];
  timestamp?: string;
}): Promise<CodeGrepFallbackEvent> {
  const query = params.query.trim();
  const reason = params.reason.trim();
  if (!query || query.length > 4_096) throw new Error("Fallback query must contain 1-4096 characters.");
  if (!reason || reason.length > 1_024) throw new Error("Fallback reason must contain 1-1024 characters.");
  if (!Number.isInteger(params.resultCount) || params.resultCount < 0) {
    throw new Error("Fallback resultCount must be a non-negative integer.");
  }
  if ((params.resultPaths?.length ?? 0) > 1_000) {
    throw new Error("Fallback resultPaths accepts at most 1000 paths.");
  }
  if ((params.resultPaths?.length ?? 0) > params.resultCount) {
    throw new Error("Fallback resultPaths cannot exceed resultCount.");
  }
  const extensionHistogram: Record<string, number> = {};
  for (const path of params.resultPaths ?? []) {
    if (!path || path.length > 4_096 || path.includes("\0")) {
      throw new Error("Fallback result paths must contain 1-4096 characters without null bytes.");
    }
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    const extension = normalized.endsWith(".js-meta.xml")
      ? ".js-meta.xml"
      : nodePath.posix.extname(normalized) || "(none)";
    extensionHistogram[extension] = (extensionHistogram[extension] ?? 0) + 1;
  }
  const event: CodeGrepFallbackEvent = {
    version: 2,
    timestamp: params.timestamp ?? new Date().toISOString(),
    query,
    reason,
    resultCount: params.resultCount,
    extensionHistogram: Object.fromEntries(Object.entries(extensionHistogram).sort(([left], [right]) =>
      left.localeCompare(right)
    )),
  };
  if (Number.isNaN(Date.parse(event.timestamp))) throw new Error("Fallback timestamp must be ISO-8601 compatible.");
  await appendTextWithLock(codeGrepFallbackTelemetryFile(params.wikiRoot), `${JSON.stringify(event)}\n`);
  return event;
}

export async function readCodeGrepFallbackEvents(wikiRoot: string): Promise<CodeGrepFallbackEvent[]> {
  const raw = await readFileSafe(codeGrepFallbackTelemetryFile(wikiRoot));
  if (raw === null || !raw.trim()) return [];
  return raw.trimEnd().split("\n").map((line, index) => {
    try {
      const event = JSON.parse(line) as {
        version?: number;
        timestamp?: unknown;
        query?: unknown;
        reason?: unknown;
        resultCount?: unknown;
        extensionHistogram?: unknown;
      };
      if (
        ![1, 2].includes(event.version ?? -1) || typeof event.timestamp !== "string" ||
        typeof event.query !== "string" || typeof event.reason !== "string" ||
        typeof event.resultCount !== "number" || !Number.isInteger(event.resultCount) || event.resultCount < 0
      ) {
        throw new Error("invalid event schema");
      }
      const histogram = event.version === 1 ? {} : event.extensionHistogram;
      if (!histogram || typeof histogram !== "object" || Array.isArray(histogram) ||
          Object.entries(histogram).some(([extension, count]) =>
            !/^(?:\.[a-z0-9][a-z0-9._+-]{0,31}|\(none\))$/u.test(extension) ||
            !Number.isInteger(count) || count < 0
          )) {
        throw new Error("invalid extension histogram");
      }
      if (Object.values(histogram).reduce<number>((total, count) =>
        total + (typeof count === "number" ? count : 0), 0
      ) > event.resultCount) {
        throw new Error("extension histogram exceeds resultCount");
      }
      return {
        version: 2,
        timestamp: event.timestamp as string,
        query: event.query as string,
        reason: event.reason as string,
        resultCount: event.resultCount as number,
        extensionHistogram: histogram as Record<string, number>,
      };
    } catch (error: unknown) {
      throw new Error(`Invalid code grep fallback telemetry at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export interface CodeGrepFallbackDemandSummary {
  totalEvents: number;
  totalResults: number;
  categorizedResults: number;
  uncategorizedResults: number;
  byExtension: Record<string, number>;
}

export async function codeGrepFallbackDemand(wikiRoot: string): Promise<CodeGrepFallbackDemandSummary> {
  const events = await readCodeGrepFallbackEvents(wikiRoot);
  const counts = new Map<string, number>();
  let totalResults = 0;
  let categorizedResults = 0;
  for (const event of events) {
    totalResults += event.resultCount;
    for (const [extension, count] of Object.entries(event.extensionHistogram)) {
      counts.set(extension, (counts.get(extension) ?? 0) + count);
      categorizedResults += count;
    }
  }
  return {
    totalEvents: events.length,
    totalResults,
    categorizedResults,
    uncategorizedResults: Math.max(0, totalResults - categorizedResults),
    byExtension: Object.fromEntries([...counts.entries()].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
    )),
  };
}
