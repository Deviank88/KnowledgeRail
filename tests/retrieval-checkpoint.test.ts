import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  computeCorpusRevision,
  CorpusRevisionLedger,
  fingerprintWikiRaw,
  readRetrievalCheckpoint,
  RetrievalCheckpointBoundsError,
  serializeRetrievalCheckpoint,
  serializeRetrievalDelta,
} from "../src/core/retrieval-checkpoint.js";
import {
  clearRetrievalIndexes,
  getRetrievalIndexDiagnostics,
  searchRetrievalIndex,
  updateRetrievalPaths,
} from "../src/core/retrieval-index.js";

async function fixture(): Promise<{ root: string; page: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-checkpoint-"));
  const page = "requirements/Checkout.md";
  await writePage(root, page, "Ordered checkout", "The ordered payment authorization preserves Retry-After.");
  return { root, page };
}

async function writePage(root: string, relativePath: string, title: string, body: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---",
    `title: ${title}`,
    "type: requirement",
    "tags: [checkpoint, retrieval]",
    "sources: []",
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n"));
}

async function initialize(root: string): Promise<void> {
  clearRetrievalIndexes();
  const hits = await searchRetrievalIndex({ wikiRoot: root, query: "ordered payment", forceRefresh: true });
  assert.equal(hits[0]?.path, "requirements/Checkout.md");
}

