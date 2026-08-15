import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileTaskContext,
  type TaskContext,
  type TaskContextEvidenceField,
} from "../src/context/task-context-compiler.js";
import { readWikiResource } from "../src/context/resource-reader.js";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import type { ContextIntent, KnowledgeGap } from "../src/context/context-manifest.js";
import {
  asEvaluationHits,
  loadHybridFixture,
  materializeHybridFixture,
  recoveredEvidenceIds,
  type HybridGoldenFixture,
  type HybridGoldenQuery,
} from "./hybrid-retrieval-quality-eval.js";
import { mean } from "./retrieval-metrics.js";

interface ExpectedImpact {
  incomingDependencies?: string[];
  outgoingDependencies?: string[];
}

interface TaskContextGoldenTask {
  id: string;
  intent: ContextIntent;
  queryId: string;
  objective: string;
  changedPaths?: string[];
  expectedCategories: Partial<Record<TaskContextEvidenceField, string[]>>;
  expectedImpact?: ExpectedImpact;
  expectedUnknownKinds?: KnowledgeGap["kind"][];
}

interface TaskContextGoldenFixture {
  version: number;
  baseFixture: string;
  maxEvidence: number;
  heuristicTokenBudget: number;
  tasks: TaskContextGoldenTask[];
}

export interface TaskContextTaskReport {
  id: string;
  intent: ContextIntent;
  queryId: string;
  compileMs: number;
  contextTokens: number;
  selectedEvidenceCount: number;
  expectedEvidenceCount: number;
  recoveredEvidenceIds: string[];
  boundedRecoveredEvidenceIds: string[];
  lostOracleEvidenceIds: string[];
  lostHybridEvidenceIds: string[];
  evidenceRecall: number;
  boundedEvidenceRecall: number;
  hybridParityRecall: number;
  categoryExpected: number;
  categoryRecovered: number;
  categoryCoverage: number;
  impactExpected: number;
  impactRecovered: number;
  impactCoverage: number;
  expectedUnknownKindsPresent: boolean;
  wideningLevel: number;
  visitedNodes: number;
  visitedEdges: number;
  fallbackUsed: boolean;
  fullGraphScanAttempted: boolean;
}

export interface TaskContextCompilerReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  baseFixtureVersion: number;
  taskIds: string[];
  taskCount: number;
  intentCount: number;
  maxEvidence: number;
  heuristicTokenBudget: number;
  metrics: {
    TaskContextEvidenceRecall: number;
    BoundedHybridEvidenceRecall: number;
    HybridParityRecall: number;
    IntentCategoryCoverage: number;
    ChangeImpactRecall: number;
    LostRelevantVsOracle: number;
    LostRelevantVsHybrid: number;
    ExpectedUnknownReportingRate: number;
    FallbackRate: number;
    FullGraphScanAttempts: number;
    MeanContextTokens: number;
    MaxContextTokens: number;
    CompileLatencyP50Ms: number;
    CompileLatencyP95Ms: number;
  };
  tasks: TaskContextTaskReport[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TASK_CONTEXT_FIXTURE = path.join(HERE, "fixtures", "task-context-golden.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)
  );
  return ordered[index]!;
}

function categoryCoverage(
  context: TaskContext,
  expected: TaskContextGoldenTask["expectedCategories"]
): { expected: number; recovered: number } {
  let expectedCount = 0;
  let recovered = 0;
  for (const [category, paths] of Object.entries(expected) as Array<[
    TaskContextEvidenceField,
    string[]
  ]>) {
    const actual = new Set(context[category].map((evidence) => evidence.path));
    for (const expectedPath of paths) {
      expectedCount++;
      if (actual.has(expectedPath)) recovered++;
    }
  }
  return { expected: expectedCount, recovered };
}

function impactCoverage(
  context: TaskContext,
  expected: ExpectedImpact | undefined
): { expected: number; recovered: number } {
  if (!expected) return { expected: 0, recovered: 0 };
  let expectedCount = 0;
  let recovered = 0;
  for (const field of ["incomingDependencies", "outgoingDependencies"] as const) {
    const actual = new Set(context.changeImpact[field].map((evidence) => evidence.path));
    for (const expectedPath of expected[field] ?? []) {
      expectedCount++;
      if (actual.has(expectedPath)) recovered++;
    }
  }
  return { expected: expectedCount, recovered };
}

async function materializedEvaluationHits(
  wikiRoot: string,
  context: TaskContext
): Promise<Array<{ path: string; heading: string; excerpt: string }>> {
  return Promise.all(context.evidence.map(async (evidence) => {
    const read = await readWikiResource({
      wikiRoot,
      resourceUri: evidence.uri,
      maxCharacters: 10_000,
    });
    return {
      path: evidence.path,
      heading: evidence.heading ?? "",
      excerpt: read.text,
    };
  }));
}

