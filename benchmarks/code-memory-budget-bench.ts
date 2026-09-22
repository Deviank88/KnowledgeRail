import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir, platform, arch, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { multilingualEfficiencyFixture, type EfficiencyCase } from "./code-efficiency-fixture.js";
import { installIoObservation, startIoObservation, finishIoObservation } from "./code-efficiency-io.js";
import type * as Index from "../src/core/code-evidence/index.js";
import type * as Resources from "../src/core/code-evidence/resource-reader.js";

const argument = (name: string, fallback = "") => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], min: sorted[0], max: sorted.at(-1) };
};
interface WorkerConfig { runtime: string; projects: string[]; targets: Array<EfficiencyCase & { id: string }>; iterations: number }

async function worker(config: WorkerConfig) {
  const module = (path: string) => import(pathToFileURL(join(config.runtime, "src", path)).href);
  const api = await module("core/code-evidence/index.ts") as typeof Index;
  const resources = await module("core/code-evidence/resource-reader.ts") as typeof Resources;
  const { clearWorkspaceStates } = await module("core/workspace-state.ts") as typeof import("../src/core/workspace-state.js");
  installIoObservation();
  const collect = async () => { await new Promise<void>((done) => setImmediate(done)); global.gc!(); return process.memoryUsage(); };
  const before = await collect();
  let sampledPeak = before;
  const observe = () => {
    const memory = process.memoryUsage();
    for (const key of Object.keys(memory) as Array<keyof NodeJS.MemoryUsage>) sampledPeak[key] = Math.max(sampledPeak[key], memory[key]);
  };
  // Retain a separate baseline object; updating peak must not mutate it.
  sampledPeak = { ...before };
  const timer = setInterval(observe, 2), digests = new Set<string>();
  const batch = async () => {
    const start = performance.now(), resultHash = createHash("sha256");
    for (const repositoryRoot of config.projects) {
      const wikiRoot = join(repositoryRoot, "wiki"), index = new api.PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
      for (const target of config.targets) {
        const response = await index.referencesWithDiagnostics(target.id, { maxResults: 100 });
        const positive = response.references.find((r) => r.source.path === target.sourcePath && r.relation === target.relation);
        assert.ok(positive, target.family);
        assert.ok(!response.references.some((r) => r.source.path === target.negativePath), target.family);
        const resource = await resources.readCodeResource({ repositoryRoot, wikiRoot, resourceUri: positive.resourceUri });
        resultHash.update(JSON.stringify({ response, resource }));
        observe();
      }
    }
    const elapsed = performance.now() - start;
    digests.add(resultHash.digest("hex"));
    return elapsed;
  };
  startIoObservation();
  const coldCpu = process.cpuUsage(), coldMs = await batch();
  const cold = { elapsedMs: coldMs, cpu: process.cpuUsage(coldCpu), io: finishIoObservation() };
  const afterCold = await collect();
  const samples = [];
  startIoObservation();
  const warmCpu = process.cpuUsage();
  for (let i = 0; i < config.iterations; i++) samples.push(await batch());
  const warm = { elapsedMs: stats(samples), samples, cpu: process.cpuUsage(warmCpu), io: finishIoObservation() };
  const afterWarm = await collect();
  observe(); clearInterval(timer);
  const cache = config.projects.map((project) => api.getCodeQueryCacheDiagnostics(join(project, "wiki")));
  clearWorkspaceStates();
  const afterEviction = await collect();
  assert.equal(digests.size, 1);
  return { cold, warm, cache, before, afterCold, afterWarm, afterEviction, sampledPeak,
    processMaxRssKiB: process.resourceUsage().maxRSS, resultDigest: [...digests][0] };
}

