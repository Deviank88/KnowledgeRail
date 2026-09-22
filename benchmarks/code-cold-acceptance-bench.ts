import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type * as Index from "../src/core/code-evidence/index.js";

const arg = (name: string, fallback = "") => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
assert.ok(arg("baseline") && arg("repository") && arg("oracle"));
const iterations = Number(arg("iterations", "30"));
assert.ok(Number.isInteger(iterations) && iterations >= 20);
const bytes = await fs.readFile(arg("oracle"));
const oracle = JSON.parse(bytes.toString()) as Array<{ id: string; target: string; source: string; relation: string }>;
oracle.sort((a, b) => a.id.localeCompare(b.id));
const root = await fs.mkdtemp(join(tmpdir(), "kr-cold-acceptance-"));
const subjects: Array<{ label: string | undefined; clear: () => void; api: typeof Index; index: Index.PersistentCodeEvidenceIndex;
  targets: Array<string | undefined>; rebuildMs: number; fragments: number; samples: number[]; checks: boolean[] }> = [];
const stats = (values: number[]) => { const a = [...values].sort((x, y) => x - y); return {
  count: a.length, p50Ms: a[Math.ceil(a.length * .5) - 1]!, p95Ms: a[Math.ceil(a.length * .95) - 1]!, minMs: a[0], maxMs: a.at(-1),
}; };
try {
  for (const [label, runtimeRoot] of [["baseline", resolve(arg("baseline"))], ["current", resolve(arg("runtime", "."))]]) {
    const api = await import(pathToFileURL(join(runtimeRoot!, "src/core/code-evidence/index.ts")).href) as typeof Index;
    const { clearWorkspaceStates: clear } = await import(pathToFileURL(join(runtimeRoot!, "src/core/workspace-state.ts")).href);
    const wikiRoot = join(root, label!, "wiki"), repositoryRoot = resolve(arg("repository"));
    const index = new api.PersistentCodeEvidenceIndex({ wikiRoot, repositoryRoot });
    const start = performance.now(); await index.rebuild(); const rebuildMs = performance.now() - start;
    const snapshot = await index.snapshot();
    const targets = oracle.map((o) => snapshot.fragments.find((f) => f.path === o.target && f.kind === "module" && f.qualifiedName === f.path)?.id);
    subjects.push({ label, clear, api, index, targets, rebuildMs, fragments: snapshot.fragments.length, samples: [] as number[], checks: [] as boolean[] });
  }
  const common = oracle.findIndex((_, i) => subjects.every((s) => s.targets[i]));
  assert.ok(common >= 0, "No shared reviewed target");
  for (let i = -2; i < iterations; i++) for (const s of i % 2 ? [...subjects].reverse() : subjects) {
    s.clear();
    const start = performance.now(); await s.index.references(s.targets[common]!, { maxResults: 100 });
    if (i >= 0) s.samples.push(performance.now() - start);
  }
  for (const s of subjects) for (const [i, o] of oracle.entries()) {
    if (!s.targets[i]) { s.checks.push(false); continue; }
    const refs = await s.index.references(s.targets[i]!, { maxResults: 100 });
    s.checks.push(refs.some((r) => r.source.path === o.source && r.relation === o.relation));
  }
  const results = subjects.map((s) => ({ runtime: s.label, rebuildMs: s.rebuildMs, fragments: s.fragments,
    cold: stats(s.samples), samples: s.samples, reviewedPositiveEdges: { passed: s.checks.filter(Boolean).length, total: s.checks.length }, cache: s.api.getCodeQueryCacheDiagnostics(s.index.wikiRoot) }));
  const report = { node: process.version, iterations, warmups: 2, targetOracleId: oracle[common]!.id, oracleSha256: createHash("sha256").update(bytes).digest("hex"), results,
    scope: "Same read-only corpus and first pre-reviewed target; alternating application-cold queries with warm OS filesystem cache. Indexes are temporary. No output parity is claimed across functional versions; positive-edge coverage is reported separately.",
    pass: results[1]!.cold.p50Ms <= results[0]!.cold.p50Ms && results[1]!.cold.p95Ms <= results[0]!.cold.p95Ms && subjects[1]!.checks.every(Boolean) };
  if (arg("json")) await fs.writeFile(arg("json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--gate")) assert.ok(report.pass, "Cold acceptance against the preserved release failed");
} finally { for (const s of subjects) s.clear(); await fs.rm(root, { recursive: true, force: true }); }
