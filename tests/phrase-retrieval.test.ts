import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  orderedWordBigrams,
  scoreBigramRerankCandidate,
  scoreOrderedPhrase,
  scoreOrderedPhraseSegments,
  surfacePhraseTokens,
} from "../src/core/phrase-scoring.js";
import {
  clearRetrievalIndexes,
  refreshRetrievalIndex,
  searchRetrievalIndex,
  updateRetrievalPaths,
  type PhraseRerankDiagnostics,
} from "../src/core/retrieval-index.js";

async function writePage(
  root: string,
  relativePath: string,
  passages: readonly { heading: string; text: string }[]
): Promise<void> {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---",
    "title: Phrase fixture",
    "type: analysis",
    "tags: [phrase-test]",
    "sources: []",
    "---",
    "",
    ...passages.flatMap((passage) => [`## ${passage.heading}`, "", passage.text, ""]),
  ].join("\n"));
}

test("ordered surface tokens preserve identifiers and remain newline deterministic", () => {
  const query = surfacePhraseTokens("POST /v2/invoices HTTP 429 Retry-After");
  assert.deepEqual(query, ["post", "/v2/invoices", "http", "429", "retry-after"]);
  assert.equal(query.includes("retry"), false, "compound identifiers must not be expanded in phrase order");
  const bigrams = orderedWordBigrams(surfacePhraseTokens("modalità sicura"));
  assert.deepEqual(
    scoreOrderedPhrase(bigrams, "La modalita\r\nsicura è attiva."),
    scoreOrderedPhrase(bigrams, "La modalità\nsicura è attiva.")
  );
});

test("phrase scoring deduplicates query grams and title/passage matches", () => {
  const repeated = orderedWordBigrams(surfacePhraseTokens("alpha beta alpha beta"));
  assert.deepEqual(
    scoreOrderedPhrase(repeated, "alpha beta"),
    { matchedBigrams: 1, queryBigrams: 2 }
  );
  assert.deepEqual(
    scoreOrderedPhraseSegments(["alpha\u0001beta"], ["alpha beta", "alpha beta"]),
    { matchedBigrams: 1, queryBigrams: 1 }
  );
});

test("protected identifiers are strictly above the maximum unprotected phrase score", () => {
  const unprotected = scoreBigramRerankCandidate({
    baseScore: 10, minimumBaseScore: 0, maximumBaseScore: 10,
    matchedBigrams: 2, queryBigramCount: 2,
  });
  const protectedMinimum = scoreBigramRerankCandidate({
    baseScore: 0, minimumBaseScore: 0, maximumBaseScore: 10,
    matchedBigrams: 0, queryBigramCount: 2, exactIdentifierMatch: true,
  });
  assert.equal(protectedMinimum > unprotected, true);
});

