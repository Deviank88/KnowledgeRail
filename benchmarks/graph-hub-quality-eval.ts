import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { GraphEdge, GraphEdgeKind, GraphNode, WikiGraph } from "../src/core/graph-index.js";
import {
  buildRuntimeGraph,
  expandRuntimeGraphFromSeeds,
  type SeededGraphQueryParams,
  type SeededGraphQueryResult,
} from "../src/core/graph-runtime.js";

export interface HubQualityCase {
  id: string;
  group: "control" | "stress";
  topology: "outgoing" | "incoming" | "request" | "starved_seed" | "two_hop" | "disconnected";
  distractors: number;
  position: "early" | "late";
  penalizeDistractors: boolean;
  targetEdgeKind?: GraphEdgeKind;
  seedTarget?: boolean;
}

interface HubQualityFixture {
  version: number;
  description: string;
  budgets: Record<string, Required<Pick<SeededGraphQueryParams, "maxNodes" | "maxDepth" | "beamWidth" | "maxVisitedNodes">>>;
  cases: HubQualityCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HUB_QUALITY_FIXTURE = path.join(HERE, "fixtures", "graph-hub-quality.json");
// Reproduce the rejected cap explicitly; production no longer applies it.
const REJECTED_EDGE_WORK_PER_VISITED_NODE = 64;

const page = (name: string): GraphNode => ({
  id: `page:${name}.md`, kind: "page", label: name, path: `${name}.md`, pageType: "concept",
});

/** The target's location and degrees are fixture properties, never chosen from measured results. */
export function materializeHubQualityCase(config: HubQualityCase): {
  graph: WikiGraph; seeds: string[]; seedScores: Map<string, number>; relevant: string[];
} {
  const hub = config.topology === "request"
    ? { id: "request:REQ_HUB", kind: "request" as const, label: "REQ-HUB" }
    : page("Hub");
  const target = page(`${config.position === "early" ? "A" : "Z"}Answer`);
  target.summary = "The release requires a quorum acknowledgement before renewing the lease.";
  const nodes: GraphNode[] = [hub, target];
  const edges: GraphEdge[] = [];
  const seeds = [hub.id];
  const seedScores = new Map([[hub.id, 1]]);
  const kind: GraphEdgeKind = config.topology === "request" ? "same_request" : "links_to";
  const connect = (node: GraphNode, edgeKind: GraphEdgeKind = kind): void => {
    edges.push(config.topology === "incoming" || config.topology === "request"
      ? { from: node.id, to: hub.id, kind: edgeKind }
      : { from: hub.id, to: node.id, kind: edgeKind });
  };
  // The shared metadata hubs are terminal in production. Their edges change the
  // ordinary hub penalty, making the late target outrank decoys in the reference.
  const tags: GraphNode[] = [0, 1].map((i) => ({ id: `tag:noise${i}`, kind: "tag", label: `noise${i}` }));
  if (config.penalizeDistractors) nodes.push(...tags);
  for (let i = 0; i < config.distractors; i++) {
    const decoy = page(`MNoise${String(i).padStart(6, "0")}`);
    nodes.push(decoy);
    connect(decoy);
    if (config.penalizeDistractors) {
      for (const tag of tags) edges.push({ from: decoy.id, to: tag.id, kind: "has_tag" });
    }
  }
  if (config.topology === "request") {
    const seed = page("Entry");
    nodes.push(seed);
    connect(seed);
    seeds[0] = seed.id;
    seedScores.delete(hub.id);
    seedScores.set(seed.id, 1);
  }
  if (config.topology === "starved_seed") {
    const second = page("SecondSeed");
    nodes.push(second);
    seeds.push(second.id);
    seedScores.set(second.id, 0.9);
    edges.push({ from: second.id, to: target.id, kind: "implements" });
  } else if (config.topology === "two_hop") {
    const bridge = page(`${config.position === "early" ? "A" : "Z"}Bridge`);
    nodes.push(bridge);
    connect(bridge);
    edges.push({ from: bridge.id, to: target.id, kind: "implements" });
  } else if (config.topology !== "disconnected") {
    connect(target, config.targetEdgeKind ?? kind);
  }
  if (config.seedTarget) {
    seeds.push(target.id);
    seedScores.set(target.id, 0.95);
  }
  return { graph: { version: 2, generatedAt: "2026-09-26T00:00:00.000Z", nodes, edges, warnings: [] },
    seeds, seedScores, relevant: [target.id] };
}

function resultEvidence(result: SeededGraphQueryResult, relevant: readonly string[]) {
  const ids = new Set(result.nodes.map((node) => node.id));
  const recovered = relevant.filter((id) => ids.has(id));
  return { recovered, missing: relevant.filter((id) => !ids.has(id)), recall: recovered.length / relevant.length };
}

function assertExactResultEdges(result: SeededGraphQueryResult): void {
  const ids = new Set(result.nodes.map((node) => node.id));
  const keys = (edges: readonly GraphEdge[]) => edges.map((edge) => JSON.stringify([edge.from, edge.kind, edge.to])).sort();
  assert.deepEqual(keys(result.edges), keys(result.graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))),
    "indexed edge extraction must preserve every edge between selected nodes");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(3));
}

