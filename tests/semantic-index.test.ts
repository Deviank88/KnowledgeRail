import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readWikiPageRecord } from "../src/core/page-record.js";
import { PersistentSemanticIndex, semanticIndexFile } from "../src/core/semantic/index.js";
import { LshAnnEngine } from "../src/core/semantic/lsh-engine.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";
import { wikiPassageId } from "../src/context/passage-id.js";

const DIMENSIONS = 32;

class CountingEmbeddingProvider implements EmbeddingProvider {
  documentInputs: string[] = [];
  documentBatches: number[] = [];
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
    this.documentBatches.push(texts.length);
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
    assert.equal(firstCoverage.every((score) =>
      score.pages.every((page) => (page.passages?.length ?? 0) > 0)
    ), true, "coverage must retain per-passage scores as well as page maxima");

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

test("durable batches resume inside a page and a changed page regenerates every passage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-resume-"));
  try {
    const body = Array.from({ length: 130 }, (_, i) => `## Section ${i}\n\nFact number ${i}.`).join("\n\n");
    await writePage(root, "large.md", "Large", body);
    await writePage(root, "stable.md", "Stable", "Unchanged reference.");
    const initialRecords = await records(root, ["large.md", "stable.md"]);
    const abort = new AbortController();
    const provider = new CountingEmbeddingProvider();
    const original = provider.embedDocuments.bind(provider);
    provider.embedDocuments = async (texts) => { const result = await original(texts); abort.abort(); return result; };
    const interrupted = new PersistentSemanticIndex(root, provider);
    await assert.rejects(interrupted.synchronize(initialRecords, { signal: abort.signal }), /abort/i);
    assert.equal(provider.documentInputs.length, 64);
    // A crash leaves a partial frame after the last complete, fsynced batch.
    await fs.appendFile(path.join(root, ".knowledge-rail/semantic-journal.bin"), Buffer.from([12, 0, 0]));
    const resumedProvider = new CountingEmbeddingProvider();
    const resumed = new PersistentSemanticIndex(root, resumedProvider);
    await resumed.synchronize(initialRecords);
    const total = initialRecords.reduce((n, r) => n + r.passages.length, 0);
    assert.equal(resumedProvider.documentInputs.length, total - 64);
    assert.equal(resumed.descriptor.state, "ready");
    await writePage(root, "large.md", "Large", body.replace("Fact number 100.", "Changed fact number 100."));
    const updatedRecords = await records(root, ["large.md", "stable.md"]);
    const before = resumedProvider.documentInputs.length;
    const updated = await resumed.synchronize(updatedRecords);
    assert.equal(updated.embeddedPages, 1);
    assert.equal(updated.reusedPages, 1);
    assert.equal(resumedProvider.documentInputs.length - before, updatedRecords[0]!.passages.length,
      "the whole changed page is regenerated, even where individual passage IDs survive");
    const raw = await fs.readFile(path.join(root, "large.md"), "utf8");
    await fs.writeFile(path.join(root, "large.md"), raw.replace("type: requirement", "type: requirement\ntags: [updated]"));
    const metadataRecords = await records(root, ["large.md", "stable.md"]);
    assert.deepEqual(metadataRecords[0]!.passages, updatedRecords[0]!.passages);
    const beforeMetadata = resumedProvider.documentInputs.length;
    const metadataUpdate = await resumed.synchronize(metadataRecords);
    assert.equal(metadataUpdate.embeddedPages, 1, "canonical metadata changes invalidate the page too");
    assert.equal(resumedProvider.documentInputs.length - beforeMetadata, metadataRecords[0]!.passages.length);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("restart restores identical search and coverage, engine changes reuse embeddings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-parity-"));
  try {
    await writePage(root, "a.md", "Alpha", "Admission policy and limits.");
    const input = await records(root, ["a.md"]);
    const first = new PersistentSemanticIndex(root, new CountingEmbeddingProvider());
    await first.synchronize(input);
    const query = "Alpha\nAdmission policy and limits.";
    const before = await first.search(query, 10);
    const coverage = await first.assessCoverage([{ id: "alpha", text: query }], ["a.md"]);
    const provider = new CountingEmbeddingProvider();
    const restarted = new PersistentSemanticIndex(root, provider);
    await restarted.synchronize(input);
    assert.deepEqual(await restarted.search(query, 10), before);
    assert.deepEqual(await restarted.assessCoverage([{ id: "alpha", text: query }], ["a.md"]), coverage);
    assert.equal(provider.documentInputs.length, 0);
    const changedEngine = new PersistentSemanticIndex(root, provider,
      new LshAnnEngine({ dimensions: DIMENSIONS, seed: "other", tables: 4 }));
    await changedEngine.synchronize(input);
    assert.equal(provider.documentInputs.length, 0, "engine changes invalidate signatures only");
    const snapshot = JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8"));
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.passages.some((p: { vector?: unknown }) => p.vector !== undefined), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const change of ["model", "version", "id", "dimensions"] as const) {
  test(`provider ${change} change regenerates all pages and never reuses another model's journal`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-provider-"));
    try {
      await writePage(root, "a.md", "Alpha", "First fact.");
      await writePage(root, "b.md", "Beta", "Second fact.");
      const input = await records(root, ["a.md", "b.md"]);
      const first = new PersistentSemanticIndex(root, new CountingEmbeddingProvider());
      await first.synchronize(input);
      await first.upsertPassages("a.md", input[0]!.passages);
      const base = new CountingEmbeddingProvider().descriptor;
      const changed = new CountingEmbeddingProvider({ ...base, [change]: change === "dimensions" ? 16 : "changed" });
      const next = new PersistentSemanticIndex(root, changed);
      const result = await next.synchronize(input);
      assert.equal(result.embeddedPages, 2);
      assert.equal(result.reusedPages, 0);
      assert.equal(changed.documentInputs.length, input.reduce((n, r) => n + r.passages.length, 0));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const corruption of ["truncated", "hash", "missing", "metadata"] as const) {
  test(`corrupt ${corruption} snapshot rebuilds from canonical pages`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-corrupt-"));
    try {
      await writePage(root, "a.md", "Alpha", "Canonical text.");
      const input = await records(root, ["a.md"]);
      await new PersistentSemanticIndex(root, new CountingEmbeddingProvider()).synchronize(input);
      const vectorFile = path.join(root, ".knowledge-rail/semantic-vectors.bin");
      if (corruption === "missing") await fs.unlink(vectorFile);
      else if (corruption === "metadata") await fs.writeFile(semanticIndexFile(root), "{");
      else {
        const bytes = await fs.readFile(vectorFile);
        if (corruption === "truncated") await fs.writeFile(vectorFile, bytes.subarray(0, bytes.length - 1));
        else { bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await fs.writeFile(vectorFile, bytes); }
      }
      const provider = new CountingEmbeddingProvider();
      await new PersistentSemanticIndex(root, provider).synchronize(input);
      assert.equal(provider.documentInputs.length, input[0]!.passages.length);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("concurrent index instances reload after acquiring the workspace lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-concurrent-"));
  try {
    await writePage(root, "a.md", "Alpha", "Shared fact.");
    const input = await records(root, ["a.md"]);
    const a = new CountingEmbeddingProvider(), b = new CountingEmbeddingProvider();
    await Promise.all([
      new PersistentSemanticIndex(root, a).synchronize(input),
      new PersistentSemanticIndex(root, b).synchronize(input),
    ]);
    assert.equal(a.documentInputs.length + b.documentInputs.length, input[0]!.passages.length);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("two independent processes share persisted batches without duplicate document embedding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-processes-"));
  try {
    const indexUrl = new URL("../src/core/semantic/index.ts", import.meta.url).href;
    const pageUrl = new URL("../src/core/page-record.ts", import.meta.url).href;
    const script = `
      import * as fs from "node:fs/promises";
      import { PersistentSemanticIndex } from ${JSON.stringify(indexUrl)};
      import { parseWikiPageRecord } from ${JSON.stringify(pageUrl)};
      const root = process.argv[2];
      const provider = {
        descriptor: { id: "process-test", model: "deterministic", version: "1", dimensions: 4 },
        async embedDocuments(texts) {
          await fs.appendFile(root + "/calls.jsonl", JSON.stringify(texts) + "\\n");
          await new Promise(resolve => setTimeout(resolve, 30));
          return texts.map(() => [1, 0, 0, 0]);
        },
        async embedQuery() { return [1, 0, 0, 0]; }
      };
      const records = Array.from({ length: 3 }, (_, i) => parseWikiPageRecord("page" + i + ".md",
        "---\\ntitle: Page " + i + "\\ntype: analysis\\n---\\n\\nFact " + i, { mtimeMs: 1, size: 70 }));
      const index = new PersistentSemanticIndex(root, provider);
      await index.synchronize(records);
      if (index.descriptor.pageCount !== 3) throw new Error("Incomplete index");
      index.dispose();
    `;
    const file = path.join(root, "worker.mjs"); await fs.writeFile(file, script);
    const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", file, root], { timeout: 20_000 });
    await Promise.all([run(), run()]);
    const inputs = (await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").flatMap((line) => JSON.parse(line) as string[]);
    assert.equal(inputs.length, 3);
    assert.equal(new Set(inputs).size, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("background builds yield to requested pages and mask stale and deleted evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-background-"));
  let index: PersistentSemanticIndex | undefined;
  try {
    await writePage(root, "a.md", "Alpha", "First fact.");
    await writePage(root, "b.md", "Beta", "Second fact.");
    const provider = new CountingEmbeddingProvider();
    index = new PersistentSemanticIndex(root, provider);
    const input = await records(root, ["a.md", "b.md"]);
    await index.startBackground(input);
    assert.equal(index.descriptor.state, "building");
    await index.prioritize(["b.md"]);
    assert.match(provider.documentInputs[0]!, /Beta/);
    await index.idle();
    assert.equal(index.descriptor.state, "ready");
    assert.equal(provider.documentInputs.length, input.reduce((n, r) => n + r.passages.length, 0));
    await writePage(root, "a.md", "Alpha", "Updated fact.");
    await index.startBackground(await records(root, ["a.md"]));
    const coverage = await index.assessCoverage([{ id: "x", text: "First fact" }], ["a.md", "b.md"]);
    assert.equal(coverage[0]!.pages.some((p) => p.pagePath === "b.md"), false);
    await index.idle();
    assert.equal(index.descriptor.pageCount, 1);
  } finally { index?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("background embedding batches small pages together instead of one provider call per page", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-batches-"));
  let index: PersistentSemanticIndex | undefined;
  try {
    const paths = Array.from({ length: 100 }, (_, i) => `p${i}.md`);
    await Promise.all(paths.map((p) => writePage(root, p, p, `Fact for ${p}.`)));
    const provider = new CountingEmbeddingProvider();
    index = new PersistentSemanticIndex(root, provider);
    await index.startBackground(await records(root, paths));
    await index.idle();
    assert.deepEqual(provider.documentBatches, [64, 36]);
    assert.equal(index.descriptor.state, "ready");
  } finally { index?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("version 1 migration preserves compatible embeddings without calling the provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-v1-"));
  try {
    await writePage(root, "a.md", "Legacy", "Existing evidence.");
    const input = await records(root, ["a.md"]);
    const provider = new CountingEmbeddingProvider();
    const engine = new LshAnnEngine({ dimensions: DIMENSIONS });
    const hash = createHash("sha256").update("knowledge-rail-semantic-page-v1\0a.md");
    const passages = [];
    for (const p of input[0]!.passages) {
      const passageId = wikiPassageId(p);
      hash.update("\0").update(passageId).update("\0").update(p.heading.normalize("NFC")).update("\0").update(p.text.normalize("NFC"));
      const id = `semantic-${createHash("sha256").update("knowledge-rail-semantic-passage-v1\0a.md\0").update(passageId).digest("hex").slice(0, 32)}`;
      passages.push({ id, pagePath: "a.md", passageId, heading: p.heading, text: p.text,
        vector: await provider.embedQuery(`${p.heading}\n${p.text}`) });
    }
    await fs.mkdir(path.join(root, ".knowledge-rail"));
    await fs.writeFile(semanticIndexFile(root), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(),
      provider: provider.descriptor, engine: engine.descriptor,
      pages: [{ path: "a.md", fingerprint: hash.digest("hex"), passageEntryIds: passages.map((p) => p.id) }], passages }));
    const migrated = new PersistentSemanticIndex(root, provider);
    const result = await migrated.synchronize(input);
    assert.equal(result.reusedPages, 1);
    assert.equal(provider.documentInputs.length, 0);
    assert.equal(JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8")).version, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an old journal surviving compaction never rolls a newer snapshot back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-compact-crash-"));
  try {
    await writePage(root, "a.md", "Alpha", "Before.");
    const provider = new CountingEmbeddingProvider();
    const index = new PersistentSemanticIndex(root, provider);
    await index.synchronize(await records(root, ["a.md"]));
    await writePage(root, "a.md", "Alpha", "After.");
    const input = await records(root, ["a.md"]);
    await index.upsertPassages("a.md", input[0]!.passages);
    const journalPath = path.join(root, ".knowledge-rail/semantic-journal.bin");
    const oldJournal = await fs.readFile(journalPath);
    await index.checkpoint();
    await fs.writeFile(journalPath, oldJournal);
    const restartedProvider = new CountingEmbeddingProvider();
    const restarted = new PersistentSemanticIndex(root, restartedProvider);
    await restarted.synchronize(input);
    assert.equal(restartedProvider.documentInputs.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("int8 snapshots restore identical quantized search and coverage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-int8-"));
  try {
    await writePage(root, "a.md", "Alpha", "Stable quantized content.");
    const input = await records(root, ["a.md"]);
    const provider = new CountingEmbeddingProvider();
    const first = new PersistentSemanticIndex(root, provider, undefined, { dtype: "i8" });
    await first.synchronize(input);
    const hits = await first.search("Alpha\nStable quantized content.", 10);
    const coverage = await first.assessCoverage([{ id: "x", text: "stable" }], ["a.md"]);
    const restarted = new PersistentSemanticIndex(root, provider, undefined, { dtype: "i8" });
    await restarted.synchronize(input);
    assert.deepEqual(await restarted.search("Alpha\nStable quantized content.", 10), hits);
    assert.deepEqual(await restarted.assessCoverage([{ id: "x", text: "stable" }], ["a.md"]), coverage);
    assert.equal(provider.documentInputs.length, input[0]!.passages.length);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing LSH signatures serve exact search while rebuilding without changing vectors", async () => {
  const engine = new LshAnnEngine({ dimensions: 4 });
  engine.restore([{ id: "x", vector: new Float32Array([1, 0, 0, 0]), normalized: true }]);
  const interim = engine.search([1, 0, 0, 0], 1);
  assert.equal(interim.diagnostics.indexMode, "exact");
  assert.equal(interim.hits[0]?.id, "x");
  await engine.ready();
  assert.deepEqual(engine.search([1, 0, 0, 0], 1).hits, interim.hits);
  assert.equal(engine.signatures("x")?.length, 10);
});

test("invalid persisted LSH signatures regenerate without discarding compatible vectors", async () => {
  const engine = new LshAnnEngine({ dimensions: 4 });
  engine.restore([{ id: "x", vector: new Float32Array([1, 0, 0, 0]), normalized: true,
    signatures: Array(10).fill(0xffff_ffff) }]);
  assert.equal(engine.search([1, 0, 0, 0], 1).hits[0]?.id, "x");
  await engine.ready();
  assert.ok(engine.signatures("x")?.every((value) => value < 2 ** engine.descriptor.bitsPerTable));
});

test("provider scheduling serializes work and lets a query precede the next background batch", async () => {
  const { EmbeddingRequestQueue } = await import("../src/core/semantic/build-queue.js");
  const queue = new EmbeddingRequestQueue();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const first = queue.run(async () => { calls.push("batch-one"); await held; });
  const second = queue.run(async () => { calls.push("batch-two"); });
  const query = queue.run(async () => { calls.push("query"); }, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["batch-one"]);
  release(); await Promise.all([first, second, query]);
  assert.deepEqual(calls, ["batch-one", "query", "batch-two"]);
});

test("semantic memory excludes canonical text and hydration masks unsynchronized edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-semantic-hydrate-"));
  const index = new PersistentSemanticIndex(root, {
    descriptor: { id: "hydration-test", model: "constant", version: "1", dimensions: 2 },
    async embedDocuments(texts) { return texts.map(() => [1, 0]); },
    async embedQuery() { return [1, 0]; },
  });
  t.after(async () => { index.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await writePage(root, "a.md", "Original", "Distinct immutable evidence.");
  const input = await records(root, ["a.md"]); await index.synchronize(input);
  const snapshot = JSON.parse(await fs.readFile(semanticIndexFile(root), "utf8"));
  assert.ok(snapshot.passages.every((p: object) => !("text" in p)));
  const query = `${input[0]!.passages[0]!.heading}\n${input[0]!.passages[0]!.text}`;
  assert.ok((await index.search(query, 5)).length > 0);
  await fs.writeFile(path.join(root, "a.md"), input[0]!.raw.replace("type: requirement", "type: decision"));
  assert.deepEqual(await index.search(query, 5), [], "even metadata-only edits invalidate a previously scored page");
});

test("continuous query traffic cannot starve a pending background batch", async () => {
  const { EmbeddingRequestQueue } = await import("../src/core/semantic/build-queue.js");
  const queue = new EmbeddingRequestQueue(); const order: string[] = [];
  let release!: () => void;
  const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const background = queue.run(async () => { order.push("background"); });
  const queries = Array.from({ length: 20 }, (_, i) => queue.run(async () => { order.push(`query${i}`); }, true));
  release(); await Promise.all([first, background, ...queries]);
  assert.equal(order.indexOf("background"), 8);
});
