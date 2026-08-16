const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;
type LogValue = string | number | boolean | null | undefined;

function configuredLevel(): LogLevel {
  const raw = process.env["KNOWLEDGE_RAIL_LOG_LEVEL"]?.toLowerCase();
  return raw && raw in LEVELS ? raw as LogLevel : "info";
}

export function redactLogText(value: string): string {
  return value
    .replace(/krb\d+_[A-Za-z0-9_-]{20,}/g, "<binding>")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <credential>")
    .replace(/[A-Za-z]:\\[^\s:'"()]+/g, "<path>")
    .replace(/(^|[\s:'"(])\/(?:[^\s:'"()]+\/?)+/g, "$1<path>")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function safeFields(fields: Record<string, LogValue>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "string" ? redactLogText(value) : value])
  ) as Record<string, string | number | boolean | null>;
}

export function log(
  level: Exclude<LogLevel, "silent">,
  subsystem: string,
  event: string,
  fields: Record<string, LogValue> = {},
  error?: unknown
): void {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    subsystem,
    event,
    ...safeFields(fields),
  };
  if (error instanceof Error) {
    record.errorName = error.name;
    record.errorMessage = redactLogText(error.message);
    if (error.stack) record.errorStack = redactLogText(error.stack);
  } else if (error !== undefined) {
    record.errorMessage = redactLogText(String(error));
  }
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const logger = {
  debug: (subsystem: string, event: string, fields?: Record<string, LogValue>) =>
    log("debug", subsystem, event, fields),
  info: (subsystem: string, event: string, fields?: Record<string, LogValue>) =>
    log("info", subsystem, event, fields),
  warn: (subsystem: string, event: string, fields?: Record<string, LogValue>, error?: unknown) =>
    log("warn", subsystem, event, fields, error),
  error: (subsystem: string, event: string, fields?: Record<string, LogValue>, error?: unknown) =>
    log("error", subsystem, event, fields, error),
};
