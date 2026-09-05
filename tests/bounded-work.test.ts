import assert from "node:assert/strict";
import { test } from "node:test";
import { mapConcurrent } from "../src/core/concurrent-map.js";
import { TopResults } from "../src/core/top-results.js";

test("bounded selection preserves full-sort results including stable ties", () => {
  let seed = 47;
  const values = Array.from({ length: 10000 }, (_, id) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return { id, score: seed % 23 }; });
  const compare = (a: typeof values[number], b: typeof values[number]) => b.score - a.score;
  for (const limit of [0, 1, 2, 12, 100, 10001]) {
    const best = new TopResults(limit, compare);
    for (const value of values) best.add(value);
    assert.deepEqual(best.sorted(), [...values].sort(compare).slice(0, limit));
  }
});

test("bounded workers preserve input order and drain pending work on error", async () => {
  let active = 0, peak = 0;
  const values = Array.from({ length: 100 }, (_, i) => i);
  const result = await mapConcurrent(values, 8, async (i) => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--; return i * 2;
  });
  assert.deepEqual(result, values.map((i) => i * 2));
  assert.equal(peak, 8);
  const failure = new Error("stat denied");
  let started = 0, completed = 0;
  await assert.rejects(mapConcurrent(values, 4, async (i) => {
    started++;
    if (i === 0) throw failure;
    await new Promise<void>((resolve) => setImmediate(resolve));
    completed++;
  }), (error) => error === failure);
  assert.equal(started, 4);
  assert.equal(completed, 3);
});
