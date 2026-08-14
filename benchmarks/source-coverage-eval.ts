import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import {
  sourceCompileNext,
  sourceCompilePlan,
  sourceCoverage,
  sourceFinalize,
  sourceRecordSegment,
} from "../src/core/ingestion/source-compiler.js";
import type { SourceCoverageMetrics } from "../src/core/ingestion/coverage-ledger.js";
import { prepareSourceIngestionDraft } from "../src/core/report-workflow.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";

interface SourceCoverageFixture {
  version: number;
  sourceUri: string;
  segmentMaxChars: number;
  fillerSectionCount: number;
  fillerParagraphRepeats: number;
  fillerSentence: string;
  relevantHeading: string;
  relevantMarker: string;
  relevantFact: string;
  query: string;
  sourceKind: "client_source" | "meeting_note" | "candidate_request" | "summary";
  title: string;
}

export interface SourceCoverageEvaluationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  sourceChars: number;
  relevantMarkerOffsetPercent: number;
  segmentMaxChars: number;
  segmentCount: number;
  maximumObservedSegmentChars: number;
  sourceAccountingComplete: boolean;
  unknownCoverageRejected: boolean;
  prematureFinalizeBlocked: boolean;
  finalSegmentDiscovered: boolean;
  finalSegmentId: string;
  finalEvidenceRefs: string[];
  finalPageRefs: string[];
  retrievalRecovered: boolean;
  retrievalHitPath: string;
  retrievalWideningLevel: number;
  retrievalUsedSourceFallback: boolean;
  beforeFinalSegment: SourceCoverageMetrics;
  final: SourceCoverageMetrics;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE_COVERAGE_FIXTURE = path.join(
  HERE,
  "fixtures",
  "source-coverage-golden.json"
);

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function materializeSource(fixture: SourceCoverageFixture): string {
  const sections = Array.from({ length: fixture.fillerSectionCount }, (_, section) => {
    const sentence = fixture.fillerSentence.replaceAll("{section}", String(section).padStart(2, "0"));
    return [
      `## Archive section ${String(section).padStart(2, "0")}`,
      "",
      sentence.repeat(fixture.fillerParagraphRepeats),
      "",
    ].join("\n");
  });
  return [
    "# Deterministic source coverage fixture",
    "",
    "This generated source contains neutral archive material followed by one actionable fact.",
    "",
    ...sections,
    `## ${fixture.relevantHeading}`,
    "",
    fixture.relevantFact,
    "",
  ].join("\n");
}

async function coverageIsUnknown(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
}): Promise<boolean> {
  try {
    await sourceCoverage(params);
    return false;
  } catch (error: unknown) {
    return error instanceof Error && error.message.includes("Source coverage is unknown");
  }
}

async function finalizeIsBlocked(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
}): Promise<boolean> {
  try {
    await sourceFinalize(params);
    return false;
  } catch (error: unknown) {
    return error instanceof Error && error.message.includes("Cannot finalize source coverage");
  }
}

