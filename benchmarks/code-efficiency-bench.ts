import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir, platform, arch, cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codeEfficiencyHarness, mcpResultForParity } from "./code-efficiency-harness.js";
import { installIoObservation, startIoObservation, finishIoObservation, type IoObservation } from "./code-efficiency-io.js";
import type * as Index from "../src/core/code-evidence/index.js";
import type * as Runtime from "../src/core/code-evidence/query-runtime.js";
import type * as Workspace from "../src/core/workspace-context.js";
import { multilingualEfficiencyFixture, salesforceEfficiencyFixture, type EfficiencyCase, type EfficiencyFixture } from "./code-efficiency-fixture.js";
import type { CodeReference } from "../src/core/code-evidence/types.js";

const argument = (name: string, fallback = "") => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length };
};
type Sample = { elapsedMs: number; cpuUserMs: number; cpuSystemMs: number; phasesMs: Record<string, number>;
  memory: NodeJS.MemoryUsage; sampledPeak: NodeJS.MemoryUsage; digest: string; requestBytes: number; responseBytes: number;
  io: IoObservation; processWallMs?: number; familyLatencyMs: Record<string, number[]>; debugResult?: unknown };
let active: Record<string, number> | undefined;
const instrumented = new WeakMap<object, Set<string>>();
function instrument(prototype: object, name: string, field: string, asynchronous: boolean) {
  const names = instrumented.get(prototype) ?? new Set<string>();
  if (names.has(name)) return;
  names.add(name); instrumented.set(prototype, names);
  const methods = prototype as Record<string, (...args: unknown[]) => unknown>;
  const original = methods[name];
  if (!original) return;
  const record = (start: number) => { if (active) active[field] = (active[field] ?? 0) + performance.now() - start; };
  methods[name] = asynchronous ? async function (this: unknown, ...args) {
    const start = performance.now();
    try { return await original.apply(this, args); } finally { record(start); }
  } : function (this: unknown, ...args) {
    const start = performance.now();
    try { return original.apply(this, args); } finally { record(start); }
  };
}
async function load(root: string, repositoryRoot: string, wikiRoot: string) {
  const module = (file: string) => import(pathToFileURL(join(root, "src", file)).href);
  const api = await module("core/code-evidence/index.ts") as typeof Index;
  const { CodeQueryRuntime } = await module("core/code-evidence/query-runtime.ts") as typeof Runtime;
  const { clearWorkspaceStates: clear } = await module("core/workspace-state.ts") as { clearWorkspaceStates(): void };
  instrument(api.PersistentCodeEvidenceIndex.prototype, "queryRuntime", "runtime", true);
  instrument(CodeQueryRuntime.prototype, "refreshSourceMetadata", "metadata", true);
  instrument(CodeQueryRuntime.prototype, "refreshProjectStructure", "structure", true);
  instrument(CodeQueryRuntime.prototype, "referenceIndex", "references", false);
  const contextApi = await module("core/workspace-context.ts") as typeof Workspace;
  const context = { ...contextApi.createWorkspaceContext(repositoryRoot), paths: { projectRoot: repositoryRoot, wikiRoot, docsRoot: join(wikiRoot, "docs") } };
  const { buildServer } = await module("mcp/server.ts") as typeof import("../src/mcp/server.js");
  const harness = await contextApi.runWithWorkspaceContext(context, () => codeEfficiencyHarness(buildServer));
  const index = () => new api.PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
  installIoObservation();
  return { api, clear, index, harness,
    publicRequest: (method: string, params: Record<string, unknown>) => contextApi.runWithWorkspaceContext(context, () => harness.request(method, params)) };
}
type Subject = Awaited<ReturnType<typeof load>>;
type Target = Partial<EfficiencyCase> & { id: string };
function verifyReferences(target: Target, references: CodeReference[]) {
  if (!target.sourcePath) return;
  assert.ok(references.some((r) => r.source.path === target.sourcePath && r.relation === target.relation), `${target.family}: missing reviewed positive edge`);
  assert.ok(!references.some((r) => r.source.path === target.negativePath), `${target.family}: false edge from negative control`);
}
async function measure(subject: Subject, targets: Target[], publicPath: boolean, concurrency = 1, updatePath?: string, session?: { batches: number; update: EfficiencyFixture["update"] }): Promise<Sample> {
  const beforeBytes = subject.harness.bytes();
  let sampledPeak = process.memoryUsage();
  const sampleMemory = () => {
    const current = process.memoryUsage();
    sampledPeak = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Math.max(value, sampledPeak[key as keyof NodeJS.MemoryUsage])])) as unknown as NodeJS.MemoryUsage;
  };
  const timer = setInterval(sampleMemory, 2);
  startIoObservation();
  const cpu = process.cpuUsage(), start = performance.now();
  active = {};
  let result: unknown;
  const familyLatencyMs: Record<string, number[]> = {};
  try {
    if (session) {
      const rebuildStart = performance.now();
      await subject.index().rebuild();
      active.initialIndex = performance.now() - rebuildStart;
    }
    if (updatePath) {
      const updateStart = performance.now();
      await subject.index().updateFile(updatePath);
      active.updatePersistence = performance.now() - updateStart;
    }
    result = [];
    for (let batchNumber = 0; batchNumber < (session?.batches ?? 1); batchNumber++) {
      if (session && batchNumber === Math.floor(session.batches / 2)) {
        const updateStart = performance.now();
        await fs.writeFile(join(subject.index().repositoryRoot, session.update.path), session.update.contents[1]);
        await subject.index().updateFile(session.update.path);
        active.updatePersistence = performance.now() - updateStart;
      }
      (result as unknown[]).push(await Promise.all(Array.from({ length: concurrency }, async () => {
        const batch = [];
        for (const target of targets) {
          const familyStart = performance.now();
          try {
            if (!publicPath) {
              const result = await subject.index().referencesWithDiagnostics(target.id, { maxResults: 100 });
              verifyReferences(target, result.references);
              batch.push(result);
              continue;
            }
            const response = await subject.publicRequest("tools/call", { name: "knowledge_code", arguments: { action: "references", symbol_id: target.id, max_results: 100 } });
            const structured = response.structuredContent!;
            const references = structured.references as CodeReference[];
            assert.ok(Array.isArray(references));
            verifyReferences(target, references);
            // Materialize one returned source, including its payload and freshness check.
            const resourceReference = references.find((r) => r.source.path === target.sourcePath) ?? references[0];
            const resource = resourceReference ? await subject.publicRequest("resources/read", { uri: resourceReference.resourceUri }) : undefined;
            const { requestId: _requestId, ...stable } = structured;
            batch.push({ ...mcpResultForParity(response), structuredContent: stable, resource: mcpResultForParity(resource) });
          } finally { (familyLatencyMs[target.family ?? "reviewed"] ??= []).push(performance.now() - familyStart); }
        }
        return batch;
      })));
    }
  } finally { clearInterval(timer); sampleMemory(); }
  const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
  const io = finishIoObservation();
  const phasesMs = active; active = undefined;
  phasesMs.loadAndPrepare = (phasesMs.runtime ?? 0) - (phasesMs.metadata ?? 0);
  const afterBytes = subject.harness.bytes();
  return { elapsedMs, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, phasesMs, io,
    memory: process.memoryUsage(), sampledPeak, familyLatencyMs, digest: hash(JSON.stringify(result)),
    ...(process.env["KNOWLEDGE_RAIL_BENCH_DEBUG_RESULTS"] === "1" ? { debugResult: result } : {}),
    requestBytes: afterBytes.requestBytes - beforeBytes.requestBytes, responseBytes: afterBytes.responseBytes - beforeBytes.responseBytes };
}

