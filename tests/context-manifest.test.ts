import assert from "node:assert/strict";
import { test } from "node:test";
import type { RetrievalHit } from "../src/core/retrieval-index.js";
import { segmentMarkdown, type WikiPageRecord } from "../src/core/page-record.js";
import {
  buildRetrievalContextManifest,
  estimateContextSize,
} from "../src/context/context-manifest.js";
import { isWikiPassageId, wikiPassageId } from "../src/context/passage-id.js";
import {
  parseWikiResourceUri,
  wikiPageUri,
  wikiPassageUri,
} from "../src/context/resource-uri.js";

function record(path: string, title: string, body: string): WikiPageRecord {
  const passages = segmentMarkdown(body);
  return {
    path,
    mtimeMs: 1,
    size: Buffer.byteLength(body, "utf8"),
    title,
    type: "requirement",
    tags: ["test"],
    aliases: [],
    sources: ["docs/client/spec.md"],
    body,
    raw: body,
    passages,
    tokenCount: 20,
  };
}

function hit(page: WikiPageRecord, heading: string, score: number): RetrievalHit {
  const passage = page.passages.find((candidate) => candidate.heading === heading);
  assert.ok(passage);
  return {
    path: page.path,
    title: page.title,
    type: page.type,
    tags: page.tags,
    sources: page.sources,
    score,
    excerpt: passage.text,
    heading: passage.heading,
    record: page,
  };
}

test("passage ids are content-addressed, order-independent and change with evidence", () => {
  const first = { heading: "Vincoli", text: "Il processo deve restare asincrono." };
  const same = { heading: "Vincoli", text: "Il processo deve restare asincrono." };
  const changed = { heading: "Vincoli", text: "Il processo deve restare sincrono." };

  const id = wikiPassageId(first);
  assert.equal(isWikiPassageId(id), true);
  assert.equal(wikiPassageId(same), id);
  assert.notEqual(wikiPassageId(changed), id);
});

test("page and passage URIs round-trip Unicode paths without traversal ambiguity", () => {
  const path = "requirements/Processo Fatture_è.md";
  const passageId = wikiPassageId({ heading: "Regola", text: "Approvazione obbligatoria." });

  const pageUri = wikiPageUri(path);
  assert.deepEqual(parseWikiResourceUri(pageUri), { path });

  const passageUri = wikiPassageUri(path, passageId);
  assert.deepEqual(parseWikiResourceUri(passageUri), { path, passageId });
  assert.throws(() => wikiPageUri("../secret.md"), /Invalid wiki resource path/);
  assert.throws(
    () => parseWikiResourceUri("knowledge-rail://page/requirements%2Fsecret.md"),
    /Encoded path separators/
  );
  assert.throws(
    () => parseWikiResourceUri(`${pageUri}?unexpected=true`),
    /Unsupported wiki resource URI parameter/
  );
});

test("context size distinguishes exact bytes from heuristic token estimate", () => {
  const size = estimateContextSize("fattura è ✅");
  assert.equal(size.characters, 11);
  assert.equal(size.utf8Bytes > size.characters, true);
  assert.equal(size.heuristicTokens, Math.ceil(size.utf8Bytes / 3));
  assert.equal(size.estimator, "utf8-bytes-div-3-v1");
});

test("retrieval manifest exposes compact passage evidence instead of page bodies", () => {
  const page = record(
    "requirements/REQ_42.md",
    "REQ-42 Approvazione",
    "# Requisito\n\nContesto generale.\n\n## Criteri\n\nOgni approvazione deve registrare utente, ruolo, timestamp e motivazione nel registro audit."
  );
  const manifest = buildRetrievalContextManifest({
    intent: "modify",
    objective: "Modificare il processo di approvazione",
    hits: [hit(page, "Criteri", 8.5)],
  });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.evidence.length, 1);
  const evidence = manifest.evidence[0]!;
  assert.equal(evidence.path, page.path);
  assert.equal(evidence.heading, "Criteri");
  assert.equal(evidence.passageId !== undefined, true);
  assert.equal(evidence.uri.includes("?passage=p-"), true);
  assert.equal(evidence.pageUri, wikiPageUri(page.path));
  assert.equal(evidence.preview.includes("Ogni approvazione"), true);
  assert.equal(evidence.preview.length < page.body.length, true);
  assert.equal(manifest.gaps.length, 0);
});

test("a relevant hit without a reliable passage falls back to its one bounded page", () => {
  const page = record(
    "decisions/PaymentRetry.md",
    "Payment retry decision",
    "# Payment retry\n\nUse stable keys.\n\n## Rationale\n\nRetries must remain idempotent."
  );
  const unresolved = {
    ...hit(page, "Payment retry", 1),
    heading: "",
    excerpt: "",
  };

  const manifest = buildRetrievalContextManifest({
    intent: "understand",
    objective: "Understand payment retry decisions",
    hits: [unresolved],
  });

  assert.equal(manifest.evidence.length, 1);
  assert.equal(manifest.evidence[0]?.uri, wikiPageUri(page.path));
  assert.equal(manifest.evidence[0]?.passageId, undefined);
});

test("manifest budget omits extra evidence and declares the limitation", () => {
  const first = record(
    "requirements/REQ_A.md",
    "Requirement A",
    "# Requirement\n\nA.\n\n## Evidence A\n\n" + "alpha evidence ".repeat(30)
  );
  const second = record(
    "decisions/DEC_B.md",
    "Decision B",
    "# Decision\n\nB.\n\n## Evidence B\n\n" + "beta evidence ".repeat(30)
  );
  const firstHit = hit(first, "Evidence A", 10);
  const secondHit = hit(second, "Evidence B", 9);

  const single = buildRetrievalContextManifest({
    intent: "understand",
    objective: "Understand evidence",
    hits: [firstHit],
    heuristicTokenBudget: 10_000,
  });
  const constrained = buildRetrievalContextManifest({
    intent: "understand",
    objective: "Understand evidence",
    hits: [firstHit, secondHit],
    heuristicTokenBudget: single.size.heuristicTokens,
  });

  assert.equal(constrained.evidence.length <= 1, true);
  assert.equal(constrained.gaps.some((gap) => gap.kind === "budget_limited"), true);
});
