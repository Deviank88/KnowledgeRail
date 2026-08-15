import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAiCompatibleEmbeddingProvider } from "../src/core/semantic/provider.js";

test("OpenAI-compatible provider supports local endpoints without provider-specific request fields", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [1, 0, 0, 0] },
        { index: 1, embedding: [0, 1, 0, 0] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "nomic-embed-text",
      modelVersion: "2026-08",
      dimensions: 4,
      apiKey: "local-token",
    });
    const vectors = await provider.embedDocuments(["alpha", "beta"]);
    assert.deepEqual(vectors, [[1, 0, 0, 0], [0, 1, 0, 0]]);
    assert.equal(requestedUrl, "http://127.0.0.1:11434/v1/embeddings");
    assert.deepEqual(requestedBody, {
      model: "nomic-embed-text",
      input: ["alpha", "beta"],
    });
    assert.equal(authorization, "Bearer local-token");
    assert.equal(provider.descriptor.version, "2026-08");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("embedding provider validates endpoint safety and response dimensions", async () => {
  assert.throws(() => new OpenAiCompatibleEmbeddingProvider({
    baseUrl: "https://user:secret@example.test/v1",
    model: "embed",
    dimensions: 4,
  }), /without credentials/);

  const previousFetch = globalThis.fetch;
  let embedding = [1, 0];
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ index: 0, embedding }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://embeddings.example.test/v1",
      model: "embed",
      dimensions: 4,
    });
    await assert.rejects(() => provider.embedQuery("query"), /dimension mismatch/);
    embedding = [0, 0, 0, 0];
    await assert.rejects(() => provider.embedQuery("query"), /zero-magnitude/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
