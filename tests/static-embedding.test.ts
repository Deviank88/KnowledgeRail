import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { StaticEmbeddingProvider, setupStaticModel, type StaticModelSpec } from "../src/core/semantic/static-provider.js";

test("local model2vec pooling is deterministic, hash-verified and identical with an uncached matrix", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kr-static-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: "F32", shape: [4, 2], data_offsets: [0, 32] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  const table = Buffer.alloc(32);
  [0, 0, 1, 0, 0, 1, 1, 1].forEach((v, i) => table.writeFloatLE(v, i * 4));
  const files = {
    "model.safetensors": Buffer.concat([prefix, header, table]),
    "config.json": Buffer.from(JSON.stringify({ model_type: "model2vec", hidden_dim: 2, normalize: true })),
    "tokenizer_config.json": Buffer.from(JSON.stringify({ unk_token: "[UNK]" })),
    "tokenizer.json": Buffer.from(JSON.stringify({ version: "1.0", added_tokens: [], post_processor: null, decoder: { type: "WordPiece", prefix: "##", cleanup: true }, normalizer: { type: "Lowercase" }, pre_tokenizer: { type: "Whitespace" },
      model: { type: "WordPiece", unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100, vocab: { "[UNK]": 0, cat: 1, dog: 2, bird: 3 } } })),
  };
  const hashes = {} as StaticModelSpec["files"];
  for (const [name, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, name), bytes);
    hashes[name as keyof typeof hashes] = createHash("sha256").update(bytes).digest("hex");
  }
  const spec = { revision: "fixture", dimensions: 2, files: hashes };
  const cached = new StaticEmbeddingProvider(directory, "fixture", spec);
  const uncached = new StaticEmbeddingProvider(directory, "fixture", spec, 0);
  const result = await cached.embedDocuments(["CAT dog", "cat cat dog", "dog", "cat unknown"]);
  assert.deepEqual(result, await uncached.embedDocuments(["CAT dog", "cat cat dog", "dog", "cat unknown"]));
  assert.deepEqual(result[2], [0, 1]); assert.deepEqual(result[3], [1, 0]);
  assert.ok(Math.abs(result[1]![0]! - 2 / Math.sqrt(5)) < 1e-12);
  await assert.rejects(cached.embedQuery("unrecognized"), /no known tokens/);
  await fs.appendFile(path.join(directory, "model.safetensors"), "corrupt");
  await assert.rejects(new StaticEmbeddingProvider(directory, "fixture", spec).embedQuery("cat"), /integrity mismatch/);
});

test("semantic setup preview never downloads or creates model assets", async (t) => {
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kr-static-preview-"));
  t.after(() => fs.rm(wikiRoot, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", () => { throw new Error("Preview must never download"); });
  const result = await setupStaticModel(wikiRoot, "potion-multilingual-128M");
  assert.equal(result.downloaded, false);
  assert.equal(result.dimensions, 256);
  assert.deepEqual(await fs.readdir(wikiRoot), []);
});
