import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { readEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";

test("new and updated code claims propose readable direct neighbors without automatically recording them", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-related-claims-")), wikiRoot = join(root, "wiki");
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, body] of Object.entries({
    "rule.ts": 'import { limit } from "./policy";\nexport function applyCredit() { return limit(); }',
    "policy.ts": "export function limit() { return 5; }", "caller.ts": 'import "./rule";\nexport function submit() { return applyCredit(); }',
    "decoy.ts": "export const name = 'applyCredit';", "external.ts": 'import "@remote/rule";',
  })) await fs.writeFile(join(root, name), body);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot }); await index.rebuild();
  const target = (await index.symbol("applyCredit"))[0]!;
  const sourceUri = "docs/normalized/credit.md", sourceContent = "Gli storni commerciali usano un limite verificato.";
  const plan = await sourceCompilePlan({ wikiRoot, sourceUri, content: sourceContent });
  const params = { wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id,
    claims: [{ text: sourceContent, kind: "behavior" as const, origin: "explicit" as const, confidence: 1,
      target: { pagePath: "implementations/Storni.md", pageTitle: "Storni", pageType: "implementation" as const, codeResourceUri: target.resourceUri } }] };
  const created = await recordEvidenceClaims(params);
  assert.equal(created.created, 1);
  assert.ok(created.relatedEvidence?.candidates.some((c) => c.direction === "incoming" && c.relation === "call"));
  assert.ok(created.relatedEvidence?.candidates.some((c) => c.direction === "outgoing" && c.relation === "import"));
  for (const candidate of created.relatedEvidence!.candidates) {
    const read = await readCodeResource({ repositoryRoot: root, wikiRoot, resourceUri: candidate.resourceUri });
    assert.ok(["policy.ts", "caller.ts"].includes(read.path));
    assert.equal(candidate.claimId, created.claims[0]!.id);
  }
  const before = await readEvidenceIrStore(wikiRoot);
  assert.equal(before.claims.length, 1); assert.deepEqual(before.claims[0]!.relations, []);
  const updated = await recordEvidenceClaims(params);
  assert.equal(updated.reused, 1); assert.deepEqual(updated.relatedEvidence, created.relatedEvidence);
  assert.equal((await readEvidenceIrStore(wikiRoot)).claims.length, 1);
  const plain = await recordEvidenceClaims({ ...params, claims: [{ text: "Regola solo documentale.", kind: "behavior", origin: "explicit", confidence: 1 }] });
  assert.equal(plain.relatedEvidence, undefined);
});

test("related candidates are bounded, exclude ambiguous outgoing calls and survive unavailable index metadata", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-related-bounds-")), wikiRoot = join(root, "wiki");
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(join(root, "rule.ts"), "export function credit() { return ambiguous(); }");
  for (let i = 0; i < 12; i++) await fs.writeFile(join(root, `caller${i}.ts`), `export function c${i}() { return credit(); }`);
  for (const file of ["first.ts", "second.ts"]) await fs.writeFile(join(root, file), "export function ambiguous() { return 1; }");
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot }); await index.rebuild();
  const target = (await index.symbol("credit"))[0]!;
  const proposal = await index.relatedEvidence(target.fragment.id);
  assert.equal(proposal.candidates.length, 8); assert.equal(proposal.truncated, true);
  assert.ok(proposal.candidates.every((candidate) => candidate.direction === "incoming"));
  const sourceUri = "docs/normalized/rule.md", sourceContent = "Credit rule";
  const plan = await sourceCompilePlan({ wikiRoot, sourceUri, content: sourceContent });
  t.mock.method(PersistentCodeEvidenceIndex.prototype, "relatedEvidenceBatch", async () => { throw new Error("unavailable"); });
  const recorded = await recordEvidenceClaims({ wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id,
    claims: [{ text: sourceContent, kind: "behavior", origin: "explicit", confidence: 1, target: { codeResourceUri: target.resourceUri } }] });
  assert.equal(recorded.created, 1); assert.equal(recorded.relatedEvidence?.warnings.length, 1);
  assert.equal((await readEvidenceIrStore(wikiRoot)).claims.length, 1);
});

test("eight claims share one manifest refresh and retain single-query proposals and partial failures", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-related-batch-")), wikiRoot = join(root, "wiki");
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(join(root, "rule.ts"), "export function credit() { return limit(); }");
  await fs.writeFile(join(root, "limit.ts"), "export function limit() { return 5; }");
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot }); await index.rebuild();
  const target = (await index.symbol("credit"))[0]!;
  const single = await index.relatedEvidence(target.fragment.id);
  const mixed = await index.relatedEvidenceBatch([target.fragment.id, "missing"]);
  assert.deepEqual(mixed.get(target.fragment.id), { status: "fulfilled", value: single });
  assert.equal(mixed.get("missing")?.status, "rejected");
  await assert.rejects(index.relatedEvidence("missing"), /Unknown/);
  const sourceUri = "docs/normalized/rule.md", sourceContent = "Credit rule";
  const plan = await sourceCompilePlan({ wikiRoot, sourceUri, content: sourceContent });
  const refresh = CodeQueryRuntime.prototype.refreshProjectStructure;
  const spy = t.mock.method(CodeQueryRuntime.prototype, "refreshProjectStructure", refresh);
  const recorded = await recordEvidenceClaims({ wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id,
    claims: Array.from({ length: 8 }, (_, i) => ({ text: `Rule ${i}`, kind: "behavior", origin: "explicit", confidence: 1,
      target: { codeResourceUri: target.resourceUri } })) });
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(recorded.created, 8);
  assert.equal(recorded.relatedEvidence?.candidates.length, 8);
  assert.equal(recorded.relatedEvidence?.warnings.length, 0);
  assert.equal(new Set(recorded.relatedEvidence?.candidates.map((c) => c.claimId)).size, 8);
  assert.ok(recorded.relatedEvidence?.candidates.every((c) => c.resourceUri === single.candidates[0]!.resourceUri));
});
