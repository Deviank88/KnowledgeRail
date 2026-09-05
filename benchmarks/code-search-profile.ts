import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { codeQueryFixture } from "./code-query-fixture.js";
import { codeResourceUri, scoreFragment } from "../src/core/code-evidence/index.js";
import { codePathAllowed, normalizedCodeText } from "../src/core/code-evidence/query-runtime.js";
import { tokenizeSearchText } from "../src/core/text-analysis.js";
const results = [];
for (const count of [1000, 10000]) {
  const snapshot = codeQueryFixture(count);
  for (const query of ["handleOrder5", "andleOrd", "unfindableNeedle", "order", "handleOrder5 bounded retry"]) {
    const timings = { filterMs: 0, scoringMs: 0, fullSortingMs: 0, copiesMs: 0 };
    const terms = tokenizeSearchText(query), normalized = normalizedCodeText(query).trim();
    for (let i = 0; i < 100; i++) {
      let started = performance.now();
      const filtered = snapshot.fragments.filter((fragment) => codePathAllowed(fragment.path, ["src"]));
      timings.filterMs += performance.now() - started;
      started = performance.now();
      const hits = filtered.map((fragment) => ({ fragment, ...scoreFragment(fragment, normalized, terms) })).filter((hit) => hit.score > 0);
      timings.scoringMs += performance.now() - started;
      started = performance.now();
      const selected = hits.sort((a, b) => b.score - a.score || a.fragment.path.localeCompare(b.fragment.path) || a.fragment.range.startLine - b.fragment.range.startLine).slice(0, 12);
      timings.fullSortingMs += performance.now() - started;
      started = performance.now();
      selected.map((hit) => ({ ...hit, fragment: structuredClone(hit.fragment), resourceUri: codeResourceUri(hit.fragment) }));
      timings.copiesMs += performance.now() - started;
    }
    results.push({ fragments: count, query, samples: 100, mean: Object.fromEntries(Object.entries(timings).map(([key, sum]) => [key, sum / 100])) });
  }
}
await fs.writeFile("benchmarks/results/274-code-profile.json", JSON.stringify({ node: process.version, results }, null, 2) + "\n");