export async function evaluateSourceCoverage(
  fixturePath = DEFAULT_SOURCE_COVERAGE_FIXTURE
): Promise<SourceCoverageEvaluationReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as SourceCoverageFixture;
  const content = materializeSource(fixture);
  const markerOffset = content.indexOf(fixture.relevantMarker);
  if (content.length <= 100_000) throw new Error(`Coverage fixture is too small: ${content.length}.`);
  if (markerOffset < content.length * 0.9) {
    throw new Error("Relevant coverage fact is not confined to the final 10% of the source.");
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-source-coverage-eval-"));
  const wikiRoot = path.join(root, "wiki");
  const common = { wikiRoot, sourceUri: fixture.sourceUri, content };
  let finalPageRef = "";

  try {
    const unknownCoverageRejected = await coverageIsUnknown(common);
    const plan = await sourceCompilePlan({
      ...common,
      segmentMaxChars: fixture.segmentMaxChars,
    });
    const sourceAccountingComplete =
      plan.ledger.segments.length > 0 &&
      plan.ledger.segments[0]!.start === 0 &&
      plan.ledger.segments.at(-1)!.end === content.length &&
      plan.ledger.segments.every((segment, index) =>
        segment.end > segment.start &&
        segment.end - segment.start <= fixture.segmentMaxChars &&
        (index === 0 || plan.ledger.segments[index - 1]!.end === segment.start)
      );
    const relevantSegment = plan.ledger.segments.find((segment) =>
      content.slice(segment.start, segment.end).includes(fixture.relevantMarker)
    );
    if (!relevantSegment) throw new Error("Compiler did not expose the final relevant segment.");

    let finalSegmentDiscovered = false;
    for (;;) {
      const unit = await sourceCompileNext({ ...common, maxChars: fixture.segmentMaxChars });
      if (!unit) break;
      if (unit.segment.id === relevantSegment.id) {
        finalSegmentDiscovered = unit.content.includes(fixture.relevantFact);
        break;
      }
      await sourceRecordSegment({
        ...common,
        segmentId: unit.segment.id,
        resolution: {
          status: "irrelevant",
          reason: "deterministic fixture padding without actionable evidence",
        },
      });
    }

    const beforeFinalSegment = (await sourceCoverage(common)).metrics;
    const prematureFinalizeBlocked = await finalizeIsBlocked(common);
    if (!finalSegmentDiscovered) throw new Error("Relevant final segment was not returned by source_compile_next.");

    const draft = prepareSourceIngestionDraft({
      sourceKind: fixture.sourceKind,
      title: fixture.title,
      sourcePath: fixture.sourceUri,
      sourceSegmentId: relevantSegment.id,
      content: content.slice(relevantSegment.start, relevantSegment.end),
    });
    finalPageRef = draft.path;
    const absolutePage = path.join(wikiRoot, draft.path);
    await fs.mkdir(path.dirname(absolutePage), { recursive: true });
    await fs.writeFile(absolutePage, draft.content, "utf8");
    const evidenceRef = `${fixture.sourceUri}#${relevantSegment.id}`;
    await sourceRecordSegment({
      ...common,
      segmentId: relevantSegment.id,
      resolution: {
        status: "integrated",
        evidenceRefs: [evidenceRef],
        pageRefs: [draft.path],
      },
    });

    // The relevant fact is deliberately the terminal source section, but keep
    // the evaluator correct if the fixture later adds explicit trailing padding.
    for (;;) {
      const unit = await sourceCompileNext({ ...common, maxChars: fixture.segmentMaxChars });
      if (!unit) break;
      await sourceRecordSegment({
        ...common,
        segmentId: unit.segment.id,
        resolution: {
          status: "irrelevant",
          reason: "explicit trailing fixture padding",
        },
      });
    }

    const finalized = await sourceFinalize(common);
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    const retrieval = await retrieveWikiHybrid({
      wikiRoot,
      query: fixture.query,
      maxResults: 5,
      progressiveWidening: true,
      maxWideningLevel: 2,
    });
    const hit = retrieval.hits.find((candidate) =>
      candidate.path === draft.path && candidate.record.body.includes(fixture.relevantFact)
    );
    const retrievalUsedSourceFallback = retrieval.attempts.some((attempt) => attempt.fallbackUsed);
    const report: SourceCoverageEvaluationReport = {
      generatedAt: new Date().toISOString(),
      fixture: path.relative(process.cwd(), fixturePath).replace(/\\/g, "/"),
      fixtureVersion: fixture.version,
      sourceChars: content.length,
      relevantMarkerOffsetPercent: (markerOffset / content.length) * 100,
      segmentMaxChars: fixture.segmentMaxChars,
      segmentCount: plan.ledger.segments.length,
      maximumObservedSegmentChars: Math.max(...plan.ledger.segments.map((segment) => segment.end - segment.start)),
      sourceAccountingComplete,
      unknownCoverageRejected,
      prematureFinalizeBlocked,
      finalSegmentDiscovered,
      finalSegmentId: relevantSegment.id,
      finalEvidenceRefs: [evidenceRef],
      finalPageRefs: [draft.path],
      retrievalRecovered: Boolean(hit),
      retrievalHitPath: hit?.path ?? "",
      retrievalWideningLevel: retrieval.wideningLevel,
      retrievalUsedSourceFallback,
      beforeFinalSegment,
      final: finalized.metrics,
    };
    process.stdout.write(
      `Source coverage fixture: ${report.sourceChars} chars, ${report.segmentCount} segments, ` +
      `relevant marker at ${report.relevantMarkerOffsetPercent.toFixed(2)}%\n`
    );
    process.stdout.write(
      `SUMMARY sourceCoveragePercent=${report.final.sourceCoveragePercent.toFixed(2)} ` +
      `unresolvedSegmentCount=${report.final.unresolvedSegmentCount} ` +
      `unrepresentedEvidenceCount=${report.final.unrepresentedEvidenceCount} ` +
      `segmentsProcessed=${report.final.segmentsProcessed} ` +
      `segmentsIgnoredWithReason=${report.final.segmentsIgnoredWithReason} ` +
      `retrievalRecovered=${report.retrievalRecovered}\n`
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
  const fixturePath = path.resolve(argValue("fixture") ?? DEFAULT_SOURCE_COVERAGE_FIXTURE);
  const report = await evaluateSourceCoverage(fixturePath);
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