function hybridQuery(
  query: HybridGoldenQuery,
  task: TaskContextGoldenTask
): string {
  return task.changedPaths?.length
    ? `${query.query} ${[...new Set(task.changedPaths)].sort().join(" ")}`
    : query.query;
}

async function evaluateTask(params: {
  wikiRoot: string;
  task: TaskContextGoldenTask;
  query: HybridGoldenQuery;
  fixture: TaskContextGoldenFixture;
  hybridFixture: HybridGoldenFixture;
}): Promise<TaskContextTaskReport> {
  const started = performance.now();
  const context = await compileTaskContext({
    wikiRoot: params.wikiRoot,
    intent: params.task.intent,
    objective: params.task.objective,
    query: params.query.query,
    changedPaths: params.task.changedPaths,
    maxEvidence: params.fixture.maxEvidence,
    heuristicTokenBudget: params.fixture.heuristicTokenBudget,
    retrievalProfile: "balanced",
  });
  const compileMs = performance.now() - started;
  const bounded = await retrieveWikiHybrid({
    wikiRoot: params.wikiRoot,
    query: hybridQuery(params.query, params.task),
    maxResults: params.hybridFixture.k,
    profile: "balanced",
    progressiveWidening: false,
    ...params.hybridFixture.boundedBudget,
  });
  const taskHits = await materializedEvaluationHits(params.wikiRoot, context);
  const taskRecovered = recoveredEvidenceIds(taskHits, params.query.relevant, params.hybridFixture.k);
  const boundedRecovered = recoveredEvidenceIds(
    asEvaluationHits(bounded.hits),
    params.query.relevant,
    params.hybridFixture.k
  );
  const oracleEvidence = new Set(params.query.relevant.map((evidence) => evidence.id));
  const category = categoryCoverage(context, params.task.expectedCategories);
  const impact = impactCoverage(context, params.task.expectedImpact);
  const expectedUnknownKindsPresent = (params.task.expectedUnknownKinds ?? []).every((kind) =>
    context.unknowns.some((gap) => gap.kind === kind)
  );
  const lastAttempt = context.retrieval.attempts.at(-1);
  return {
    id: params.task.id,
    intent: params.task.intent,
    queryId: params.task.queryId,
    compileMs,
    contextTokens: context.size.heuristicTokens,
    selectedEvidenceCount: context.evidence.length,
    expectedEvidenceCount: oracleEvidence.size,
    recoveredEvidenceIds: [...taskRecovered].sort(),
    boundedRecoveredEvidenceIds: [...boundedRecovered].sort(),
    lostOracleEvidenceIds: [...oracleEvidence].filter((id) => !taskRecovered.has(id)).sort(),
    lostHybridEvidenceIds: [...boundedRecovered].filter((id) => !taskRecovered.has(id)).sort(),
    evidenceRecall: ratio(taskRecovered.size, oracleEvidence.size),
    boundedEvidenceRecall: ratio(boundedRecovered.size, oracleEvidence.size),
    hybridParityRecall: ratio(
      [...boundedRecovered].filter((id) => taskRecovered.has(id)).length,
      boundedRecovered.size
    ),
    categoryExpected: category.expected,
    categoryRecovered: category.recovered,
    categoryCoverage: ratio(category.recovered, category.expected),
    impactExpected: impact.expected,
    impactRecovered: impact.recovered,
    impactCoverage: ratio(impact.recovered, impact.expected),
    expectedUnknownKindsPresent,
    wideningLevel: context.retrieval.wideningLevel,
    visitedNodes: lastAttempt?.visitedNodes ?? 0,
    visitedEdges: lastAttempt?.visitedEdges ?? 0,
    fallbackUsed: context.retrieval.fallbackUsed,
    fullGraphScanAttempted: context.retrieval.fullGraphScanAttempted,
  };
}

