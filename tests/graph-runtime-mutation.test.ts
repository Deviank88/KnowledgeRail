import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getWikiGraph, invalidateWikiGraph } from "../src/core/graph-index.js";
import {
  clearRuntimeWikiGraphs,
  getRuntimeWikiGraph,
  peekRuntimeWikiGraph,
  updateRuntimeWikiGraphPaths,
} from "../src/core/graph-runtime.js";
import {
  clearRetrievalIndexes,
  refreshRetrievalIndex,
  updateRetrievalPaths,
} from "../src/core/retrieval-index.js";

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
    "tags: [runtime-mutation-test]",
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

function edgeExists(
  runtime: Awaited<ReturnType<typeof getRuntimeWikiGraph>>,
  from: string,
  to: string,
  kind: string
): boolean {
  return runtime.graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);
}

async function fixture(): Promise<{ root: string; wikiRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-runtime-mutation-"));
  const wikiRoot = path.join(root, "wiki");
  await writePage(wikiRoot, "requirements/REQ.md", {
    title: "Retry requirement",
    type: "requirement",
    requestId: "REQ-1",
    body: "Retry must stop after three attempts.",
  });
  await writePage(wikiRoot, "implementations/Worker.md", {
    title: "Retry worker",
    type: "implementation",
    requestId: "REQ-1",
    body: "The worker executes retry scheduling.",
  });
  return { root, wikiRoot };
}

async function cleanup(root: string, wikiRoot: string): Promise<void> {
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(wikiRoot);
  await fs.rm(root, { recursive: true, force: true });
}

test("warm page edit patches the same runtime object and only recomputes affected request relations", async () => {
  const { root, wikiRoot } = await fixture();
  try {
    const runtime = await getRuntimeWikiGraph(wikiRoot, true);
    const requirementId = "page:requirements/REQ.md";
    const implementationId = "page:implementations/Worker.md";
    assert.equal(edgeExists(runtime, requirementId, implementationId, "implements"), true);
    assert.equal(edgeExists(runtime, requirementId, "request:REQ_1", "same_request"), true);

    await writePage(wikiRoot, "requirements/REQ.md", {
      title: "Retry requirement v2",
      type: "requirement",
      requestId: "REQ-2",
      body: "Retry must stop after four attempts and emit escalation evidence.",
    });
    await updateRetrievalPaths(wikiRoot, ["requirements/REQ.md"]);

    const updated = await updateRuntimeWikiGraphPaths(wikiRoot, ["requirements/REQ.md"]);
    assert.equal(updated, true);
    assert.equal(peekRuntimeWikiGraph(wikiRoot), runtime);
    assert.equal(await getRuntimeWikiGraph(wikiRoot), runtime, "warm reads must keep the patched runtime identity");
    assert.equal((await getWikiGraph(wikiRoot)), runtime.graph, "graph cache and runtime graph must share the patched object");

    const page = runtime.nodesById.get(requirementId);
    assert.equal(page?.label, "Retry requirement v2");
    assert.equal(page?.requestId, "REQ-2");
    assert.match(page?.summary ?? "", /four attempts/);
    assert.equal(edgeExists(runtime, requirementId, implementationId, "implements"), false);
    assert.equal(edgeExists(runtime, requirementId, "request:REQ_1", "same_request"), false);
    assert.equal(edgeExists(runtime, requirementId, "request:REQ_2", "same_request"), true);
    assert.equal(runtime.nodesById.has("request:REQ_1"), true, "REQ-1 remains referenced by the implementation");
  } finally {
    await cleanup(root, wikiRoot);
  }
});

test("warm page delete removes the page and incident edges without replacing the runtime", async () => {
  const { root, wikiRoot } = await fixture();
  try {
    const runtime = await getRuntimeWikiGraph(wikiRoot, true);
    const implementationPath = "implementations/Worker.md";
    const implementationId = `page:${implementationPath}`;
    await fs.rm(path.join(wikiRoot, implementationPath));
    await updateRetrievalPaths(wikiRoot, [implementationPath]);

    assert.equal(await updateRuntimeWikiGraphPaths(wikiRoot, [implementationPath]), true);
    assert.equal(peekRuntimeWikiGraph(wikiRoot), runtime);
    assert.equal(runtime.nodesById.has(implementationId), false);
    assert.equal(runtime.graph.edges.some((edge) => edge.from === implementationId || edge.to === implementationId), false);
    assert.equal(runtime.pageNodeByPath.has(implementationPath), false);
  } finally {
    await cleanup(root, wikiRoot);
  }
});

test("cold page mutation does not construct a graph just to service a write", async () => {
  const { root, wikiRoot } = await fixture();
  try {
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    assert.equal(peekRuntimeWikiGraph(wikiRoot), undefined);

    await writePage(wikiRoot, "requirements/REQ.md", {
      title: "Cold edit",
      type: "requirement",
      requestId: "REQ-1",
      body: "A cold mutation must not trigger graph construction.",
    });
    await updateRetrievalPaths(wikiRoot, ["requirements/REQ.md"]);

    assert.equal(await updateRuntimeWikiGraphPaths(wikiRoot, ["requirements/REQ.md"]), false);
    assert.equal(peekRuntimeWikiGraph(wikiRoot), undefined);
    await assert.rejects(fs.stat(path.join(wikiRoot, ".knowledge-rail", "graph.json")), /ENOENT/);
  } finally {
    await cleanup(root, wikiRoot);
  }
});

test("reconciled external edit replaces the stale warm runtime instead of serving it forever", async () => {
  const { root, wikiRoot } = await fixture();
  try {
    const before = await getRuntimeWikiGraph(wikiRoot, true);
    await writePage(wikiRoot, "requirements/REQ.md", {
      title: "Externally edited requirement",
      type: "requirement",
      requestId: "REQ-1",
      body: "An external editor changed the canonical Markdown directly.",
    });

    // Deterministically model the filesystem watcher reconciliation pass.
    await refreshRetrievalIndex(wikiRoot, { force: true });
    const after = await getRuntimeWikiGraph(wikiRoot);

    assert.notEqual(after, before, "external canonical changes must replace the stale runtime");
    assert.equal(after.nodesById.get("page:requirements/REQ.md")?.label, "Externally edited requirement");
  } finally {
    await cleanup(root, wikiRoot);
  }
});
