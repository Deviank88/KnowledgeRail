import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { logger } from "../core/logger.js";

const enabled = process.env["KNOWLEDGE_RAIL_STARTUP_TIMINGS"] === "1";
const eventLoopDelay = enabled ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
eventLoopDelay?.enable();

export function startupMark(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  if (!enabled) return;
  const memory = process.memoryUsage();
  logger.info("startup", event, {
    elapsedMs: Number(performance.now().toFixed(3)),
    rssMb: Number((memory.rss / 1024 / 1024).toFixed(3)),
    heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(3)),
    eventLoopDelayMaxMs: eventLoopDelay
      ? Number((eventLoopDelay.max / 1_000_000).toFixed(3))
      : undefined,
    ...fields,
  });
}

export function closeStartupTiming(): void {
  eventLoopDelay?.disable();
}