if (argument("worker")) {
  assert.ok(global.gc, "Run with --expose-gc");
  console.log(JSON.stringify(await worker(JSON.parse(await fs.readFile(argument("worker"), "utf8")))));
} else {
  const scale = Number(argument("scale", "10000")), iterations = Number(argument("iterations", "20")), repetitions = Number(argument("repetitions", "3"));
  const workspaceCounts = argument("workspaces", "1,4,5").split(",").map(Number);
  assert.ok(Number.isInteger(scale) && scale >= 20 && Number.isInteger(iterations) && iterations >= 5 && Number.isInteger(repetitions) && repetitions > 0);
  assert.ok(workspaceCounts.every((n) => Number.isInteger(n) && n >= 1 && n <= 5));
  const root = await fs.mkdtemp(join(tmpdir(), "kr-code-memory-")), repository = resolve(".");
  try {
    const projects = Array.from({ length: Math.max(...workspaceCounts) }, (_, i) => join(root, `project-${i}`));
    const fixture = multilingualEfficiencyFixture(scale, false);
    for (const [path, content] of fixture.files) {
      await fs.mkdir(join(projects[0]!, path, ".."), { recursive: true });
      await fs.writeFile(join(projects[0]!, path), content);
    }
    const api = await import("../src/core/code-evidence/index.js");
    const index = new api.PersistentCodeEvidenceIndex({ repositoryRoot: projects[0]!, wikiRoot: join(projects[0]!, "wiki") });
    await index.rebuild();
    const snapshot = await index.snapshot();
    const targets = fixture.cases.map((entry) => ({ ...entry, id: snapshot.fragments.find((f) => f.path === entry.targetPath &&
      (entry.symbol ? f.kind !== "module" && f.symbol === entry.symbol : f.kind === "module"))!.id }));
    for (const project of projects.slice(1)) await fs.cp(projects[0]!, project, { recursive: true });
    const runtimes = [];
    let productionBudgetMiB = 0;
    for (const budgetMiB of [32, 64]) {
      const runtime = join(root, `runtime-${budgetMiB}`);
      await fs.mkdir(runtime);
      await fs.cp(join(repository, "src"), join(runtime, "src"), { recursive: true });
      await fs.copyFile(join(repository, "package.json"), join(runtime, "package.json"));
      await fs.symlink(join(repository, "node_modules"), join(runtime, "node_modules"), "dir");
      const file = join(runtime, "src/core/code-evidence/index.ts"), original = await fs.readFile(file, "utf8");
      const declaration = /const MAX_QUERY_CACHE_ESTIMATED_BYTES = (\d+) \* 1024 \* 1024;/u;
      const match = original.match(declaration); assert.ok(match);
      productionBudgetMiB = Number(match[1]);
      await fs.writeFile(file, original.replace(declaration, `const MAX_QUERY_CACHE_ESTIMATED_BYTES = ${budgetMiB} * 1024 * 1024;`));
      runtimes.push({ budgetMiB, runtime });
    }
    const results = [];
    for (const workspaces of workspaceCounts) for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const runtime of repetition % 2 ? [...runtimes].reverse() : runtimes) {
        const config = join(root, "worker.json");
        await fs.writeFile(config, JSON.stringify({ runtime: runtime.runtime, projects: projects.slice(0, workspaces), targets, iterations } satisfies WorkerConfig));
        const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), `--worker=${config}`], {
          maxBuffer: 8 * 1024 * 1024, timeout: 300_000,
          env: { ...process.env, KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP: "5" },
        });
        results.push({ budgetMiB: runtime.budgetMiB, workspaces, repetition, ...JSON.parse(stdout) });
        console.error(`Completed budget=${runtime.budgetMiB} MiB, workspaces=${workspaces}, repetition=${repetition + 1}`);
      }
    }
    for (const workspaces of workspaceCounts) assert.equal(new Set(results.filter((r) => r.workspaces === workspaces).map((r) => r.resultDigest)).size, 1);
    const report = { version: 2, environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem(), workspaceStateCap: 5 },
      scale, actualFragments: snapshot.fragments.length, snapshotBytes: (await fs.stat(api.codeEvidenceIndexFile(join(projects[0]!, "wiki")))).size,
      fixtureDigest: hash(fixture), iterations, repetitions, productionBudgetMiB, results,
      observations: { scope: "Isolated fresh processes; internal reference + reviewed resource reads, sequential complete batches across projects",
        memory: "GC before baseline and retained/released checkpoints; no forced GC between warm batches. RSS may remain allocated after eviction. Sampling can miss synchronous peaks; process maximum includes module startup.",
        exposure: "Code subsystem only; full MCP, semantic/document caches, other processes and model-client memory excluded",
        filesystem: "OS cache exercised by fixture creation/indexing, never flushed; API IO is not physical SSD traffic",
        budget: "Variants change disposable copies only; productionBudgetMiB records the checked-out default. Estimates are admission accounting, not process RAM limits.",
        modelTokens: null } };
    if (argument("json")) await fs.writeFile(argument("json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
