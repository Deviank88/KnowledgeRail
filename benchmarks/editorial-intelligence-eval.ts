import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSectionContext,
  formatSectionContext,
  type DocumentType,
} from "../src/core/document-workflow.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";
import {
  sourceCompilePlan,
  sourceFinalize,
  sourceRecordSegment,
} from "../src/core/ingestion/source-compiler.js";
import { invalidateWikiGraph } from "../src/core/graph-index.js";
import { clearRuntimeWikiGraphs } from "../src/core/graph-runtime.js";
import { clearRetrievalIndexes } from "../src/core/retrieval-index.js";
import { estimateContextSize } from "../src/context/context-manifest.js";
import {
  createConsultingFixture,
  evaluateScenario,
  QUALITY_SCENARIOS,
} from "./document-quality-eval.js";
import type { EditorialEvidenceKind } from "../src/config/editorial-plans.js";

interface EditorialGoldenSection {
  id: string;
  documentType: DocumentType;
  title: string;
  query: string;
  expectedMarkers: string[];
  expectedRequiredEvidence: EditorialEvidenceKind[];
  expectGap: boolean;
  expectedMissingEvidence?: EditorialEvidenceKind[];
  maxPages: number;
  maxOutputChars: number;
  outputTokenBudget: number;
  heuristicTokenBudget: number;
}

interface EditorialGoldenFixture {
  version: number;
  sourceUri: string;
  sourceContent: string;
  sections: EditorialGoldenSection[];
}

export interface EditorialSectionReport {
  id: string;
  baselineV3Recall: number;
  editorialRecall: number;
  recallDelta: number;
  requiredEvidence: EditorialEvidenceKind[];
  foundEvidence: EditorialEvidenceKind[];
  missingEvidence: EditorialEvidenceKind[];
  expectedGap: boolean;
  gapReported: boolean;
  sourceCoveragePercent: number | null;
  unprovenancedClaimsBaseline: number;
  unprovenancedClaimsEditorial: number;
  contextTokens: number;
  tokenBudget: number;
  withinTokenBudget: boolean;
  wideningLevel: number;
  fallbackUsed: boolean;
  fullGraphScanAttempted: boolean;
  fullSourceGrepAttempted: boolean;
}

