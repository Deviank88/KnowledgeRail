import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { buildRuntimeGraph, type RuntimeGraph } from "../src/core/graph-runtime.js";
import type { GraphEdge, GraphNode, WikiGraph } from "../src/core/graph-index.js";
import { listWikiPagePaths, parseWikiPageRecord, type WikiPageRecord } from "../src/core/page-record.js";
import { normalizeSearchText } from "../src/core/text-analysis.js";

type TermTuple = readonly [term: string, body: number, title: number, metadata: number];
type GlobalTermTuple = readonly [term: string, flatPostings: number[]];

interface PerRecordCandidate {
  version: 2;
  records: WikiPageRecord[];
  indexedTerms: TermTuple[][];
}

interface GlobalCandidate {
  version: 2;
  records: WikiPageRecord[];
  terms: GlobalTermTuple[];
}

interface Distribution {
  iterations: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

interface Measurement {
  elapsedMs: number;
  heapDeltaMb: number;
}

interface RuntimeIndex {
  records: Map<string, WikiPageRecord>;
  postings: Map<string, Map<string, { body: number; title: number; metadata: number }>>;
  totalTokenCount: number;
}

const DEFAULT_SCALES = [1_000, 5_000, 10_000];

function countTerms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const normalized = normalizeSearchText(text);
  for (const token of normalized.match(/\/?[\p{L}\p{N}][\p{L}\p{N}_./:#-]*/gu) ?? []) {
    result.set(token, (result.get(token) ?? 0) + 1);
    for (const part of token.split(/[_./:#-]+/).filter((value) => value.length >= 2)) {
      if (part !== token) result.set(part, (result.get(part) ?? 0) + 1);
    }
  }
  return result;
}

function termsFor(record: WikiPageRecord): TermTuple[] {
  const title = countTerms(`${record.title} ${record.aliases.join(" ")}`);
  const metadata = countTerms([
    record.type,
    record.tags.join(" "),
    record.sources.join(" "),
    record.requestId ?? "",
    record.client ?? "",
    record.project ?? "",
    record.path,
    record.passages.map((passage) => passage.heading).join(" "),
  ].join(" "));
  const body = countTerms(record.body);
  return [...new Set([...title.keys(), ...metadata.keys(), ...body.keys()])]
    .sort()
    .map((term) => [term, body.get(term) ?? 0, title.get(term) ?? 0, metadata.get(term) ?? 0]);
}

function encodePerRecord(records: readonly WikiPageRecord[]): PerRecordCandidate {
  return {
    version: 2,
    records: [...records],
    indexedTerms: records.map(termsFor),
  };
}

function encodeGlobal(records: readonly WikiPageRecord[], indexedTerms: readonly TermTuple[][]): GlobalCandidate {
  const terms = new Map<string, number[]>();
  indexedTerms.forEach((recordTerms, recordIndex) => {
    for (const [term, body, title, metadata] of recordTerms) {
      const postings = terms.get(term) ?? [];
      postings.push(recordIndex, body, title, metadata);
      terms.set(term, postings);
    }
  });
  return {
    version: 2,
    records: [...records],
    terms: [...terms.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
}

function addPosting(
  runtime: RuntimeIndex,
  record: WikiPageRecord,
  term: string,
  body: number,
  title: number,
  metadata: number
): void {
  let byPath = runtime.postings.get(term);
  if (!byPath) {
    byPath = new Map();
    runtime.postings.set(term, byPath);
  }
  byPath.set(record.path, { body, title, metadata });
}

function emptyRuntime(records: readonly WikiPageRecord[]): RuntimeIndex {
  return {
    records: new Map(records.map((record) => [record.path, record])),
    postings: new Map(),
    totalTokenCount: records.reduce((sum, record) => sum + record.tokenCount, 0),
  };
}

function hydrateCurrent(records: readonly WikiPageRecord[]): RuntimeIndex {
  const runtime = emptyRuntime(records);
  records.forEach((record) => {
    for (const [term, body, title, metadata] of termsFor(record)) {
      addPosting(runtime, record, term, body, title, metadata);
    }
  });
  return runtime;
}

function hydratePerRecord(candidate: PerRecordCandidate): RuntimeIndex {
  if (candidate.records.length !== candidate.indexedTerms.length) throw new Error("Candidate length mismatch.");
  const runtime = emptyRuntime(candidate.records);
  candidate.indexedTerms.forEach((recordTerms, recordIndex) => {
    const record = candidate.records[recordIndex]!;
    for (const [term, body, title, metadata] of recordTerms) {
      addPosting(runtime, record, term, body, title, metadata);
    }
  });
  return runtime;
}

function hydrateGlobal(candidate: GlobalCandidate): RuntimeIndex {
  const runtime = emptyRuntime(candidate.records);
  for (const [term, flat] of candidate.terms) {
    if (flat.length % 4 !== 0) throw new Error("Invalid compact postings width.");
    for (let offset = 0; offset < flat.length; offset += 4) {
      const record = candidate.records[flat[offset]!]!;
      addPosting(runtime, record, term, flat[offset + 1]!, flat[offset + 2]!, flat[offset + 3]!);
    }
  }
  return runtime;
}

function syntheticRaw(index: number, scale: number): string {
  const next = (index + 1) % scale;
  const second = (index + 17) % scale;
  const third = (index + 97) % scale;
  return [
    "---",
    `title: Requirement ${index}`,
    "type: requirement",
    `tags: [domain-${index % 40}, workflow-${index % 17}]`,
    `aliases: [REQ-${String(index).padStart(5, "0")}]`,
    `sources: [source-${index % 23}]`,
    `request_id: REQ-${String(index % Math.max(1, Math.floor(scale / 4))).padStart(5, "0")}`,
    "client: benchmark-client",
    "project: dense-checkpoint",
    "---",
    "",
    `# Ordered invoice recovery ${index}`,
    "",
    `The payment authorization flow preserves HTTP 429 Retry-After and idempotency key REQ-${index}.`,
    `It links [[requirements/Page-${next}]], [[requirements/Page-${second}]], and [dependency](Page-${third}.md).`,
    "",
    "## Verification and rollback",
    "",
    `Rollback sequence ${index % 11} verifies durable ledger state before retrying the ordered workflow.`,
  ].join("\n");
}

function buildRecords(scale: number): WikiPageRecord[] {
  return Array.from({ length: scale }, (_, index) => {
    const raw = syntheticRaw(index, scale);
    return parseWikiPageRecord(`requirements/Page-${index}.md`, raw, {
      mtimeMs: 1_700_000_000_000 + index,
      size: Buffer.byteLength(raw),
    });
  });
}

function denseGraph(records: readonly WikiPageRecord[]): WikiGraph {
  const nodes: GraphNode[] = records.map((record) => ({
    id: `page:${record.path}`,
    kind: "page",
    label: record.title,
    path: record.path,
    pageType: record.type,
    requestId: record.requestId,
    tags: record.tags,
    sources: record.sources,
    summary: record.passages[0]?.text.slice(0, 500),
  }));
  const requestIds = [...new Set(records.map((record) => record.requestId).filter((value): value is string => Boolean(value)))];
  nodes.push(...requestIds.map((requestId) => ({ id: `request:${requestId}`, kind: "request" as const, label: requestId })));
  const edges: GraphEdge[] = [];
  records.forEach((record, index) => {
    const from = `page:${record.path}`;
    for (const offset of [1, 17, 97]) {
      const target = records[(index + offset) % records.length]!;
      edges.push({ from, to: `page:${target.path}`, kind: "links_to" });
    }
    if (record.requestId) edges.push({ from, to: `request:${record.requestId}`, kind: "same_request" });
  });
  return {
    version: 2,
    generatedAt: "1970-01-01T00:00:00.000Z",
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind) || left.to.localeCompare(right.to)),
    warnings: [],
  };
}

function collectRuntime(runtime: RuntimeIndex | RuntimeGraph): void {
  if ("postings" in runtime) {
    if (runtime.records.size === 0 || runtime.postings.size === 0) throw new Error("Empty lexical runtime.");
  } else if (runtime.nodesById.size === 0) {
    throw new Error("Empty graph runtime.");
  }
}

async function measured<T>(operation: () => T | Promise<T>): Promise<{ value: T; measurement: Measurement }> {
  global.gc?.();
  const beforeHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - startedAt;
  const heapDeltaMb = Math.max(0, process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024;
  return { value, measurement: { elapsedMs, heapDeltaMb } };
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    iterations: values.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1),
  };
}

function summarize(measurements: readonly Measurement[]): { latency: Distribution; heapDeltaMb: Distribution } {
  return {
    latency: distribution(measurements.map((measurement) => measurement.elapsedMs)),
    heapDeltaMb: distribution(measurements.map((measurement) => measurement.heapDeltaMb)),
  };
}

async function writeCanonicalFiles(root: string, records: readonly WikiPageRecord[]): Promise<void> {
  const directory = path.join(root, "requirements");
  await fs.mkdir(directory, { recursive: true });
  const batchSize = 200;
  for (let start = 0; start < records.length; start += batchSize) {
    await Promise.all(records.slice(start, start + batchSize).map((record) =>
      fs.writeFile(path.join(root, record.path), record.raw)));
  }
}

async function verifyMetadata(root: string): Promise<number> {
  const paths = await listWikiPagePaths(root);
  const stats = await Promise.all(paths.map((relativePath) => fs.stat(path.join(root, relativePath))));
  return stats.reduce((sum, stat) => sum + stat.size, 0);
}

async function benchmarkScale(root: string, scale: number, iterations: number): Promise<Record<string, unknown>> {
  const scaleRoot = path.join(root, String(scale));
  const records = buildRecords(scale);
  await writeCanonicalFiles(scaleRoot, records);
  const perRecord = encodePerRecord(records);
  const global = encodeGlobal(records, perRecord.indexedTerms);
  const graph = denseGraph(records);
  const currentJson = JSON.stringify({ version: 1, generatedAt: "1970-01-01T00:00:00.000Z", records });
  const perRecordJson = JSON.stringify(perRecord);
  const globalJson = JSON.stringify(global);
  const graphJson = JSON.stringify(graph);
  const files = {
    current: path.join(scaleRoot, "current.json"),
    perRecord: path.join(scaleRoot, "per-record.json"),
    global: path.join(scaleRoot, "global.json"),
    graph: path.join(scaleRoot, "graph.json"),
  };
  await Promise.all([
    fs.writeFile(files.current, currentJson),
    fs.writeFile(files.perRecord, perRecordJson),
    fs.writeFile(files.global, globalJson),
    fs.writeFile(files.graph, graphJson),
  ]);

  const samples: Record<string, Measurement[]> = Object.fromEntries([
    "currentReadParse", "currentLexicalHydrate", "perRecordReadParse", "perRecordLexicalHydrate",
    "globalReadParse", "globalLexicalHydrate", "canonicalMetadataVerify", "graphReadValidate",
    "graphRuntimeHydrate", "fallbackRebuild", "onePageDeltaReplay",
  ].map((name) => [name, []]));

  // Untimed warm-up stabilizes filesystem cache and JIT before distributions.
  await verifyMetadata(scaleRoot);
  collectRuntime(hydrateCurrent(records));
  collectRuntime(hydratePerRecord(perRecord));
  collectRuntime(hydrateGlobal(global));
  collectRuntime(buildRuntimeGraph(graph));
  const deltaRuntime = hydrateGlobal(global);

  for (let iteration = 0; iteration < iterations; iteration++) {
    const currentParsed = await measured(async () => JSON.parse(await fs.readFile(files.current, "utf8")) as { records: WikiPageRecord[] });
    samples.currentReadParse!.push(currentParsed.measurement);
    const currentHydrated = await measured(() => hydrateCurrent(currentParsed.value.records));
    collectRuntime(currentHydrated.value);
    samples.currentLexicalHydrate!.push(currentHydrated.measurement);

    const perRecordParsed = await measured(async () => JSON.parse(await fs.readFile(files.perRecord, "utf8")) as PerRecordCandidate);
    samples.perRecordReadParse!.push(perRecordParsed.measurement);
    const perRecordHydrated = await measured(() => hydratePerRecord(perRecordParsed.value));
    collectRuntime(perRecordHydrated.value);
    samples.perRecordLexicalHydrate!.push(perRecordHydrated.measurement);

    const globalParsed = await measured(async () => JSON.parse(await fs.readFile(files.global, "utf8")) as GlobalCandidate);
    samples.globalReadParse!.push(globalParsed.measurement);
    const globalHydrated = await measured(() => hydrateGlobal(globalParsed.value));
    collectRuntime(globalHydrated.value);
    samples.globalLexicalHydrate!.push(globalHydrated.measurement);

    const verified = await measured(() => verifyMetadata(scaleRoot));
    if (verified.value <= 0) throw new Error("Canonical verification found no data.");
    samples.canonicalMetadataVerify!.push(verified.measurement);

    const graphParsed = await measured(async () => {
      const candidate = JSON.parse(await fs.readFile(files.graph, "utf8")) as WikiGraph;
      if (candidate.version !== 2 || candidate.nodes.length === 0 || candidate.edges.length === 0) {
        throw new Error("Invalid graph candidate.");
      }
      return candidate;
    });
    samples.graphReadValidate!.push(graphParsed.measurement);
    const graphHydrated = await measured(() => buildRuntimeGraph(graphParsed.value));
    collectRuntime(graphHydrated.value);
    samples.graphRuntimeHydrate!.push(graphHydrated.measurement);

    const fallback = await measured(() => {
      const reparsed = records.map((record) => parseWikiPageRecord(record.path, record.raw, record));
      const lexical = hydrateCurrent(reparsed);
      const runtimeGraph = buildRuntimeGraph(denseGraph(reparsed));
      collectRuntime(lexical);
      collectRuntime(runtimeGraph);
      return { lexical, runtimeGraph };
    });
    samples.fallbackRebuild!.push(fallback.measurement);

    const delta = await measured(() => {
      const index = iteration % records.length;
      const record = records[index]!;
      for (const [term, byPath] of deltaRuntime.postings) {
        byPath.delete(record.path);
        if (byPath.size === 0) deltaRuntime.postings.delete(term);
      }
      for (const [term, body, title, metadata] of termsFor(record)) {
        addPosting(deltaRuntime, record, term, body, title, metadata);
      }
      return deltaRuntime;
    });
    collectRuntime(delta.value);
    samples.onePageDeltaReplay!.push(delta.measurement);
  }

  const corpusRevision = createHash("sha256")
    .update(records.map((record) => `${record.path}\0${createHash("sha256").update(record.raw).digest("hex")}`).join("\n"))
    .digest("hex");
  return {
    scale,
    corpusRevision,
    checkpointBytes: {
      current: Buffer.byteLength(currentJson),
      perRecord: Buffer.byteLength(perRecordJson),
      global: Buffer.byteLength(globalJson),
      graph: Buffer.byteLength(graphJson),
      perRecordVsCurrentRatio: Buffer.byteLength(perRecordJson) / Buffer.byteLength(currentJson),
      globalVsCurrentRatio: Buffer.byteLength(globalJson) / Buffer.byteLength(currentJson),
    },
    phases: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)])),
  };
}

async function main(): Promise<void> {
  const scales = (process.env["RESTART_BENCH_SCALES"] ?? DEFAULT_SCALES.join(","))
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  const iterations = Math.max(1, Number(process.env["RESTART_BENCH_ITERATIONS"] ?? 5));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-restart-bench-"));
  try {
    const reports = [];
    for (const scale of scales) reports.push(await benchmarkScale(root, scale, iterations));
    process.stdout.write(`${JSON.stringify({
      benchmark: "knowledge-rail-restart-checkpoint",
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      iterations,
      reports,
    }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
