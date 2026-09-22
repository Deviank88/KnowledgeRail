import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEvidenceClaim, claimValidAt } from "../src/core/ingestion/evidence-claim.js";
import { readEvidenceIrStore, mutateEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import { recomputeEvidenceClaimStatuses } from "../src/core/ingestion/evidence-linker.js";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { consolidateKnowledge } from "../src/core/consolidation.js";
import { stableContextPayload, compactStructuredContext } from "../src/tools/context-tools.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { detectCodeDrift } from "../src/core/drift-detection.js";

async function project(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-memory-"));
  const wikiRoot = path.join(root, "wiki"); await fs.mkdir(wikiRoot);
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot };
}
function claim(text: string, source = "one", from = "2026-01-01T00:00:00.000Z") {
  return createEvidenceClaim({ sourceUri: `docs/normalized/${source}.md`, segmentId: `seg-${"a".repeat(24)}`, now: from,
    input: { text, kind: "decision", origin: "explicit", confidence: 1, validFrom: from,
      target: { pagePath: "decisions/Policy.md", pageTitle: "Credit policy", pageType: "decision" } } });
}

test("supersession closes validity and historical context uses the appropriate claim, never current prose", async (t) => {
  const p = await project(t), old = claim("Credit limit is five."), replacement = claim("Credit limit is ten.", "two", "2026-03-01T00:00:00.000Z");
  await mutateEvidenceIrStore(p.wikiRoot, (store) => {
    store.claims.push(old, replacement);
    store.resolutions.push({ claimId: replacement.id, disposition: "supersedes", targetClaimIds: [old.id], candidatePagePaths: [], targetPagePath: "decisions/Policy.md", reason: "fixture", resolvedAt: replacement.createdAt });
    recomputeEvidenceClaimStatuses(store, replacement.createdAt);
  });
  const stored = await readEvidenceIrStore(p.wikiRoot);
  assert.equal(stored.claims[0]!.validUntil, replacement.validFrom);
  assert.equal(claimValidAt(stored.claims[0]!, replacement.validFrom!), false);
  const context = await compileTaskContext({ wikiRoot: p.wikiRoot, intent: "understand", objective: "Credit limit", asOf: "2026-02-01T00:00:00.000Z", heuristicTokenBudget: 4000 });
  assert.deepEqual(context.temporal!.claims.map((c) => c.id), [old.id]);
  assert.equal(JSON.stringify(context).includes(replacement.text), false);
  assert.equal(context.repositoryMap, undefined);
  assert.ok(context.budget.withinHeuristicBudget);
  assert.deepEqual(compactStructuredContext(context).temporal, context.temporal);
  const current = await compileTaskContext({ wikiRoot: p.wikiRoot, intent: "understand", objective: "Credit limit", asOf: "2026-04-01T00:00:00.000Z", heuristicTokenBudget: 4000 });
  assert.deepEqual(current.temporal!.claims.map((c) => c.id), [replacement.id]);
  assert.deepEqual(stableContextPayload(context), context, "serialization ordering must preserve the payload's values");
  assert.ok(JSON.stringify(stableContextPayload(context)).indexOf('"decisions"') < JSON.stringify(stableContextPayload(context)).indexOf('"task"'));
  await assert.rejects(compileTaskContext({ wikiRoot: p.wikiRoot, intent: "understand", objective: "Credit", asOf: "invalid" }), /UTC ISO/);
});

test("consolidation is reproducible, preview is read-only and aliases retain all source provenance", async (t) => {
  const p = await project(t), a = claim("Credit limit is five."), b = claim("Credit limit is five.", "two");
  await mutateEvidenceIrStore(p.wikiRoot, (store) => { store.claims.push(a, b); });
  const before = await readEvidenceIrStore(p.wikiRoot);
  const options = { now: Date.parse("2026-09-01T00:00:00Z") };
  const preview = await consolidateKnowledge(p.wikiRoot, options);
  assert.deepEqual(await consolidateKnowledge(p.wikiRoot, options), preview);
  assert.deepEqual(await readEvidenceIrStore(p.wikiRoot), before);
  assert.equal(preview.duplicates.length, 1); assert.equal(preview.canonicalClaimsAfter, 1);
  assert.equal(preview.usage.observedSince, null);
  const applied = await consolidateKnowledge(p.wikiRoot, { ...options, apply: true, proposals: ["Review the common credit concept."] });
  const after = await readEvidenceIrStore(p.wikiRoot);
  assert.equal(after.claims.length, 2); assert.equal(applied.deletions, 0); assert.equal(applied.synthesisApplied, false);
  assert.deepEqual(after.claims.map((c) => c.sourceUri).sort(), before.claims.map((c) => c.sourceUri).sort());
  assert.equal(after.resolutions.filter((r) => r.disposition === "duplicate").length, 1);
  assert.match(applied.review, /explicit review/);
});

test("test evidence must target tests; drift checks changes and disappearance independently of implementation anchors", async (t) => {
  const p = await project(t);
  await fs.mkdir(path.join(p.root, "tests"));
  await fs.writeFile(path.join(p.root, "tests/credit.test.ts"), "export function verifiesCredit() { return 5; }\n");
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: p.root, wikiRoot: p.wikiRoot }); await index.rebuild();
  const target = (await index.symbol("verifiesCredit"))[0]!;
  assert.ok(target);
  const sourceUri = "docs/normalized/credit.md", sourceContent = "Credit limit is tested.";
  const plan = await sourceCompilePlan({ wikiRoot: p.wikiRoot, sourceUri, content: sourceContent });
  const recorded = await recordEvidenceClaims({ wikiRoot: p.wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id,
    claims: [{ text: sourceContent, kind: "behavior", origin: "explicit", confidence: 1, verifiedBy: [target.resourceUri] }] });
  assert.equal(recorded.claims[0]!.testEvidence!.length, 1);
  assert.equal((await detectCodeDrift({ repositoryRoot: p.root, wikiRoot: p.wikiRoot })).entries[0]!.verdict, "fresh");
  await fs.writeFile(path.join(p.root, "tests/credit.test.ts"), "export function verifiesCredit() { return 6; }\n");
  assert.equal((await detectCodeDrift({ repositoryRoot: p.root, wikiRoot: p.wikiRoot })).entries[0]!.verdict, "drift_suspected");
  await fs.unlink(path.join(p.root, "tests/credit.test.ts"));
  assert.equal((await detectCodeDrift({ repositoryRoot: p.root, wikiRoot: p.wikiRoot })).entries[0]!.reason, "file_missing");
});
