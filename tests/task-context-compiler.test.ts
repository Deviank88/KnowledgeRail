import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

interface FixturePage {
  path: string;
  title: string;
  type: string;
  tags: string[];
  body: string;
}

const PAGES: FixturePage[] = [
  {
    path: "requirements/PineTrace.md",
    title: "Pine trace invariant",
    type: "requirement",
    tags: ["pine", "invariant", "constraint"],
    body: "# Requirement\n\nPine exports must always preserve the originating transaction identifier and must not regenerate it.",
  },
  {
    path: "decisions/PineCorrelation.md",
    title: "Pine correlation decision",
    type: "decision",
    tags: ["pine", "decision"],
    body: "# Decision\n\nThe canonical Pine correlation key is copied unchanged into each envelope.",
  },
  {
    path: "implementations/PineEmitter.md",
    title: "Pine envelope emitter",
    type: "implementation",
    tags: ["pine", "emitter"],
    body: "# Current implementation\n\nThe Pine emitter propagates the originating transaction identifier.",
  },
  {
    path: "tests/PineEmitter.md",
    title: "Pine emitter regression",
    type: "test_result",
    tags: ["pine", "regression"],
    body: "# Verification\n\nThe Pine regression compares the input identifier with every emitted envelope.",
  },
  {
    path: "analysis/PineIncident.md",
    title: "Pine duplicate incident",
    type: "analysis",
    tags: ["pine", "incident"],
    body: "# Historical incident\n\nA Pine replay failure showed that regenerated identifiers produce duplicate exports.",
  },
  {
    path: "risks/PineRisk.md",
    title: "Pine traceability risk",
    type: "risk",
    tags: ["pine", "risk"],
    body: "# Risk\n\nLosing the originating identifier prevents audit reconciliation.",
  },
];

