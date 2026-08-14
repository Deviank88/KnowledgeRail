import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  codeResourceUri,
  PersistentCodeEvidenceIndex,
} from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";
import {
  readCodeGrepFallbackEvents,
  recordCodeGrepFallback,
} from "../src/core/code-evidence/telemetry.js";

async function writeFixture(root: string): Promise<void> {
  const files: Record<string, string> = {
    "src/config.ts": [
      "/** Maximum retry attempts used by order processing. */",
      "export const RETRY_LIMIT = Number(process.env.RETRY_LIMIT ?? 3);",
      "",
    ].join("\n"),
    "src/db.ts": [
      "/** Persist an accepted order. */",
      "export async function saveOrder(orderId: string): Promise<void> {",
      "  await database.table(\"orders\").insert({ orderId });",
      "}",
      "",
    ].join("\n"),
    "src/service.ts": [
      "import { RETRY_LIMIT } from \"./config.js\";",
      "import { saveOrder } from \"./db.js\";",
      "",
      "/** Validate and persist an order with bounded retry behavior. */",
      "export async function processOrder(orderId: string): Promise<number> {",
      "  validateOrder(orderId);",
      "  await saveOrder(orderId);",
      "  return RETRY_LIMIT;",
      "}",
      "",
      "function validateOrder(orderId: string): void {",
      "  if (!orderId) throw new Error(\"order id required\");",
      "}",
      "",
      "export class OrderCoordinator {",
      "  async coordinate(orderId: string): Promise<number> {",
      "    return processOrder(orderId);",
      "  }",
      "}",
      "",
      "export function unrelated(): string { return \"adjacent secret\"; }",
      "",
    ].join("\n"),
    "src/routes.ts": [
      "import { processOrder } from \"./service.js\";",
      "router.post(\"/orders\", processOrder);",
      "",
    ].join("\n"),
    "tests/service.test.ts": [
      "import { processOrder } from \"../src/service.js\";",
      "test(\"processes and persists an order\", async () => {",
      "  await processOrder(\"order-1\");",
      "});",
      "",
    ].join("\n"),
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

test("TypeScript adapter indexes minimum code evidence and structural relations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-code-index-"));
  const wikiRoot = path.join(root, "wiki");
  try {
    await writeFixture(root);
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
    const first = await index.rebuild();
    assert.deepEqual(
      { scanned: first.scannedFiles, reused: first.reusedFiles, reparsed: first.reparsedFiles, removed: first.removedFiles },
      { scanned: 5, reused: 0, reparsed: 5, removed: 0 }
    );
    const second = await index.rebuild();
    assert.deepEqual(
      { scanned: second.scannedFiles, reused: second.reusedFiles, reparsed: second.reparsedFiles },
      { scanned: 5, reused: 5, reparsed: 0 }
    );

    const snapshot = await index.snapshot();
    assert.equal(snapshot.files.length, 5);
    assert.equal(snapshot.fragments.some((fragment) => fragment.kind === "module"), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.kind === "class" && fragment.symbol === "OrderCoordinator"), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.kind === "method" && fragment.qualifiedName === "OrderCoordinator.coordinate"), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.kind === "test" && fragment.isTest), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.docComment?.includes("bounded retry behavior")), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.imports.includes("./db.js")), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.calls.includes("saveOrder")), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.configKeys.includes("RETRY_LIMIT")), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.databaseRefs.includes("orders")), true);
    assert.equal(snapshot.fragments.some((fragment) => fragment.routes.some((route) => route.path === "/orders")), true);

    const definitions = await index.symbol("processOrder");
    assert.equal(definitions[0]?.fragment.path, "src/service.ts");
    const references = await index.references(definitions[0]!.fragment.id, { maxResults: 50 });
    assert.equal(references.some((reference) => reference.source.path === "src/routes.ts"), true);
    assert.equal(references.some((reference) => reference.source.path === "tests/service.test.ts" && reference.source.isTest), true);
    assert.equal((await index.search("POST /orders processOrder"))[0]?.fragment.kind, "route");
    assert.equal((await index.search("RETRY_LIMIT consumer bounded retry")).some((hit) => hit.fragment.path === "src/service.ts"), true);

    const read = await readCodeResource({
      repositoryRoot: root,
      wikiRoot,
      resourceUri: codeResourceUri(definitions[0]!.fragment),
    });
    assert.equal(read.text.includes("saveOrder(orderId)"), true);
    assert.equal(read.text.includes("adjacent secret"), false);
    assert.equal(read.startLine, 5);
    assert.equal(read.endLine, 9);

    await fs.appendFile(path.join(root, "src/service.ts"), "// stale\n", "utf8");
    await assert.rejects(
      readCodeResource({
        repositoryRoot: root,
        wikiRoot,
        resourceUri: codeResourceUri(definitions[0]!.fragment),
      }),
      /stale/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("code evidence updates renamed symbols, removes files, and records grep fallbacks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-code-update-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-code-outside-"));
  const wikiRoot = path.join(root, "wiki");
  try {
    await writeFixture(root);
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
    await index.rebuild();
    const servicePath = path.join(root, "src/service.ts");
    const before = await fs.readFile(servicePath, "utf8");
    await fs.writeFile(servicePath, before.replaceAll("processOrder", "fulfillOrder"), "utf8");
    const updated = await index.updateFile("src/service.ts");
    assert.deepEqual(
      { scanned: updated.scannedFiles, reused: updated.reusedFiles, reparsed: updated.reparsedFiles },
      { scanned: 1, reused: 0, reparsed: 1 }
    );
    assert.equal((await index.symbol("processOrder")).some((hit) => hit.fragment.path === "src/service.ts"), false);
    assert.equal((await index.symbol("fulfillOrder"))[0]?.fragment.path, "src/service.ts");

    await fs.unlink(path.join(root, "tests/service.test.ts"));
    const removed = await index.removeFile("tests/service.test.ts");
    assert.equal(removed.removedFiles, 1);
    assert.equal((await index.snapshot()).files.some((record) => record.path === "tests/service.test.ts"), false);

    await fs.writeFile(path.join(outside, "escape.ts"), "export function escaped() {}\n", "utf8");
    await fs.symlink(path.join(outside, "escape.ts"), path.join(root, "src/escape.ts"));
    await assert.rejects(index.updateFile("src/escape.ts"), /outside the repository root/);

    await recordCodeGrepFallback({
      wikiRoot,
      query: "legacy symbol",
      reason: "coverage controller found no indexed evidence",
      resultCount: 2,
      timestamp: "2026-08-14T10:00:00.000Z",
    });
    const events = await readCodeGrepFallbackEvents(wikiRoot);
    assert.deepEqual(events, [{
      version: 1,
      timestamp: "2026-08-14T10:00:00.000Z",
      query: "legacy symbol",
      reason: "coverage controller found no indexed evidence",
      resultCount: 2,
    }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
