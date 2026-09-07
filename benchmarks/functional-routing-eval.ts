import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { applyEvidenceSynthesis } from "../src/core/ingestion/evidence-synthesis.js";
import { readEvidenceIrStore, mutateEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";
import { detectCodeDrift } from "../src/core/drift-detection.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";

export async function evaluateFunctionalRouting(options: { live?: boolean } = {}) {
  const provider = options.live ? configuredEmbeddingProvider() : undefined;
  if (options.live && !provider) throw new Error("Configure an embedding provider before --live evaluation.");
  const bytes = await fs.readFile(new URL("fixtures/functional-routing-golden.json", import.meta.url), "utf8");
  const fixture = JSON.parse(bytes) as { version: number; provenance: string; domains: Array<{
    id: string; title: string; claim: string; queries: Array<{ split: string; text: string }>;
  }> };
  const root = await fs.mkdtemp(join(tmpdir(), "kr-functional-eval-"));
  // A deterministic lexical run must not silently call a developer's provider.
  const envKeys = ["KNOWLEDGE_RAIL_EMBEDDING_BASE_URL", "KNOWLEDGE_RAIL_EMBEDDING_MODEL", "KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS"];
  const previous = envKeys.map((key) => process.env[key]);
  if (!options.live) envKeys.forEach((key) => { delete process.env[key]; });
  const cases = [];
  const relatedClaims = [];
  try {
    for (const [domainIndex, domain] of fixture.domains.entries()) for (const layout of ["flat", "relocated"]) {
      const repositoryRoot = join(root, domain.id, layout), wikiRoot = join(repositoryRoot, "wiki");
      const target = layout === "flat" ? "a.ts" : "unusual/component/x1.ts";
      const caller = layout === "flat" ? "b.ts" : "ports/front/z9.ts";
      const specifier = layout === "flat" ? "./a.js" : "../../unusual/component/x1.js";
      const symbol = `op${domainIndex}`;
      for (const [name, content] of Object.entries({ [target]: `export function ${symbol}() { return 5; }`,
        [caller]: `import { ${symbol} } from "${specifier}";\nexport function start${domainIndex}() { return ${symbol}(); }`,
        "decoy.ts": 'import "@external/component";\nexport function unrelated() { return 8; }',
      })) { await fs.mkdir(dirname(join(repositoryRoot, name)), { recursive: true }); await fs.writeFile(join(repositoryRoot, name), content); }
      const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot }); await index.rebuild();
      const hit = (await index.symbol(symbol))[0]!;
      const sourceUri = "docs/normalized/rules.md", sourceContent = domain.claim;
      const plan = await sourceCompilePlan({ wikiRoot, sourceUri, content: sourceContent });
      const recordParams = { wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id,
        claims: [{ text: sourceContent, kind: "behavior" as const, origin: "explicit" as const, confidence: 1,
          target: { pagePath: "implementations/Rule.md", pageTitle: domain.title, pageType: "implementation" as const, codeResourceUri: hit.resourceUri } }] };
      const recorded = await recordEvidenceClaims(recordParams);
      await resolveEvidenceClaims({ wikiRoot }); await applyEvidenceSynthesis({ wikiRoot });
      clearWorkspaceStates();
      const beforeClaims = (await readEvidenceIrStore(wikiRoot)).claims.length;
      const proposals = recorded.relatedEvidence?.candidates ?? [];
      const proposalPaths = [];
      for (const candidate of proposals) proposalPaths.push((await readCodeResource({ repositoryRoot, wikiRoot, resourceUri: candidate.resourceUri })).path);
      assert.ok(proposalPaths.length > 0 && proposalPaths.every((path) => path === caller));
      assert.equal((await readEvidenceIrStore(wikiRoot)).claims.length, beforeClaims, "proposals must not create claims");
      const update = await index.updateFile(target);
      assert.equal(update.reparsedFiles, 0, "unchanged incremental refresh must reuse source extraction");
      for (const query of domain.queries) {
        assert.equal(query.text.includes(symbol), false);
        const context = await compileTaskContext({ wikiRoot, intent: "modify", objective: query.text, maxEvidence: 1, heuristicTokenBudget: 6000 });
        const roots = context.changeImpact.codeRoots ?? [], relations = context.changeImpact.codeRelations ?? [];
        const shown = [...new Set(context.evidence.map((entry) => entry.path))];
        const incoming = [...new Set(relations.map((entry) => entry.path))];
        let materializedCharacters = 0;
        for (const resource of [...roots, ...relations]) materializedCharacters += (await readCodeResource({ repositoryRoot, wikiRoot, resourceUri: resource.uri })).text.length;
        cases.push({ id: `${domain.id}/${layout}/${query.split}`, split: query.split, query: query.text, layout,
          shown, expected: ["implementations/Rule.md"], codeRoots: roots.map((entry) => entry.path), incoming,
          usefulIncoming: incoming.filter((path) => path === caller).length, expectedIncoming: 1,
          shownTokens: context.size.heuristicTokens, materializedCharacters, gapCount: context.unknowns.length,
          fallbackNeededByOracle: !roots.some((entry) => entry.path === target) || !incoming.includes(caller),
          pass: shown.length === 1 && shown[0] === "implementations/Rule.md" && roots.length === 1 && roots[0]!.path === target &&
            incoming.length === 1 && incoming[0] === caller && context.budget.withinHeuristicBudget,
        });
      }
      // Controlled negatives remain project knowledge, but cannot seed automatic
      // code evidence. Historical/ambiguous evidence is never upgraded to certainty.
      if (layout === "flat") for (const state of ["anchorless", "superseded", "ambiguous", "contradicted", "stale"] as const) {
        await mutateEvidenceIrStore(wikiRoot, (store) => {
          const claim = store.claims[0]!; claim.status = state === "anchorless" || state === "stale" ? "active" : state;
          claim.codeAnchor = state === "anchorless" ? undefined : structuredClone(recorded.claims[0]!.codeAnchor);
        });
        if (state === "stale") { await fs.writeFile(join(repositoryRoot, target), `export function ${symbol}() { return 99; }`); await detectCodeDrift({ repositoryRoot, wikiRoot }); }
        const context = await compileTaskContext({ wikiRoot, intent: "modify", objective: domain.queries[0]!.text, maxEvidence: 1, heuristicTokenBudget: 6000 });
        cases.push({ id: `${domain.id}/${state}`, split: "evaluation", scenario: state, codeRoots: context.changeImpact.codeRoots ?? [],
          pass: !(context.changeImpact.codeRoots?.length), fallbackNeededByOracle: false });
      }
      const accepted = proposals[0]!;
      const additional = await recordEvidenceClaims({ ...recordParams, claims: [{ text: `The inspected entry point applies this rule: ${domain.title}.`,
        kind: "behavior", origin: "inferred", confidence: 0.9, target: { codeResourceUri: accepted.resourceUri } }] });
      const afterClaims = (await readEvidenceIrStore(wikiRoot)).claims.length;
      assert.equal(additional.created, 1); assert.equal(afterClaims, beforeClaims + 1);
      relatedClaims.push({ id: `${domain.id}/${layout}`, checkedCandidates: proposalPaths.length, usefulCandidates: proposalPaths.length,
        claimsBeforeExplicitAcceptance: beforeClaims, claimsAfterExplicitAcceptance: afterClaims });
      clearWorkspaceStates();
    }
    for (const kind of ["documents-only", "code-only"] as const) {
      const repositoryRoot = join(root, kind), wikiRoot = join(repositoryRoot, "wiki");
      await fs.mkdir(join(wikiRoot, "requirements"), { recursive: true });
      if (kind === "documents-only") await fs.writeFile(join(wikiRoot, "requirements/Rule.md"), '---\ntitle: Storni commerciali\ntype: requirement\n---\nIl tetto degli storni commerciali è cinque.');
      else { await fs.writeFile(join(repositoryRoot, "a.ts"), "export function op0() { return 5; }"); await new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot }).rebuild(); }
      const context = await compileTaskContext({ wikiRoot, intent: "modify", objective: "Modificare il tetto degli storni commerciali", heuristicTokenBudget: 6000 });
      cases.push({ id: kind, split: "evaluation", scenario: kind, shown: context.evidence.map((entry) => entry.path), gaps: context.unknowns.length,
        pass: !(context.changeImpact.codeRoots?.length) && (kind === "documents-only" ? context.evidence.length > 0 : context.evidence.length === 0 && context.unknowns.length > 0),
        fallbackNeededByOracle: kind === "code-only" });
      clearWorkspaceStates();
    }
    const impact = cases.filter((sample) => sample.expectedIncoming !== undefined);
    return { version: fixture.version, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), provenance: fixture.provenance,
      mode: options.live ? "live_with_recorded_domain_aliases" : "lexical_with_recorded_domain_aliases",
      semanticProvider: provider ? { status: "measured", descriptor: provider.descriptor } : { status: "not_measured", reason: "Optional live provider quality is separate; deterministic semantic integration remains in eval:semantic:gate and hybrid-semantic tests." },
      relatedClaims: { scope: "controlled author verifies candidates then explicitly records one additional claim; proposals alone never write claims", cases: relatedClaims },
      impact: { cases: impact.length, shownRecall: impact.reduce((n, c) => n + (c.usefulIncoming ?? 0), 0) / impact.length,
        shownPrecision: impact.reduce((n, c) => n + (c.usefulIncoming ?? 0), 0) / Math.max(1, impact.reduce((n, c) => n + (c.incoming?.length ?? 0), 0)),
        fallbackAvoidedByOracle: impact.filter((c) => !c.fallbackNeededByOracle).length,
        scope: "controlled task outcomes, not observed user fallback telemetry" },
      cases, pass: cases.every((sample) => sample.pass) };
  } finally {
    envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await evaluateFunctionalRouting({ live: process.argv.includes("--live") });
  const output = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--gate")) assert.ok(report.pass, "Functional routing oracle failed.");
}
