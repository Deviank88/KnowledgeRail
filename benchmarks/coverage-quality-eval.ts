import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SeededGraphQueryResult } from "../src/core/graph-runtime.js";
import { parseWikiPageRecord } from "../src/core/page-record.js";
import type { RetrievalHit } from "../src/core/retrieval-index.js";
import { wikiPassageId } from "../src/context/passage-id.js";
import {
  assessRetrievalCoverage,
  semanticCoverageQueries,
  type RetrievalCoverageRequirements,
} from "../src/core/retrieval-coverage.js";
import { queryCoverage, tokenizeSearchText } from "../src/core/text-analysis.js";

interface CoverageCase {
  id: string;
  query: string;
  displayTitle?: string;
  displayBody?: string;
  displayType?: string;
  displayTags?: string[];
  displaySources?: string[];
  candidateBody?: string;
  requiredPageTypes?: string[];
  minimumSourceDiversity?: number;
  requireContradictionCheck?: boolean;
  semanticCoverage?: boolean;
  expectedGap: boolean;
}

interface CoverageFixture {
  version: number;
  cases: CoverageCase[];
}

export interface GapQualityMetrics {
  gapPrecision: number;
  silentMiss: number;
  predictedGaps: number;
  trueGaps: number;
  falseGaps: number;
  silentMisses: number;
}

