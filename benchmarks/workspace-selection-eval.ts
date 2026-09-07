import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listWikiPagePaths } from "../src/core/page-record.js";
import { mapConcurrent } from "../src/core/concurrent-map.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { selectLexicalEvidence } from "../src/core/retrieval-selection.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

const argument = (name: string, fallback: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceWiki = path.resolve(argument("wiki", path.join(repositoryRoot, "wiki")));
const fixtureBytes = await fs.readFile(new URL("fixtures/workspace-specific-pages.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  version: number; provenance: string;
  cases: Array<{ id: string; query: string; expected: string; supportingText: string }>;
};
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const root = await fs.mkdtemp(path.join(tmpdir(), "kr-workspace-selection-"));
let clearBaseline: (() => void) | undefined;
try {
  // Freeze the actual canonical pages, including their evidence history. No
  // synthetic overview, source text edit or checkpoint is added to this corpus.
  const wikiRoot = path.join(root, "wiki");
  const pages = await mapConcurrent(await listWikiPagePaths(sourceWiki, { strict: true }), 16, async (relative) => {
    const bytes = await fs.readFile(path.join(sourceWiki, relative));
    await fs.mkdir(path.dirname(path.join(wikiRoot, relative)), { recursive: true });
    await fs.writeFile(path.join(wikiRoot, relative), bytes);
    return { path: relative, sha256: digest(bytes), bytes: bytes.length };
  });
  for (const item of fixture.cases) {
    assert.ok(pages.some((page) => page.path === item.expected), `Missing expected page: ${item.id}`);
    const body = await fs.readFile(path.join(wikiRoot, item.expected), "utf8");
    assert.ok(body.split("\n### ").some((block) => block.includes(item.supportingText) && /\bstatus active\b/u.test(block)), `Review stale oracle evidence: ${item.id}`);
  }

  // The A/B runtime differs at exactly one call site. Reuse its real fusion,
  // budget selection and coverage rather than reimplementing them in the probe.
  const baseline = path.join(root, "without-selection");
  await fs.cp(path.join(repositoryRoot, "src"), path.join(baseline, "src"), { recursive: true });
  await fs.copyFile(path.join(repositoryRoot, "package.json"), path.join(baseline, "package.json"));
  await fs.symlink(path.join(repositoryRoot, "node_modules"), path.join(baseline, "node_modules"), "dir");
  const hybridPath = path.join(baseline, "src/core/hybrid-retrieval.ts");
  const original = await fs.readFile(hybridPath, "utf8");
  const call = "selectLexicalEvidence(request.query, fused, request.coverageRequirements, evidenceSignals)";
  assert.equal(original.split(call).length, 2, "Review A/B isolation when the selector call changes");
  await fs.writeFile(hybridPath, original.replace(call, "fused"));
  const previous = await import(pathToFileURL(hybridPath).href) as typeof import("../src/core/hybrid-retrieval.js");
  clearBaseline = (await import(pathToFileURL(path.join(baseline, "src/core/workspace-state.ts")).href)).clearWorkspaceStates;
  const cases = [];
  for (const profile of ["precision", "balanced", "coverage"] as const) for (const tokenBudget of [2_000, 4_000]) for (const item of fixture.cases) {
    const params = { wikiRoot, query: item.query, profile, maxResults: 4,
      initialBudget: { tokenBudget }, semanticEnabled: false, progressiveWidening: false, persistDerivedIndexes: false };
    const before = await previous.retrieveWikiHybrid(params), after = await retrieveWikiHybrid(params);
    assert.deepEqual(after.coverageHits.map((hit) => [hit.path, hit.score, hit.channels]),
      before.coverageHits.map((hit) => [hit.path, hit.score, hit.channels]), "A/B must preserve the complete scored pool");
    const kept = new Set(selectLexicalEvidence(item.query, after.coverageHits).map((hit) => hit.path));
    const shownBefore = before.hits.map((hit) => hit.path), shownAfter = after.hits.map((hit) => hit.path);
    cases.push({ id: item.id, query: item.query, expected: item.expected, profile, tokenBudget,
      targetPoolRank: after.coverageHits.findIndex((hit) => hit.path === item.expected) + 1,
      found: after.coverageHits.map((hit) => hit.path), shownBefore, shownAfter,
      removedByDominance: after.coverageHits.filter((hit) => !kept.has(hit.path)).map((hit) => hit.path),
      targetRemovedByDominance: after.coverageHits.some((hit) => hit.path === item.expected) && !kept.has(item.expected),
      targetShownBefore: shownBefore.includes(item.expected), targetShownAfter: shownAfter.includes(item.expected),
      tokensBefore: before.estimatedContextTokens, tokensAfter: after.estimatedContextTokens,
      gapsBefore: before.coverage.evidenceGaps, gapsAfter: after.coverage.evidenceGaps });
  }
  const report = { version: fixture.version, fixtureSha256: digest(fixtureBytes), provenance: fixture.provenance, pages,
    method: "Actual workspace pages frozen byte-for-byte; one-call-site A/B with identical scored pools, budgets and fixed W0. Semantic disabled. Three profiles and two budgets repeat twelve questions; these are not 72 independent queries. Checks target-page retention, not answer correctness or passage freshness.",
    summary: { questions: fixture.cases.length, runs: cases.length,
      targetShownBefore: cases.filter((item) => item.targetShownBefore).length,
      targetShownAfter: cases.filter((item) => item.targetShownAfter).length,
      targetRemovedByDominance: cases.filter((item) => item.targetRemovedByDominance).length,
      newlyMissing: cases.filter((item) => item.targetShownBefore && !item.targetShownAfter).length,
      newlyShown: cases.filter((item) => !item.targetShownBefore && item.targetShownAfter).length,
      runsWithDominance: cases.filter((item) => item.removedByDominance.length).length,
      targetsBelowFirstRank: cases.filter((item) => item.targetPoolRank > 1).length },
    limitation: "This six-page workspace has thematic implementation pages, without a separately authored broad overview. When expected pages already rank first, retention cannot validate the risk of a higher-ranked overview suppressing a specific lower-ranked page. Do not declare the rule stable from this check.", cases };
  const output = path.resolve(argument("json", path.join(repositoryRoot, "benchmarks/results/280-workspace-selection.json")));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary, null, 2));
} finally {
  clearWorkspaceStates(); clearBaseline?.();
  await fs.rm(root, { recursive: true, force: true });
}