function checksum(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

test("v2 checkpoint resumes after metadata verification without retokenizing canonical pages", async () => {
  const { root } = await fixture();
  try {
    await initialize(root);
    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "Retry-After", persist: false });
    assert.equal(hits[0]?.path, "requirements/Checkout.md");
    const diagnostics = getRetrievalIndexDiagnostics(root);
    assert.equal(diagnostics.snapshotLoaded, true);
    assert.equal(diagnostics.recovery, "restored");
    assert.equal(diagnostics.reusedRecords, 1);
    assert.equal(diagnostics.changedRecords, 0);
    assert.match(diagnostics.corpusRevision, /^[a-f0-9]{64}$/);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("base-aware journal replays a targeted update and ignores only an incomplete tail", async () => {
  const { root, page } = await fixture();
  try {
    await initialize(root);
    await writePage(root, page, "Ordered checkout", "Circuit breaker state is authoritative for REQ-204.");
    await updateRetrievalPaths(root, [page]);
    const journalPath = path.join(root, ".knowledge-rail", "retrieval-delta.jsonl");
    await fs.appendFile(journalPath, "{\"payload\":");

    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "circuit breaker REQ-204", persist: false });
    assert.equal(hits[0]?.path, page);
    const diagnostics = getRetrievalIndexDiagnostics(root);
    assert.equal(diagnostics.snapshotLoaded, true);
    assert.equal(diagnostics.deltaCount, 1);
    assert.equal(diagnostics.recovery, "restored");
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("checksum-valid but out-of-bounds postings discard the whole candidate and rebuild read-only", async () => {
  const { root } = await fixture();
  try {
    await initialize(root);
    const snapshotPath = path.join(root, ".knowledge-rail", "retrieval-index.json");
    const parsed = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
      payload: { lexicalRuntime: { terms: Array<[string, number[]]> } };
      payloadChecksum: string;
    };
    parsed.payload.lexicalRuntime.terms[0]![1][0] = 99_999;
    parsed.payloadChecksum = checksum(parsed.payload);
    const poisoned = `${JSON.stringify(parsed)}\n`;
    await fs.writeFile(snapshotPath, poisoned);

    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "ordered payment", persist: false });
    assert.equal(hits[0]?.path, "requirements/Checkout.md");
    assert.equal(getRetrievalIndexDiagnostics(root).fallbackReason, "snapshot_bounds_invalid");
    assert.equal(await fs.readFile(snapshotPath, "utf8"), poisoned, "read-only fallback must not repair project files");
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("checkpoint writers refuse reader-incompatible snapshots and journals before persistence", async () => {
  const { root, page } = await fixture();
  try {
    await initialize(root);
    const checkpoint = await readRetrievalCheckpoint(root);
    assert.equal(checkpoint.kind, "v2");
    if (checkpoint.kind !== "v2") return;

    assert.throws(
      () => serializeRetrievalCheckpoint(checkpoint.data, { maxRecords: 0 }),
      (error) => error instanceof RetrievalCheckpointBoundsError && error.reason === "record_limit"
    );
    assert.throws(
      () => serializeRetrievalCheckpoint(checkpoint.data, { maxTerms: 0 }),
      (error) => error instanceof RetrievalCheckpointBoundsError && error.reason === "term_limit"
    );
    assert.throws(
      () => serializeRetrievalCheckpoint(checkpoint.data, { maxPostings: 0 }),
      (error) => error instanceof RetrievalCheckpointBoundsError && error.reason === "posting_limit"
    );
    assert.throws(
      () => serializeRetrievalCheckpoint(checkpoint.data, { maxSnapshotBytes: 1 }),
      (error) => error instanceof RetrievalCheckpointBoundsError && error.reason === "snapshot_bytes"
    );

    const record = checkpoint.data.records.get(page)!;
    assert.throws(
      () => serializeRetrievalDelta(
        checkpoint.data.corpusRevision,
        checkpoint.data.corpusRevision,
        [{
          path: page,
          record,
          fingerprint: checkpoint.data.fingerprints.get(page),
          metadata: checkpoint.data.fileMetadata.get(page),
          indexedTerms: [],
        }],
        { maxJournalBytes: 1 }
      ),
      (error) => error instanceof RetrievalCheckpointBoundsError && error.reason === "journal_bytes"
    );
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("builder mismatch is reason-coded and never contributes partial records", async () => {
  const { root } = await fixture();
  try {
    await initialize(root);
    const snapshotPath = path.join(root, ".knowledge-rail", "retrieval-index.json");
    const parsed = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as {
      payload: { builderVersion: string };
      payloadChecksum: string;
    };
    parsed.payload.builderVersion = "future-builder";
    parsed.payloadChecksum = checksum(parsed.payload);
    await fs.writeFile(snapshotPath, `${JSON.stringify(parsed)}\n`);

    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "Retry-After", persist: false });
    assert.equal(hits.length, 1);
    assert.equal(getRetrievalIndexDiagnostics(root).fallbackReason, "snapshot_builder_mismatch");
    assert.equal(getRetrievalIndexDiagnostics(root).recovery, "rebuilt");
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("content verification detects a same-size edit with restored mtime", async () => {
  const { root, page } = await fixture();
  try {
    await initialize(root);
    const absolute = path.join(root, page);
    const before = await fs.stat(absolute);
    const original = await fs.readFile(absolute, "utf8");
    const changed = original.replace("Retry-After", "Retry-Later");
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    await fs.writeFile(absolute, changed);
    await fs.utimes(absolute, before.atime, before.mtime);

    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({
      wikiRoot: root,
      query: "Retry-Later",
      persist: false,
      forceRefresh: true,
      verificationMode: "content",
    });
    assert.equal(hits[0]?.path, page);
    const diagnostics = getRetrievalIndexDiagnostics(root);
    assert.equal(diagnostics.verificationMode, "content");
    assert.equal(diagnostics.changedRecords, 1);
    assert.equal(diagnostics.recovery, "patched");
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an explicit content-integrity request upgrades an already warm metadata generation", async () => {
  const { root } = await fixture();
  try {
    await initialize(root);
    assert.equal(getRetrievalIndexDiagnostics(root).verificationMode, "metadata");
    await searchRetrievalIndex({
      wikiRoot: root,
      query: "ordered payment",
      persist: false,
      verificationMode: "content",
    });
    assert.equal(getRetrievalIndexDiagnostics(root).verificationMode, "content");
    assert.equal(getRetrievalIndexDiagnostics(root).reusedRecords, 1);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("snapshot symlinks are rejected and canonical Markdown remains usable", {
  skip: process.platform === "win32",
}, async () => {
  const { root } = await fixture();
  const external = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-external-")), "snapshot.json");
  try {
    await initialize(root);
    const snapshotPath = path.join(root, ".knowledge-rail", "retrieval-index.json");
    await fs.rename(snapshotPath, external);
    await fs.symlink(external, snapshotPath);
    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "ordered payment", persist: false });
    assert.equal(hits[0]?.path, "requirements/Checkout.md");
    assert.equal(getRetrievalIndexDiagnostics(root).fallbackReason, "snapshot_symlink");
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(external), { recursive: true, force: true });
  }
});

test("a symlinked checkpoint directory is neither trusted nor mutated", {
  skip: process.platform === "win32",
}, async () => {
  const { root, page } = await fixture();
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-external-meta-"));
  const externalMetadata = path.join(externalRoot, "metadata");
  try {
    await initialize(root);
    const metadata = path.join(root, ".knowledge-rail");
    await fs.rename(metadata, externalMetadata);
    await fs.symlink(externalMetadata, metadata);
    const before = await fs.readFile(path.join(externalMetadata, "retrieval-index.json"), "utf8");

    clearRetrievalIndexes();
    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "ordered payment", persist: false });
    assert.equal(hits[0]?.path, page);
    assert.equal(getRetrievalIndexDiagnostics(root).fallbackReason, "checkpoint_directory_symlink");
    await assert.rejects(updateRetrievalPaths(root, [page]), /must not be a symbolic link/);
    assert.equal(await fs.readFile(path.join(externalMetadata, "retrieval-index.json"), "utf8"), before);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  }
});

test("fingerprints normalize line endings but preserve Unicode distinctions", () => {
  assert.equal(fingerprintWikiRaw("alpha\r\nbeta\r"), fingerprintWikiRaw("alpha\nbeta\n"));
  assert.notEqual(fingerprintWikiRaw("caffè\n"), fingerprintWikiRaw("caffe\u0300\n"));
});

test("Merkle revision ledger matches a full recomputation after an existing-path edit", () => {
  const fingerprints = new Map([
    ["requirements/A.md", fingerprintWikiRaw("alpha")],
    ["requirements/B.md", fingerprintWikiRaw("beta")],
    ["requirements/C.md", fingerprintWikiRaw("gamma")],
  ]);
  const ledger = CorpusRevisionLedger.from(fingerprints).clone();
  const replacement = fingerprintWikiRaw("beta v2");
  assert.equal(ledger.updateExisting("requirements/B.md", replacement), true);
  fingerprints.set("requirements/B.md", replacement);
  assert.equal(ledger.revision, computeCorpusRevision(fingerprints));
  assert.equal(ledger.updateExisting("requirements/Missing.md", replacement), false);
});

test("concurrent targeted updates serialize into one valid journal lineage", async () => {
  const { root, page } = await fixture();
  const second = "requirements/Inventory.md";
  try {
    await writePage(root, second, "Inventory", "Reserve stock before shipment.");
    await initialize(root);
    await writePage(root, page, "Ordered checkout", "Authorize payment before capture.");
    await writePage(root, second, "Inventory", "Validate stock before reservation.");
    await Promise.all([
      updateRetrievalPaths(root, [page]),
      updateRetrievalPaths(root, [second]),
    ]);
    const checkpoint = await readRetrievalCheckpoint(root);
    assert.equal(checkpoint.kind, "v2");
    if (checkpoint.kind === "v2") {
      assert.equal(checkpoint.deltaCount, 2);
      assert.equal(checkpoint.data.records.size, 2);
      assert.equal(checkpoint.persistedRevision, checkpoint.data.corpusRevision);
    }
    clearRetrievalIndexes();
    assert.equal((await searchRetrievalIndex({ wikiRoot: root, query: "payment capture", persist: false }))[0]?.path, page);
    assert.equal((await searchRetrievalIndex({ wikiRoot: root, query: "stock reservation", persist: false }))[0]?.path, second);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("checkpoint reader reports a fully valid persisted generation", async () => {
  const { root } = await fixture();
  try {
    await initialize(root);
    const loaded = await readRetrievalCheckpoint(root);
    assert.equal(loaded.kind, "v2");
    if (loaded.kind === "v2") {
      assert.equal(loaded.data.records.size, 1);
      assert.equal(loaded.data.postings.size > 0, true);
      assert.equal(loaded.persistedRevision, loaded.data.corpusRevision);
    }
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("snapshot persistence reloads and converges after an external artifact CAS change", async () => {
  const { root, page } = await fixture();
  try {
    await initialize(root);
    clearRetrievalIndexes();
    await searchRetrievalIndex({ wikiRoot: root, query: "ordered payment", persist: false });
    await writePage(root, page, "Ordered checkout", "A reconciled token survives an external checkpoint writer.");
    await searchRetrievalIndex({
      wikiRoot: root,
      query: "reconciled token",
      forceRefresh: true,
      persist: false,
    });
    const snapshotPath = path.join(root, ".knowledge-rail", "retrieval-index.json");
    await fs.appendFile(snapshotPath, "\n");

    const hits = await searchRetrievalIndex({ wikiRoot: root, query: "reconciled token" });
    assert.equal(hits[0]?.path, page);
    const persisted = await readRetrievalCheckpoint(root);
    assert.equal(persisted.kind, "v2");
    if (persisted.kind === "v2") {
      assert.equal(persisted.persistedRevision, persisted.data.corpusRevision);
      assert.equal(persisted.data.records.get(page)?.body.includes("reconciled token"), true);
    }
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
});
