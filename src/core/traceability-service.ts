import { wikiDir } from "./paths.js";
import { getWikiPageRecords } from "./retrieval-index.js";

export interface TraceabilityRow {
  requestId: string;
  type: string;
  path: string;
  title: string;
}

export function formatTraceabilityRows(rows: TraceabilityRow[]): string {
  const byRequest = new Map<string, TraceabilityRow[]>();
  for (const row of rows) {
    const bucket = byRequest.get(row.requestId) ?? [];
    bucket.push(row);
    byRequest.set(row.requestId, bucket);
  }

  const lines = ["# Traceability report", ""];
  for (const [requestId, bucket] of [...byRequest.entries()].sort()) {
    if (requestId === "(none)") continue;
    const types = new Set(bucket.map((row) => row.type));
    const missing = ["request", "requirement", "implementation", "test_result", "release"].filter(
      (type) => !types.has(type)
    );
    lines.push(`## ${requestId}`);
    lines.push(`- Pagine: ${bucket.length}`);
    lines.push(`- Copertura: ${missing.length === 0 ? "completa" : `manca ${missing.join(", ")}`}`);
    for (const row of bucket.sort((a, b) => a.type.localeCompare(b.type))) {
      lines.push(`  - ${row.type}: ${row.title} (${row.path})`);
    }
    lines.push("");
  }

  if (lines.length === 2) lines.push("Nessuna richiesta tracciata trovata.");
  return lines.join("\n").trimEnd();
}

export async function collectTraceabilityRowsFromMarkdown(): Promise<TraceabilityRow[]> {
  return (await getWikiPageRecords(wikiDir(), false, { persist: false })).map((record) => ({
    requestId: record.requestId ?? "(none)",
    type: record.type,
    path: record.path,
    title: record.title,
  }));
}

export async function buildTraceabilityText(): Promise<string> {
  return formatTraceabilityRows(await collectTraceabilityRowsFromMarkdown());
}
