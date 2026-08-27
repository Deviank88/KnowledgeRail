import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearRetrievalIndexes, searchRetrievalIndex, type RetrievalHit } from "../src/core/retrieval-index.js";
import { orderedWordBigrams, scoreBigramRerankCandidate, surfacePhraseTokens } from "../src/core/phrase-scoring.js";
import { mean, ndcgAtK, recallAtK } from "./retrieval-metrics.js";

type Split = "development" | "heldout";
type Method = "baseline" | "bigram" | "bigram_trigram" | "phrase_idf" | "phrase_idf_contiguous" | "contiguous" | "proximity" | "combined";
type ReportMethod = Method | "production_bigram";

interface PassageFixture { heading: string; text: string }
interface PageFixture { path: string; title: string; passages: PassageFixture[] }
interface PhraseCase {
  id: string;
  class: string;
  split: Split;
  query: string;
  exactPhraseExpected: boolean;
  critical: boolean;
  relevant: PageFixture & { grade: number; expectedHeading: string };
  decoy: PageFixture;
}
interface PhraseFixture { version: number; seed: number; cases: PhraseCase[] }

interface PhraseSignals {
  bigram: number;
  trigram: number;
  phraseIdf: number;
  longestContiguous: number;
  proximity: number;
}

interface RankedPhraseHit extends RetrievalHit {
  phraseSignals: PhraseSignals;
  phraseHeading: string;
}

interface QueryResult {
  id: string;
  class: string;
  split: Split;
  critical: boolean;
  exactPhraseExpected: boolean;
  relevantPath: string;
  expectedHeading: string;
  topPaths: string[];
  ndcgAt5: number;
  recallAt5: number;
  passageMatch: number;
}

