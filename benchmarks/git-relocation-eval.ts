import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureGitRevision } from "../src/core/code-evidence/git-anchor.js";
import { codeAnchorHash } from "../src/core/code-evidence/code-anchor.js";
import { detectCodeDrift } from "../src/core/drift-detection.js";
import { createEvidenceClaim } from "../src/core/ingestion/evidence-claim.js";
import { mutateEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";

/** Real Git histories supplement (and do not replace) the existing drift golden gate. */
export async function evaluateGitRelocation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-drift-gate-"));
  const wikiRoot = path.join(root, "wiki"), file = path.join(root, "amount.ts");
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: root });
  try {
    await fs.mkdir(wikiRoot); await git(["init", "--quiet"]);
    const original = "// original heading\nexport function amount() {\n  return 3;\n}\n";
    await fs.writeFile(file, original); await git(["add", "amount.ts"]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    const anchor = { path: "amount.ts", startLine: 2, endLine: 4, rangeHash: codeAnchorHash(original, 2, 4),
      parserVersion: "fixture", capturedAt: "2026-01-01T00:00:00.000Z", revision: await captureGitRevision(root, "amount.ts", original) };
    if (!anchor.revision) throw new Error("Git fixture revision capture failed.");
    const cases = [
      { id: "git-insertion-before-range", text: "// inserted\n" + original, anchor, expected: "relocated" },
      { id: "git-deletion-before-range", text: original.slice(original.indexOf("\n") + 1), anchor, expected: "relocated" },
      { id: "git-modified-range", text: "// inserted\n" + original.replace("return 3", "return 4"), anchor, expected: "drift_suspected" },
      { id: "git-unverified-original-hash", text: "// inserted\n" + original, anchor: { ...anchor, rangeHash: "0".repeat(64) }, expected: "drift_suspected" },
      { id: "git-missing-revision", text: "// inserted\n" + original, anchor: { ...anchor, revision: "0".repeat(40) }, expected: "drift_suspected" },
    ];
    const results = [];
    for (const sample of cases) {
      const claim = createEvidenceClaim({ sourceUri: "docs/normalized/rule.md", segmentId: `seg-${"a".repeat(24)}`,
        input: { text: "Amount is three.", kind: "behavior", origin: "explicit", confidence: 1, target: { codeResourceUri: `code://repo/amount.ts#symbol-${"b".repeat(20)}` } }, codeAnchor: sample.anchor });
      await mutateEvidenceIrStore(wikiRoot, (store) => { store.claims = [claim]; });
      await fs.writeFile(file, sample.text);
      const report = await detectCodeDrift({ repositoryRoot: root, wikiRoot, writeLedger: false });
      const actual = report.entries[0]?.verdict;
      results.push({ id: sample.id, expected: sample.expected, actual, passed: actual === sample.expected });
    }
    return results;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