export interface EditorialIntelligenceReport {
  fixtureVersion: number;
  sectionIds: string[];
  documentQuality: Array<{
    name: string;
    baselineRecall: number;
    editorialRecall: number;
    outputChars: number;
  }>;
  sections: EditorialSectionReport[];
  metrics: {
    DocumentQualityRecall: number;
    BaselineV3SectionEvidenceRecall: number;
    SectionEvidenceRecall: number;
    SectionEvidenceRecallDelta: number;
    GapReportingRate: number;
    RequiredEvidencePlanAccuracy: number;
    SourceCoveragePercent: number;
    ClaimsWithoutProvenanceBaseline: number;
    ClaimsWithoutProvenanceEditorial: number;
    MaxContextTokens: number;
    TokenBudgetViolationCount: number;
    FullGraphScanAttempts: number;
    FullSourceGrepAttempts: number;
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EDITORIAL_FIXTURE = path.join(
  HERE,
  "fixtures",
  "editorial-intelligence-golden.json"
);

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function markerRecall(text: string, markers: readonly string[]): number {
  return ratio(markers.filter((marker) => text.includes(marker)).length, markers.length);
}

async function writePage(wikiRoot: string, relPath: string, params: {
  title: string;
  type: string;
  body: string;
  sources?: string[];
}): Promise<void> {
  const absolute = path.join(wikiRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---",
    `title: "${params.title}"`,
    `type: ${params.type}`,
    "tags: [editorial-golden]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    `sources: [${(params.sources ?? []).map((source) => `"${source}"`).join(", ")}]`,
    "---",
    "",
    `# ${params.title}`,
    "",
    params.body,
  ].join("\n"), "utf8");
}

async function materializeEditorialFixture(
  wikiRoot: string,
  fixture: EditorialGoldenFixture
): Promise<{ markerPaths: Map<string, string>; provenancePaths: Set<string> }> {
  const markerPaths = new Map<string, string>();
  const provenancePaths = new Set<string>();
  const pages = [
    {
      path: "requirements/REQ_APPROVAL.md",
      title: "Requisito processo approvativo",
      type: "requirement",
      body: "EVID-EDITORIAL-REQ Il processo approvativo richiede validazione e audit. [[Approval validation decision]]",
    },
    {
      path: "decisions/DEC_APPROVAL.md",
      title: "Approval validation decision",
      type: "decision",
      body: "EVID-EDITORIAL-DEC La decisione mantiene il controllo separato. [[Approval execution engine]]",
    },
    {
      path: "implementations/ApprovalEngine.md",
      title: "Approval execution engine",
      type: "implementation",
      body: "EVID-EDITORIAL-IMPL Il componente applica optimistic locking e persistenza idempotente.",
    },
    {
      path: "requirements/REQ_SECURITY.md",
      title: "Requisito sicurezza dati",
      type: "requirement",
      body: "EVID-EDITORIAL-SEC Security encryption e authorization sono obbligatorie per i dati sensibili.",
    },
  ];
  for (const page of pages) {
    await writePage(wikiRoot, page.path, { ...page, sources: [fixture.sourceUri] });
    provenancePaths.add(page.path);
    for (const marker of page.body.match(/EVID-EDITORIAL-[A-Z]+/g) ?? []) markerPaths.set(marker, page.path);
  }
  for (let index = 0; index < 12; index++) {
    await writePage(wikiRoot, `concepts/Noise_${index}.md`, {
      title: `Nota operativa ${index}`,
      type: "concept",
      body: `Contesto generico su cataloghi, anagrafiche e attività operative ${index}. `.repeat(12),
      sources: [fixture.sourceUri],
    });
  }
  const planned = await sourceCompilePlan({
    wikiRoot,
    sourceUri: fixture.sourceUri,
    content: fixture.sourceContent,
    segmentMaxChars: 512,
  });
  for (const segment of planned.ledger.segments) {
    await sourceRecordSegment({
      wikiRoot,
      sourceUri: fixture.sourceUri,
      content: fixture.sourceContent,
      segmentId: segment.id,
      resolution: {
        status: "integrated",
        evidenceRefs: [...markerPaths.keys()],
        pageRefs: [...new Set(markerPaths.values())],
      },
    });
  }
  await sourceFinalize({
    wikiRoot,
    sourceUri: fixture.sourceUri,
    content: fixture.sourceContent,
  });
  return { markerPaths, provenancePaths };
}

async function historicalV3Context(
  wikiRoot: string,
  section: EditorialGoldenSection
): Promise<{ text: string; selectedPaths: string[] }> {
  const query = `${section.title} ${section.query}`;
  const result = await retrieveWikiHybrid({
    wikiRoot,
    query,
    maxResults: Math.max(section.maxPages * 4, 20),
    lexicalPoolSize: Math.max(section.maxPages * 4, 20),
    seedCount: Math.max(1, Math.min(8, section.maxPages * 2)),
    graphMaxNodes: Math.max(section.maxPages * 3, 24),
    graphMaxDepth: 1,
    graphBeamWidth: Math.max(section.maxPages * 2, 16),
    graphMaxVisitedNodes: Math.max(section.maxPages * 6, 48),
    profile: "coverage",
  });
  const selected = result.hits.slice(0, section.maxPages);
  return {
    text: selected.map((hit) => hit.record.body.slice(0, 1_200)).join("\n\n"),
    selectedPaths: selected.map((hit) => hit.path),
  };
}

function unprovenancedRecoveredClaims(params: {
  text: string;
  markers: readonly string[];
  markerPaths: ReadonlyMap<string, string>;
  sourcePaths: ReadonlySet<string>;
}): number {
  return params.markers.filter((marker) => {
    if (!params.text.includes(marker)) return false;
    const pagePath = params.markerPaths.get(marker);
    return !pagePath || !params.sourcePaths.has(pagePath);
  }).length;
}

async function evaluateDocumentQualityBaseline(): Promise<EditorialIntelligenceReport["documentQuality"]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-editorial-quality-"));
  try {
    await createConsultingFixture(root);
    clearRetrievalIndexes();
    const results = [];
    for (const scenario of QUALITY_SCENARIOS) {
      const evaluated = await evaluateScenario(root, scenario);
      results.push({
        name: evaluated.name,
        baselineRecall: 1,
        editorialRecall: evaluated.v3Recall,
        outputChars: evaluated.v3Chars,
      });
    }
    return results;
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function evaluateEditorialIntelligence(
  fixturePath = DEFAULT_EDITORIAL_FIXTURE
): Promise<EditorialIntelligenceReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as EditorialGoldenFixture;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-editorial-eval-"));
  const wikiRoot = path.join(root, "wiki");
  clearRetrievalIndexes();
  clearRuntimeWikiGraphs();
  try {
    const { markerPaths, provenancePaths } = await materializeEditorialFixture(wikiRoot, fixture);
    const sections: EditorialSectionReport[] = [];
    for (const section of fixture.sections) {
      const baseline = await historicalV3Context(wikiRoot, section);
      const context = await createSectionContext({
        wikiRoot,
        documentType: section.documentType,
        sectionTitle: section.title,
        query: section.query,
        maxPages: section.maxPages,
        maxCharsPerPage: 1_200,
        maxTotalChars: section.maxOutputChars - 2_000,
        maxOutputChars: section.maxOutputChars,
        heuristicTokenBudget: section.heuristicTokenBudget,
        retrievalProfile: "coverage",
      });
      const editorialText = formatSectionContext(context, section.title, section.maxOutputChars);
      const baselineRecall = markerRecall(baseline.text, section.expectedMarkers);
      const editorialRecall = markerRecall(editorialText, section.expectedMarkers);
      const contextTokens = estimateContextSize(editorialText).heuristicTokens;
      sections.push({
        id: section.id,
        baselineV3Recall: baselineRecall,
        editorialRecall,
        recallDelta: editorialRecall - baselineRecall,
        requiredEvidence: context.coverage.requiredEvidence,
        foundEvidence: context.coverage.foundEvidence,
        missingEvidence: context.coverage.missingEvidence,
        expectedGap: section.expectGap,
        gapReported: context.coverage.status === "GAP",
        sourceCoveragePercent: context.coverage.sourceCoverage.averageCoveragePercent,
        unprovenancedClaimsBaseline: unprovenancedRecoveredClaims({
          text: baseline.text,
          markers: section.expectedMarkers,
          markerPaths,
          sourcePaths: provenancePaths,
        }),
        unprovenancedClaimsEditorial: unprovenancedRecoveredClaims({
          text: editorialText,
          markers: section.expectedMarkers,
          markerPaths,
          sourcePaths: provenancePaths,
        }),
        contextTokens,
        tokenBudget: section.outputTokenBudget,
        withinTokenBudget: contextTokens <= section.outputTokenBudget &&
          context.compiler.withinHeuristicBudget,
        wideningLevel: context.compiler.wideningLevel,
        fallbackUsed: context.compiler.fallbackUsed,
        fullGraphScanAttempted: context.compiler.fullGraphScanAttempted,
        fullSourceGrepAttempted: context.compiler.fullSourceGrepAttempted,
      });
    }

    const documentQuality = await evaluateDocumentQualityBaseline();
    const expectedMarkers = fixture.sections.reduce((sum, section) => sum + section.expectedMarkers.length, 0);
    const baselineRecovered = fixture.sections.reduce(
      (sum, section, index) => sum + sections[index]!.baselineV3Recall * section.expectedMarkers.length,
      0
    );
    const editorialRecovered = fixture.sections.reduce(
      (sum, section, index) => sum + sections[index]!.editorialRecall * section.expectedMarkers.length,
      0
    );
    const requiredPlanMatches = fixture.sections.filter((section, index) =>
      JSON.stringify(sections[index]!.requiredEvidence) === JSON.stringify(section.expectedRequiredEvidence) &&
      JSON.stringify(sections[index]!.missingEvidence) === JSON.stringify(section.expectedMissingEvidence ?? [])
    ).length;
    const knownCoverage = sections
      .map((section) => section.sourceCoveragePercent)
      .filter((value): value is number => value !== null);
    const metrics: EditorialIntelligenceReport["metrics"] = {
      DocumentQualityRecall: Math.min(...documentQuality.map((result) => result.editorialRecall)),
      BaselineV3SectionEvidenceRecall: ratio(baselineRecovered, expectedMarkers),
      SectionEvidenceRecall: ratio(editorialRecovered, expectedMarkers),
      SectionEvidenceRecallDelta: ratio(editorialRecovered, expectedMarkers) - ratio(baselineRecovered, expectedMarkers),
      GapReportingRate: ratio(
        fixture.sections.filter((section, index) => sections[index]!.gapReported === section.expectGap).length,
        fixture.sections.length
      ),
      RequiredEvidencePlanAccuracy: ratio(requiredPlanMatches, fixture.sections.length),
      SourceCoveragePercent: knownCoverage.length === 0
        ? 0
        : knownCoverage.reduce((sum, value) => sum + value, 0) / knownCoverage.length,
      ClaimsWithoutProvenanceBaseline: sections.reduce((sum, section) => sum + section.unprovenancedClaimsBaseline, 0),
      ClaimsWithoutProvenanceEditorial: sections.reduce((sum, section) => sum + section.unprovenancedClaimsEditorial, 0),
      MaxContextTokens: Math.max(...sections.map((section) => section.contextTokens)),
      TokenBudgetViolationCount: sections.filter((section) => !section.withinTokenBudget).length,
      FullGraphScanAttempts: sections.filter((section) => section.fullGraphScanAttempted).length,
      FullSourceGrepAttempts: sections.filter((section) => section.fullSourceGrepAttempted).length,
    };
    for (const section of sections) {
      process.stdout.write(
        `${section.id.padEnd(22)} recall=${section.baselineV3Recall.toFixed(3)}->${section.editorialRecall.toFixed(3)} ` +
        `coverage=${section.foundEvidence.join(",") || "none"} gap=${section.gapReported} ` +
        `tokens=${section.contextTokens}/${section.tokenBudget} W${section.wideningLevel}\n`
      );
    }
    process.stdout.write(
      `SUMMARY DocumentQuality=${metrics.DocumentQualityRecall.toFixed(4)} ` +
      `SectionEvidence=${metrics.BaselineV3SectionEvidenceRecall.toFixed(4)}->${metrics.SectionEvidenceRecall.toFixed(4)} ` +
      `Delta=${metrics.SectionEvidenceRecallDelta.toFixed(4)} Gaps=${metrics.GapReportingRate.toFixed(4)} ` +
      `Unprovenanced=${metrics.ClaimsWithoutProvenanceBaseline}->${metrics.ClaimsWithoutProvenanceEditorial} ` +
      `FullSourceGrep=${metrics.FullSourceGrepAttempts}\n`
    );
    return {
      fixtureVersion: fixture.version,
      sectionIds: fixture.sections.map((section) => section.id),
      documentQuality,
      sections,
      metrics,
    };
  } finally {
    clearRetrievalIndexes();
    clearRuntimeWikiGraphs();
    invalidateWikiGraph(wikiRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixtureArg = process.argv.find((argument) => argument.startsWith("--fixture="));
  await evaluateEditorialIntelligence(fixtureArg?.slice("--fixture=".length));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
