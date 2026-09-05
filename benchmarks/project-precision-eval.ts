import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

interface Page { id: string; source?: string; anchor?: string; body: string; synthetic?: boolean }
interface Case { id: string; split: string; query: string; expected: string[]; gap: boolean; heading?: string; excerpt?: string; contradictionCheck?: boolean; maxResults?: number }
const runtimeRoot = process.argv.find((v) => v.startsWith("--runtime="))?.slice(10) ?? ".";
const moduleUrl = (name: string) => pathToFileURL(path.resolve(runtimeRoot, `src/core/${name}.ts`)).href;
const { retrieveWikiHybrid } = await import(moduleUrl("hybrid-retrieval")) as typeof import("../src/core/hybrid-retrieval.js");
const { PersistentCodeEvidenceIndex } = await import(moduleUrl("code-evidence/index")) as typeof import("../src/core/code-evidence/index.js");
const { clearWorkspaceStates } = await import(moduleUrl("workspace-state")) as typeof import("../src/core/workspace-state.js");
const fixturePath = new URL("fixtures/project-precision-golden.json", import.meta.url);
const bytes = await fs.readFile(fixturePath, "utf8");
const fixture = JSON.parse(bytes) as { version: number; provenance: string; pages: Page[]; cases: Case[] };
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-project-precision-"));
const cases: Array<{ id: string; split: string; query: string; expected: string[]; found: string[]; shown: string[]; usefulFound: string[]; usefulShown: string[]; expectedGap: boolean; predictedGap: boolean; passageCorrect: boolean; evidenceGaps: string[]; budgetLimitedGaps: string[] }> = [];
try {
  await fs.mkdir(path.join(root, "concepts"));
  for (const page of fixture.pages) {
    if (page.source) assert.ok((await fs.readFile(page.source, "utf8")).includes(page.anchor!), `source anchor changed: ${page.id}`);
    await fs.writeFile(path.join(root, `concepts/${page.id}.md`), `---\ntitle: ${page.id}\ntype: concept\nsources: []\n---\n${page.body}\n`);
  }
  for (const query of fixture.cases) {
    const result = await retrieveWikiHybrid({ wikiRoot: root, query: query.query, maxResults: query.maxResults ?? 3, semanticEnabled: false, persistDerivedIndexes: false, coverageRequirements: { requireContradictionCheck: query.contradictionCheck } });
    const ids = (hits: typeof result.hits) => [...new Set(hits.map((hit) => path.basename(hit.path, ".md")))];
    const found = ids(result.coverageHits), shown = ids(result.hits);
    const usefulFound = query.expected.filter((id) => found.includes(id));
    const usefulShown = query.expected.filter((id) => shown.includes(id));
    const predictedGap = !result.coverage.displaySufficient;
    const passageCorrect = (!query.heading || result.hits[0]?.heading === query.heading) && (!query.excerpt || result.hits[0]?.excerpt.includes(query.excerpt) === true);
    cases.push({ id: query.id, split: query.split, query: query.query, expected: query.expected, found, shown, usefulFound, usefulShown, expectedGap: query.gap, predictedGap, passageCorrect, evidenceGaps: result.coverage.evidenceGaps, budgetLimitedGaps: result.coverage.budgetLimitedGaps });
  }
  const summaries = Object.fromEntries(["development", "evaluation"].map((split) => {
    const selected = cases.filter((c) => c.split === split);
    const expected = selected.reduce((n, c) => n + c.expected.length, 0);
    const shown = selected.reduce((n, c) => n + c.shown.length, 0);
    const usefulShown = selected.reduce((n, c) => n + c.usefulShown.length, 0);
    const predictedGaps = selected.filter((c) => c.predictedGap).length;
    const correctGaps = selected.filter((c) => c.expectedGap && c.predictedGap).length;
    return [split, { cases: selected.length, foundRecall: selected.reduce((n, c) => n + c.usefulFound.length, 0) / expected, shownRecall: usefulShown / expected, shownPrecision: shown ? usefulShown / shown : 1, gapPrecision: predictedGaps ? correctGaps / predictedGaps : 1, correctGaps, falseGaps: selected.filter((c) => !c.expectedGap && c.predictedGap).length, silentMisses: selected.filter((c) => c.expectedGap && !c.predictedGap).length, passageErrors: selected.filter((c) => !c.passageCorrect).length }];
  }));
  // Exercise actual adapters independently of the document questions.
  const repositoryRoot = path.join(root, "code-project");
  const codeFiles: Record<string, string> = {
    "lib/Module.ts": "export const value = 1;",
    "other/Module.ts": "export const value = 2;",
    "src/explicit.ts": 'import "../lib/Module.ts";',
    "src/runtime.ts": 'import "../lib/Module.js";',
    "src/package.ts": 'import "Module"; import "lib/Module.ts"; import "@alias/Module";',
    "src/other.ts": 'import "../other/Module.ts";',
    "orders.py": "def place_order():\n    return 1\n",
    "service.py": "from orders import place_order\ndef run():\n    return place_order()\n",
    "src/dynamic.py": 'import importlib\nmodule = importlib.import_module("hidden_module")',
  };
  for (const [name, source] of Object.entries(codeFiles)) {
    await fs.mkdir(path.dirname(path.join(repositoryRoot, name)), { recursive: true });
    await fs.writeFile(path.join(repositoryRoot, name), source);
  }
  const code = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot: path.join(repositoryRoot, "wiki") });
  await code.rebuild();
  const snapshot = await code.snapshot();
  const module = snapshot.fragments.find((fragment) => fragment.kind === "module" && fragment.path === "lib/Module.ts")!;
  const imports = [...new Set((await code.references(module.id, { maxResults: 100 })).filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
  const expectedImports = ["src/explicit.ts", "src/runtime.ts"];
  const usefulImports = imports.filter((name) => expectedImports.includes(name));
  const pythonModule = snapshot.fragments.find((fragment) => fragment.kind === "module" && fragment.path === "orders.py")!;
  const pythonImports = (await code.references(pythonModule.id, { maxResults: 100 })).filter((hit) => hit.relation === "import")
    .map((hit) => ({ path: hit.source.path, kind: hit.source.kind }));
  const codeReferences = { codeFixtureVersion: 2, codeFixtureSha256: createHash("sha256").update(JSON.stringify(codeFiles)).digest("hex"),
    pythonImports, expectedPythonImports: [{ path: "service.py", kind: "module" }, { path: "service.py", kind: "function" }],
    expectedImports, imports, recall: usefulImports.length / expectedImports.length, precision: imports.length ? usefulImports.length / imports.length : 0,
    dynamicPythonImportRecovered: snapshot.fragments.some((fragment) => fragment.path === "src/dynamic.py" && fragment.imports.includes("hidden_module")),
    knownLimit: "The Python adapter does not resolve importlib.import_module string targets." };
  const report = { version: fixture.version, fixtureSha256: createHash("sha256").update(bytes).digest("hex"), provenance: fixture.provenance, syntheticPageCount: fixture.pages.filter((p) => p.synthetic).length, codeReferences, summaries, cases };
  const output = process.argv.find((v) => v.startsWith("--json="))?.slice(7) ?? "benchmarks/results/274-project-precision.json";
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(summaries, null, 2));
} finally { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); }
