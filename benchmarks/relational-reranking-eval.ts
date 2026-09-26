import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphEdgeKind } from "../src/core/graph-index.js";
import { configuredReranker, type RerankProvider } from "../src/core/reranker.js";
import { mean, ndcgAtK, reciprocalRank } from "./retrieval-metrics.js";

interface Fixture {
  version: number; description: string;
  pages: Array<{ path: string; title: string; type: string; body: string }>;
  edges: Array<{ fromPath: string; toPath: string; kind: GraphEdgeKind }>;
  queries: Array<{ id: string; split: string; language: string; query: string; seedPath: string; relevantPaths: string[] }>;
}
const fixtureFile = fileURLToPath(new URL("./fixtures/relational-reranking-294.json", import.meta.url));
interface Variant {
  mode: "plain" | "with_path"; wallMs: number; ranked: Array<{ path: string; score: number }>;
  reciprocalRank: number | null; ndcgAt3: number | null;
}
interface Row { id: string; split: string; validated?: boolean; answerable?: boolean; variants?: Variant[] }

export function verifiedPaths(fixture: Fixture, seed: string): Map<string, string> {
  const labels = new Map(fixture.pages.map((page) => [page.path, page.title]));
  assert.ok(labels.has(seed));
  const paths = new Map([[seed, labels.get(seed)!]]);
  let frontier = [seed];
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const current of frontier) for (const edge of fixture.edges) {
      assert.ok(labels.has(edge.fromPath) && labels.has(edge.toPath), "edge endpoint must exist");
      const target = edge.fromPath === current ? edge.toPath : edge.toPath === current ? edge.fromPath : undefined;
      if (!target || paths.has(target)) continue;
      paths.set(target, `${paths.get(current)} ${edge.fromPath === current ? `--${edge.kind}-->` : `<--${edge.kind}--`} ${labels.get(target)}`);
      next.push(target);
    }
    frontier = next;
  }
  paths.delete(seed);
  return paths;
}

export async function evaluateRelationalReranking(provider: RerankProvider | null, validateOnly = false) {
  const bytes = await fs.readFile(fixtureFile);
  const fixture = JSON.parse(bytes.toString("utf8")) as Fixture;
  assert.equal(fixture.version, 1);
  assert.equal(new Set(fixture.queries.map((q) => q.id)).size, fixture.queries.length);
  const owners = new Map<string, string>();
  const rows: Row[] = [];
  for (const query of fixture.queries) {
    const paths = verifiedPaths(fixture, query.seedPath);
    for (const member of [query.seedPath, ...paths.keys()]) {
      assert.ok(!owners.has(member) || owners.get(member) === query.split, "development and evaluation components must be disjoint");
      owners.set(member, query.split);
    }
    for (const relevant of query.relevantPaths) assert.ok(paths.has(relevant), `${query.id}: relevant evidence must have a verified path`);
    const candidates = fixture.pages.filter((page) => page.path !== query.seedPath);
    if (validateOnly) { rows.push({ id: query.id, split: query.split, validated: true }); continue; }
    assert.ok(provider, "Configure the existing reranker, or use --validate-only.");
    const variants: Variant[] = [];
    for (const mode of ["plain", "with_path"] as const) {
      const documents = candidates.map((page) => {
        const prefix = mode === "with_path" && paths.has(page.path) ? `Verified graph path: ${paths.get(page.path)}\n` : "";
        return `${prefix}${page.title}\n${page.type}\n${page.body}`.slice(0, 2048);
      });
      const started = performance.now();
      const scores: readonly number[] = await provider.rerank(query.query, documents, AbortSignal.timeout(30_000));
      assert.equal(scores.length, candidates.length);
      assert.ok(scores.every(Number.isFinite));
      const ranked = candidates.map((page, i) => ({ path: page.path, score: scores[i]! })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const relevant = query.relevantPaths.map((value) => ({ path: value }));
      variants.push({ mode, wallMs: performance.now() - started, ranked,
        reciprocalRank: relevant.length ? reciprocalRank(ranked, relevant) : null,
        ndcgAt3: relevant.length ? ndcgAtK(ranked, relevant, 3) : null });
    }
    rows.push({ id: query.id, split: query.split, answerable: query.relevantPaths.length > 0, variants });
  }
  const summaries = ["development", "evaluation"].map((split) => ({ split,
    variants: ["plain", "with_path"].map((mode) => {
      const scored = rows.filter((row) => row.split === split && row.answerable).flatMap((row) => row.variants!.filter((v) => v.mode === mode));
      return { mode, queries: scored.length, mrr: mean(scored.map((v) => v.reciprocalRank!)), ndcgAt3: mean(scored.map((v) => v.ndcgAt3!)) };
    }) }));
  return { generatedAt: new Date().toISOString(), fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    fixture: path.basename(fixtureFile), description: fixture.description, provider: provider?.descriptor, validateOnly,
    limitation: "Frozen synthetic reranking experiment only. Negative questions have no answer and receive no recall score; model relevance is not answerability. Runtime retrieval is unchanged.", summaries, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const validateOnly = process.argv.includes("--validate-only");
  const report = await evaluateRelationalReranking(validateOnly ? null : configuredReranker(), validateOnly);
  const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
  if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(output ? { output, summaries: report.summaries } : report, null, 2));
}
