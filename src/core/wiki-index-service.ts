import { indexFile, logFile, wikiDir } from "./paths.js";
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
  entity: "Entità",
  concept: "Concetti",
  summary: "Riepiloghi",
  comparison: "Confronti",
  overview: "Panoramiche",
  analysis: "Analisi",
  meeting_note: "Meeting note",
  client_source: "Fonti cliente",
  candidate_request: "Richieste candidate",
  request: "Richieste validate",
  requirement: "Requisiti",
  implementation: "Implementazioni",
  test_result: "Esiti test",
  decision: "Decisioni",
  release: "Release",
  risk: "Rischi",
  data_model: "Data model",
  automation: "Automazioni",
  integration: "Integrazioni",
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
    "# Indice Wiki",
    "",
    "> Catalogo rigenerato automaticamente.",
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

  await ensureDir(wikiDir());
  await atomicWriteText(indexFile(), lines.join("\n").trimEnd() + "\n");
  return pages.length;
}

export async function appendLog(
  entry: string,
  level: "INFO" | "WARN" | "ACTION" | "DECISION" = "ACTION"
): Promise<void> {
  await ensureDir(wikiDir());
  await appendTextWithLock(logFile(), `\n## [${level}] ${timestamp()}\n\n${entry}\n`);
}
