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
  timestamp?: string;
}): Promise<CodeGrepFallbackEvent> {
  const query = params.query.trim();
  const reason = params.reason.trim();
  if (!query || query.length > 4_096) throw new Error("Fallback query must contain 1-4096 characters.");
  if (!reason || reason.length > 1_024) throw new Error("Fallback reason must contain 1-1024 characters.");
  if (!Number.isInteger(params.resultCount) || params.resultCount < 0) {
    throw new Error("Fallback resultCount must be a non-negative integer.");
  }
  const event: CodeGrepFallbackEvent = {
    version: 1,
    timestamp: params.timestamp ?? new Date().toISOString(),
    query,
    reason,
    resultCount: params.resultCount,
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
      const event = JSON.parse(line) as Partial<CodeGrepFallbackEvent>;
      if (
        event.version !== 1 || typeof event.timestamp !== "string" ||
        typeof event.query !== "string" || typeof event.reason !== "string" ||
        !Number.isInteger(event.resultCount) || (event.resultCount ?? -1) < 0
      ) {
        throw new Error("invalid event schema");
      }
      return event as CodeGrepFallbackEvent;
    } catch (error: unknown) {
      throw new Error(`Invalid code grep fallback telemetry at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
