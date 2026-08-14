import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDocxText } from "../src/docx/text.js";

test("normalizeDocxText preserves accents and applies Italian typography for Word export", () => {
  assert.equal(
    normalizeDocxText("Qual'è un pò perchè l'utente -> valore"),
    "Qual è un po’ perché l’utente → valore"
  );
});

test("normalizeDocxText can skip typography for code blocks", () => {
  assert.equal(
    normalizeDocxText("if (a -> b) return 'x'", { typography: false }),
    "if (a -> b) return 'x'"
  );
});
