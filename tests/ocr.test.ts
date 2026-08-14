import assert from "node:assert/strict";
import { test } from "node:test";
import { callGlmOcrBase64, processPdfOllama } from "../src/services/ocr.js";

test("callGlmOcrBase64 retries transient failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new Error("temporary");
    return new Response(JSON.stringify({ model: "m", response: " ok ", done: true }));
  }) as typeof fetch;

  try {
    const text = await callGlmOcrBase64("abc", "prompt", "http://ollama", "m", {
      retries: 1,
      timeoutMs: 1000,
    });
    assert.equal(text, "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processPdfOllama can continue after a failed page", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new Error("page failed");
    return new Response(JSON.stringify({ model: "m", response: "page ok", done: true }));
  }) as typeof fetch;

  try {
    const text = await processPdfOllama("fake.pdf", "prompt", "http://ollama", "m", {
      continueOnPageError: true,
      timeoutMs: 1000,
      renderPdf: async () => [
        { content: Buffer.from("one") },
        { content: Buffer.from("two") },
      ],
    });

    assert.equal(text.includes("OCR summary: 1/2 pages succeeded, 1 failed"), true);
    assert.equal(text.includes("OCR failed: page failed"), true);
    assert.equal(text.includes("page ok"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
