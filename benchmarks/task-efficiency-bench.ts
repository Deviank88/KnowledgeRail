import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { codeEfficiencyHarness, mcpResultForParity } from "./code-efficiency-harness.js";
import { loadHybridFixture, materializeHybridFixture, recoveredEvidenceIds } from "./hybrid-retrieval-quality-eval.js";
import { wikiPageUri } from "../src/context/resource-uri.js";
import { driftLedgerFile } from "../src/core/drift-detection.js";
import type { EvidenceRef, KnowledgeGap, ContextIntent } from "../src/context/context-manifest.js";
import type { TaskContext, TaskContextEvidenceField } from "../src/context/task-context-compiler.js";

const argument = (name: string, fallback = "") => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], min: sorted[0], max: sorted.at(-1) };
};
interface Task {
  id: string; language: string; intent: ContextIntent; objective: string; query: string; queryId?: string;
  scenario?: "stale" | "missing"; changedPaths?: string[];
  expectedCategories: Partial<Record<TaskContextEvidenceField, string[]>>;
  expectedUnknownKinds?: KnowledgeGap["kind"][];
  expectedImpact?: { incomingDependencies?: string[]; outgoingDependencies?: string[] };
}
const bytes = await fs.readFile(new URL("fixtures/efficiency-task-oracle-v1.json", import.meta.url));
const fixture = JSON.parse(bytes.toString()) as { version: number; provenance: string; maxEvidence: number; heuristicTokenBudget: number; tasks: Task[] };
const hybrid = await loadHybridFixture();
const iterations = Number(argument("iterations", "20"));
assert.ok(Number.isInteger(iterations) && iterations >= 5);
const envKeys = ["KNOWLEDGE_RAIL_EMBEDDING_BASE_URL", "KNOWLEDGE_RAIL_EMBEDDING_MODEL", "KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS"];
const previous = envKeys.map((key) => process.env[key]);
envKeys.forEach((key) => { delete process.env[key]; });
const root = await fs.mkdtemp(join(tmpdir(), "kr-task-efficiency-"));
const subjects = [];
const rows = [];
try {
  const versions = [{ label: "current", root: resolve(".") }];
  if (argument("baseline")) versions.unshift({ label: "baseline", root: resolve(argument("baseline")) });
  for (const version of versions) {
    const repositoryRoot = join(root, version.label), wikiRoot = join(repositoryRoot, "wiki");
    await materializeHybridFixture(wikiRoot, hybrid);
    await fs.writeFile(join(wikiRoot, "requirements/StaleDispatch.md"), '---\ntitle: StaleDispatch shipment policy\ntype: requirement\nsources: ["policy/dispatch.md"]\n---\n# StaleDispatch\nStaleDispatch shipment policy requires two approvals. La regola spedizioni richiede due approvazioni.');
    await fs.mkdir(join(driftLedgerFile(wikiRoot), ".."), { recursive: true });
    await fs.writeFile(driftLedgerFile(wikiRoot), JSON.stringify({ version: 1, checkedAt: "2026-09-22T00:00:00Z", entries: [{
      claimId: `claim-${"a".repeat(32)}`, pagePaths: ["requirements/StaleDispatch.md"],
      anchor: { path: "shipping/policy.py", startLine: 1, endLine: 1, rangeHash: "b".repeat(64), parserVersion: "python-deterministic-v1", capturedAt: "2026-09-21T00:00:00Z" },
      checkedAt: "2026-09-22T00:00:00Z", verdict: "drift_suspected", reason: "content_changed",
    }] }));
    const module = (path: string) => import(pathToFileURL(join(version.root, "src", path)).href);
    const workspace = await module("core/workspace-context.ts") as typeof import("../src/core/workspace-context.js");
    const state = await module("core/workspace-state.ts") as typeof import("../src/core/workspace-state.js");
    const server = await module("mcp/server.ts") as typeof import("../src/mcp/server.js");
    const context = workspace.createWorkspaceContext(repositoryRoot);
    const harness = await workspace.runWithWorkspaceContext(context, () => codeEfficiencyHarness(server.buildServer));
    subjects.push({ ...version, wikiRoot, harness, clear: state.clearWorkspaceStates,
      request: (method: string, params: Record<string, unknown>) => workspace.runWithWorkspaceContext(context, () => harness.request(method, params)) });
  }
  for (const task of fixture.tasks) for (const strategy of ["passages", "pages"] as const) for (const detail of ["full", "compact"] as const) {
    const samples = new Map<string, number[]>();
    const digests = new Set<string>(), contextDigests = new Set<string>();
    for (let iteration = -1; iteration < iterations; iteration++) for (const subject of iteration % 2 ? [...subjects].reverse() : subjects) {
      subject.clear();
      const before = subject.harness.bytes(), start = performance.now();
      const response = await subject.request("tools/call", { name: "knowledge_context", arguments: {
        intent: task.intent, objective: task.objective, query: task.query, changed_paths: task.changedPaths,
        max_evidence: fixture.maxEvidence, heuristic_token_budget: fixture.heuristicTokenBudget, response_detail: detail,
      } });
      const context = response.structuredContent as unknown as TaskContext;
      const evidence = context.evidence as EvidenceRef[];
      const unknowns = detail === "full" ? context.unknowns : context.gaps;
      const unique = [...new Map(evidence.map((entry) => [strategy === "pages" ? wikiPageUri(entry.path) : entry.uri, entry])).entries()];
      const resources = [];
      const resourceErrors: string[] = [];
      const hits: Array<{ path: string; heading: string; excerpt: string }> = [];
      for (const [uri, entry] of unique) {
        let resource;
        try { resource = await subject.request("resources/read", { uri }); }
        catch (error) {
          resourceErrors.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        resources.push(resource);
        const contents = resource.contents as Array<{ text?: string }>;
        hits.push({ path: entry.path, heading: strategy === "pages" ? "" : entry.heading ?? "", excerpt: contents.map((c) => c.text ?? "").join("\n") });
      }
      const elapsedMs = performance.now() - start, after = subject.harness.bytes();
      const oracle = hybrid.queries.find((q) => q.id === task.queryId);
      // Full-page reads have no passage heading; verify every expected literal
      // in its expected source path rather than deriving labels from retrieval.
      const recovered = oracle ? strategy === "passages" ? [...recoveredEvidenceIds(hits, oracle.relevant, 100)]
        : oracle.relevant.filter((e) => hits.some((hit) => hit.path === e.path && hit.excerpt.includes(e.match))).map((e) => e.id) : [];
      const missing = oracle?.relevant.filter((e) => !recovered.includes(e.id)).map((e) => e.id) ?? [];
      const unknownsPresent = (task.expectedUnknownKinds ?? []).every((kind) => unknowns.some((gap) => gap.kind === kind));
      const categoryMissing = detail === "full" ? Object.entries(task.expectedCategories).flatMap(([field, paths]) =>
        paths!.filter((path) => !context[field as TaskContextEvidenceField].some((e) => e.path === path))) : [];
      const impactMissing = detail === "full" ? Object.entries(task.expectedImpact ?? {}).flatMap(([field, paths]) =>
        paths.filter((path) => !context.changeImpact[field as "incomingDependencies" | "outgoingDependencies"].some((e) => e.path === path))) : [];
      const pass = resourceErrors.length === 0 && missing.length === 0 && unknownsPresent && categoryMissing.length === 0 && impactMissing.length === 0 &&
        (task.scenario !== "missing" || evidence.length === 0) &&
        (task.scenario !== "stale" || evidence.every((e) => e.path !== "requirements/StaleDispatch.md" || e.stale) && unknowns.some((gap) => gap.kind === "stale_evidence" && gap.paths?.includes("requirements/StaleDispatch.md")));
      contextDigests.add(hash(JSON.stringify(mcpResultForParity(response))));
      if (resourceErrors.length === 0) digests.add(hash(JSON.stringify(resources.map(mcpResultForParity))));
      if (iteration >= 0) (samples.get(subject.label) ?? (samples.set(subject.label, []), samples.get(subject.label)!)).push(elapsedMs);
      if (iteration === iterations - 1) rows.push({ taskId: task.id, language: task.language, intent: task.intent, runtime: subject.label,
        strategy, detail, pass, resourceErrors, missing, categoryMissing, impactMissing, unknownsPresent,
        evidence: evidence.map((e) => ({ uri: e.uri, path: e.path, stale: e.stale, staleReason: e.staleReason })), unknowns,
        tools: 1, resourceReads: unique.length, requests: 1 + unique.length,
        requestBytes: after.requestBytes - before.requestBytes, responseBytes: after.responseBytes - before.responseBytes,
        contextChannels: { contentBytes: size((response as unknown as { content: unknown }).content), structuredContentBytes: size(response.structuredContent) },
        elapsedMs: stats(samples.get(subject.label)!),
        directSelectedPagesBytes: (await Promise.all([...new Set(evidence.map((e) => e.path))].map(async (path) => (await fs.readFile(join(subject.wikiRoot, path))).length))).reduce((a, b) => a + b, 0),
      });
    }
    assert.equal(contextDigests.size, 1, `Context parity failed: ${task.id}/${strategy}/${detail}`);
    assert.ok(digests.size <= 1, `Successful resource parity failed: ${task.id}/${strategy}/${detail}`);
  }
  for (const row of rows.filter((r) => r.detail === "full")) {
    const compact: { evidence: unknown; unknowns: unknown } = rows.find((r) => r.taskId === row.taskId && r.runtime === row.runtime && r.strategy === row.strategy && r.detail === "compact")!;
    assert.deepEqual(compact.evidence, row.evidence, "Compact projection lost evidence or staleness");
    assert.deepEqual(compact.unknowns, row.unknowns, "Compact projection lost uncertainty");
  }
  const report = { version: 1, fixtureSha256: hash(bytes), baseFixtureSha256: hash(await fs.readFile(new URL("fixtures/hybrid-retrieval-golden.json", import.meta.url))),
    provenance: fixture.provenance, taskCount: fixture.tasks.length, intents: [...new Set(fixture.tasks.map((t) => t.intent))],
    iterations, warmups: 1, rows, pass: rows.filter((r) => r.runtime === "current").every((r) => r.pass), baselineFailures: rows.filter((r) => r.runtime === "baseline" && !r.pass).length,
    observations: { transport: "Actual serialized in-process MCP dispatch; all distinct selected resources are read once per replay",
      clientExposure: "unobserved; content/structuredContent sizes reported separately, not assumed to be model input",
      directBaseline: "bytes of the already-selected original wiki pages only; discovery and model work absent, not an equivalent completed-task baseline",
      freshness: "resources read again on every replay; only duplicate URIs within that replay are coalesced",
      modelTaskSuccess: "not measured", totalModelTokens: null, tokenSavings: "not measured", providerCalls: 0,
      parity: "Context responses match exactly. Successful resource responses match; legacy whole-page routing failures are reported separately and cannot count as successful low-latency tasks.",
      acceptance: "Tool/resource evidence recall and runtime parity, not final artifact quality or completed model tasks" } };
  if (argument("json")) await fs.writeFile(argument("json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--gate")) assert.ok(report.pass, "Task/resource replay oracle failed");
} finally {
  for (const subject of subjects) { subject.clear(); await subject.harness.close(); }
  envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  await fs.rm(root, { recursive: true, force: true });
}
