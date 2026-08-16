import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { sectionEvidencePlan } from "../src/config/editorial-plans.js";
import {
  createSectionContext,
  formatSectionContext,
} from "../src/core/document-workflow.js";
import {
  sourceCompilePlan,
  sourceFinalize,
  sourceRecordSegment,
} from "../src/core/ingestion/source-compiler.js";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

async function writePage(root: string, relPath: string, params: {
  title: string;
  type: string;
  body: string;
  requestId?: string;
  sources?: string[];
}): Promise<void> {
  const absolute = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---",
    `title: "${params.title}"`,
    `type: ${params.type}`,
    "tags: [editorial-intelligence]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    `sources: [${(params.sources ?? []).map((source) => `"${source}"`).join(", ")}]`,
    ...(params.requestId ? [`request_id: "${params.requestId}"`] : []),
    "---",
    "",
    `# ${params.title}`,
    "",
    params.body,
  ].join("\n"), "utf8");
}

async function fullyCoverSource(wikiRoot: string, sourceUri: string, pageRef: string): Promise<void> {
  const content = "Specifica confermata dal cliente per il flusso TO-BE.";
  const planned = await sourceCompilePlan({ wikiRoot, sourceUri, content, segmentMaxChars: 512 });
  for (const segment of planned.ledger.segments) {
    await sourceRecordSegment({
      wikiRoot,
      sourceUri,
      content,
      segmentId: segment.id,
      resolution: {
        status: "integrated",
        evidenceRefs: ["claim-editorial-1"],
        pageRefs: [pageRef],
      },
    });
  }
  await sourceFinalize({ wikiRoot, sourceUri, content });
}

test("template sections resolve to normalized declarative evidence plans", () => {
  assert.deepEqual(sectionEvidencePlan("functional_spec", "Soluzione TO-BE"), {
    require: ["requirement", "implementation"],
    prefer: ["decision", "constraint", "source"],
  });
  assert.deepEqual(sectionEvidencePlan("custom", "Sezione libera", {
    require: ["source", "source"],
    prefer: ["source", "decision", "decision"],
  }), {
    require: ["source"],
    prefer: ["decision"],
  });
});

test("editorial context reports evidence, provenance, source coverage and bounded compiler work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-editorial-covered-"));
  const wikiRoot = path.join(root, "wiki");
  const sourceUri = "docs/client/to-be.md";
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  try {
    await writePage(wikiRoot, "requirements/REQ_FLOW.md", {
      title: "REQ-FLOW Processo approvativo",
      type: "requirement",
      requestId: "REQ-FLOW",
      sources: [sourceUri],
      body: "EVID-REQ-TOBE Il processo richiede due approvatori e registra un audit immutabile.",
    });
    await writePage(wikiRoot, "implementations/ApprovalService.md", {
      title: "ApprovalService",
      type: "implementation",
      requestId: "REQ-FLOW",
      sources: [sourceUri],
      body: "EVID-IMPL-TOBE ApprovalService applica la regola con optimistic locking.",
    });
    await fullyCoverSource(wikiRoot, sourceUri, "requirements/REQ_FLOW.md");

    const context = await createSectionContext({
      wikiRoot,
      documentType: "functional_spec",
      sectionTitle: "Soluzione TO-BE",
      query: "processo approvatori audit ApprovalService optimistic locking",
      maxPages: 6,
      maxTotalChars: 4_000,
      maxOutputChars: 6_000,
      heuristicTokenBudget: 4_000,
    });

    assert.equal(context.coverage.status, "COVERED");
    assert.deepEqual(context.coverage.missingEvidence, []);
    assert.equal(context.coverage.foundEvidence.includes("requirement"), true);
    assert.equal(context.coverage.foundEvidence.includes("implementation"), true);
    assert.equal(context.coverage.foundEvidence.includes("source"), true);
    assert.equal(context.coverage.sourceCoverage.averageCoveragePercent, 100);
    assert.equal(context.coverage.sourceCoverage.fullyCoveredSources, 1);
    assert.equal(context.coverage.unprovenancedEvidenceCount, 0);
    assert.equal(context.compiler.withinHeuristicBudget, true);
    assert.equal(context.compiler.fullGraphScanAttempted, false);
    assert.equal(context.compiler.fullSourceGrepAttempted, false);
    const formatted = formatSectionContext(context, "Soluzione TO-BE", 6_000);
    assert.equal(formatted.includes("EVID-REQ-TOBE"), true);
    assert.equal(formatted.includes("EVID-IMPL-TOBE"), true);
    assert.equal(formatted.includes("Evidence URI"), true);
    assert.equal(formatted.length <= 6_000, true);
    assert.equal(Buffer.byteLength(formatted, "utf8") <= 6_000, true);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing required evidence is emitted as GAP instead of inferred content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-editorial-gap-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  try {
    await writePage(wikiRoot, "requirements/REQ_ONLY.md", {
      title: "REQ-ONLY Flusso parziale",
      type: "requirement",
      requestId: "REQ-ONLY",
      sources: ["docs/client/partial.md"],
      body: "Il processo TO-BE richiede una validazione, ma l'implementazione non è documentata.",
    });
    const context = await createSectionContext({
      wikiRoot,
      documentType: "functional_spec",
      sectionTitle: "Soluzione TO-BE",
      query: "processo validazione",
      maxPages: 4,
      maxTotalChars: 3_000,
      heuristicTokenBudget: 3_000,
    });

    assert.equal(context.coverage.status, "GAP");
    assert.deepEqual(context.coverage.missingEvidence, ["implementation"]);
    assert.equal(
      formatSectionContext(context, "Soluzione TO-BE").includes("GAP — required evidence is missing"),
      true
    );
    assert.equal(context.compiler.fullSourceGrepAttempted, false);
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("explicit editorial evidence rejects symlinks escaping the wiki root", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symbolic-link creation is not consistently available on Windows runners.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-editorial-symlink-"));
  const wikiRoot = path.join(root, "wiki");
  const outside = path.join(root, "outside.md");
  await fs.mkdir(path.join(wikiRoot, "requirements"), { recursive: true });
  await fs.writeFile(outside, [
    "---",
    'title: "Outside"',
    "type: requirement",
    "tags: [outside]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "sources: []",
    "---",
    "",
    "Secret external evidence.",
  ].join("\n"), "utf8");
  await fs.symlink(outside, path.join(wikiRoot, "requirements", "Outside.md"));
  try {
    await assert.rejects(
      createSectionContext({
        wikiRoot,
        sectionTitle: "Requisiti",
        pagePaths: ["requirements/Outside.md"],
      }),
      /outside the wiki root/
    );
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});
