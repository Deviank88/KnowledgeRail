import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emailDomainsInText,
  normalizeEmailDomain,
  redactEmailAddresses,
  stakeholderAffiliation,
} from "../src/core/stakeholder.js";
import { createEvidenceClaim } from "../src/core/ingestion/evidence-claim.js";

const SEGMENT_ID = "seg-0123456789abcdef01234567";

function stakeholderClaim(options: {
  text: string;
  emailDomain?: string;
  affiliation?: "client" | "internal" | "partner" | "unknown";
  userEmailDomain?: string | null;
}) {
  return createEvidenceClaim({
    sourceUri: "docs/transcripts/customer-call.md",
    segmentId: SEGMENT_ID,
    userEmailDomain: options.userEmailDomain ?? null,
    now: "2026-09-02T10:00:00.000Z",
    input: {
      text: options.text,
      kind: "stakeholder",
      origin: "explicit",
      confidence: 1,
      target: {
        pageTitle: "Jane Doe",
        ...(options.emailDomain ? { emailDomain: options.emailDomain } : {}),
        ...(options.affiliation ? { affiliation: options.affiliation } : {}),
      },
    },
  });
}

test("stakeholder domains normalize case and internationalized labels", () => {
  assert.equal(normalizeEmailDomain("@BÜCHER.Example."), "xn--bcher-kva.example");
  assert.deepEqual(
    emailDomainsInText("Jane <JANE@BÜCHER.Example> and Pat <pat@Internal.Example>"),
    ["internal.example", "xn--bcher-kva.example"]
  );
  assert.equal(normalizeEmailDomain("ПРИМЕР.РФ"), "xn--e1afmkfd.xn--p1ai");
  assert.deepEqual(
    emailDomainsInText("Ivan <ivan@пример.рф>, approved the request."),
    ["xn--e1afmkfd.xn--p1ai"]
  );
  assert.equal(
    redactEmailAddresses("Ask ivan@пример.рф; then archive it."),
    "Ask [email-domain:xn--e1afmkfd.xn--p1ai]; then archive it."
  );
});

test("multiple domains are redacted without guessing one stakeholder domain", () => {
  const claim = stakeholderClaim({
    text: "Jane jane@customer.example joined with Pat pat@partner.example and is explicitly a client stakeholder.",
    affiliation: "client",
  });
  assert.equal(claim.target?.emailDomain, undefined);
  assert.equal(claim.target?.affiliation, "client");
  assert.equal(claim.text.includes("jane@customer.example"), false);
  assert.equal(claim.text.includes("pat@partner.example"), false);
  assert.match(claim.text, /\[email-domain:customer\.example\]/);
  assert.match(claim.text, /\[email-domain:partner\.example\]/);
});

test("explicit client/internal affiliation is retained only when domain comparison is unavailable", () => {
  assert.equal(stakeholderClaim({
    text: "Jane is explicitly identified as a client stakeholder.",
    affiliation: "client",
  }).target?.affiliation, "client");

  assert.equal(stakeholderAffiliation({
    stakeholderEmailDomain: "internal.example",
    userEmailDomain: "internal.example",
    explicitAffiliation: "client",
  }), "internal");
  assert.equal(stakeholderAffiliation({
    userEmailDomain: "internal.example",
    explicitAffiliation: "unknown",
  }), "unknown");
  assert.equal(stakeholderAffiliation({
    stakeholderEmailDomain: "external.example",
    userEmailDomain: "internal.example",
    explicitAffiliation: "partner",
  }), "partner");
});

test("a target domain must be evidenced by the claim", () => {
  assert.throws(() => stakeholderClaim({
    text: "Jane can be reached at jane@source.example.",
    emailDomain: "invented.example",
    userEmailDomain: "internal.example",
  }), /contradicts the email domain/);

  const disambiguated = stakeholderClaim({
    text: "Jane jane@customer.example met Pat pat@partner.example.",
    emailDomain: "customer.example",
    userEmailDomain: "internal.example",
  });
  assert.equal(disambiguated.target?.emailDomain, "customer.example");
  assert.equal(disambiguated.target?.affiliation, "client");
});

test("redaction and normalization reject complete addresses as domains", () => {
  assert.equal(normalizeEmailDomain("jane@example.com"), undefined);
  assert.equal(redactEmailAddresses("Ask JANE@EXAMPLE.COM"), "Ask [email-domain:example.com]");
});
