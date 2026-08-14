import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createSectionContext, formatSectionContext } from "../src/core/document-workflow.js";
import {
  buildWikiGraph,
  formatGraphQueryResult,
  graphFile,
  graphReportFile,
  queryWikiGraph,
} from "../src/core/graph-index.js";

async function writePage(
  root: string,
  rel: string,
  frontmatter: Record<string, string>,
  body: string
): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const lines = [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    body,
  ];
  await fs.writeFile(abs, lines.join("\n"), "utf-8");
}

test("graph builder derives nodes and traceability edges from markdown metadata", async () => {
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-graph-"));
  await writePage(
    wikiRoot,
    "requests/REQ_1.md",
    {
      title: '"Alpha request"',
      type: "request",
      tags: "[alpha]",
      created: "2026-06-08",
      updated: "2026-06-08",
      sources: '["docs/reports/REQ-1.md"]',
      request_id: '"REQ-1"',
      client: '"Client A"',
      project: '"Project A"',
    },
    "# Alpha request\n\nSee [[Alpha requirement]]."
  );
  await writePage(
    wikiRoot,
    "requirements/Alpha_requirement.md",
    {
      title: '"Alpha requirement"',
      type: "requirement",
      tags: "[alpha, requirement]",
      created: "2026-06-08",
      updated: "2026-06-08",
      sources: '["docs/reports/REQ-1.md"]',
      request_id: '"REQ-1"',
    },
    "# Alpha requirement\n\nRequirement body."
  );
  await writePage(
    wikiRoot,
    "implementations/Alpha_impl.md",
    {
      title: '"Alpha implementation"',
      type: "implementation",
      tags: "[alpha]",
      created: "2026-06-08",
      updated: "2026-06-08",
      sources: '["docs/reports/REQ-1.md"]',
      request_id: '"REQ-1"',
    },
    "# Alpha implementation\n\n[Requirement](../requirements/Alpha_requirement.md)"
  );
  await writePage(
    wikiRoot,
    "tests/Alpha_test.md",
    {
      title: '"Alpha test"',
      type: "test_result",
      tags: "[alpha, test]",
      created: "2026-06-08",
      updated: "2026-06-08",
      sources: '["docs/reports/REQ-1.md"]',
      request_id: '"REQ-1"',
    },
    "# Alpha test\n\nPass."
  );
  await writePage(
    wikiRoot,
    "releases/Alpha_release.md",
    {
      title: '"Alpha release"',
      type: "release",
      tags: "[alpha, release]",
      created: "2026-06-08",
      updated: "2026-06-08",
      sources: '["docs/reports/REQ-1.md"]',
      request_id: '"REQ-1"',
    },
    "# Alpha release\n\nReleased."
  );

  const graph = await buildWikiGraph(wikiRoot);
  assert.equal(graph.nodes.some((node) => node.kind === "client" && node.label === "Client A"), true);
  assert.equal(graph.nodes.some((node) => node.kind === "project" && node.label === "Project A"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "implements"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "tests"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "released_by"), true);
  await fs.access(graphFile(wikiRoot));
  await fs.access(graphReportFile(wikiRoot));

  const query = queryWikiGraph(graph, { query: "Alpha requirement", maxNodes: 4, maxDepth: 1 });
  assert.equal(query.nodes.length <= 4, true);
  assert.equal(formatGraphQueryResult(query).includes("Pagine suggerite"), true);

  const context = await createSectionContext({
    wikiRoot,
    sectionTitle: "Requisiti Alpha",
    query: "implementation",
    maxPages: 2,
    maxCharsPerPage: 200,
    maxTotalChars: 400,
    useGraph: true,
  });
  assert.equal(formatSectionContext(context, "Requisiti Alpha").includes("Sintesi graph-based"), true);
});