test("production bigram reranking changes only the bounded BM25 ordering and explains the change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-rank-"));
  try {
    await writePage(root, "pairs/a-decoy.md", [{ heading: "Sequence", text: "alpha gamma beta" }]);
    await writePage(root, "pairs/b-relevant.md", [{ heading: "Sequence", text: "alpha beta gamma" }]);
    clearRetrievalIndexes();
    const baseline = await searchRetrievalIndex({
      wikiRoot: root,
      query: "alpha beta gamma",
      maxResults: 2,
      phraseRerank: false,
      persist: false,
    });
    let diagnostics: PhraseRerankDiagnostics | undefined;
    const reranked = await searchRetrievalIndex({
      wikiRoot: root,
      query: "alpha beta gamma",
      maxResults: 2,
      phraseRerank: true,
      persist: false,
      onPhraseDiagnostics: (value) => { diagnostics = value; },
    });
    assert.equal(baseline[0]?.path, "pairs/a-decoy.md", "BM25 tie must retain path order");
    assert.equal(reranked[0]?.path, "pairs/b-relevant.md");
    assert.equal(diagnostics?.enabled, true);
    assert.equal(diagnostics?.candidateCount, 2);
    assert.equal(diagnostics?.rescoredCount, 2);
    assert.deepEqual(diagnostics?.rankChanges.map((change) => change.path).sort(), [
      "pairs/a-decoy.md",
      "pairs/b-relevant.md",
    ]);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("page reranking and passage selection share the ordered bigram signal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-passage-"));
  try {
    await writePage(root, "pairs/page.md", [
      { heading: "Wrong order", text: "alpha gamma beta" },
      { heading: "Right order", text: "alpha beta gamma" },
    ]);
    clearRetrievalIndexes();
    const baseline = await searchRetrievalIndex({
      wikiRoot: root,
      query: "alpha beta gamma",
      phraseRerank: false,
      persist: false,
    });
    const reranked = await searchRetrievalIndex({
      wikiRoot: root,
      query: "alpha beta gamma",
      phraseRerank: true,
      persist: false,
    });
    assert.equal(baseline[0]?.heading, "Wrong order");
    assert.equal(reranked[0]?.heading, "Right order");
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("one marginal bigram cannot outrank complete lexical evidence in a noisy pool", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-noisy-"));
  try {
    await writePage(root, "pairs/a-relevant.md", [{
      heading: "Complete evidence",
      text: "alpha noise beta noise gamma noise delta noise epsilon noise zeta",
    }]);
    await writePage(root, "pairs/b-marginal.md", [{
      heading: "Marginal coincidence",
      text: "alpha beta unrelated",
    }]);
    await Promise.all(Array.from({ length: 198 }, (_, index) => writePage(
      root,
      `noise/noise-${String(index).padStart(3, "0")}.md`,
      [{ heading: "Noise", text: `alpha unrelated filler-${index}` }]
    )));
    clearRetrievalIndexes();
    const baseline = await searchRetrievalIndex({
      wikiRoot: root,
      query: "alpha beta gamma delta epsilon zeta",
      maxResults: 160,
      phraseRerank: false,
      persist: false,
    });
    let diagnostics: PhraseRerankDiagnostics | undefined;
    const reranked = await searchRetrievalIndex({
      wikiRoot: root,
      query: "alpha beta gamma delta epsilon zeta",
      maxResults: 160,
      phraseRerank: true,
      persist: false,
      onPhraseDiagnostics: (value) => { diagnostics = value; },
    });
    assert.equal(baseline[0]?.path, "pairs/a-relevant.md");
    assert.equal(reranked[0]?.path, "pairs/a-relevant.md");
    assert.equal(diagnostics?.enabled, true, "hybrid widening pools must retain phrase scoring");
    assert.equal(diagnostics?.candidateCount, 200);
    assert.equal(diagnostics?.rescoredCount, 200);
    assert.equal(
      diagnostics?.rankChanges.some((change) =>
        change.path === "pairs/b-marginal.md" && change.rerankedRank === 1
      ),
      false
    );
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("phrase reranking cannot displace a page matching every strong technical identifier", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-identifier-"));
  try {
    await writePage(root, "pairs/a-protected.md", [
      { heading: "Identifiers", text: "REQ-771 is documented separately from the HTTP response code 429." },
    ]);
    await writePage(root, "pairs/b-phrase-decoy.md", [
      { heading: "Response", text: "An unrelated endpoint returns HTTP 429." },
    ]);
    clearRetrievalIndexes();
    let diagnostics: PhraseRerankDiagnostics | undefined;
    const result = await searchRetrievalIndex({
      wikiRoot: root,
      query: "REQ-771 HTTP 429",
      maxResults: 2,
      phraseRerank: true,
      persist: false,
      onPhraseDiagnostics: (value) => { diagnostics = value; },
    });
    assert.equal(result[0]?.path, "pairs/a-protected.md");
    assert.equal(diagnostics?.protectedIdentifierCount, 2);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("identifier-heavy lookups retain lexical passage selection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-heavy-identifiers-"));
  try {
    await writePage(root, "requirements/REQ_771.md", [
      { heading: "REQ-771", text: "Tenant ALPHA-42 may issue 240 signed requests." },
      { heading: "Rejection", text: "The gateway returns HTTP 429 with Retry-After." },
    ]);
    clearRetrievalIndexes();
    let diagnostics: PhraseRerankDiagnostics | undefined;
    const result = await searchRetrievalIndex({
      wikiRoot: root,
      query: "REQ-771 ALPHA-42 240 HTTP 429 Retry-After",
      phraseRerank: true,
      persist: false,
      onPhraseDiagnostics: (value) => { diagnostics = value; },
    });
    assert.equal(result[0]?.heading, "REQ-771");
    assert.equal(diagnostics?.enabled, false);
    assert.equal(diagnostics?.protectedIdentifierCount, 5);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cached phrase evidence supports different queries and follows updates and checkpoint reloads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-cache-"));
  const relativePath = "pairs/page.md";
  const search = (query: string) => searchRetrievalIndex({ wikiRoot: root, query, phraseRerank: true });
  try {
    await writePage(root, relativePath, [
      { heading: "First", text: "alpha beta gamma" },
      { heading: "Second", text: "gamma beta alpha" },
    ]);
    clearRetrievalIndexes();
    assert.equal((await search("alpha beta"))[0]?.heading, "First");
    assert.equal((await search("beta alpha"))[0]?.heading, "Second");
    assert.equal((await search("alpha beta alpha beta"))[0]?.heading, "First");

    await writePage(root, relativePath, [
      { heading: "First", text: "gamma beta alpha" },
      { heading: "Second", text: "alpha beta gamma" },
    ]);
    await updateRetrievalPaths(root, [relativePath]);
    const updated = await search("alpha beta");
    assert.equal(updated[0]?.heading, "Second");
    assert.equal((await search("beta alpha"))[0]?.heading, "First");
    clearRetrievalIndexes();
    const restored = await search("alpha beta");
    assert.equal(restored[0]?.heading, updated[0]?.heading);
    assert.equal(restored[0]?.score, updated[0]?.score);
    assert.equal(restored[0]?.excerpt, updated[0]?.excerpt);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("phrase cache stays bounded and eviction preserves exact search results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-budget-"));
  try {
    for (let index = 0; index < 60; index++) {
      await writePage(root, `pairs/page-${String(index).padStart(2, "0")}.md`, [{
        heading: "Evidence",
        text: `alpha beta ${Array.from({ length: 512 }, (_, word) => `word${index}x${word}`).join(" ")}`,
      }]);
    }
    clearRetrievalIndexes();
    const params = { wikiRoot: root, query: "alpha beta", maxResults: 60, persist: false };
    const first = await searchRetrievalIndex(params);
    const state = await refreshRetrievalIndex(root, { persist: false });
    assert.ok(state.phraseCache.size > 0 && state.phraseCache.size < 60, "the corpus must exceed the cache budget");
    assert.ok(state.phraseCacheBytes <= 2 * 1024 * 1024);
    const second = await searchRetrievalIndex(params);
    assert.deepEqual(second, first, "recomputing evicted evidence must preserve scores, order and passages");
    assert.ok(state.phraseCacheBytes <= 2 * 1024 * 1024);

    await writePage(root, "pairs/oversized.md", [{
      heading: "Large evidence",
      text: `alpha beta ${Array.from({ length: 30_000 }, (_, word) => `oversizedword${word}`).join(" ")}`,
    }]);
    await updateRetrievalPaths(root, ["pairs/oversized.md"]);
    const large = await searchRetrievalIndex({ ...params, maxResults: 100 });
    assert.ok(large.some((hit) => hit.path === "pairs/oversized.md"));
    assert.equal(state.phraseCache.has("pairs/oversized.md"), false, "oversized records remain searchable without cache admission");
    assert.ok(state.phraseCacheBytes <= 2 * 1024 * 1024);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});