async function sourceDigest(root: string) {
  const files: Array<[string, string]> = [];
  async function walk(directory: string) {
    for (const entry of (await fs.readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(directory, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith(".ts")) files.push([relative, hash(await fs.readFile(join(root, relative)))]);
    }
  }
  await walk("src");
  return { algorithm: "sha256-json-sorted-path-content-digests-v1", digest: hash(JSON.stringify(files)), files: files.length };
}

async function main() {
  if (argument("worker")) {
    const config = JSON.parse(await fs.readFile(argument("worker"), "utf8")) as { root: string; repositoryRoot: string; wikiRoot: string; targets: Target[]; publicPath: boolean };
    const subject = await load(config.root, config.repositoryRoot, config.wikiRoot);
    try { console.log(JSON.stringify(await measure(subject, config.targets, config.publicPath))); }
    finally { subject.clear(); await subject.harness.close(); }
    return;
  }
  const iterations = Number(argument("iterations", "20"));
  const profile = argument("profile", "multilingual");
  assert.ok(["multilingual", "salesforce"].includes(profile), "Unknown profile");
  assert.ok(["dense", "sparse"].includes(argument("layout", "dense")), "Unknown layout");
  const scales = argument("scales", "1000,10000").split(",").map(Number);
  assert.ok(Number.isInteger(iterations) && iterations >= 5 && scales.every((n) => Number.isInteger(n) && n >= 20));
  assert.ok(!argument("repository") || argument("oracle"), "A real repository requires a pre-reviewed oracle");
  const root = await fs.mkdtemp(join(tmpdir(), "kr-efficiency-"));
  const runtimeRoots = [{ label: "current", root: resolve(argument("runtime-root", ".")) }];
  if (argument("baseline")) runtimeRoots.unshift({ label: "baseline", root: resolve(argument("baseline")) });
  const runtimes = await Promise.all(runtimeRoots.map(async (entry) => ({ ...entry, source: await sourceDigest(entry.root) })));
  const sessions = argument("sessions").split(",").filter(Boolean).map(Number);
  assert.ok(sessions.every((n) => [1, 5, 20].includes(n)), "Session batches must be 1, 5 or 20");
  const results = [];
  try {
    for (const scale of argument("repository") ? [0] : scales) {
      const repositoryRoot = argument("repository") ? resolve(argument("repository")) : join(root, `fixture-${scale}`);
      let cases: Partial<EfficiencyCase>[], fixtureDigest: string, updateSpec: EfficiencyFixture["update"] | undefined;
      if (scale) {
        const fixture = (profile === "multilingual" ? multilingualEfficiencyFixture : salesforceEfficiencyFixture)(scale, argument("layout", "dense") === "sparse");
        for (const [file, content] of fixture.files) {
          await fs.mkdir(join(repositoryRoot, file, ".."), { recursive: true });
          await fs.writeFile(join(repositoryRoot, file), content);
        }
        cases = fixture.cases;
        updateSpec = fixture.update;
        fixtureDigest = hash(JSON.stringify(fixture));
      } else {
        const bytes = await fs.readFile(argument("oracle"));
        const oracle = JSON.parse(bytes.toString()) as Array<{ id: string; target: string }>;
        cases = [{ targetPath: [...oracle].sort((a, b) => a.id.localeCompare(b.id))[0]!.target }];
        fixtureDigest = hash(bytes);
      }
      const subjects = [];
      for (const runtime of runtimes) {
        const subjectRepository = scale ? join(root, `${scale}-${runtime.label}`) : repositoryRoot;
        if (scale) await fs.cp(repositoryRoot, subjectRepository, { recursive: true });
        const wikiRoot = scale ? join(subjectRepository, "wiki") : join(root, runtime.label, "wiki");
        const subject = await load(runtime.root, subjectRepository, wikiRoot);
        const start = performance.now(), cpu = process.cpuUsage();
        startIoObservation();
        const update = await subject.index().rebuild();
        const rebuild = { elapsedMs: performance.now() - start, cpu: process.cpuUsage(cpu), io: finishIoObservation(), ...update };
        const snapshot = await subject.index().snapshot();
        const targets = cases.map((entry) => {
          const target = snapshot.fragments.find((f) => f.path === entry.targetPath && (entry.symbol
            ? f.symbol === entry.symbol && f.kind !== "module" : f.kind === "module" && f.qualifiedName === entry.targetPath));
          assert.ok(target, `${entry.family ?? "Oracle"}: target not indexed`);
          return { ...entry, id: target.id };
        });
        subjects.push({ ...subject, ...runtime, repositoryRoot: subjectRepository, wikiRoot, targets, rebuild, snapshotBytes: (await fs.stat(subject.api.codeEvidenceIndexFile(wikiRoot))).size,
          corpusDigest: hash(JSON.stringify(snapshot.files.map((f) => [f.path, f.contentHash]))), rows: {} as Record<string, Sample[]> });
      }
      try {
        const defaultModes = ["applicationCold", "warm", "concurrent", "publicCold", "publicWarm", "restart", "publicRestart", "postUpdate", "publicPostUpdate", ...sessions.map((n) => `publicSession${n}`)];
        const modes = argument("modes") ? argument("modes").split(",") : defaultModes;
        assert.ok(modes.every((mode) => defaultModes.includes(mode)), "Unknown measurement mode");
        for (const mode of modes) {
          // Public paths require projectRoot/wiki. Never write telemetry or an
          // index into an authorized read-only real checkout.
          if (!scale && (mode.startsWith("public") || mode.endsWith("Update"))) continue;
          for (let iteration = -2; iteration < iterations; iteration++) {
            for (const subject of iteration % 2 ? [...subjects].reverse() : subjects) {
              const publicPath = mode.startsWith("public");
              const session = mode.startsWith("publicSession") ? { batches: Number(mode.slice("publicSession".length)), update: updateSpec! } : undefined;
              if (session) {
                subject.clear();
                await fs.rm(subject.api.codeEvidenceIndexFile(subject.wikiRoot), { force: true });
                await fs.writeFile(join(subject.repositoryRoot, session.update.path), session.update.contents[0]);
              }
              const updatePath = mode.endsWith("Update") ? updateSpec!.path : undefined;
              if (updatePath) await fs.writeFile(join(subject.repositoryRoot, updatePath), updateSpec!.contents[Math.abs(iteration % 2)]!);
              if (mode.includes("Cold") || mode === "concurrent" || mode.toLowerCase().includes("restart")) subject.clear();
              let sample: Sample;
              if (mode.toLowerCase().includes("restart")) {
                if (iteration < 0) continue;
                const config = join(root, "worker.json");
                await fs.writeFile(config, JSON.stringify({ root: subject.root, repositoryRoot: subject.repositoryRoot, wikiRoot: subject.wikiRoot, targets: subject.targets, publicPath }));
                const start = performance.now();
                const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), `--worker=${config}`], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
                sample = JSON.parse(stdout) as Sample;
                sample.processWallMs = performance.now() - start;
              } else sample = await measure(subject, subject.targets, publicPath, mode === "concurrent" ? 8 : 1, updatePath, session);
              if (iteration >= 0) (subject.rows[mode] ??= []).push(sample);
            }
          }
        }
        for (const mode of Object.keys(subjects[0]!.rows)) {
          const digests: string[] = subjects.flatMap((s) => s.rows[mode]!.map((row) => row.digest));
          if (new Set(digests).size !== 1 && argument("debug-json")) await fs.writeFile(argument("debug-json"), JSON.stringify({ mode,
            subjects: subjects.map((s) => ({ runtime: s.label, samples: s.rows[mode] })) }, null, 2));
          assert.equal(new Set(digests).size, 1, `Result/diagnostic parity failed: ${mode}`);
        }
        for (const subject of subjects) {
          for (const target of subject.targets) await subject.index().referencesWithDiagnostics(target.id, { maxResults: 100 });
          global.gc?.();
          const retainedMemory = process.memoryUsage();
          const cache = subject.api.getCodeQueryCacheDiagnostics(subject.wikiRoot);
          subject.clear();
          global.gc?.();
          results.push({ runtime: subject.label, scale, profile: scale ? profile : "real-reviewed", oracle: cases, queryCountPerBatch: cases.length, layout: argument("layout", "dense"), fixtureDigest, corpusDigest: subject.corpusDigest,
            snapshotBytes: subject.snapshotBytes, rebuild: subject.rebuild, cache, retainedMemory, releasedMemory: process.memoryUsage(),
            measurements: Object.fromEntries(Object.entries(subject.rows).map(([mode, rows]) => [mode, {
              familyLatencyMs: Object.fromEntries(Object.keys(rows[0]!.familyLatencyMs).map((family) => [family, stats(rows.flatMap((r) => r.familyLatencyMs[family]!))])),
              elapsedMs: stats(rows.map((r) => r.elapsedMs)), cpuUserMs: stats(rows.map((r) => r.cpuUserMs)), cpuSystemMs: stats(rows.map((r) => r.cpuSystemMs)),
              phasesMs: Object.fromEntries(Object.keys(rows[0]!.phasesMs).map((phase) => [phase, stats(rows.map((r) => r.phasesMs[phase] ?? 0))])),
              requestBytes: stats(rows.map((r) => r.requestBytes)), responseBytes: stats(rows.map((r) => r.responseBytes)),
              ...(rows[0]!.processWallMs === undefined ? {} : { processWallMs: stats(rows.map((r) => r.processWallMs!)) }),
              io: { readBytes: stats(rows.map((r) => r.io.readBytes)), writtenBytes: stats(rows.map((r) => r.io.writtenBytes)),
                operations: Object.fromEntries([...new Set(rows.flatMap((r) => Object.keys(r.io.operations)))].sort().map((name) => [name, stats(rows.map((r) => r.io.operations[name] ?? 0))])) },
              resultDigest: rows[0]!.digest, samples: rows,
            }])) });
        }
      } finally { for (const subject of subjects) { subject.clear(); await subject.harness.close(); } }
    }
    const benchmarkDigest = hash(JSON.stringify(await Promise.all(["code-efficiency-bench.ts", "code-efficiency-harness.ts", "code-efficiency-io.ts", "code-efficiency-fixture.ts"].map(async (name) =>
      [name, hash(await fs.readFile(new URL(name, import.meta.url)))]))));
    const report = { version: 2, benchmarkDigest, environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, gcExposed: Boolean(global.gc) },
      iterations, warmups: 2, profile, sessionBatches: sessions, runtimes: runtimes.map(({ label, source }) => ({ label, source })),
      observation: { filesystemCache: "OS cache exercised by fixture creation and indexing; not flushed", publicTransport: "serialized in-process MCP request/response, telemetry and one resource read per target included",
        memory: "process-wide bytes; 2ms sampling plus operation boundaries, synchronous peaks may be missed; paired runtimes coexist; restart samples isolate each runtime",
        phaseConcurrency: "eight concurrent batches; targets within each batch run sequentially; phase durations overlap, do not add them", task: "deterministic reference/resource replay; not a completed model task",
        io: "fs/promises API calls and file handles, including failures; callback APIs (glob discovery), kernel syscalls and physical disk IO excluded",
        realRepository: "internal path only; public runs use disposable synthetic projects so real checkouts remain read-only",
        sessions: "optional fresh index plus one explicit manifest/sidecar edit and 1/5/20 public batches; includes simulated edit IO; each batch is reference/resource replay across all targets, not a model task",
        update: "multilingual: inert package description edit; salesforce: sidecar apiVersion edit preserving status; persistence plus first query batch included, simulated external edit excluded",
        unobserved: ["model input/output/reasoning/cache tokens", "client exposure of payload channels", "system prompt and catalog sent to model", "1/5/20 complete-task sessions", "model task success"],
        totalModelTokens: null, tokenSavings: "not measured" }, results };
    if (argument("json")) await fs.writeFile(argument("json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, results: results.map((r) => ({ ...r, measurements: Object.fromEntries(Object.entries(r.measurements).map(([mode, { samples: _samples, ...summary }]) => [mode, summary])) })) }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
await main();
