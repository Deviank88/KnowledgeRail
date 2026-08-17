import assert from "node:assert/strict";
import { test } from "node:test";
import type { SeededGraphQueryResult } from "../src/core/graph-runtime.js";
import { parseWikiPageRecord } from "../src/core/page-record.js";
import type { RetrievalHit } from "../src/core/retrieval-index.js";
import {
  assessRetrievalCoverage,
  extractQueryEntities,
  semanticCoverageQueries,
} from "../src/core/retrieval-coverage.js";

function hit(
  index: number,
  body: string,
  options: { title?: string; type?: string; tags?: string[] } = {}
): RetrievalHit {
  const pagePath = `concepts/Page_${index}.md`;
  const title = options.title ?? `Page ${index}`;
  const type = options.type ?? "concept";
  const tags = options.tags ?? [];
  const raw = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    `tags: [${tags.join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n");
  const record = parseWikiPageRecord(pagePath, raw, { mtimeMs: 0, size: raw.length });
  return {
    path: pagePath,
    title,
    type,
    tags,
    sources: [],
    score: 1 / index,
    heading: title,
    excerpt: body,
    record,
  };
}

function graphResult(): SeededGraphQueryResult {
  return {
    graph: { version: 2, generatedAt: "", nodes: [], edges: [], warnings: [] },
    nodes: [],
    edges: [],
    seedNodeIds: [],
    stats: {
      seedCount: 0,
      visitedNodes: 0,
      visitedEdges: 0,
      emittedNodes: 0,
      emittedEdges: 0,
      maxDepthReached: 0,
      truncatedFrontierCount: 0,
    },
  };
}

test("entity extraction ignores task verbs and ordinary slash-separated prose", () => {
  const entities = extractQueryEntities(
    "Spiegare i Lease nel progetto SilverFir: data model, automazioni/componenti, test e rilasci per Asset__c REQ-808 /services/data/v1"
  );

  assert.equal(entities.includes("Spiegare"), false);
  assert.equal(entities.includes("automazioni/componenti"), false);
  assert.equal(entities.includes("Lease"), true);
  assert.equal(entities.includes("SilverFir"), false, "project scope labels must not become retrieval entities");
  assert.equal(entities.includes("Asset__c"), true);
  assert.equal(entities.includes("REQ-808"), true);
  assert.equal(entities.includes("/services/data/v1"), true);
  assert.equal(extractQueryEntities("SilverFir Lease lifecycle").includes("SilverFir"), true);
  assert.equal(extractQueryEntities("Checkout loads the next page").includes("Checkout"), false);

  const guidedTaskEntities = extractQueryEntities(
    "Capire il funzionamento dei lease nel progetto SilverFir, includendo data model, automazioni e componenti, validazioni, test e rilasci, evidenziando limiti e gap documentali."
  );
  assert.equal(guidedTaskEntities.includes("Capire"), false);
  assert.equal(guidedTaskEntities.includes("lease"), true);
  assert.equal(guidedTaskEntities.includes("SilverFir"), false);
});

test("single-word proper nouns remain coverage entities without substring matches", () => {
  const entities = extractQueryEntities("Explain Payment and System behavior");
  assert.equal(entities.includes("Explain"), false);
  assert.equal(entities.includes("Payment"), true);
  assert.equal(entities.includes("System"), true);

  const substringOnly = assessRetrievalCoverage({
    query: "Explain Payment behavior",
    hits: [hit(1, "Prepayment behavior is documented for the invoice worker.")],
    graphResult: graphResult(),
  });
  assert.equal(substringOnly.unresolvedEntities.includes("Payment"), true);
  assert.equal(substringOnly.evidenceGaps.includes("entity:Payment"), true);

  const exact = assessRetrievalCoverage({
    query: "Explain Payment behavior",
    hits: [hit(1, "Payment behavior is documented for the invoice worker.")],
    graphResult: graphResult(),
  });
  assert.equal(exact.unresolvedEntities.includes("Payment"), false);
});

test("coverage uses the full candidate set and labels display exclusions as budget limited", () => {
  const displayed = Array.from({ length: 8 }, (_, index) =>
    hit(index + 1, "Unrelated archival notes about billing."));
  const rankNine = hit(9, "The service is deployed safely through a staged rollout.");
  const coverage = assessRetrievalCoverage({
    query: "deployment",
    hits: [...displayed, rankNine],
    displayHits: displayed,
    graphResult: graphResult(),
  });

  assert.equal(coverage.coverageMode, "lexical");
  assert.equal(coverage.evidenceGaps.includes("query_facets"), false);
  assert.equal(coverage.evidenceGaps.includes("passage_evidence"), false);
  assert.equal(coverage.budgetLimitedGaps.includes("query_facets"), true);
  assert.equal(coverage.budgetLimitedGaps.includes("passage_evidence"), true);
  assert.equal(coverage.sufficient, true, "the complete pool remains the missing-evidence oracle");
  assert.equal(coverage.displaySufficient, false, "display coverage must remain visibly insufficient");
});

test("lexical coverage tolerates entity delimiters and classifier page-type equivalences", () => {
  const request = hit(1, "Order Service stores the approved behavior.", {
    title: "Order Service request",
    type: "request",
  });
  const coverage = assessRetrievalCoverage({
    query: "OrderService",
    hits: [request],
    graphResult: graphResult(),
    requirements: { requiredPageTypes: ["requirement"] },
  });

  assert.deepEqual(coverage.unresolvedEntities, []);
  assert.equal(coverage.unresolvedRelations.includes("required_type:requirement"), false);
  assert.equal(coverage.sufficient, true);
});

test("semantic scores cover paraphrase facets while preserving entity and type equivalences", () => {
  const request = hit(1, "Authentication is enforced for the Order Service.", {
    title: "Order Service request",
    type: "request",
  });
  const requirements = { requiredPageTypes: ["requirement"] } as const;
  const lexical = assessRetrievalCoverage({
    query: "auth OrderService",
    hits: [request],
    graphResult: graphResult(),
    requirements,
  });
  assert.equal(lexical.evidenceGaps.includes("query_facets"), true);

  const semanticScores = semanticCoverageQueries("auth OrderService", requirements).map((query) => ({
    id: query.id,
    pages: [{ pagePath: request.path, score: 0.95 }],
  }));
  const semantic = assessRetrievalCoverage({
    query: "auth OrderService",
    hits: [request],
    graphResult: graphResult(),
    requirements,
    coverageMode: "semantic",
    semanticScores,
  });

  assert.equal(semantic.coverageMode, "semantic");
  assert.deepEqual(semantic.evidenceGaps, []);
  assert.equal(semantic.sufficient, true);
});
