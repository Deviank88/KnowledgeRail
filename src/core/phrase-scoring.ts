const TRAILING_PROSE_PUNCTUATION = /[.,;!?]+$/u;

export const PHRASE_BOOST_WEIGHT = 1.5;
// An unprotected candidate can score at most 1 + PHRASE_BOOST_WEIGHT.
// Keep protected identifiers strictly above that bound, not merely tied.
export const EXACT_IDENTIFIER_PROTECTION_BONUS = PHRASE_BOOST_WEIGHT + 1.01;

export function scoreBigramRerankCandidate(params: {
  baseScore: number;
  minimumBaseScore: number;
  maximumBaseScore: number;
  matchedBigrams: number;
  queryBigramCount: number;
  exactIdentifierMatch?: boolean;
}): number {
  const baseRange = Math.max(params.maximumBaseScore - params.minimumBaseScore, 1e-9);
  const normalizedBase = (params.baseScore - params.minimumBaseScore) / baseRange;
  const phraseCoverage = Math.max(0, params.matchedBigrams) / Math.max(1, params.queryBigramCount);
  return normalizedBase + PHRASE_BOOST_WEIGHT * phraseCoverage +
    (params.exactIdentifierMatch ? EXACT_IDENTIFIER_PROTECTION_BONUS : 0);
}

/**
 * Ordered phrase tokens deliberately do not expand compound identifiers. The
 * lexical tokenizer may index both `Retry-After` and its parts for recall, but
 * phrase matching must never invent adjacency between those expanded parts.
 */
export function surfacePhraseTokens(value: string): string[] {
  return (value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/\/?[\p{L}\p{N}][\p{L}\p{N}_./:#-]*/gu) ?? [])
    .map((token) => token.replace(TRAILING_PROSE_PUNCTUATION, ""))
    .filter(Boolean);
}

export function orderedWordBigrams(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index + 1 < tokens.length; index++) {
    result.push(`${tokens[index]!}\u0001${tokens[index + 1]!}`);
  }
  return result;
}

export interface OrderedPhraseScore {
  matchedBigrams: number;
  queryBigrams: number;
}

/**
 * A deterministic, positive-only ordered-word signal across independent text
 * segments. Query grams and matches are sets: a title/passage repetition must
 * not manufacture more phrase evidence than the query contains, and segment
 * boundaries must not invent adjacency.
 */
export function scoreOrderedPhraseSegments(
  queryBigrams: readonly string[],
  passageTexts: readonly string[]
): OrderedPhraseScore {
  if (queryBigrams.length === 0) return { matchedBigrams: 0, queryBigrams: 0 };
  const uniqueQueryBigrams = new Set(queryBigrams);
  const passageBigrams = new Set<string>();
  for (const passageText of passageTexts) {
    for (const bigram of orderedWordBigrams(surfacePhraseTokens(passageText))) {
      passageBigrams.add(bigram);
    }
  }
  let matchedBigrams = 0;
  for (const bigram of uniqueQueryBigrams) if (passageBigrams.has(bigram)) matchedBigrams++;
  return { matchedBigrams, queryBigrams: uniqueQueryBigrams.size };
}

/** A deterministic, positive-only ordered-word signal for one passage. */
export function scoreOrderedPhrase(
  queryBigrams: readonly string[],
  passageText: string
): OrderedPhraseScore {
  return scoreOrderedPhraseSegments(queryBigrams, [passageText]);
}
