/** Frozen-pair parity against the measured /rerank reference, using the production Ollama adapter. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { OllamaRerankProvider } from "../src/core/ollama-reranker.js";
import { RerankSession } from "../src/core/reranker.js";

const argument = (name: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const directory = argument("output", "benchmarks/results/ollama-reranker-292/native-ollama");
const baseUrl = argument("base-url", "http://127.0.0.1:11434");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname));
await fs.mkdir(directory); // Refuse to overwrite an earlier run.
const pairBytes = await fs.readFile("benchmarks/results/retrieval-extension-292/ollama-reranker-pairs.json");
const pairs = JSON.parse(pairBytes.toString()) as Record<string, { query: string; document: string }>;
const reference = JSON.parse(await fs.readFile("benchmarks/results/ollama-reranker-292/bge-reference/reranker-scores.json", "utf8")) as { scores: Record<string, number> };
const groups = new Map<string, Array<{ key: string; document: string }>>();
for (const [key, pair] of Object.entries(pairs)) { const docs = groups.get(pair.query) ?? []; docs.push({ key, document: pair.document }); groups.set(pair.query, docs); }
const provider = new OllamaRerankProvider({ baseUrl, model: argument("model", "knowledgerail-bge-reranker-v2-m3:q8_0") });
const scores: Record<string, number> = {}, rows: unknown[] = [];
let maximumDifference = 0, rankChanges = 0, completed = 0;
for (const [query, docs] of groups) {
  for (let offset = 0; offset < docs.length; offset += 64) {
    const batch = docs.slice(offset, offset + 64), session = new RerankSession(provider, provider.defaultBudgetMs), start = performance.now();
    try {
      const values = await session.score(query, batch.map((doc) => doc.document));
      assert.ok(values, JSON.stringify(session.diagnostics));
      batch.forEach((doc, i) => { scores[doc.key] = values[i]!; maximumDifference = Math.max(maximumDifference, Math.abs(values[i]! - reference.scores[doc.key]!)); });
      rows.push({ queryHash: createHash("sha256").update(query).digest("hex"), documents: batch.length, wallMs: performance.now() - start, diagnostics: session.diagnostics });
    } finally { session.close(); }
  }
  const order = (values: Record<string, number>) => [...docs].sort((a, b) => values[b.key]! - values[a.key]!).map((doc) => doc.key);
  if (JSON.stringify(order(scores)) !== JSON.stringify(order(reference.scores))) rankChanges++;
  if (++completed % 10 === 0) console.log(JSON.stringify({ completed, total: groups.size, maximumDifference, rankChanges }));
}
await fs.writeFile(`${directory}/reranker-scores.json`, JSON.stringify({ descriptor: provider.descriptor, scores }));
await fs.writeFile(`${directory}/parity.json`, JSON.stringify({ pairFileSha256: createHash("sha256").update(pairBytes).digest("hex"),
  queries: groups.size, pairs: Object.keys(scores).length, maximumDifference, rankChanges, rows }, null, 2));
console.log(JSON.stringify({ pairs: Object.keys(scores).length, maximumDifference, rankChanges }));