export function compareHubQuality(config: HubQualityCase, budget: HubQualityFixture["budgets"][string], iterations = 5) {
  assert.ok(Number.isInteger(iterations) && iterations > 0);
  const fixture = materializeHubQualityCase(config);
  const runtime = buildRuntimeGraph(fixture.graph);
  const base: SeededGraphQueryParams = { ...budget, seedNodeIds: fixture.seeds, seedScores: fixture.seedScores };
  const edgeBudget = budget.maxVisitedNodes * REJECTED_EDGE_WORK_PER_VISITED_NODE;
  const params = {
    production: base,
    bounded: { ...base, maxEdgeWork: edgeBudget },
    reference: { ...base, maxEdgeWork: Number.POSITIVE_INFINITY },
  };
  const variants = ["production", "bounded", "reference"] as const;
  const results = {
    production: expandRuntimeGraphFromSeeds(runtime, params.production),
    bounded: expandRuntimeGraphFromSeeds(runtime, params.bounded),
    reference: expandRuntimeGraphFromSeeds(runtime, params.reference),
  };
  const times = { production: [] as number[], bounded: [] as number[], reference: [] as number[] };
  for (let i = 0; i < iterations; i++) {
    const offset = i % variants.length;
    const order = [...variants.slice(offset), ...variants.slice(0, offset)];
    for (const mode of order) {
      const started = performance.now();
      const result = expandRuntimeGraphFromSeeds(runtime, params[mode]);
      times[mode].push(performance.now() - started);
      results[mode] = result;
    }
  }
  // Oracle extraction and assertions are outside the measured region.
  const { production, bounded, reference } = results;
  for (const mode of variants) assertExactResultEdges(results[mode]);
  assert.ok(bounded.stats.edgeWork <= edgeBudget);
  const current = resultEvidence(production, fixture.relevant);
  const observed = resultEvidence(bounded, fixture.relevant);
  const oracle = resultEvidence(reference, fixture.relevant);
  const lostToEdgeBudget = oracle.recovered.filter((id) => !observed.recovered.includes(id));
  const gainedWithEdgeBudget = observed.recovered.filter((id) => !oracle.recovered.includes(id));
  return {
    id: config.id, group: config.group, topology: config.topology, distractors: config.distractors,
    relevant: fixture.relevant, nodeCount: runtime.graph.nodes.length, edgeCount: runtime.graph.edges.length,
    budget, edgeBudget,
    production: { ...current, stats: production.stats, p50Ms: median(times.production) },
    bounded: { ...observed, stats: bounded.stats, p50Ms: median(times.bounded) },
    reference: { ...oracle, stats: reference.stats, p50Ms: median(times.reference) },
    lostToEdgeBudget, gainedWithEdgeBudget,
    lostInProduction: oracle.recovered.filter((id) => !current.recovered.includes(id)),
    productionMatchesReference: JSON.stringify(production.nodes.map((node) => node.id)) === JSON.stringify(reference.nodes.map((node) => node.id))
      && JSON.stringify(production.stats) === JSON.stringify(reference.stats),
    missedByBoth: observed.missing.filter((id) => oracle.missing.includes(id)),
    identicalNodeSet: JSON.stringify(bounded.nodes.map((node) => node.id).sort()) === JSON.stringify(reference.nodes.map((node) => node.id).sort()),
    exactEdgesPreserved: true,
  };
}

