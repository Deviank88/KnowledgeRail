export type RetrievalProfile = "precision" | "balanced" | "coverage";

export function normalizeSearchText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./:#-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenizes prose without destroying identifiers such as REQ-123 or Asset__c. */
export function tokenizeSearchText(input: string): string[] {
  const normalized = normalizeSearchText(input);
  if (!normalized) return [];
  const tokens = normalized.match(/\/?[\p{L}\p{N}][\p{L}\p{N}_./:#-]*/gu) ?? [];
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    for (const part of token.split(/[_./:#-]+/).filter((value) => value.length >= 2)) {
      if (part !== token) expanded.push(part);
    }
  }
  return [...new Set(expanded)];
}

export function queryCoverage(text: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const tokens = new Set(tokenizeSearchText(text));
  let matched = 0;
  for (const term of queryTerms) if (tokens.has(term)) matched++;
  return matched / queryTerms.length;
}