async function writeFixture(wikiRoot: string): Promise<void> {
  for (const page of PAGES) {
    const absolute = path.join(wikiRoot, page.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, [
      "---",
      `title: ${JSON.stringify(page.title)}`,
      `type: ${page.type}`,
      `tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
      "request_id: REQ-PINE-7",
      `sources: [${JSON.stringify(`docs/${page.path}`)}]`,
      "created: 2026-08-14",
      "updated: 2026-08-14",
      "---",
      "",
      page.body,
    ].join("\n"), "utf8");
  }
}

async function withFixture(run: (wikiRoot: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-task-context-"));
  const wikiRoot = path.join(root, "wiki");
  try {
    await writeFixture(wikiRoot);
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await run(wikiRoot);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function paths(values: readonly { path: string }[]): string[] {
  return values.map((value) => value.path);
}

test("modify context compiles decision evidence and directional change impact", async () => {
  await withFixture(async (wikiRoot) => {
    const context = await compileTaskContext({
      wikiRoot,
      intent: "modify",
      objective: "Modify the Pine envelope emitter without breaking traceability",
      query: "Pine originating transaction identifier emitter regression incident risk",
      changedPaths: ["implementations/PineEmitter.md"],
      maxEvidence: 8,
      heuristicTokenBudget: 4_000,
    });

    assert.equal(context.version, 2);
    assert.deepEqual(context.task, {
      intent: "modify",
      objective: "Modify the Pine envelope emitter without breaking traceability",
    });
    assert.equal(context.retrieval.strategy, "hybrid_progressive_widening");
    assert.equal(context.retrieval.fullGraphScanAttempted, false);
    assert.equal(context.retrieval.fallbackUsed, false);
    assert.equal(context.retrieval.attempts.every((attempt) =>
      attempt.visitedNodes <= attempt.maxVisitedNodes
    ), true);
    assert.equal(paths(context.requirements).includes("requirements/PineTrace.md"), true);
    assert.equal(paths(context.decisions).includes("decisions/PineCorrelation.md"), true);
    assert.equal(paths(context.invariants).includes("requirements/PineTrace.md"), true);
    assert.equal(paths(context.constraints).includes("requirements/PineTrace.md"), true);
    assert.equal(paths(context.implementationEvidence).includes("implementations/PineEmitter.md"), true);
    assert.equal(paths(context.tests).includes("tests/PineEmitter.md"), true);
    assert.equal(paths(context.incidents).includes("analysis/PineIncident.md"), true);
    assert.equal(paths(context.risks).includes("risks/PineRisk.md"), true);

    assert.equal(context.changeImpact.mode, "explicit");
    assert.deepEqual(paths(context.changeImpact.changedComponents), ["implementations/PineEmitter.md"]);
    assert.equal(
      paths(context.changeImpact.incomingDependencies).includes("requirements/PineTrace.md"),
      true
    );
    assert.equal(paths(context.changeImpact.outgoingDependencies).includes("tests/PineEmitter.md"), true);
    assert.equal(paths(context.changeImpact.decisions).includes("decisions/PineCorrelation.md"), true);
    assert.equal(paths(context.changeImpact.incidents).includes("analysis/PineIncident.md"), true);
    assert.equal(paths(context.changeImpact.risks).includes("risks/PineRisk.md"), true);
    assert.equal(
      context.changeImpact.relations.some((relation) =>
        relation.direction === "incoming" && relation.kind === "implements"
      ),
      true
    );
    assert.equal(
      context.changeImpact.relations.some((relation) =>
        relation.direction === "outgoing" && relation.kind === "tests"
      ),
      true
    );
    assert.equal(new Set(context.evidence.map((evidence) => evidence.uri)).size, context.evidence.length);
    assert.equal(context.size.heuristicTokens <= 4_000, true);
    assert.equal(context.budget.withinHeuristicBudget, true);
  });
});

test("debug intent prioritizes incidents, tests and current implementation", async () => {
  await withFixture(async (wikiRoot) => {
    const context = await compileTaskContext({
      wikiRoot,
      intent: "debug",
      objective: "Debug duplicate Pine exports after replay",
      query: "Pine replay failure duplicate exports regression emitter",
      maxEvidence: 6,
      heuristicTokenBudget: 3_000,
    });
    assert.equal(context.evidence[0]?.path, "analysis/PineIncident.md");
    assert.equal(paths(context.incidents).includes("analysis/PineIncident.md"), true);
    assert.equal(paths(context.tests).includes("tests/PineEmitter.md"), true);
    assert.equal(paths(context.implementationEvidence).includes("implementations/PineEmitter.md"), true);
    assert.equal(context.retrieval.fallbackUsed, false);
  });
});

test("compiler reports budget omissions instead of silently dropping evidence", async () => {
  await withFixture(async (wikiRoot) => {
    const context = await compileTaskContext({
      wikiRoot,
      intent: "review",
      objective: "Review the Pine traceability change",
      query: "Pine traceability decision emitter regression incident risk",
      maxEvidence: 6,
      heuristicTokenBudget: 1_500,
    });
    assert.equal(context.budget.omittedEvidenceCount > 0, true);
    assert.equal(context.unknowns.some((gap) => gap.kind === "budget_limited"), true);
    assert.equal(context.budget.withinHeuristicBudget, true);
    assert.equal(context.size.heuristicTokens <= 1_500, true);
  });
});

test("documentation about contradiction handling is not itself conflicting evidence", async () => {
  await withFixture(async (wikiRoot) => {
    const pagePath = path.join(wikiRoot, "implementations", "EvidenceIrHandling.md");
    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await fs.writeFile(pagePath, [
      "---",
      'title: "Evidence IR handling"',
      "type: implementation",
      "tags: [evidence-ir, provenance]",
      "sources: []",
      "created: 2026-08-14",
      "updated: 2026-08-14",
      "---",
      "",
      "# Evidence IR handling",
      "",
      "Evidence IR preserves duplicates, contradictions and supersessions without automatic rewriting.",
    ].join("\n"), "utf8");

    const context = await compileTaskContext({
      wikiRoot,
      intent: "understand",
      objective: "Understand how Evidence IR handles contradictory claims",
      query: "Evidence IR preserves duplicates contradictions supersessions",
      maxEvidence: 4,
      heuristicTokenBudget: 2_000,
    });
    assert.equal(paths(context.contradictions).includes("implementations/EvidenceIrHandling.md"), false);
    assert.equal(context.unknowns.some((gap) => gap.kind === "contradiction"), true);
  });
});

test("explicit impact paths reject traversal and platform-specific absolute forms", async () => {
  await withFixture(async (wikiRoot) => {
    for (const invalid of ["../outside.md", "/tmp/outside.md", "C:\\temp\\outside.md"]) {
      await assert.rejects(
        compileTaskContext({
          wikiRoot,
          intent: "modify",
          objective: "Reject unsafe impact target",
          changedPaths: [invalid],
        }),
        /Changed path must be a normalized relative wiki Markdown path/
      );
    }
  });
});
