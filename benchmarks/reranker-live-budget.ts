import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { HttpRerankProvider, RerankSession } from "../src/core/reranker.js";
const directory = "benchmarks/results/retrieval-extension-292";
const port = JSON.parse(await fs.readFile("/private/tmp/kr292-reranker-port.json", "utf8"));
const endpoint = `http://127.0.0.1:${port.port}`;
const provider = new HttpRerankProvider({ endpoint: `${endpoint}/rerank`, model: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", version: "1427fd652930e4ba29e8149678df786c240d8825" });
const groups = new Map<string, Set<string>>();
for (const pair of Object.values(JSON.parse(await fs.readFile(`${directory}/ollama-reranker-pairs.json`, "utf8"))) as Array<{ query: string; document: string }>) {
  const docs = groups.get(pair.query) ?? new Set(); docs.add(pair.document); groups.set(pair.query, docs);
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const selected = [...groups].filter(([, docs]) => docs.size >= 32).sort((a, b) => sha(a[0]).localeCompare(sha(b[0]))).slice(0, 20);
const rows = [];
try {
  for (const [query, all] of selected) for (const pool of [32, 64]) for (const budget of [500, 30000]) {
    await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(30000) });
    const documents = [...all].slice(0, pool), session = new RerankSession(provider, budget), started = performance.now();
    try {
      const scores = await session.score(query, documents);
      rows.push({ queryHash: sha(query), pool, documents: documents.length, characters: documents.reduce((n, d) => n + d.length, 0), budget, wallMs: performance.now() - started,
        applied: scores !== null, diagnostics: { ...session.diagnostics } });
    } finally { session.close(); }
  }
  await fs.writeFile(`${directory}/reranker-live-budget.json`, JSON.stringify({ provider: provider.descriptor, modelLoadMs: port.loadMs, calls: rows.length,
    limitations: ["Local CPU HTTP inference on recorded query/document pools; full request embedding and coverage are measured separately.", "Serial requests; loaded model; source texts are benchmark fixtures."], rows }, null, 2));
  console.log(JSON.stringify({ calls: rows.length, appliedWithin500ms: rows.filter((r) => r.budget === 500 && r.applied).length }));
} finally { await fetch(`${endpoint}/shutdown`, { method: "POST" }); }
