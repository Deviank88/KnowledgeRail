/** Offline operating-point analysis. This never changes runtime coverage thresholds. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

interface Row {
  id: string; split: string; group: string; answerable: boolean; sufficient: boolean;
  rerank: { maxScore: number | null; scoredCandidates: number };
}
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const input = arg("input"), output = arg("output");
assert.ok(input && output, "--input=<coverage diagnostics JSON> and --output=<new JSON file> are required");
// An explicit analysis allowance, not an accepted product target or model-independent default.
const maxFalseGapRate = Number(arg("max-false-gap-rate") ?? "0.10");
assert.ok(Number.isFinite(maxFalseGapRate) && maxFalseGapRate >= 0 && maxFalseGapRate <= 1);
const bytes = await fs.readFile(input);
const source = JSON.parse(bytes.toString("utf8")) as { rows: Row[]; settings?: unknown; fixtures?: unknown; provider?: unknown };
assert.ok(source.rows.length && new Set(source.rows.map((row) => row.id)).size === source.rows.length);
assert.ok(source.rows.every((row) => typeof row.answerable === "boolean" && typeof row.sufficient === "boolean"));
assert.ok(source.rows.every((row) => row.rerank?.maxScore !== null && Number.isFinite(row.rerank?.maxScore) && row.rerank.scoredCandidates > 0),
  "Every query must have actual reranker scores; missing-service/fallback reports cannot calibrate score thresholds.");
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
function measure(rows: Row[], threshold: number | null) {
  let tp = 0, fp = 0, tn = 0, fn = 0, inDomainFp = 0;
  const rejected: Array<{ id: string; answerable: boolean; maxScore: number }> = [];
  for (const row of rows) {
    const sufficient = row.sufficient && (threshold === null || row.rerank.maxScore! >= threshold);
    if (row.answerable) { if (sufficient) tp++; else fn++; }
    else if (sufficient) { fp++; if (row.group === "absent-indomain") inDomainFp++; } else tn++;
    if (row.sufficient && !sufficient) rejected.push({ id: row.id, answerable: row.answerable, maxScore: row.rerank.maxScore! });
  }
  const inDomainNegatives = rows.filter((row) => !row.answerable && row.group === "absent-indomain").length;
  return { positives: tp + fn, negatives: fp + tn, tp, fp, tn, fn,
    falseGapRate: ratio(fn, fn + tp), falseSufficientRate: ratio(fp, fp + tn),
    inDomainFp, inDomainNegatives, inDomainFalseSufficientRate: ratio(inDomainFp, inDomainNegatives),
    // This depends on the query mix and is distinct from false positives among negatives.
    falseDiscoveryRate: ratio(fp, tp + fp), precision: ratio(tp, tp + fp),
    balancedAccuracy: tp + fn && fp + tn ? (tp / (tp + fn) + tn / (tn + fp)) / 2 : null, newlyRejected: rejected };
}
const development = source.rows.filter((row) => row.split === "development");
assert.ok(development.some((row) => row.answerable) && development.some((row) => row.group === "absent-indomain"));
// Fixed, coarse grid: do not fit a cutoff to individual observed logits.
const thresholds = [-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2];
const grid = [null, ...thresholds].map((threshold) => ({ threshold, development: measure(development, threshold) }));
const eligible = grid.filter((row) => row.development.falseGapRate! <= maxFalseGapRate);
eligible.sort((a, b) => a.development.inDomainFalseSufficientRate! - b.development.inDomainFalseSufficientRate! ||
  a.development.fn - b.development.fn || (a.threshold ?? -Infinity) - (b.threshold ?? -Infinity));
const selected = eligible[0];
assert.ok(selected, "No tested operating point meets the analysis allowance; do not relax it based on holdout results.");
const splits = [...new Set(source.rows.map((row) => row.split))];
const report = {
  generatedAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  sourceSettings: source.settings, fixtures: source.fixtures, embeddingProvider: source.provider,
  selection: { split: "development", maxFalseGapRate,
    objective: "Minimize in-domain false-sufficient rate under the declared false-gap allowance; ties prefer fewer false gaps, then the less restrictive threshold.",
    threshold: selected.threshold }, developmentGrid: grid,
  observations: source.rows.map(({ id, split, group, answerable, sufficient, rerank }) => ({ id, split, group, answerable, sufficient, rerank })),
  evaluation: [...splits, "all"].map((split) => {
    const rows = split === "all" ? source.rows : source.rows.filter((row) => row.split === split);
    return { split, baseline: measure(rows, null), candidate: measure(rows, selected.threshold) };
  }),
  limitations: ["The 10% default is an illustrative analysis allowance, not an accepted product requirement.",
    "Scores and cutoffs are specific to the recorded reranker, weights, candidate pool and corpus. No runtime threshold is changed.",
    "The existing holdout has already been inspected in earlier diagnostics; this is regression validation, not a fresh blind test.",
    "Small negative sets cannot establish a low production error rate. Measure complete agent answers separately from retrieval coverage.",
    "False-discovery rate depends on the prevalence of answerable questions. Keep its denominator separate from false-sufficient rate."] };
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, selection: report.selection, evaluation: report.evaluation.map(({ split, baseline, candidate }) => ({
  split, baseline: { fp: baseline.fp, fn: baseline.fn }, candidate: { fp: candidate.fp, fn: candidate.fn,
    inDomainFalseSufficientRate: candidate.inDomainFalseSufficientRate, falseDiscoveryRate: candidate.falseDiscoveryRate } })) }, null, 2));
