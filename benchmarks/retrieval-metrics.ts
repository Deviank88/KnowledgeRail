export interface RankedResult {
  path: string;
}

export interface GradedRelevant {
  path: string;
  grade?: number;
}

function relevantSet(relevant: readonly GradedRelevant[]): Set<string> {
  return new Set(relevant.map((item) => item.path));
}

export function precisionAtK(
  results: readonly RankedResult[],
  relevant: readonly GradedRelevant[],
  k: number
): number {
  if (k <= 0) return 0;
  const expected = relevantSet(relevant);
  const hits = results.slice(0, k).filter((result) => expected.has(result.path)).length;
  return hits / k;
}

export function recallAtK(
  results: readonly RankedResult[],
  relevant: readonly GradedRelevant[],
  k: number
): number {
  if (relevant.length === 0) return 1;
  const expected = relevantSet(relevant);
  const hits = new Set(results.slice(0, k).filter((result) => expected.has(result.path)).map((result) => result.path));
  return hits.size / expected.size;
}

export function reciprocalRank(
  results: readonly RankedResult[],
  relevant: readonly GradedRelevant[]
): number {
  const expected = relevantSet(relevant);
  const index = results.findIndex((result) => expected.has(result.path));
  return index === -1 ? 0 : 1 / (index + 1);
}

function dcg(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => {
    const gain = Math.pow(2, grade) - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);
}

export function ndcgAtK(
  results: readonly RankedResult[],
  relevant: readonly GradedRelevant[],
  k: number
): number {
  if (k <= 0 || relevant.length === 0) return 0;
  const grades = new Map(relevant.map((item) => [item.path, item.grade ?? 1]));
  const actual = results.slice(0, k).map((result) => grades.get(result.path) ?? 0);
  const ideal = relevant
    .map((item) => item.grade ?? 1)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