export async function evaluateTaskContextCompiler(
  fixturePath = DEFAULT_TASK_CONTEXT_FIXTURE
): Promise<TaskContextCompilerReport> {
  const fixture = JSON.parse(
    await fs.readFile(fixturePath, "utf8")
  ) as TaskContextGoldenFixture;
  const baseFixturePath = path.resolve(path.dirname(fixturePath), fixture.baseFixture);
  const hybridFixture = await loadHybridFixture(baseFixturePath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-task-context-eval-"));
  const wikiRoot = path.join(root, "wiki");
  try {
    await materializeHybridFixture(wikiRoot, hybridFixture);
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    const queryById = new Map(hybridFixture.queries.map((query) => [query.id, query] as const));
    const reports: TaskContextTaskReport[] = [];
    for (const task of fixture.tasks) {
      const query = queryById.get(task.queryId);
      if (!query) throw new Error(`Unknown hybrid golden query for task ${task.id}: ${task.queryId}.`);
      const report = await evaluateTask({ wikiRoot, task, query, fixture, hybridFixture });
      reports.push(report);
      process.stdout.write(
        `${task.id.padEnd(28)} intent=${task.intent.padEnd(10)} ` +
        `E=${report.evidenceRecall.toFixed(3)} parity=${report.hybridParityRecall.toFixed(3)} ` +
        `categories=${report.categoryCoverage.toFixed(3)} impact=${report.impactCoverage.toFixed(3)} ` +
        `tokens=${report.contextTokens} W${report.wideningLevel}\n`
      );
    }
    const expectedEvidence = reports.reduce((sum, report) => sum + report.expectedEvidenceCount, 0);
    const recoveredEvidence = reports.reduce(
      (sum, report) => sum + report.expectedEvidenceCount - report.lostOracleEvidenceIds.length,
      0
    );
    const boundedRecovered = reports.reduce(
      (sum, report) => sum + report.boundedRecoveredEvidenceIds.length,
      0
    );
    const parityRecovered = reports.reduce(
      (sum, report) => sum + report.boundedRecoveredEvidenceIds.length - report.lostHybridEvidenceIds.length,
      0
    );
    const categoryExpected = reports.reduce((sum, report) => sum + report.categoryExpected, 0);
    const categoryRecovered = reports.reduce((sum, report) => sum + report.categoryRecovered, 0);
    const impactExpected = reports.reduce((sum, report) => sum + report.impactExpected, 0);
    const impactRecovered = reports.reduce((sum, report) => sum + report.impactRecovered, 0);
    const latencies = reports.map((report) => report.compileMs);
    const tasksExpectingUnknowns = new Set(
      fixture.tasks
        .filter((task) => (task.expectedUnknownKinds?.length ?? 0) > 0)
        .map((task) => task.id)
    );
    const metrics: TaskContextCompilerReport["metrics"] = {
      TaskContextEvidenceRecall: ratio(recoveredEvidence, expectedEvidence),
      BoundedHybridEvidenceRecall: ratio(boundedRecovered, expectedEvidence),
      HybridParityRecall: ratio(parityRecovered, boundedRecovered),
      IntentCategoryCoverage: ratio(categoryRecovered, categoryExpected),
      ChangeImpactRecall: ratio(impactRecovered, impactExpected),
      LostRelevantVsOracle: reports.reduce(
        (sum, report) => sum + report.lostOracleEvidenceIds.length,
        0
      ),
      LostRelevantVsHybrid: reports.reduce(
        (sum, report) => sum + report.lostHybridEvidenceIds.length,
        0
      ),
      ExpectedUnknownReportingRate: ratio(
        reports.filter((report) =>
          tasksExpectingUnknowns.has(report.id) && report.expectedUnknownKindsPresent
        ).length,
        tasksExpectingUnknowns.size
      ),
      FallbackRate: ratio(reports.filter((report) => report.fallbackUsed).length, reports.length),
      FullGraphScanAttempts: reports.filter((report) => report.fullGraphScanAttempted).length,
      MeanContextTokens: mean(reports.map((report) => report.contextTokens)),
      MaxContextTokens: Math.max(0, ...reports.map((report) => report.contextTokens)),
      CompileLatencyP50Ms: percentile(latencies, 50),
      CompileLatencyP95Ms: percentile(latencies, 95),
    };
    const report: TaskContextCompilerReport = {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      baseFixtureVersion: hybridFixture.version,
      taskIds: reports.map((task) => task.id),
      taskCount: reports.length,
      intentCount: new Set(reports.map((task) => task.intent)).size,
      maxEvidence: fixture.maxEvidence,
      heuristicTokenBudget: fixture.heuristicTokenBudget,
      metrics,
      tasks: reports,
    };
    process.stdout.write(
      `SUMMARY TaskContextEvidenceRecall=${metrics.TaskContextEvidenceRecall.toFixed(4)} ` +
      `HybridParityRecall=${metrics.HybridParityRecall.toFixed(4)} ` +
      `IntentCategoryCoverage=${metrics.IntentCategoryCoverage.toFixed(4)} ` +
      `ChangeImpactRecall=${metrics.ChangeImpactRecall.toFixed(4)} ` +
      `LostOracle=${metrics.LostRelevantVsOracle} LostHybrid=${metrics.LostRelevantVsHybrid} ` +
      `MeanTokens=${metrics.MeanContextTokens.toFixed(2)} MaxTokens=${metrics.MaxContextTokens} ` +
      `CompileP50=${metrics.CompileLatencyP50Ms.toFixed(2)}ms ` +
      `CompileP95=${metrics.CompileLatencyP95Ms.toFixed(2)}ms\n`
    );
    return report;
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_TASK_CONTEXT_FIXTURE);
  const report = await evaluateTaskContextCompiler(fixturePath);
  const outputPath = argValue("json");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`JSON written to ${resolved}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
