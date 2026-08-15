import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mean,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "../benchmarks/retrieval-metrics.js";

test("retrieval metrics compute ranked quality deterministically", () => {
  const results = [
    { path: "B.md" },
    { path: "A.md" },
    { path: "X.md" },
    { path: "C.md" },
  ];
  const relevant = [
    { path: "A.md", grade: 3 },
    { path: "B.md", grade: 2 },
    { path: "C.md", grade: 1 },
  ];

  assert.equal(recallAtK(results, relevant, 2), 2 / 3);
  assert.equal(precisionAtK(results, relevant, 2), 1);
  assert.equal(reciprocalRank(results, relevant), 1);
  assert.ok(ndcgAtK(results, relevant, 4) > 0.7);
  assert.equal(mean([1, 2, 3]), 2);
});

test("retrieval metrics handle empty relevance safely", () => {
  assert.equal(recallAtK([], [], 5), 1);
  assert.equal(precisionAtK([], [], 5), 0);
  assert.equal(reciprocalRank([], []), 0);
  assert.equal(ndcgAtK([], [], 5), 0);
  assert.equal(mean([]), 0);
});
