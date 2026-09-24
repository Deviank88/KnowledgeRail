/** Live reranker budget probe over frozen pools; never changes retrieval defaults. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { HttpRerankProvider, RerankSession } from "../src/core/reranker.js";
import { OllamaRerankProvider } from "../src/core/ollama-reranker.js";

const argument = (name: string, fallback?: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const endpoint = argument("endpoint"), model = argument("model"), version = argument("version"), output = argument("output");
assert.ok(endpoint && model && version && output, "Required: --endpoint= --model= --version= --output=");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname), "Local benchmark endpoints only.");
const directory = argument("pairs", "benchmarks/results/retrieval-extension-292/ollama-reranker-pairs.json")!;
const count = Number(argument("queries", "20"));
const budgets = argument("budgets", "500,30000")!.split(",").map(Number);
assert.ok(budgets.length && budgets.every((value) => Number.isInteger(value) && value >= 0 && value <= 30000));
assert.ok(Number.isInteger(count) && count >= 1 && count <= 20);
const outputFile = await fs.open(output, "wx");
const provider = argument("provider") === "ollama" ? new OllamaRerankProvider({ baseUrl: endpoint, model }) : new HttpRerankProvider({ endpoint, model, version });
const groups = new Map<string, Set<string>>();
const pairBytes = await fs.readFile(directory);
for (const pair of Object.values(JSON.parse(pairBytes.toString("utf8"))) as Array<{ query: string; document: string }>) {
  const documents = groups.get(pair.query) ?? new Set(); documents.add(pair.document); groups.set(pair.query, documents);
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const selected = [...groups].filter(([, docs]) => docs.size >= 32).sort((a, b) => sha(a[0]).localeCompare(sha(b[0]))).slice(0, count);
const rows = [];
try {
  for (const [query, all] of selected) for (const pool of [32, 64]) for (const budget of budgets) {
    const documents = [...all].slice(0, pool), session = new RerankSession(provider, budget), start = performance.now();
    try {
      const scores = await session.score(query, documents);
      rows.push({ queryHash: sha(query), pool, documents: documents.length, budget, wallMs: performance.now() - start,
        applied: scores !== null, diagnostics: { ...session.diagnostics } });
    } finally { session.close(); }
    if (rows.length % 8 === 0) console.log(JSON.stringify({ completed: rows.length, planned: selected.length * 2 * budgets.length }));
  }
  await outputFile.writeFile(JSON.stringify({ provider: provider.descriptor, pairFileSha256: sha(pairBytes), rows,
    limitations: ["Loaded local HTTP model; excludes embedding and coverage.", "Fixed existing pools; measurements do not choose a new retrieval cap.", "A request after cancellation may include outstanding server work; this is part of the observed provider behavior."] }, null, 2));
  console.log(JSON.stringify({ calls: rows.length, appliedWithin500ms: rows.filter((row) => row.budget === 500 && row.applied).length,
    completedWithin30s: rows.filter((row) => row.budget === 30000 && row.applied).length,
    completedWithoutDeadline: rows.filter((row) => row.budget === 0 && row.applied).length }));
} finally { await outputFile.close(); }
