import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { multilingualEfficiencyFixture } from "../benchmarks/code-efficiency-fixture.js";
import { codeEvidenceIndexFile, codeResourceUri, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

test("all adapter families preserve references and resource freshness across cached reads, updates and eviction", async (t) => {
  const repositoryRoot = await fs.mkdtemp(join(tmpdir(), "kr-resource-generation-")), wikiRoot = join(repositoryRoot, "wiki");
  t.after(async () => { clearWorkspaceStates(); await fs.rm(repositoryRoot, { recursive: true, force: true }); });
  const fixture = multilingualEfficiencyFixture(20, false);
  for (const [path, content] of fixture.files) {
    await fs.mkdir(join(repositoryRoot, path, ".."), { recursive: true });
    await fs.writeFile(join(repositoryRoot, path), content);
  }
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
  await index.rebuild();
  const snapshot = await index.snapshot();
  assert.equal(new Set(fixture.cases.map((c) => c.family)).size, 13);
  const promises = (await import("node:fs/promises")).default, readFile = promises.readFile;
  let snapshotReads = 0;
  t.mock.method(promises, "readFile", (...args: Parameters<typeof readFile>) => {
    if (String(args[0]) === codeEvidenceIndexFile(wikiRoot)) snapshotReads++;
    return readFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const entry of fixture.cases) {
    const target = snapshot.fragments.find((f) => f.path === entry.targetPath && (entry.symbol ? f.symbol === entry.symbol : f.kind === "module"))!;
    const refs = await index.references(target.id, { maxResults: 100 });
    const positive = refs.find((r) => r.source.path === entry.sourcePath && r.relation === entry.relation);
    assert.ok(positive, entry.family);
    assert.ok(!refs.some((r) => r.source.path === entry.negativePath), entry.family);
    const params = { repositoryRoot, wikiRoot, resourceUri: positive.resourceUri };
    const before = snapshotReads;
    const original = await readCodeResource(params);
    assert.deepEqual(await readCodeResource(params), original);
    assert.equal(snapshotReads, before, `${entry.family}: resource must reuse the admitted generation`);
    const source = join(repositoryRoot, entry.sourcePath), content = await fs.readFile(source, "utf8");
    await fs.writeFile(source, `${content}\n`);
    await assert.rejects(readCodeResource(params), /stale/);
    await index.updateFile(entry.sourcePath);
    assert.deepEqual(await readCodeResource(params), original);
    clearWorkspaceStates();
    assert.deepEqual(await readCodeResource(params), original);
  }
  // An externally replaced or corrupt snapshot must invalidate warm resource reads.
  await fs.writeFile(codeEvidenceIndexFile(wikiRoot), "{");
  const source = fixture.cases[0]!.sourcePath;
  const fragment = snapshot.fragments.find((f) => f.path === source)!;
  await assert.rejects(readCodeResource({ repositoryRoot, wikiRoot, resourceUri: codeResourceUri(fragment) }), /Cannot read code evidence index/);
  assert.equal(await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8"), "{", "read-only resources cannot repair indexes");
});
