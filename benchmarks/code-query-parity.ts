import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { codeQueryFixture } from "./code-query-fixture.js";
import { codeEvidenceIndexFile, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import type { CodeSearchOptions } from "../src/core/code-evidence/types.js";
const baselineRoot = process.argv.find((v) => v.startsWith("--baseline="))?.slice(11);
if (!baselineRoot) throw new Error("Pass --baseline=/path/to/preserved/runtime");
const baseline = await import(pathToFileURL(path.resolve(baselineRoot, "src/core/code-evidence/index.ts")).href) as typeof import("../src/core/code-evidence/index.js");
const baselineState = await import(pathToFileURL(path.resolve(baselineRoot, "src/core/workspace-state.ts")).href) as typeof import("../src/core/workspace-state.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-query-parity-"));
let comparisons = 0;
try {
  const wikiRoot = path.join(root, "wiki");
  const snapshot = codeQueryFixture(1000);
  snapshot.fragments.forEach((fragment, i) => {
    if (i % 7 === 0) fragment.kind = "function";
    if (i % 11 === 0) fragment.path = "src/Tied.ts";
    if (i % 13 === 0) { fragment.symbol = "Ｔｉｅｄ"; fragment.qualifiedName = "Ns::Tied"; fragment.range.startLine = 1; }
  });
  await fs.mkdir(path.dirname(codeEvidenceIndexFile(wikiRoot)), { recursive: true });
  await fs.writeFile(codeEvidenceIndexFile(wikiRoot), JSON.stringify(snapshot));
  const current = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  const oldWikiRoot = path.join(root, "baseline-wiki");
  const old = new baseline.PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: oldWikiRoot });
  // Parser upgrades affect extraction metadata, not the fixed query corpus.
  // Each runtime validates its own roster against identical fragment bytes.
  await fs.mkdir(path.dirname(codeEvidenceIndexFile(oldWikiRoot)), { recursive: true });
  await fs.writeFile(codeEvidenceIndexFile(oldWikiRoot), JSON.stringify({ ...snapshot, adapters: old.registry.roster() }));
  for (const query of ["handleOrder5", "andleOrd", "unfindableNeedle", "order", "bounded retry", "Ｔｉｅｄ", "Ns::Tied", "ORDER_RETRY_LIMIT", "src/Service1", "orders.js"])
    for (const maxResults of [1, 2, 12, 100])
      for (const kinds of [undefined, [], ["method"], ["function"]] as CodeSearchOptions["kinds"][])
        for (const paths of [undefined, [], ["src/Service1.ts"], ["src/"], ["missing"]]) {
          const options = { maxResults, kinds, paths };
          assert.deepEqual(await current.search(query, options), await old.search(query, options), JSON.stringify({ query, options }));
          comparisons++;
          assert.deepEqual(await current.symbol(query, options), await old.symbol(query, options), JSON.stringify({ query, options }));
          comparisons++;
        }
  console.log(JSON.stringify({ comparisons, result: "identical", scope: "Text and symbol optimization; corrected import edges have separate positive/negative regressions." }));
} finally { clearWorkspaceStates(); baselineState.clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
