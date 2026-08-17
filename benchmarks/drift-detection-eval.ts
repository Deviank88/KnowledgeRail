import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { codeAnchorHash } from "../src/core/code-evidence/code-anchor.js";
import type { CodeAnchor } from "../src/core/code-evidence/types.js";
import {
  evaluateCodeAnchor,
  type DriftReason,
  type DriftVerdict,
} from "../src/core/drift-detection.js";

interface DriftScenario {
  id: string;
  path: string;
  capturedContent: string;
  currentContent: string | null;
  startLine: number;
  endLine: number;
  anchorParserVersion: string;
  currentParserVersion: string;
  expectedVerdict: DriftVerdict;
  expectedReason?: DriftReason;
}

interface DriftFixture {
  version: number;
  scenarios: DriftScenario[];
}

export interface DriftScenarioResult {
  id: string;
  expectedVerdict: DriftVerdict;
  expectedReason?: DriftReason;
  actualVerdict: DriftVerdict;
  actualReason?: DriftReason;
  passed: boolean;
}

export interface DriftEvaluationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  scenarioCount: number;
  verdictAccuracy: number;
  falsePositiveRate: number;
  silentMissRate: number;
  scaleAnchorCount: number;
  scopedAnchorCount: number;
  fullEvaluationMs: number;
  scopedEvaluationMs: number;
  results: DriftScenarioResult[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DRIFT_FIXTURE = path.join(HERE, "fixtures", "drift-detection-golden.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function anchorFor(scenario: DriftScenario, capturedAt = "2026-08-18T08:00:00.000Z"): CodeAnchor {
  return {
    path: scenario.path,
    startLine: scenario.startLine,
    endLine: scenario.endLine,
    rangeHash: codeAnchorHash(scenario.capturedContent, scenario.startLine, scenario.endLine),
    parserVersion: scenario.anchorParserVersion,
    capturedAt,
  };
}

export async function evaluateDriftDetection(
  fixturePath = DEFAULT_DRIFT_FIXTURE
): Promise<DriftEvaluationReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as DriftFixture;
  const results = fixture.scenarios.map((scenario): DriftScenarioResult => {
    const actual = evaluateCodeAnchor({
      anchor: anchorFor(scenario),
      content: scenario.currentContent,
      parserVersion: scenario.currentParserVersion,
    });
    return {
      id: scenario.id,
      expectedVerdict: scenario.expectedVerdict,
      ...(scenario.expectedReason ? { expectedReason: scenario.expectedReason } : {}),
      actualVerdict: actual.verdict,
      ...(actual.reason ? { actualReason: actual.reason } : {}),
      passed: actual.verdict === scenario.expectedVerdict && actual.reason === scenario.expectedReason,
    };
  });
  const expectedFresh = results.filter((result) => result.expectedVerdict === "fresh");
  const expectedDrift = results.filter((result) => result.expectedVerdict === "drift_suspected");
  const falsePositives = expectedFresh.filter((result) => result.actualVerdict !== "fresh").length;
  const silentMisses = expectedDrift.filter((result) => result.actualVerdict === "fresh").length;

  const scaleAnchors = Array.from({ length: 1_000 }, (_, index) => {
    const scenario = fixture.scenarios[index % fixture.scenarios.length]!;
    return {
      anchor: { ...anchorFor(scenario), path: `src/${index < 100 ? "scoped" : "other"}/file-${index}.ts` },
      scenario,
    };
  });
  const fullStarted = performance.now();
  for (const item of scaleAnchors) {
    evaluateCodeAnchor({
      anchor: item.anchor,
      content: item.scenario.currentContent,
      parserVersion: item.scenario.currentParserVersion,
    });
  }
  const fullEvaluationMs = performance.now() - fullStarted;
  const scoped = scaleAnchors.filter((item) => item.anchor.path.startsWith("src/scoped/"));
  const scopedStarted = performance.now();
  for (const item of scoped) {
    evaluateCodeAnchor({
      anchor: item.anchor,
      content: item.scenario.currentContent,
      parserVersion: item.scenario.currentParserVersion,
    });
  }
  const scopedEvaluationMs = performance.now() - scopedStarted;

  return {
    generatedAt: new Date().toISOString(),
    fixture: path.resolve(fixturePath),
    fixtureVersion: fixture.version,
    scenarioCount: results.length,
    verdictAccuracy: ratio(results.filter((result) => result.passed).length, results.length),
    falsePositiveRate: ratio(falsePositives, expectedFresh.length),
    silentMissRate: ratio(silentMisses, expectedDrift.length),
    scaleAnchorCount: scaleAnchors.length,
    scopedAnchorCount: scoped.length,
    fullEvaluationMs: Number(fullEvaluationMs.toFixed(3)),
    scopedEvaluationMs: Number(scopedEvaluationMs.toFixed(3)),
    results,
  };
}

async function main(): Promise<void> {
  const report = await evaluateDriftDetection(path.resolve(argValue("fixture") ?? DEFAULT_DRIFT_FIXTURE));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
