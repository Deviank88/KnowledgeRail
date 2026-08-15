import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createConsultingFixture,
  evaluateScenario,
  QUALITY_SCENARIOS,
} from "../benchmarks/document-quality-eval.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

test("v3 context packs recover annotated functional and technical evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-quality-test-"));
  await createConsultingFixture(root);
  clearRetrievalIndexes();
  for (const scenario of QUALITY_SCENARIOS) {
    const result = await evaluateScenario(root, scenario);
    assert.equal(result.v3Recall, 1, `${scenario.name}: evidence recall`);
    assert.equal(result.v3Recall >= result.legacyRecall, true, `${scenario.name}: regression vs legacy`);
    assert.equal(result.v3Chars <= 6000, true, `${scenario.name}: output budget`);
    assert.equal(result.pages <= 8, true, `${scenario.name}: page budget`);
  }
});
