import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  GraphCheckpointBoundsError,
  readGraphCheckpoint,
  serializeGraphCheckpoint,
  serializeGraphDelta,
} from "../src/core/graph-checkpoint.js";
import {
  buildWikiGraph,
  getWikiGraphDiagnostics,
  invalidateWikiGraph,
} from "../src/core/graph-index.js";
import {
  clearRuntimeWikiGraphs,
  getRuntimeWikiGraph,
  updateRuntimeWikiGraphPaths,
} from "../src/core/graph-runtime.js";
import { clearRetrievalIndexes, updateRetrievalPaths } from "../src/core/retrieval-index.js";

async function writePage(root: string, relativePath: string, title: string, body: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---",
    `title: ${title}`,
    "type: requirement",
    "tags: [graph-checkpoint]",
    "request_id: REQ-GRAPH",
    "sources: []",
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n"));
}

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-graph-checkpoint-"));
  await writePage(root, "requirements/Alpha.md", "Alpha", "See [[Beta]].");
  await writePage(root, "requirements/Beta.md", "Beta", "Graph hydration target.");
  return root;
}

function clear(root: string): void {
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  invalidateWikiGraph(root);
}

function checksum(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

test("graph v3 resumes only after its input corpus revision is verified", async () => {
  const root = await fixture();
  try {
    const built = await buildWikiGraph(root);
    clear(root);
    const runtime = await getRuntimeWikiGraph(root, false, { persist: false });
    assert.deepEqual(runtime.graph.nodes, built.nodes);
    assert.deepEqual(runtime.graph.edges, built.edges);
    assert.equal(runtime.nodesById.size, built.nodes.length);
    const diagnostics = getWikiGraphDiagnostics(root);
    assert.equal(diagnostics?.recovery, "restored");
    assert.equal(diagnostics?.fallbackReason, "none");
    assert.match(diagnostics?.inputCorpusRevision ?? "", /^[a-f0-9]{64}$/);
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("revision-mismatched graph is discarded and rebuilt without rewriting in read-only mode", async () => {
  const root = await fixture();
  try {
    const oracle = await buildWikiGraph(root);
    const graphPath = path.join(root, ".knowledge-rail", "graph.json");
    const parsed = JSON.parse(await fs.readFile(graphPath, "utf8")) as {
      payload: { inputCorpusRevision: string };
      payloadChecksum: string;
    };
    parsed.payload.inputCorpusRevision = "0".repeat(64);
    parsed.payloadChecksum = checksum(parsed.payload);
    const stale = `${JSON.stringify(parsed)}\n`;
    await fs.writeFile(graphPath, stale);

    clear(root);
    const runtime = await getRuntimeWikiGraph(root, false, { persist: false });
    assert.deepEqual(runtime.graph.nodes, oracle.nodes);
    assert.deepEqual(runtime.graph.edges, oracle.edges);
    assert.equal(getWikiGraphDiagnostics(root)?.fallbackReason, "graph_revision_mismatch");
    assert.equal(await fs.readFile(graphPath, "utf8"), stale);
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("graph writers refuse generations outside the reader bounds", async () => {
  const root = await fixture();
  try {
    const graph = await buildWikiGraph(root);
    const revision = getWikiGraphDiagnostics(root)!.inputCorpusRevision;
    assert.throws(
      () => serializeGraphCheckpoint(graph, revision, { maxNodes: 0 }),
      (error) => error instanceof GraphCheckpointBoundsError && error.reason === "node_limit"
    );
    assert.throws(
      () => serializeGraphCheckpoint(graph, revision, { maxEdges: 0 }),
      (error) => error instanceof GraphCheckpointBoundsError && error.reason === "edge_limit"
    );
    assert.throws(
      () => serializeGraphCheckpoint(graph, revision, { maxSnapshotBytes: 1 }),
      (error) => error instanceof GraphCheckpointBoundsError && error.reason === "snapshot_bytes"
    );
    assert.throws(
      () => serializeGraphDelta(revision, revision, {
        removedNodeIds: [],
        upsertNodes: [],
        removedEdges: [],
        upsertEdges: [],
        warningPatches: [],
      }, { maxJournalBytes: 1 }),
      (error) => error instanceof GraphCheckpointBoundsError && error.reason === "journal_bytes"
    );
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy graph v2 is a migration input, never a trusted warm checkpoint", async () => {
  const root = await fixture();
  try {
    const graph = await buildWikiGraph(root);
    const graphPath = path.join(root, ".knowledge-rail", "graph.json");
    await fs.writeFile(graphPath, `${JSON.stringify(graph)}\n`);
    clear(root);
    const rebuilt = await getRuntimeWikiGraph(root, false, { persist: false });
    assert.deepEqual(rebuilt.graph.nodes, graph.nodes);
    assert.equal(getWikiGraphDiagnostics(root)?.fallbackReason, "graph_v2_migration");
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("authorized warm mutation persists a graph bound to the new lexical revision", async () => {
  const root = await fixture();
  try {
    await getRuntimeWikiGraph(root, true);
    const graphPath = path.join(root, ".knowledge-rail", "graph.json");
    const snapshotBefore = await fs.readFile(graphPath, "utf8");
    await writePage(root, "requirements/Alpha.md", "Alpha v2", "See [[Beta]] after the revision.");
    await updateRetrievalPaths(root, ["requirements/Alpha.md"]);
    assert.equal(await updateRuntimeWikiGraphPaths(root, ["requirements/Alpha.md"]), true);
    const checkpoint = await readGraphCheckpoint(root);
    assert.equal(checkpoint.kind, "v3");
    if (checkpoint.kind === "v3") {
      assert.equal(checkpoint.graph.nodes.some((node) => node.label === "Alpha v2"), true);
      assert.equal(checkpoint.inputCorpusRevision, getWikiGraphDiagnostics(root)?.inputCorpusRevision);
      assert.equal(checkpoint.deltaCount, 1);
      assert.equal(checkpoint.deltaBytes > 0, true);
      assert.equal(await fs.readFile(graphPath, "utf8"), snapshotBefore, "small mutations append a graph delta");
      const expected = checkpoint.graph;
      clear(root);
      const restored = await getRuntimeWikiGraph(root, false, { persist: false });
      assert.deepEqual(restored.graph.nodes, expected.nodes);
      assert.deepEqual(restored.graph.edges, expected.edges);
    }
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("graph warning deltas replace warnings for paths containing colons", {
  skip: process.platform === "win32",
}, async () => {
  const root = await fixture();
  const relPath = "requirements/Colon:Page.md";
  try {
    await writePage(root, relPath, "Colon page", "See [[MissingAlpha]].");
    await getRuntimeWikiGraph(root, true);
    await writePage(root, relPath, "Colon page", "See [[MissingBeta]].");
    await updateRetrievalPaths(root, [relPath]);
    assert.equal(await updateRuntimeWikiGraphPaths(root, [relPath]), true);
    const checkpoint = await readGraphCheckpoint(root);
    assert.equal(checkpoint.kind, "v3");
    if (checkpoint.kind === "v3") {
      assert.equal(checkpoint.graph.warnings.some((warning) => warning.includes("MissingAlpha")), false);
      assert.equal(checkpoint.graph.warnings.some((warning) =>
        warning === `${relPath}: unresolved link 'MissingBeta'`), true);
    }
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("graph checkpoint symlink is rejected before parsing", { skip: process.platform === "win32" }, async () => {
  const root = await fixture();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-graph-outside-"));
  try {
    await buildWikiGraph(root);
    const graphPath = path.join(root, ".knowledge-rail", "graph.json");
    const external = path.join(outsideRoot, "graph.json");
    await fs.rename(graphPath, external);
    await fs.symlink(external, graphPath);
    clear(root);
    const runtime = await getRuntimeWikiGraph(root, false, { persist: false });
    assert.equal(runtime.graph.nodes.length > 0, true);
    assert.equal(getWikiGraphDiagnostics(root)?.fallbackReason, "graph_symlink");
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test("graph reader rejects a symlinked checkpoint directory", { skip: process.platform === "win32" }, async () => {
  const root = await fixture();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-graph-meta-outside-"));
  try {
    await buildWikiGraph(root);
    const metadata = path.join(root, ".knowledge-rail");
    const externalMetadata = path.join(outsideRoot, "metadata");
    await fs.rename(metadata, externalMetadata);
    await fs.symlink(externalMetadata, metadata);
    const checkpoint = await readGraphCheckpoint(root);
    assert.equal(checkpoint.kind, "empty");
    assert.equal(checkpoint.fallbackReason, "checkpoint_directory_symlink");
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test("graph journal ignores only an incomplete final append", async () => {
  const root = await fixture();
  try {
    await getRuntimeWikiGraph(root, true);
    await writePage(root, "requirements/Alpha.md", "Alpha journal", "See [[Beta]] after append.");
    await updateRetrievalPaths(root, ["requirements/Alpha.md"]);
    await updateRuntimeWikiGraphPaths(root, ["requirements/Alpha.md"]);
    const journalPath = path.join(root, ".knowledge-rail", "graph-delta.jsonl");
    await fs.appendFile(journalPath, "{\"payload\":");
    clear(root);
    const restored = await getRuntimeWikiGraph(root, false, { persist: false });
    assert.equal(restored.graph.nodes.some((node) => node.label === "Alpha journal"), true);
    assert.equal(getWikiGraphDiagnostics(root)?.recovery, "restored");
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("newline-terminated malformed graph journal falls back cold without rewriting artifacts", async () => {
  const root = await fixture();
  try {
    await getRuntimeWikiGraph(root, true);
    const journalPath = path.join(root, ".knowledge-rail", "graph-delta.jsonl");
    const malformed = "{}\n";
    await fs.writeFile(journalPath, malformed);
    clear(root);
    const rebuilt = await getRuntimeWikiGraph(root, false, { persist: false });
    assert.equal(rebuilt.graph.nodes.length > 0, true);
    assert.equal(getWikiGraphDiagnostics(root)?.fallbackReason, "graph_journal_malformed");
    assert.equal(await fs.readFile(journalPath, "utf8"), malformed);
  } finally {
    clear(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});
