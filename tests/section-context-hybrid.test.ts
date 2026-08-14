import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createSectionContext } from "../src/core/document-workflow.js";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

async function writePage(
  wikiRoot: string,
  relPath: string,
  params: { title: string; type: string; requestId?: string; body: string }
): Promise<void> {
  const file = path.join(wikiRoot, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    `title: \"${params.title}\"`,
    `type: ${params.type}`,
    "tags: [section-context-test]",
    "created: 2026-08-13",
    "updated: 2026-08-13",
    ...(params.requestId ? [`request_id: \"${params.requestId}\"`] : []),
    "---",
    "",
    `# ${params.title}`,
    "",
    params.body,
  ].join("\n"), "utf8");
}

test("section context always uses the accuracy-safe compiler and admits graph-only evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-section-hybrid-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);

  try {
    await writePage(wikiRoot, "requirements/REQ_POLICY.md", {
      title: "Retry escalation policy",
      type: "requirement",
      requestId: "REQ-77",
      body: "Retry escalation occurs after exactly three attempts and requires audit evidence.",
    });
    await writePage(wikiRoot, "implementations/Worker.md", {
      title: "Asynchronous worker implementation",
      type: "implementation",
      requestId: "REQ-77",
      body: "A scheduled worker persists execution telemetry and idempotency state.",
    });
    await writePage(wikiRoot, "analysis/Noise.md", {
      title: "Warehouse capacity notes",
      type: "analysis",
      body: "Warehouse capacity planning and invoice batching details.",
    });

    const context = await createSectionContext({
      wikiRoot,
      sectionTitle: "Retry escalation",
      query: "three attempts retry escalation audit evidence",
      maxPages: 4,
      maxCharsPerPage: 1_000,
      maxTotalChars: 4_000,
      useGraph: false,
    });
    assert.equal(
      context.pages.some((page) => page.relPath === "implementations/Worker.md"),
      true,
      "the compatibility flag must not disable the graph-backed accuracy-safe path"
    );
    assert.equal(context.compiler.strategy, "hybrid_progressive_widening");
    assert.equal(context.compiler.fullGraphScanAttempted, false);
    assert.equal(context.compiler.fullSourceGrepAttempted, false);
    assert.equal(typeof context.graphSummary, "string");
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});