export interface CoverageQualityReport {
  fixtureVersion: number;
  caseCount: number;
  baseline205: GapQualityMetrics;
  baseline205FullPool: GapQualityMetrics;
  lexical: GapQualityMetrics;
  semantic: GapQualityMetrics;
  cases: Array<{
    id: string;
    expectedGap: boolean;
    baselineGap: boolean;
    baselineFullPoolGap: boolean;
    lexicalGap: boolean;
    semanticGap: boolean;
  }>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COVERAGE_FIXTURE = path.join(HERE, "fixtures", "coverage-quality-golden.json");
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"]);

function graphResult(): SeededGraphQueryResult {
  return {
    graph: { version: 2, generatedAt: "", nodes: [], edges: [], warnings: [] },
    nodes: [],
    edges: [],
    seedNodeIds: [],
    stats: {
      seedCount: 0,
      visitedNodes: 0,
      visitedEdges: 0,
      emittedNodes: 0,
      emittedEdges: 0,
      maxDepthReached: 0,
      truncatedFrontierCount: 0,
    },
  };
}

function hit(config: CoverageCase, suffix: string, body: string): RetrievalHit {
  const pagePath = `concepts/Evidence-${suffix}.md`;
  const title = config.displayTitle ?? "Evidence page";
  const type = config.displayType ?? "concept";
  const tags = config.displayTags ?? [];
  const sources = config.displaySources ?? [];
  const raw = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    `tags: [${tags.join(", ")}]`,
    `sources: [${sources.map((source) => JSON.stringify(source)).join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
  ].join("\n");
  const record = parseWikiPageRecord(pagePath, raw, { mtimeMs: 0, size: raw.length });
  return {
    path: pagePath,
    title,
    type,
    tags,
    sources,
    score: suffix === "display" ? 1 : 0.01,
    excerpt: body,
    heading: title,
    record,
  };
}

function requirements(config: CoverageCase): RetrievalCoverageRequirements {
  return {
    requiredPageTypes: config.requiredPageTypes,
    minimumSourceDiversity: config.minimumSourceDiversity,
    requireContradictionCheck: config.requireContradictionCheck,
  };
}

function legacyEntities(query: string): string[] {
  return [...query.matchAll(/\/?[A-Za-z][A-Za-z0-9_.]*(?:[-_/:#][A-Za-z0-9_.]+)+|\b[A-Z]{2,}[A-Z0-9]*\b|\b[A-Z][a-zA-Z]{2,}\b|\b\d{2,}\b/g)]
    .map((match) => match[0]);
}

function legacyGap(config: CoverageCase, displayed: readonly RetrievalHit[]): boolean {
  const terms = tokenizeSearchText(config.query).filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  const searchable = displayed.map((item) => [
    item.path, item.title, item.type, item.tags.join(" "), item.heading, item.excerpt, item.record.body,
  ].join(" ")).join(" ");
  const passage = displayed.map((item) => `${item.heading} ${item.excerpt}`).join(" ");
  if ((terms.length === 0 ? 1 : queryCoverage(searchable, terms)) < 0.6) return true;
  if ((displayed.length === 0 ? 0 : queryCoverage(passage, terms)) < 0.2) return true;
  const normalized = searchable.normalize("NFKC").toLowerCase();
  if (legacyEntities(config.query).some((entity) => !normalized.includes(entity.toLowerCase()))) return true;
  if ((config.requiredPageTypes ?? []).some((required) => !displayed.some((item) => item.type === required))) return true;
  if (new Set(displayed.flatMap((item) => item.sources)).size < (config.minimumSourceDiversity ?? 0)) return true;
  if (config.requireContradictionCheck) return true;
  return false;
}

function metrics(expected: readonly boolean[], predicted: readonly boolean[]): GapQualityMetrics {
  const trueGaps = expected.filter(Boolean).length;
  const predictedGaps = predicted.filter(Boolean).length;
  const falseGaps = predicted.filter((value, index) => value && !expected[index]).length;
  const silentMisses = predicted.filter((value, index) => !value && expected[index]).length;
  return {
    gapPrecision: predictedGaps === 0 ? 1 : (predictedGaps - falseGaps) / predictedGaps,
    silentMiss: trueGaps === 0 ? 0 : silentMisses / trueGaps,
    predictedGaps,
    trueGaps,
    falseGaps,
    silentMisses,
  };
}

export async function evaluateCoverageQuality(
  fixturePath = DEFAULT_COVERAGE_FIXTURE
): Promise<CoverageQualityReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as CoverageFixture;
  const expected: boolean[] = [];
  const baselineDisplay: boolean[] = [];
  const baselineFullPool: boolean[] = [];
  const lexical: boolean[] = [];
  const semantic: boolean[] = [];
  const cases: CoverageQualityReport["cases"] = [];
  for (const config of fixture.cases) {
    const displayed = config.displayBody ? [hit(config, "display", config.displayBody)] : [];
    const candidates = config.candidateBody
      ? [...displayed, hit(config, "candidate", config.candidateBody)]
      : displayed;
    const explicit = requirements(config);
    const lexicalCoverage = assessRetrievalCoverage({
      query: config.query,
      hits: candidates,
      displayHits: displayed,
      graphResult: graphResult(),
      requirements: explicit,
    });
    const semanticScores = config.semanticCoverage
      ? semanticCoverageQueries(config.query, explicit).map((query) => ({
          id: query.id,
          pages: candidates.map((candidate) => ({
            pagePath: candidate.path,
            score: 0.95,
            passages: candidate.record.passages.map((passage) => ({
              passageId: wikiPassageId(passage),
              score: 0.95,
            })),
          })),
        }))
      : [];
    const semanticCoverage = assessRetrievalCoverage({
      query: config.query,
      hits: candidates,
      displayHits: displayed,
      graphResult: graphResult(),
      requirements: explicit,
      coverageMode: "semantic",
      semanticScores,
    });
    const baselinePrediction = legacyGap(config, displayed);
    const baselineFullPoolPrediction = legacyGap(config, candidates);
    const lexicalPrediction = lexicalCoverage.evidenceGaps.length > 0;
    const semanticPrediction = semanticCoverage.evidenceGaps.length > 0;
    expected.push(config.expectedGap);
    baselineDisplay.push(baselinePrediction);
    baselineFullPool.push(baselineFullPoolPrediction);
    lexical.push(lexicalPrediction);
    semantic.push(semanticPrediction);
    cases.push({
      id: config.id,
      expectedGap: config.expectedGap,
      baselineGap: baselinePrediction,
      baselineFullPoolGap: baselineFullPoolPrediction,
      lexicalGap: lexicalPrediction,
      semanticGap: semanticPrediction,
    });
  }
  return {
    fixtureVersion: fixture.version,
    caseCount: fixture.cases.length,
    baseline205: metrics(expected, baselineDisplay),
    baseline205FullPool: metrics(expected, baselineFullPool),
    lexical: metrics(expected, lexical),
    semantic: metrics(expected, semantic),
    cases,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  evaluateCoverageQuality().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
