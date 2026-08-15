import type { SeededGraphQueryResult } from "./graph-runtime.js";
import type { RetrievalHit } from "./retrieval-index.js";
import {
  normalizeSearchText,
  queryCoverage,
  tokenizeSearchText,
} from "./text-analysis.js";

export interface RetrievalCoverage {
  queryFacetCoverage: number;
  sourceDiversity: number;
  unresolvedEntities: string[];
  unresolvedRelations: string[];
  truncatedFrontierCount: number;
  contradictions: number;
  evidenceGaps: string[];
  sufficient: boolean;
}

export interface RetrievalBudget {
  maxSeedCandidates: number;
  maxVisitedNodes: number;
  maxDepth: number;
  maxEvidence: number;
  tokenBudget: number;
}

export interface RetrievalCoverageRequirements {
  requiredPageTypes?: readonly string[];
  minimumSourceDiversity?: number;
  requireContradictionCheck?: boolean;
  minimumQueryFacetCoverage?: number;
  minimumPassageCoverage?: number;
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
  "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "with",
  "al", "alla", "alle", "con", "da", "dal", "dalla", "de", "dei", "del", "della", "di", "e",
  "gli", "i", "il", "in", "la", "le", "lo", "nel", "nella", "o", "per", "su", "tra", "un", "una",
  "analyze", "debug", "describe", "explain", "find", "implement", "modify", "retrieve", "review", "show",
  "understand", "update", "verify", "please", "context", "project", "system",
  "analizza", "analizzare", "capire", "comprendere", "contesto", "descrivi", "descrivere", "evidenzia",
  "evidenziare", "evidenziando", "implementa", "implementare", "includere", "includendo", "modifica",
  "modificare", "mostra", "mostrare", "progetto", "recupera", "recuperare", "revisiona", "revisionare",
  "sistema", "spiega", "spiegare", "trova", "trovare", "verifica", "verificare",
]);

const REQUIRED_TYPE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["requirement", /\b(requirement|requirements|requisito|requisiti)\b/i],
  ["decision", /\b(decision|decisions|decisione|decisioni)\b/i],
  ["implementation", /\b(implementation|implementations|implementazione|implementazioni)\b/i],
  ["test_result", /\b(test|tests|verification|verifica|verifiche)\b/i],
  ["analysis", /\b(incident|incidents|incidente|incidenti)\b/i],
];

