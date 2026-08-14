import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { applyWikiMigration } from "../src/core/migration-service.js";
import { clearRetrievalIndexes, searchRetrievalIndex } from "../src/core/retrieval-index.js";

async function writeLegacyV3Project(root: string): Promise<string> {
  await fs.mkdir(path.join(root, ".knowledge-rail"), { recursive: true });
  await fs.mkdir(path.join(root, "custom"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".knowledge-rail", "state.json"),
    `${JSON.stringify({
      formatVersion: 3,
      artifactVersions: { manifest: 1, graph: 2, retrieval: 1 },
      migratedAt: "2026-08-01T00:00:00.000Z",
      migratedFrom: 2,
    }, null, 2)}\n`,
    "utf-8"
  );
  await fs.writeFile(
    path.join(root, "SCHEMA.md"),
    "# Legacy project schema\n\nCustom project conventions must survive migration.\n",
    "utf-8"
  );
  await fs.writeFile(path.join(root, "index.md"), "# Legacy index\n", "utf-8");

  const canonical = [
    "---",
    'title: "Warehouse allocation rule"',
    "type: business_rule_custom",
    "tags: [warehouse, allocation]",
    "aliases: [Allocation invariant candidate]",
    "created: 2026-07-01",
    "updated: 2026-08-01",
    "sources: []",
    'domain_profile: "logistics-vendor-extension"',
    'custom_meta: "must-not-be-dropped"',
    "---",
    "",
    "# Warehouse allocation rule",
    "",
    "Allocation uses the closest eligible warehouse with available stock.",
    "",
    "This is legacy documented knowledge. Migration must preserve it verbatim and must not silently reinterpret it as a v4 invariant.",
    "",
  ].join("\n");
  await fs.writeFile(path.join(root, "custom", "WarehouseAllocation.md"), canonical, "utf-8");
  return canonical;
}

test("legacy v3 repair preserves canonical pages and custom metadata verbatim", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-migration-contract-"));
  const original = await writeLegacyV3Project(root);

  clearRetrievalIndexes();
  const before = await searchRetrievalIndex({
    wikiRoot: root,
    query: "closest eligible warehouse available stock",
    maxResults: 5,
    forceRefresh: true,
  });
  assert.equal(before[0]?.path, "custom/WarehouseAllocation.md");

  const result = await applyWikiMigration(root, { targetVersion: "4", backup: true });
  assert.equal(result.plan.detectedVersion, 3);

  const afterRaw = await fs.readFile(path.join(root, "custom", "WarehouseAllocation.md"), "utf-8");
  assert.equal(afterRaw, original);
  assert.match(afterRaw, /domain_profile: "logistics-vendor-extension"/);
  assert.match(afterRaw, /custom_meta: "must-not-be-dropped"/);

  const after = await searchRetrievalIndex({
    wikiRoot: root,
    query: "closest eligible warehouse available stock",
    maxResults: 5,
    forceRefresh: true,
  });
  assert.equal(after[0]?.path, "custom/WarehouseAllocation.md");
  assert.equal(after[0]?.title, before[0]?.title);

  const journal = JSON.parse(
    await fs.readFile(path.join(root, ".knowledge-rail", "migrations", result.runId, "journal.json"), "utf-8")
  ) as { status?: string };
  assert.equal(journal.status, "complete");
  assert.equal(
    await fs.readFile(path.join(result.backupDir, "custom", "WarehouseAllocation.md"), "utf8"),
    original,
    "rollback backup must contain every canonical Markdown byte"
  );
});
