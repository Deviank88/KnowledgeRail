import * as nodePath from "node:path";
import { resolveRealWithin, wikiDir } from "./paths.js";
import { atomicWriteText, appendTextWithLock } from "./fs-service.js";
import {
  ensureDir,
  timestamp,
} from "./utils.js";
import { WIKI_PAGE_TYPES } from "./wiki-validation.js";
import { getWikiPageRecords } from "./retrieval-index.js";

export interface WikiPageMetadata {
  path: string;
  title?: string;
  type?: string;
  updated?: string;
}

export const WIKI_TYPE_LABELS: Record<string, string> = {
  entity: "Entities",
  concept: "Concepts",
  summary: "Summaries",
  comparison: "Comparisons",
  overview: "Overviews",
  analysis: "Analysis",
  meeting_note: "Meeting notes",
  client_source: "Client sources",
  candidate_request: "Candidate requests",
  request: "Validated requests",
  requirement: "Requirements",
  implementation: "Implementations",
  test_result: "Test results",
  decision: "Decisions",
  release: "Releases",
  risk: "Risks",
  data_model: "Data model",
  automation: "Automations",
  integration: "Integrations",
  api: "API",
};

export async function listWikiPageMetadata(): Promise<WikiPageMetadata[]> {
  return (await getWikiPageRecords(wikiDir()))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((record) => ({ path: record.path, title: record.title, type: record.type, updated: record.updated }));
}

export async function rebuildIndex(): Promise<number> {
  const pages = await listWikiPageMetadata();
  const grouped = new Map<string, Array<{ path: string; title: string; updated: string }>>();
  for (const page of pages) {
    const type = page.type ?? "unknown";
    const bucket = grouped.get(type) ?? [];
    bucket.push({
      path: page.path,
      title: page.title ?? page.path,
      updated: page.updated ?? "",
    });
    grouped.set(type, bucket);
  }

  const orderedTypes = [
    ...WIKI_PAGE_TYPES,
    ...[...grouped.keys()].filter(
      (type) => !WIKI_PAGE_TYPES.includes(type as (typeof WIKI_PAGE_TYPES)[number])
    ),
  ];
  const lines = [
    "# Wiki Index",
    "",
    "> Automatically regenerated catalog.",
    "",
  ];

  for (const type of orderedTypes) {
    const bucket = grouped.get(type);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`## ${WIKI_TYPE_LABELS[type] ?? type}`);
    lines.push("");
    for (const page of bucket.sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(`- [${page.title}](${page.path})${page.updated ? ` - ${page.updated}` : ""}`);
    }
    lines.push("");
  }

  const safeIndex = await resolveRealWithin(wikiDir(), "index.md");
  await ensureDir(nodePath.dirname(safeIndex));
  await atomicWriteText(safeIndex, lines.join("\n").trimEnd() + "\n");
  return pages.length;
}

export async function appendLog(
  entry: string,
  level: "INFO" | "WARN" | "ACTION" | "DECISION" = "ACTION"
): Promise<void> {
  const safeLog = await resolveRealWithin(wikiDir(), "log.md");
  await ensureDir(nodePath.dirname(safeLog));
  await appendTextWithLock(safeLog, `\n## [${level}] ${timestamp()}\n\n${entry}\n`);
}