function uniqueStable(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function inferredRequiredTypes(query: string): string[] {
  return REQUIRED_TYPE_PATTERNS
    .filter(([, pattern]) => pattern.test(query))
    .map(([pageType]) => pageType);
}

export function extractQueryEntities(query: string): string[] {
  const subjectPattern = /\b(?:funzionamento|comportamento|architettura|contesto|functioning|behavior|behaviour|architecture|context)\s+(?:di|del|della|dei|degli|delle|su|sui|sulle|of|about|for)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_.#/-]*)/gi;
  const subjects = [...query.matchAll(subjectPattern)].map((match) => match[1]!).filter(Boolean);
  const lexicalPattern = /\/?[A-Za-z][A-Za-z0-9_.]*(?:[-_/:#][A-Za-z0-9_.]+)+|\b[A-Z]{2,}[A-Z0-9]*\b|\b[A-Z][a-zA-Z]{2,}\b|\b\d{2,}\b/g;
  const lexical = [...query.matchAll(lexicalPattern)].flatMap((match) => {
    const candidate = match[0];
    const prefix = query.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (/\b(?:client|cliente|project|progetto|system|sistema)\s+$/i.test(prefix)) return [];
    return [candidate];
  });
  return uniqueStable([...subjects, ...lexical].filter((candidate) => {
    const normalized = candidate.toLowerCase();
    if (QUERY_STOP_WORDS.has(normalized)) return false;
    // Ordinary prose such as "automazioni/componenti" is not an identifier.
    // Keep paths and compounds that carry an actual technical signal.
    if (
      /^[A-Za-z]+\/[A-Za-z]+$/.test(candidate) &&
      candidate === normalized
    ) return false;
    return true;
  }));
}

export function inferCoverageRequirements(
  query: string,
  explicit: RetrievalCoverageRequirements = {}
): Required<RetrievalCoverageRequirements> {
  const requiredPageTypes = uniqueStable([
    ...inferredRequiredTypes(query),
    ...(explicit.requiredPageTypes ?? []),
  ]);
  const asksForMultipleSources = /\b(sources|fonti|multiple sources|piu fonti|più fonti)\b/i.test(query);
  const asksForContradictions = /\b(contradict|contradiction|conflict|conflicting|contradd|conflitt)\w*/i.test(query);
  return {
    requiredPageTypes,
    minimumSourceDiversity: Math.max(
      0,
      explicit.minimumSourceDiversity ?? (asksForMultipleSources ? 2 : 0)
    ),
    requireContradictionCheck: explicit.requireContradictionCheck ?? asksForContradictions,
    minimumQueryFacetCoverage: Math.min(1, Math.max(0, explicit.minimumQueryFacetCoverage ?? 0.6)),
    minimumPassageCoverage: Math.min(1, Math.max(0, explicit.minimumPassageCoverage ?? 0.2)),
  };
}

function searchableHitText(hit: RetrievalHit): string {
  return [
    hit.path,
    hit.title,
    hit.type,
    hit.tags.join(" "),
    hit.sources.join(" "),
    hit.requestId ?? "",
    hit.heading,
    hit.excerpt,
    hit.record.body,
  ].join(" ");
}

function relevantQueryTerms(query: string): string[] {
  return tokenizeSearchText(query).filter((term) =>
    term.length >= 2 && !QUERY_STOP_WORDS.has(term)
  );
}

function unresolvedEntities(query: string, hits: readonly RetrievalHit[]): string[] {
  const haystack = normalizeSearchText(hits.map(searchableHitText).join(" "));
  return extractQueryEntities(query).filter((entity) =>
    !haystack.includes(normalizeSearchText(entity))
  );
}

function contradictionCount(hits: readonly RetrievalHit[]): number {
  const byRequest = new Map<string, RetrievalHit[]>();
  for (const hit of hits) {
    if (!hit.requestId) continue;
    const bucket = byRequest.get(hit.requestId) ?? [];
    bucket.push(hit);
    byRequest.set(hit.requestId, bucket);
  }

  let contradictions = 0;
  for (const related of byRequest.values()) {
    if (related.length < 2) continue;
    const numericClaims = new Set<string>();
    for (const hit of related) {
      for (const value of hit.record.body.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []) {
        numericClaims.add(value.replace(",", "."));
      }
    }
    const explicitlyConflicting = related.some((hit) =>
      /\b(contradict|conflict|conflicting|earlier decision|legacy window|contradd|conflitt)\w*/i.test(hit.record.body)
    );
    if (numericClaims.size >= 2 || explicitlyConflicting) contradictions++;
  }
  return contradictions;
}

export function assessRetrievalCoverage(params: {
  query: string;
  hits: readonly RetrievalHit[];
  graphResult: SeededGraphQueryResult;
  requirements?: RetrievalCoverageRequirements;
}): RetrievalCoverage {
  const requirements = inferCoverageRequirements(params.query, params.requirements);
  const queryTerms = relevantQueryTerms(params.query);
  const candidateText = params.hits.map(searchableHitText).join(" ");
  const facetCoverage = queryTerms.length === 0 ? 1 : queryCoverage(candidateText, queryTerms);
  // Broad task queries intentionally span multiple evidence passages. Measure
  // the selected passage set as a whole; requiring one passage to cover every
  // facet incorrectly marks a coherent multi-document answer as missing.
  const passageCoverage = params.hits.length === 0
    ? 0
    : queryCoverage(
      params.hits.map((hit) => `${hit.heading} ${hit.excerpt}`).join(" "),
      queryTerms
    );
  const sources = new Set(params.hits.flatMap((hit) => hit.sources));
  const presentTypes = new Set(params.hits.map((hit) => hit.type));
  const missingTypes = requirements.requiredPageTypes.filter((pageType) => !presentTypes.has(pageType));
  const missingEntities = unresolvedEntities(params.query, params.hits);
  const contradictions = contradictionCount(params.hits);
  const unresolvedRelations = [
    ...missingTypes.map((pageType) => `required_type:${pageType}`),
    ...(requirements.requireContradictionCheck && contradictions === 0
      ? ["contradiction_evidence"]
      : []),
  ];
  const evidenceGaps: string[] = [];
  if (facetCoverage < requirements.minimumQueryFacetCoverage) evidenceGaps.push("query_facets");
  if (passageCoverage < requirements.minimumPassageCoverage) evidenceGaps.push("passage_evidence");
  if (sources.size < requirements.minimumSourceDiversity) evidenceGaps.push("source_diversity");
  if (params.graphResult.stats.truncatedFrontierCount > 0) evidenceGaps.push("truncated_frontier");
  evidenceGaps.push(...missingEntities.map((entity) => `entity:${entity}`));
  evidenceGaps.push(...unresolvedRelations);

  const stableGaps = uniqueStable(evidenceGaps);
  return {
    queryFacetCoverage: facetCoverage,
    sourceDiversity: sources.size,
    unresolvedEntities: missingEntities,
    unresolvedRelations,
    truncatedFrontierCount: params.graphResult.stats.truncatedFrontierCount,
    contradictions,
    evidenceGaps: stableGaps,
    sufficient: stableGaps.length === 0,
  };
}

export function estimateRetrievalContextTokens(hits: readonly RetrievalHit[]): number {
  const bytes = Buffer.byteLength(hits.map((hit) => [
    hit.title,
    hit.type,
    hit.heading,
    hit.excerpt,
    hit.sources.join(" "),
  ].join(" ")).join("\n"), "utf8");
  return Math.ceil(bytes / 3);
}
