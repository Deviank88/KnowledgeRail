import assert from "node:assert/strict";
import { test } from "node:test";
import { compareHubQuality, type HubQualityCase } from "../benchmarks/graph-hub-quality-eval.js";

const budget = { maxNodes: 8, maxDepth: 2, beamWidth: 8, maxVisitedNodes: 8 };
const late: HubQualityCase = { id: "late", group: "stress", topology: "outgoing",
  distractors: 700, position: "late", penalizeDistractors: true };

test("production reaches late hub targets, request siblings and later seeds without an implicit edge cap", () => {
  // Leave room to visit two hops and emit the target, isolating edge-scan loss.
  const traversalBudget = { maxNodes: 24, maxDepth: 2, beamWidth: 8, maxVisitedNodes: 32 };
  for (const topology of ["outgoing", "incoming", "request", "starved_seed", "two_hop"] as const) {
    const row = compareHubQuality({ ...late, topology, distractors: 2_200 }, traversalBudget, 1);
    assert.equal(row.production.recall, 1, topology);
    assert.deepEqual(row.production.recovered, row.relevant, topology);
    assert.equal(row.production.stats.edgeBudgetExhausted, false, topology);
    assert.ok(row.production.stats.edgeWork > row.edgeBudget, topology);
    assert.equal(row.productionMatchesReference, true, topology);
    assert.deepEqual(row.lostInProduction, [], topology);
    assert.equal(row.bounded.recall, 0, `the rejected cap would hide the ${topology} target`);
  }
});

test("hub diagnostic attributes a missing late target to the edge cap with every other limit held equal", () => {
  const row = compareHubQuality(late, budget, 1);
  assert.equal(row.bounded.recall, 0);
  assert.equal(row.reference.recall, 1);
  assert.deepEqual(row.lostToEdgeBudget, row.relevant);
  assert.deepEqual(row.missedByBoth, []);
  assert.equal(row.bounded.stats.edgeBudgetExhausted, true);
  assert.equal(row.bounded.stats.edgeWork, 512);
  assert.ok(row.reference.stats.edgeWork > 512);
  assert.equal(row.exactEdgesPreserved, true);
});

test("hub diagnostic does not misattribute beam losses or disconnected targets to the edge cap", () => {
  for (const config of [{ ...late, penalizeDistractors: false }, { ...late, topology: "disconnected" as const }]) {
    const row = compareHubQuality(config, budget, 1);
    assert.equal(row.bounded.recall, 0);
    assert.equal(row.reference.recall, 0);
    assert.deepEqual(row.lostToEdgeBudget, []);
    assert.deepEqual(row.missedByBoth, row.relevant);
  }
});

test("hub diagnostic preserves early targets, direct seeds and ordinary small graphs", () => {
  for (const config of [{ ...late, position: "early" as const }, { ...late, seedTarget: true }, { ...late, distractors: 100 }]) {
    const row = compareHubQuality(config, budget, 1);
    assert.equal(row.bounded.recall, 1);
    assert.equal(row.reference.recall, 1);
    assert.deepEqual(row.lostToEdgeBudget, []);
  }
});
