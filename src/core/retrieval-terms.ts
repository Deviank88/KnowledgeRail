import type { WikiPageRecord } from "./page-record.js";
import type { IndexedTermTuple } from "./retrieval-checkpoint.js";
import { normalizeSearchText } from "./text-analysis.js";

function countTerms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const normalized = normalizeSearchText(text);
  for (const token of normalized.match(/\/?[\p{L}\p{N}][\p{L}\p{N}_./:#-]*/gu) ?? []) {
    result.set(token, (result.get(token) ?? 0) + 1);
    for (const part of token.split(/[_./:#-]+/).filter((value) => value.length >= 2)) {
      if (part !== token) result.set(part, (result.get(part) ?? 0) + 1);
    }
  }
  return result;
}

export function indexedTermsForRecord(record: WikiPageRecord): IndexedTermTuple[] {
  const title = countTerms(`${record.title} ${record.aliases.join(" ")}`);
  const metadata = countTerms([
    record.type,
    record.tags.join(" "),
    record.sources.join(" "),
    record.requestId ?? "",
    record.client ?? "",
    record.project ?? "",
    record.path,
    record.passages.map((passage) => passage.heading).join(" "),
  ].join(" "));
  const body = countTerms(record.body);
  return [...new Set([...title.keys(), ...metadata.keys(), ...body.keys()])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((term) => [term, body.get(term) ?? 0, title.get(term) ?? 0, metadata.get(term) ?? 0]);
}