export async function evaluateHubQuality(fixturePath = DEFAULT_HUB_QUALITY_FIXTURE, iterations = 5) {
  const bytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(bytes.toString("utf8")) as HubQualityFixture;
  assert.equal(fixture.version, 1);
  assert.equal(new Set(fixture.cases.map((item) => item.id)).size, fixture.cases.length);
  const results = Object.entries(fixture.budgets).flatMap(([stage, budget]) =>
    fixture.cases.map((config) => ({ stage, ...compareHubQuality(config, budget, iterations) })));
  const summaries = Object.keys(fixture.budgets).flatMap((stage) => ["all", "control", "stress"].map((group) => {
    const rows = results.filter((row) => row.stage === stage && (group === "all" || row.group === group));
    const sum = (select: (row: typeof rows[number]) => number) => rows.reduce((total, row) => total + select(row), 0);
    const expected = sum((row) => row.relevant.length);
    const referenceRecovered = sum((row) => row.reference.recovered.length);
    const boundedRecovered = sum((row) => row.bounded.recovered.length);
    const productionRecovered = sum((row) => row.production.recovered.length);
    const lostToEdgeBudget = sum((row) => row.lostToEdgeBudget.length);
    return { stage, group, cases: rows.length, expected, productionRecovered, boundedRecovered, referenceRecovered, lostToEdgeBudget,
      productionRecall: productionRecovered / expected,
      lostInProduction: sum((row) => row.lostInProduction.length),
      productionMatchesReference: rows.every((row) => row.productionMatchesReference),
      boundedRecall: boundedRecovered / expected, referenceRecall: referenceRecovered / expected,
      lossAmongReferenceRecovered: referenceRecovered === 0 ? null : lostToEdgeBudget / referenceRecovered,
      affectedCases: rows.filter((row) => row.lostToEdgeBudget.length > 0).length,
      missedByBoth: sum((row) => row.missedByBoth.length),
      exhaustedCases: rows.filter((row) => row.bounded.stats.edgeBudgetExhausted).length,
    };
  }));
  const sourceSha256 = Object.fromEntries(await Promise.all([
    "src/core/graph-runtime.ts", "src/core/graph-runtime-mutation.ts", "benchmarks/graph-hub-quality-eval.ts",
  ].map(async (file) => [file, createHash("sha256").update(await fs.readFile(path.join(HERE, "..", file))).digest("hex")])));
  return { benchmark: "graph-hub-quality", generatedAt: new Date().toISOString(),
    fixture: path.basename(fixturePath), fixtureVersion: fixture.version,
    fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    scope: fixture.description, iterations, nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model, sourceSha256,
    comparison: "Production omits maxEdgeWork. Bounded explicitly reproduces the rejected cap of 64 entries per visited-node slot; reference sets Infinity. All retain the same seed scores, beam, depth, visited-node and emitted-node limits. No LLM, embedding, lexical retrieval or final answer is evaluated.",
    summaries, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const report = await evaluateHubQuality(arg("fixture"), Number(arg("iterations") ?? 5));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const output = arg("json");
  if (output) await fs.writeFile(output, json);
  process.stdout.write(output ? `${JSON.stringify({ output, summaries: report.summaries }, null, 2)}\n` : json);
}