interface MethodReport {
  method: ReportMethod;
  split: Split;
  ndcgAt5: number;
  recallAt5: number;
  passageAccuracy: number;
  criticalTop1: number;
  paraphraseRecallAt5: number;
  queries: QueryResult[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "phrase-retrieval-golden.json");
const METHODS: Method[] = [
  "baseline", "bigram", "bigram_trigram", "phrase_idf", "phrase_idf_contiguous", "contiguous", "proximity", "combined",
];

function grams(tokens: readonly string[], width: number): string[] {
  if (width === 2) return orderedWordBigrams(tokens);
  const result: string[] = [];
  for (let index = 0; index + width <= tokens.length; index++) {
    result.push(tokens.slice(index, index + width).join("\u0001"));
  }
  return result;
}

function longestContiguous(query: readonly string[], passage: readonly string[]): number {
  let best = 0;
  for (let queryStart = 0; queryStart < query.length; queryStart++) {
    for (let passageStart = 0; passageStart < passage.length; passageStart++) {
      let length = 0;
      while (query[queryStart + length] !== undefined && query[queryStart + length] === passage[passageStart + length]) {
        length++;
      }
      best = Math.max(best, length);
    }
  }
  return best;
}

function proximityScore(query: readonly string[], passage: readonly string[]): number {
  const required = [...new Set(query)];
  if (required.length === 0) return 0;
  let bestWindow = Number.POSITIVE_INFINITY;
  for (let start = 0; start < passage.length; start++) {
    const remaining = new Set(required);
    for (let end = start; end < passage.length; end++) {
      remaining.delete(passage[end]!);
      if (remaining.size === 0) {
        bestWindow = Math.min(bestWindow, end - start + 1);
        break;
      }
    }
  }
  return Number.isFinite(bestWindow) ? required.length / bestWindow : 0;
}

function passageSignals(
  queryTokens: readonly string[],
  passageTokens: readonly string[],
  phraseIdf: ReadonlyMap<string, number>
): PhraseSignals {
  const queryBigrams = grams(queryTokens, 2);
  const queryTrigrams = grams(queryTokens, 3);
  const passageBigrams = new Set(grams(passageTokens, 2));
  const passageTrigrams = new Set(grams(passageTokens, 3));
  const matchedBigrams = queryBigrams.filter((gram) => passageBigrams.has(gram));
  const matchedTrigrams = queryTrigrams.filter((gram) => passageTrigrams.has(gram));
  return {
    bigram: matchedBigrams.length,
    trigram: matchedTrigrams.length,
    phraseIdf: [...matchedBigrams, ...matchedTrigrams].reduce((sum, gram) => sum + (phraseIdf.get(gram) ?? 0), 0),
    longestContiguous: longestContiguous(queryTokens, passageTokens),
    proximity: proximityScore(queryTokens, passageTokens),
  };
}

function signalValue(method: Method, signals: PhraseSignals, queryLength: number): number {
  if (method === "baseline") return 0;
  if (method === "bigram") return signals.bigram * 1.5;
  if (method === "bigram_trigram") return signals.bigram * 1.25 + signals.trigram * 2.5;
  if (method === "phrase_idf") return signals.phraseIdf;
  if (method === "phrase_idf_contiguous") {
    return signals.phraseIdf + 10 * (signals.longestContiguous ** 2) / Math.max(1, queryLength);
  }
  if (method === "contiguous") return (signals.longestContiguous ** 2) / Math.max(1, queryLength);
  if (method === "proximity") return signals.proximity * 2;
  return signals.bigram * 0.75 + signals.trigram * 1.5 +
    (signals.longestContiguous ** 2) / Math.max(1, queryLength) + signals.proximity;
}

function phraseIdfFor(queryTokens: readonly string[], hits: readonly RetrievalHit[]): Map<string, number> {
  const queryGrams = [...new Set([...grams(queryTokens, 2), ...grams(queryTokens, 3)])];
  const result = new Map<string, number>();
  for (const gram of queryGrams) {
    const width = gram.split("\u0001").length;
    const documentFrequency = hits.filter((hit) => hit.record.passages.some((passage) =>
      new Set(grams(surfacePhraseTokens(`${passage.heading} ${passage.text}`), width)).has(gram))).length;
    result.set(gram, Math.log(1 + (hits.length + 1) / (documentFrequency + 1)));
  }
  return result;
}

function rerank(method: Method, query: string, hits: readonly RetrievalHit[]): RankedPhraseHit[] {
  const queryTokens = surfacePhraseTokens(query);
  const phraseIdf = phraseIdfFor(queryTokens, hits);
  if (method === "baseline") {
    return hits.map((hit) => ({
      ...hit,
      phraseSignals: { bigram: 0, trigram: 0, phraseIdf: 0, longestContiguous: 0, proximity: 0 },
      phraseHeading: hit.heading,
    }));
  }
  const scored = hits.map((hit) => {
    let bestHeading = hit.heading;
    let bestSignals: PhraseSignals = { bigram: 0, trigram: 0, phraseIdf: 0, longestContiguous: 0, proximity: 0 };
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const passage of hit.record.passages) {
      const signals = passageSignals(queryTokens, surfacePhraseTokens(`${passage.heading} ${passage.text}`), phraseIdf);
      const value = signalValue(method, signals, queryTokens.length);
      if (value > bestValue) {
        bestValue = value;
        bestSignals = signals;
        bestHeading = passage.heading;
      }
    }
    return { hit, bestValue: Math.max(0, bestValue), bestSignals, bestHeading };
  });
  const baseScores = scored.map((item) => item.hit.score);
  const minBase = Math.min(...baseScores);
  const maxBase = Math.max(...baseScores);
  const maxPhrase = Math.max(...scored.map((item) => item.bestValue), 1);
  const queryBigramCount = new Set(grams(queryTokens, 2)).size;
  return scored.map(({ hit, bestValue, bestSignals, bestHeading }) => ({
    ...hit,
    score: method === "bigram"
      ? scoreBigramRerankCandidate({
          baseScore: hit.score,
          minimumBaseScore: minBase,
          maximumBaseScore: maxBase,
          matchedBigrams: bestSignals.bigram,
          queryBigramCount,
        })
      : (hit.score - minBase) / Math.max(maxBase - minBase, 1e-9) +
        1.5 * bestValue / maxPhrase,
    phraseSignals: bestSignals,
    phraseHeading: bestHeading,
  })).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

async function materialize(root: string, fixture: PhraseFixture): Promise<void> {
  for (const item of fixture.cases) {
    for (const page of [item.relevant, item.decoy]) {
      // Phrase-positive pairs deliberately equalize passage count and heading
      // metadata so unigram BM25 cannot win from an unrelated length cue.
      const passages = page === item.decoy && item.exactPhraseExpected
        ? item.relevant.passages.map((passage, index) => ({
            heading: passage.heading,
            text: item.decoy.passages[index % item.decoy.passages.length]!.text,
          }))
        : page.passages;
      const absolute = path.join(root, page.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, [
        "---",
        `title: ${JSON.stringify(page.title)}`,
        "type: analysis",
        `tags: [${JSON.stringify(item.class)}, phrase-evaluation]`,
        "sources: []",
        "---",
        "",
        ...passages.flatMap((passage) => [`## ${passage.heading}`, "", passage.text, ""]),
      ].join("\n"));
    }
  }
}

async function evaluateMethod(
  root: string,
  fixture: PhraseFixture,
  method: Method,
  split: Split
): Promise<MethodReport & { method: Method }> {
  const results: QueryResult[] = [];
  for (const item of fixture.cases.filter((candidate) => candidate.split === split)) {
    const baseline = await searchRetrievalIndex({
      wikiRoot: root,
      query: item.query,
      maxResults: 20,
      profile: "precision",
      persist: false,
      phraseRerank: false,
    });
    const ranked = rerank(method, item.query, baseline);
    const relevant = [{ path: item.relevant.path, grade: item.relevant.grade }];
    const relevantHit = ranked.find((hit) => hit.path === item.relevant.path);
    results.push({
      id: item.id,
      class: item.class,
      split,
      critical: item.critical,
      exactPhraseExpected: item.exactPhraseExpected,
      relevantPath: item.relevant.path,
      expectedHeading: item.relevant.expectedHeading,
      topPaths: ranked.slice(0, 5).map((hit) => hit.path),
      ndcgAt5: ndcgAtK(ranked, relevant, 5),
      recallAt5: recallAtK(ranked, relevant, 5),
      passageMatch: relevantHit?.phraseHeading === item.relevant.expectedHeading ? 1 : 0,
    });
  }
  const critical = results.filter((result) => result.critical);
  const paraphrases = results.filter((result) => !result.exactPhraseExpected && result.class === "paraphrase_without_exact_phrase");
  return {
    method,
    split,
    ndcgAt5: mean(results.map((result) => result.ndcgAt5)),
    recallAt5: mean(results.map((result) => result.recallAt5)),
    passageAccuracy: mean(results.map((result) => result.passageMatch)),
    criticalTop1: mean(critical.map((result) => result.topPaths[0] === result.relevantPath ? 1 : 0)),
    paraphraseRecallAt5: mean(paraphrases.map((result) => result.recallAt5)),
    queries: results,
  };
}

async function evaluateProduction(
  root: string,
  fixture: PhraseFixture,
  split: Split
): Promise<MethodReport> {
  const results: QueryResult[] = [];
  for (const item of fixture.cases.filter((candidate) => candidate.split === split)) {
    const ranked = await searchRetrievalIndex({
      wikiRoot: root,
      query: item.query,
      maxResults: 20,
      profile: "precision",
      persist: false,
      phraseRerank: true,
    });
    const relevant = [{ path: item.relevant.path, grade: item.relevant.grade }];
    const relevantHit = ranked.find((hit) => hit.path === item.relevant.path);
    results.push({
      id: item.id,
      class: item.class,
      split,
      critical: item.critical,
      exactPhraseExpected: item.exactPhraseExpected,
      relevantPath: item.relevant.path,
      expectedHeading: item.relevant.expectedHeading,
      topPaths: ranked.slice(0, 5).map((hit) => hit.path),
      ndcgAt5: ndcgAtK(ranked, relevant, 5),
      recallAt5: recallAtK(ranked, relevant, 5),
      passageMatch: relevantHit?.heading === item.relevant.expectedHeading ? 1 : 0,
    });
  }
  const critical = results.filter((result) => result.critical);
  const paraphrases = results.filter((result) =>
    !result.exactPhraseExpected && result.class === "paraphrase_without_exact_phrase"
  );
  return {
    method: "production_bigram",
    split,
    ndcgAt5: mean(results.map((result) => result.ndcgAt5)),
    recallAt5: mean(results.map((result) => result.recallAt5)),
    passageAccuracy: mean(results.map((result) => result.passageMatch)),
    criticalTop1: mean(critical.map((result) => result.topPaths[0] === result.relevantPath ? 1 : 0)),
    paraphraseRecallAt5: mean(paraphrases.map((result) => result.recallAt5)),
    queries: results,
  };
}

function improvement(candidate: MethodReport, baseline: MethodReport): { ndcg: number; passage: number } {
  return {
    ndcg: candidate.ndcgAt5 - baseline.ndcgAt5,
    passage: candidate.passageAccuracy - baseline.passageAccuracy,
  };
}

function selectDevelopmentWinner(
  reports: readonly (MethodReport & { method: Method })[]
): MethodReport & { method: Method } {
  const baseline = reports.find((report) => report.method === "baseline")!;
  return reports
    .filter((report) => report.method !== "baseline")
    .filter((report) => report.criticalTop1 >= baseline.criticalTop1 && report.paraphraseRecallAt5 >= baseline.paraphraseRecallAt5)
    .sort((left, right) => {
      const leftGain = improvement(left, baseline);
      const rightGain = improvement(right, baseline);
      return rightGain.ndcg - leftGain.ndcg || rightGain.passage - leftGain.passage || left.method.localeCompare(right.method);
    })[0] ?? baseline;
}

function printReport(report: MethodReport, baseline: MethodReport): void {
  const gain = improvement(report, baseline);
  process.stdout.write(
    `${report.split.padEnd(11)} ${report.method.padEnd(16)} ` +
    `NDCG@5=${report.ndcgAt5.toFixed(4)} (${gain.ndcg >= 0 ? "+" : ""}${gain.ndcg.toFixed(4)}) ` +
    `Passage=${report.passageAccuracy.toFixed(4)} (${gain.passage >= 0 ? "+" : ""}${gain.passage.toFixed(4)}) ` +
    `R@5=${report.recallAt5.toFixed(4)} CriticalTop1=${report.criticalTop1.toFixed(4)} ` +
    `ParaphraseR@5=${report.paraphraseRecallAt5.toFixed(4)}\n`
  );
}

async function main(): Promise<void> {
  const fixtureRaw = await fs.readFile(FIXTURE_PATH);
  const fixture = JSON.parse(fixtureRaw.toString("utf8")) as PhraseFixture;
  if (fixture.cases.length < 30) throw new Error("Phrase fixture must contain at least 30 hand-labeled queries.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-phrase-ab-"));
  try {
    await materialize(root, fixture);
    clearRetrievalIndexes();
    const development: Array<MethodReport & { method: Method }> = [];
    for (const method of METHODS) development.push(await evaluateMethod(root, fixture, method, "development"));
    const developmentBaseline = development.find((report) => report.method === "baseline")!;
    development.forEach((report) => printReport(report, developmentBaseline));

    const winner = selectDevelopmentWinner(development);
    process.stdout.write(`\nSelected on development only: ${winner.method}\n\n`);
    const [heldoutBaseline, heldoutWinner] = await Promise.all([
      evaluateMethod(root, fixture, "baseline", "heldout"),
      evaluateMethod(root, fixture, winner.method, "heldout"),
    ]);
    printReport(heldoutBaseline, heldoutBaseline);
    printReport(heldoutWinner, heldoutBaseline);
    const production = await evaluateProduction(root, fixture, "heldout");
    printReport(production, heldoutBaseline);

    const gain = improvement(heldoutWinner, heldoutBaseline);
    const criticalRegressions = heldoutWinner.queries.filter((query) => {
      if (!query.critical) return false;
      const baseline = heldoutBaseline.queries.find((item) => item.id === query.id)!;
      return baseline.topPaths[0] === baseline.relevantPath && query.topPaths[0] !== query.relevantPath;
    });
    const perQueryRegressions = heldoutWinner.queries.flatMap((query) => {
      const baseline = heldoutBaseline.queries.find((item) => item.id === query.id)!;
      return query.ndcgAt5 + 1e-12 < baseline.ndcgAt5 || query.passageMatch < baseline.passageMatch
        ? [{ id: query.id, baselineNdcg: baseline.ndcgAt5, candidateNdcg: query.ndcgAt5,
          baselinePassage: baseline.passageMatch, candidatePassage: query.passageMatch }]
        : [];
    });
    const exploratoryGo = winner.method !== "baseline" && gain.ndcg >= 0.08 && gain.passage >= 0.10 &&
      criticalRegressions.length === 0 && heldoutWinner.paraphraseRecallAt5 >= heldoutBaseline.paraphraseRecallAt5;
    const productionGain = improvement(production, heldoutBaseline);
    const productionRegressions = production.queries.flatMap((query) => {
      const baseline = heldoutBaseline.queries.find((item) => item.id === query.id)!;
      return query.ndcgAt5 + 1e-12 < baseline.ndcgAt5 || query.passageMatch < baseline.passageMatch
        ? [{ id: query.id, baselineNdcg: baseline.ndcgAt5, candidateNdcg: query.ndcgAt5,
          baselinePassage: baseline.passageMatch, candidatePassage: query.passageMatch }]
        : [];
    });
    const productionGo = productionGain.ndcg >= 0.08 && productionGain.passage >= 0.10 &&
      production.criticalTop1 >= heldoutBaseline.criticalTop1 &&
      production.paraphraseRecallAt5 >= heldoutBaseline.paraphraseRecallAt5 &&
      productionRegressions.length === 0;
    process.stdout.write(`${JSON.stringify({
      fixture: path.relative(process.cwd(), FIXTURE_PATH).replace(/\\/g, "/"),
      fixtureSha256: createHash("sha256").update(fixtureRaw).digest("hex"),
      seed: fixture.seed,
      pageCount: fixture.cases.length * 2,
      queryCount: fixture.cases.length,
      developmentWinner: winner.method,
      exploratoryVerification: { report: heldoutWinner, gain, decision: exploratoryGo ? "GO" : "NO_GO" },
      heldout: { baseline: heldoutBaseline, candidate: production, gain: productionGain },
      productionVerification: { report: production, gain: productionGain, regressions: productionRegressions, decision: productionGo ? "GO" : "NO_GO" },
      criticalRegressions,
      perQueryRegressions,
      decision: productionGo ? "GO" : "NO_GO",
    }, null, 2)}\n`);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
