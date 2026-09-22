import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { captureGitRevision, mapUnchangedRange, relocateGitAnchor } from "../src/core/code-evidence/git-anchor.js";
import { codeAnchorHash } from "../src/core/code-evidence/code-anchor.js";
import { detectCodeDrift, staleClaimsByPage } from "../src/core/drift-detection.js";
import { createEvidenceClaim } from "../src/core/ingestion/evidence-claim.js";
import { mutateEvidenceIrStore, readEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";

test("diff mapping rejects intersecting changes and translates insertions/deletions before the range", () => {
  assert.deepEqual(mapUnchangedRange(3, 5, "@@ -0,0 +1,2 @@\n+x\n+y"), { startLine: 5, endLine: 7 });
  assert.deepEqual(mapUnchangedRange(3, 5, "@@ -1,1 +0,0 @@\n-x"), { startLine: 2, endLine: 4 });
  assert.equal(mapUnchangedRange(3, 5, "@@ -3,0 +4,1 @@\n+x"), null);
  assert.equal(mapUnchangedRange(3, 5, "@@ -3 +3 @@\n-a\n+b"), null);
});

test("Git relocation requires unchanged content, persists history, and no-ledger mode leaves anchors untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-git-anchor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wikiRoot = path.join(root, "wiki");
  await fs.mkdir(wikiRoot);
  const run = (args: string[]) => promisify(execFile)("git", args, { cwd: root });
  await run(["init", "--quiet"]);
  const content = "export function amount() {\n  return 3;\n}\n";
  await fs.writeFile(path.join(root, "amount.ts"), content);
  await run(["add", "amount.ts"]);
  await run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  const revision = await captureGitRevision(root, "amount.ts", content);
  assert.match(revision!, /^[a-f0-9]{40,64}$/u);
  const anchor = { path: "amount.ts", startLine: 1, endLine: 3, rangeHash: codeAnchorHash(content, 1, 3),
    parserVersion: "fixture", capturedAt: "2026-01-01T00:00:00.000Z", revision };
  const claim = createEvidenceClaim({ sourceUri: "docs/normalized/rule.md", segmentId: `seg-${"a".repeat(24)}`,
    input: { text: "Amount is three.", kind: "behavior", origin: "explicit", confidence: 1,
      target: { codeResourceUri: `code://repo/amount.ts#symbol-${"b".repeat(20)}` } }, codeAnchor: anchor });
  await mutateEvidenceIrStore(wikiRoot, (store) => { store.claims.push(claim); });
  const moved = "// heading\n// extra\n" + content;
  await fs.writeFile(path.join(root, "amount.ts"), moved);
  assert.equal(await captureGitRevision(root, "amount.ts", moved), undefined, "uncommitted bytes must not be labeled HEAD");
  const preview = await detectCodeDrift({ repositoryRoot: root, wikiRoot, writeLedger: false });
  assert.equal(preview.entries[0]?.verdict, "relocated");
  assert.equal((await readEvidenceIrStore(wikiRoot)).claims[0]!.codeAnchor!.startLine, 1);
  const saved = await detectCodeDrift({ repositoryRoot: root, wikiRoot });
  assert.equal(saved.summary.relocated, 1);
  const next = (await readEvidenceIrStore(wikiRoot)).claims[0]!.codeAnchor!;
  assert.equal(next.startLine, 3);
  assert.deepEqual(next.history, [anchor]);
  assert.equal((await staleClaimsByPage(wikiRoot)).size, 0);
  assert.equal(await relocateGitAnchor(root, anchor, moved.replace("return 3", "return 4"), new Date().toISOString()), null);
  await fs.writeFile(path.join(root, "amount.ts"), moved.replace("return 3", "return 4"));
  assert.equal((await detectCodeDrift({ repositoryRoot: root, wikiRoot })).entries[0]?.verdict, "drift_suspected");
});
