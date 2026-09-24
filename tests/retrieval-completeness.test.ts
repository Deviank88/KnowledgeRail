import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { ExactAnnEngine } from "../src/core/semantic/exact-engine.js";
import { PersistentSemanticIndex } from "../src/core/semantic/index.js";
import { createEvidenceClaim, claimValidAt } from "../src/core/ingestion/evidence-claim.js";
import { mutateEvidenceIrStore, readEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import { recomputeEvidenceClaimStatuses, resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { evidenceHistory } from "../src/core/ingestion/evidence-history.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";
import { setWikiRoot, getWikiRoot } from "../src/core/paths.js";
import type { McpServer } from "@modelcontextprotocol/server";

async function project(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-completeness-")), wikiRoot = path.join(root, "wiki");
  await fs.mkdir(wikiRoot);
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return wikiRoot;
}

test("the sixth complementary page remains retrievable after a five-page batch; changed evidence invalidates its cursor", async (t) => {
  const wikiRoot = await project(t);
  for (let i = 0; i < 6; i++) await fs.writeFile(path.join(wikiRoot, `part-${i}.md`), `---\ntitle: Retrieval component ${i}\ntype: concept\n---\n\nRetrieval component ${i} provides complementary evidence for a distinct requirement ${i}.`);
  const params = { wikiRoot, intent: "understand" as const, objective: "Retrieval component", includeAdditional: true, maxEvidence: 5, heuristicTokenBudget: 12000 };
  const first = await compileTaskContext(params);
  assert.equal(first.evidence.length, 5); assert.equal(first.retrieval.nextEvidenceOffset, 5);
  assert.equal(first.retrieval.remainingEvidenceCount, 1);
  const next = { ...params, evidenceOffset: first.retrieval.nextEvidenceOffset, evidenceRevision: first.retrieval.evidenceRevision };
  const second = await compileTaskContext(next);
  assert.equal(second.evidence.length, 1); assert.equal(second.retrieval.nextEvidenceOffset, undefined);
  assert.equal(new Set([...first.evidence, ...second.evidence].map((e) => e.path)).size, 6);
  await fs.appendFile(path.join(wikiRoot, "part-0.md"), "\nNewly recorded evidence.");
  await getWikiPageRecords(wikiRoot, true, { persist: false });
  await assert.rejects(compileTaskContext(next), /Evidence changed/);
});

test("candidate expansion reuses one query embedding and discloses resource truncation", async (t) => {
  const wikiRoot = await project(t); let queries = 0;
  for (let i = 0; i < 9; i++) await fs.writeFile(path.join(wikiRoot, `part-${i}.md`), `---\ntitle: Component ${i}\ntype: concept\n---\n\nUnique evidence ${i}.`);
  const engine = new ExactAnnEngine({ dimensions: 3 });
  const index = new PersistentSemanticIndex(wikiRoot, { descriptor: { id: "test", model: "complementary", version: "1", dimensions: 3 },
    async embedDocuments(texts) { return texts.map(() => [1, 0, 0]); }, async embedQuery() { queries++; return [1, 0, 0]; } }, engine);
  t.after(() => index.dispose());
  await index.synchronize(await getWikiPageRecords(wikiRoot, true, { persist: false }));
  const expanded = await index.searchWithDiagnostics("complementary", 5, { expandCandidates: true });
  assert.equal(expanded.hits.length, 9); assert.equal(queries, 1);
  assert.equal(expanded.diagnostics.searchPasses, 2); assert.equal(expanded.diagnostics.approximate, false);
  const limited = await index.searchWithDiagnostics("complementary", 5, { expandCandidates: true, maximumCandidates: 6 });
  assert.equal(limited.hits.length, 6); assert.equal(limited.diagnostics.candidateLimitReached, true);
});

test("superseded knowledge returns only through a new sourced interval, preserving the inactive period and reasons", async (t) => {
  const wikiRoot = await project(t);
  const claim = (text: string, source: string, month: string) => createEvidenceClaim({ sourceUri: `docs/normalized/${source}.md`, segmentId: `seg-${"a".repeat(24)}`, now: `2026-${month}-01T00:00:00.000Z`,
    input: { text, kind: "decision", origin: "explicit", confidence: 1, validFrom: `2026-${month}-01T00:00:00.000Z`, target: { pagePath: "Policy.md", pageType: "decision", pageTitle: "Retrieval policy" } } });
  const a = claim("Retrieval uses policy A.", "original", "01"), b = claim("Retrieval uses policy B because requirements changed.", "replacement", "03"), c = claim(a.text, "reinstatement", "06");
  b.relations = [{ type: "supersedes", targetClaimId: a.id }];
  c.relations = [{ type: "reinstates", targetClaimId: a.id }, { type: "supersedes", targetClaimId: b.id }];
  await mutateEvidenceIrStore(wikiRoot, (store) => { store.claims.push(a, b, c); });
  await resolveEvidenceClaims({ wikiRoot });
  const store = await readEvidenceIrStore(wikiRoot);
  for (const [date, expected] of [["02", a.id], ["04", b.id], ["07", c.id]]) {
    assert.deepEqual(store.claims.filter((claim) => claimValidAt(claim, `2026-${date}-01T00:00:00Z`)).map((claim) => claim.id), [expected]);
  }
  const history = evidenceHistory(store, ["Policy.md"], "2026-07-01T00:00:00Z");
  assert.deepEqual(history.claims.map((claim) => claim.validity), ["expired", "expired", "valid"]);
  assert.equal(history.claims[0]!.supersededBy[0]!.sourceUri, b.sourceUri);
  assert.equal(history.claims[0]!.supersededBy[0]!.reason, b.text);
  assert.ok(history.claims[2]!.relations.some((r) => r.type === "reinstates" && r.targetClaimId === a.id));
  await fs.writeFile(path.join(wikiRoot, "Policy.md"), "---\ntitle: Retrieval policy\ntype: decision\n---\n\nRetrieval uses policy A again, with a recorded reason.");
  await getWikiPageRecords(wikiRoot, true, { persist: false });
  const context = await compileTaskContext({ wikiRoot, intent: "understand", objective: "Retrieval policy", includeHistory: true, heuristicTokenBudget: 4000 });
  assert.equal(context.history!.totalClaims, 3); assert.ok(context.budget.withinHeuristicBudget);
  assert.equal(context.history!.claims.at(-1)!.id, c.id);
  assert.throws(() => recomputeEvidenceClaimStatuses({ ...store, resolutions: [], claims: [{ ...a, validUntil: undefined }, c] }, c.createdAt), /Reinstatement/);
});

test("unknown effective dates and unresolved conflicts are exposed rather than inferred from similarity", async (t) => {
  const wikiRoot = await project(t);
  const c = createEvidenceClaim({ sourceUri: "docs/normalized/undated.md", segmentId: `seg-${"b".repeat(24)}`, now: "2026-01-01T00:00:00Z", input: { text: "An unresolved policy.", kind: "decision", origin: "explicit", confidence: 1, target: { pagePath: "Policy.md" } } });
  c.status = "contradicted";
  const store = await readEvidenceIrStore(wikiRoot); store.claims.push(c);
  const history = evidenceHistory(store, ["Policy.md"], "2026-07-01T00:00:00Z");
  assert.equal(history.claims[0]!.validity, "unresolved"); assert.ok(history.warnings.some((w) => w.includes("valid_from is absent")));
});

test("public context cursors recover all history within bounded responses and reject edited history", async (t) => {
  const wikiRoot = await project(t), previous = getWikiRoot(); setWikiRoot(path.dirname(wikiRoot)); t.after(() => setWikiRoot(previous));
  await fs.writeFile(path.join(wikiRoot, "Policy.md"), "---\ntitle: Retrieval policy\ntype: decision\n---\nRetrieval policy records all complementary constraints.");
  const claims = Array.from({ length: 25 }, (_, i) => createEvidenceClaim({ sourceUri: `docs/normalized/source${i}.md`, segmentId: `seg-${"c".repeat(24)}`, now: "2026-01-01T00:00:00Z",
    input: { text: `Retrieval policy constraint ${i}.`, kind: "constraint", origin: "explicit", confidence: 1, validFrom: "2026-01-01T00:00:00Z", target: { pagePath: "Policy.md" } } }));
  await mutateEvidenceIrStore(wikiRoot, (store) => { store.claims.push(...claims); });
  let handler!: (args: Record<string, unknown>, context: Record<string, never>) => Promise<any>;
  registerAgentTools({ registerTool(name: string, _config: unknown, callback: typeof handler) { if (name === "knowledge_context") handler = callback; } } as unknown as McpServer, "modern");
  let args: Record<string, unknown> = { mode: "task", intent: "understand", objective: "Retrieval policy", history_cursor: "start", evidence_cursor: "start", heuristic_token_budget: 4000, max_evidence: 5, retrieval_profile: "balanced", response_detail: "compact" };
  const ids = new Set<string>(); let cursor: string | undefined;
  for (let i = 0; i < 25; i++) {
    const result = await handler(args, {}); assert.equal(result.isError, undefined);
    const history = result.structuredContent.history;
    assert.ok(history.claims.length > 0); assert.equal(history.totalClaims, 25);
    for (const claim of history.claims) { assert.ok(!ids.has(claim.id)); ids.add(claim.id); }
    const next = result.structuredContent.nextAction?.suggestedArguments;
    if (!history.nextOffset) break;
    cursor = next.history_cursor; args = next;
  }
  assert.equal(ids.size, 25); assert.ok(cursor);
  await mutateEvidenceIrStore(wikiRoot, (store) => { store.claims[0]!.status = "contradicted"; });
  const stale = await handler({ ...args, history_cursor: cursor }, {}); assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /history changed/);
});
