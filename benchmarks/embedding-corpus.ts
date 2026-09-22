import * as fs from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { parseWikiPageRecord } from "../src/core/page-record.js";

/** Actual local documentation, then source excerpts: never synthetic padding or repeated passages. */
export async function embeddingCorpus(wiki: string, count: number): Promise<string[]> {
  const records = await getWikiPageRecords(wiki, false, { persist: false });
  for (const file of (await fg(["*.md", "docs/**/*.md"], { onlyFiles: true })).sort()) {
    const raw = await fs.readFile(file, "utf8");
    records.push(parseWikiPageRecord(file, raw, { mtimeMs: 0, size: Buffer.byteLength(raw) }));
  }
  const texts = new Set(records.sort((a, b) => a.path.localeCompare(b.path)).flatMap((r) => r.passages.map((p) => `${p.heading}\n${p.text}`)));
  for (const file of (await fg("src/**/*.ts", { onlyFiles: true })).sort()) {
    if (texts.size >= count) break;
    const lines = (await fs.readFile(path.resolve(file), "utf8")).split("\n");
    for (let i = 0; i < lines.length && texts.size < count; i += 40) {
      const body = lines.slice(i, i + 40).join("\n").trim();
      if (body) texts.add(`${file}:${i + 1}\n${body}`);
    }
  }
  if (texts.size < count) throw new Error(`Expected ${count} distinct real passages, found ${texts.size}.`);
  return [...texts].slice(0, count);
}
