import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readWikiPageRecord } from "../src/core/page-record.js";
import { PersistentSemanticIndex, semanticIndexFile } from "../src/core/semantic/index.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";

const DIMENSIONS = 32;

class CountingEmbeddingProvider implements EmbeddingProvider {
  documentInputs: string[] = [];
  queryInputs: string[] = [];

  constructor(readonly descriptor = {
    id: "deterministic-test-provider",
    model: "golden-hash-embedding",
    version: "1",
    dimensions: DIMENSIONS,
  }) {}

  private vector(text: string): number[] {
    const digest = createHash("sha256").update(text.normalize("NFKC")).digest();
    return Array.from({ length: this.descriptor.dimensions }, (_, index) =>
      (digest[index % digest.length]! - 127.5) / 127.5
    );
  }

  async embedDocuments(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.documentInputs.push(...texts);
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<readonly number[]> {
    this.queryInputs.push(text);
    return this.vector(text);
  }
}

async function writePage(wikiRoot: string, relPath: string, title: string, body: string): Promise<void> {
  const file = path.join(wikiRoot, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    "---",
    `title: "${title}"`,
    "type: requirement",
    "tags: [semantic-test]",
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n"), "utf8");
}

async function records(wikiRoot: string, paths: readonly string[]) {
  const result = await Promise.all(paths.map((relPath) => readWikiPageRecord(wikiRoot, relPath)));
  return result.filter((record): record is NonNullable<typeof record> => record !== null);
}

test("LSH ANN performs bounded deterministic candidate retrieval", () => {
  const engine = new LshAnnEngine({
    dimensions: 4,
    tables: 8,
    bitsPerTable: 4,
    probes: 3,
    minimumScore: 0.6,
    seed: "semantic-index-test",
  });
  engine.rebuild([
    { id: "alpha", vector: [1, 0, 0, 0] },
    { id: "beta", vector: [0, 1, 0, 0] },
    { id: "gamma", vector: [0, 0, 1, 0] },
  ]);

  const first = engine.search([1, 0, 0, 0], 2);
  const second = engine.search([1, 0, 0, 0], 2);
  assert.deepEqual(first, second);
  assert.equal(first.hits[0]?.id, "alpha");
  assert.equal(first.hits[0]?.score, 1);
  assert.equal(first.diagnostics.vectorCount, 3);
  assert.equal(first.diagnostics.visitedBuckets, 24);
  assert.equal(first.diagnostics.candidateCount <= first.diagnostics.vectorCount, true);
});

test("semantic passage index is derived, incremental, versioned and leaves Markdown untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-semantic-index-"));
  const wikiRoot = path.join(root, "wiki");
  const pagePaths = ["requirements/Alpha.md", "requirements/Beta.md"];

  try {
    await writePage(wikiRoot, pagePaths[0]!, "Alpha policy", "Requests use adaptive admission control.");
    await writePage(wikiRoot, pagePaths[1]!, "Beta policy", "Audit events remain immutable.");
    const canonicalBefore = await Promise.all(pagePaths.map((relPath) =>
      fs.readFile(path.join(wikiRoot, relPath), "utf8")
    ));

    const provider = new CountingEmbeddingProvider();
    const index = new PersistentSemanticIndex(wikiRoot, provider);
    const initial = await index.synchronize(await records(wikiRoot, pagePaths));
    assert.equal(initial.embeddedPages, 2);
    assert.equal(initial.embeddedPassages, provider.documentInputs.length);
    assert.deepEqual(await Promise.all(pagePaths.map((relPath) =>
      fs.readFile(path.join(wikiRoot, relPath), "utf8")
    )), canonicalBefore);

    const snapshot = JSON.parse(await fs.readFile(semanticIndexFile(wikiRoot), "utf8")) as {
      provider: { model: string; version: string };
      pages: unknown[];
      passages: unknown[];
    };
    assert.deepEqual(snapshot.provider, {
      id: "deterministic-test-provider",
      model: "golden-hash-embedding",
      version: "1",
      dimensions: DIMENSIONS,
    });
    assert.equal(snapshot.pages.length, 2);
    assert.equal(snapshot.passages.length, provider.documentInputs.length);

    const coverageQueries = [
      { id: "facet:0", text: "adaptive admission" },
      { id: "type:0", text: "requirement specification" },
    ];
    const firstCoverage = await index.assessCoverage(coverageQueries, pagePaths);
    const secondCoverage = await index.assessCoverage(coverageQueries, [...pagePaths].reverse());
    assert.deepEqual(secondCoverage, firstCoverage, "semantic coverage scores must be deterministic");
    assert.equal(provider.queryInputs.length, coverageQueries.length);
    assert.equal(firstCoverage.every((score) => score.pages.length === 2), true);

    const warmProvider = new CountingEmbeddingProvider();
    const warmIndex = new PersistentSemanticIndex(wikiRoot, warmProvider);
    const warm = await warmIndex.synchronize(await records(wikiRoot, pagePaths));
    assert.equal(warm.reusedPages, 2);
    assert.equal(warmProvider.documentInputs.length, 0, "unchanged passages must reuse derived vectors");

    await writePage(wikiRoot, pagePaths[0]!, "Alpha policy", "Requests use predictive load shedding.");
    const incremental = await warmIndex.synchronize(await records(wikiRoot, pagePaths));
    assert.equal(incremental.embeddedPages, 1);
    assert.equal(incremental.reusedPages, 1);

    await fs.unlink(path.join(wikiRoot, pagePaths[1]!));
    const removed = await warmIndex.synchronize(await records(wikiRoot, [pagePaths[0]!]));
    assert.equal(removed.removedPages, 1);
    assert.equal(warmIndex.descriptor.pageCount, 1);

    const canonicalBeforeVersionChange = await fs.readFile(path.join(wikiRoot, pagePaths[0]!), "utf8");
    const changedProvider = new CountingEmbeddingProvider({
      id: "deterministic-test-provider",
      model: "golden-hash-embedding",
      version: "2",
      dimensions: DIMENSIONS,
    });
    const rebuilt = new PersistentSemanticIndex(wikiRoot, changedProvider);
    const versionChange = await rebuilt.synchronize(await records(wikiRoot, [pagePaths[0]!]));
    assert.equal(versionChange.embeddedPages, 1, "model version changes must rebuild derived embeddings");
    assert.equal(changedProvider.documentInputs.length > 0, true);
    assert.equal(
      await fs.readFile(path.join(wikiRoot, pagePaths[0]!), "utf8"),
      canonicalBeforeVersionChange,
      "re-embedding must never rewrite canonical Markdown"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("semantic index rejects a symlinked derived-index directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-semantic-symlink-"));
  const wikiRoot = path.join(root, "wiki");
  const outside = path.join(root, "outside");
  try {
    await fs.mkdir(wikiRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, path.join(wikiRoot, ".knowledge-rail"), "dir");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (["EPERM", "EACCES", "ENOSYS"].includes(code ?? "")) {
        t.skip(`symlinks unavailable on this platform (${code})`);
        return;
      }
      throw error;
    }
    const index = new PersistentSemanticIndex(wikiRoot, new CountingEmbeddingProvider());
    await assert.rejects(() => index.synchronize([]), /must not be a symbolic link/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
