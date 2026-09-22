import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { codeEfficiencyHarness } from "../benchmarks/code-efficiency-harness.js";
import { registerWikiResources } from "../src/tools/resources.js";
import { createWorkspaceContext, runWithWorkspaceContext } from "../src/core/workspace-context.js";
import { wikiPageUri } from "../src/context/resource-uri.js";
import { buildRetrievalContextManifest } from "../src/context/context-manifest.js";
import { searchRetrievalIndex } from "../src/core/retrieval-index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

for (const bound of [false, true]) test(`MCP reads whole wiki pages and passages with workspace binding=${bound}`, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-wiki-resource-protocol-")), wikiRoot = join(root, "wiki");
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(join(wikiRoot, "requirements"), { recursive: true });
  await fs.writeFile(join(wikiRoot, "requirements/Shipping.md"), '---\ntitle: Shipping policy\ntype: requirement\nsources: ["policy/shipping.md"]\n---\n# Shipping policy\nTwo approvals are required.\n\n## Verification\nDispatch stays blocked without approval.');
  const context = createWorkspaceContext(root);
  const harness = await codeEfficiencyHarness(() => {
    const server = new McpServer({ name: "wiki-resource-test", version: "1" });
    registerWikiResources(server, { includeWorkspaceBinding: bound });
    return server;
  });
  t.after(() => harness.close());
  const hits = await searchRetrievalIndex({ wikiRoot, query: "Shipping policy approvals", maxResults: 1 });
  const manifest = buildRetrievalContextManifest({ intent: "understand", objective: "Shipping approvals", hits });
  const passage = manifest.evidence[0]!.uri;
  assert.ok(passage.includes("?passage="));
  for (const original of [wikiPageUri("requirements/Shipping.md"), passage]) {
    const uri = new URL(original);
    if (bound) uri.searchParams.set("workspace_binding", "test-binding");
    const read = await runWithWorkspaceContext(context, () => harness.request("resources/read", { uri: uri.href }));
    const text = (read.contents as Array<{ text: string }>)[0]!.text;
    assert.ok(text.includes("Two approvals are required."));
    if (!original.includes("?")) assert.ok(text.includes("policy/shipping.md"), "whole pages preserve document provenance");
  }
  await assert.rejects(runWithWorkspaceContext(context, () => harness.request("resources/read", {
    uri: wikiPageUri("requirements/Shipping.md") + (bound ? "?workspace_binding=test-binding&unexpected=1" : "?unexpected=1"),
  })), /Unsupported|not found/);
});
