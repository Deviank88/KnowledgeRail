import type { SeededGraphQueryResult } from "./graph-runtime.js";
import type { RetrievalHit } from "./retrieval-index.js";
import type { SemanticCoverageQuery, SemanticCoverageScore } from "./semantic/types.js";
import { tokenizeSearchText } from "./text-analysis.js";
import { wikiPassageId } from "../context/passage-id.js";

export type RetrievalCoverageMode = "semantic" | "lexical";

export interface RetrievalCoverage {
  coverageMode: RetrievalCoverageMode;
  warnings: string[];
  queryFacetCoverage: number;
  sourceDiversity: number;
  unresolvedEntities: string[];
  unresolvedRelations: string[];
  truncatedFrontierCount: number;
  contradictions: number;
  evidenceGaps: string[];
  /** Gaps in the displayed subset that the full retrieved candidate set can cover. */
  budgetLimitedGaps: string[];
  /** Whether the evidence actually returned to the caller covers the request. */
  displaySufficient: boolean;
  /** Whether the complete fused candidate pool covers the request. */
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

const COMPONENT_TYPES = new Set(["implementation", "api", "integration", "automation", "data_model"]);
const SEMANTIC_FACET_THRESHOLD = 0.72;
const SEMANTIC_ENTITY_THRESHOLD = 0.8;
const SEMANTIC_ARTIFACT_THRESHOLD = 0.72;
const LEADING_PROSE_VERBS = new Set([
  "allow", "allows", "carica", "caricano", "contain", "contains", "contiene", "contengono", "create", "creates",
  "crea", "creano", "delete", "deletes", "elimina", "eliminano", "gestisce", "gestiscono", "handle",
  "handles", "include", "includes", "legge", "leggono", "load", "loads", "permette", "permettono",
  "provide", "provides", "read", "reads", "receive", "receives", "restituisce", "restituiscono", "require",
  "requires", "return", "returns", "riceve", "ricevono", "run", "runs", "scrive", "scrivono", "send",
  "sends", "store", "stores", "support", "supports", "usa", "usano", "use", "uses", "update", "updates",
  "write", "writes",
]);
const NAMED_DOMAIN_STOP_WORDS = new Set(["system", "sistema"]);

interface CoverageConcept {
  id: string;
  kind: "facet" | "entity" | "type";
  value: string;
  text: string;
}

interface CoverageSnapshot {
  queryFacetCoverage: number;
  sourceDiversity: number;
  unresolvedEntities: string[];
  unresolvedRelations: string[];
  contradictions: number;
  evidenceGaps: string[];
}

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
  // Delimiters cannot overlap with the adjacent identifier components, so
  // matching remains linear even for adversarial delimiter-heavy input.
  const technicalPattern = /\/?[A-Za-z][A-Za-z0-9]*(?:[-_./:#]+[A-Za-z0-9]+)+|\b[A-Z]{2,}[A-Z0-9]*\b|\b\d{2,}\b/g;
  const technical = [...query.matchAll(technicalPattern)].flatMap((match) => {
    const candidate = match[0];
    const prefix = query.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (/\b(?:client|cliente|project|progetto|system|sistema)\s+$/i.test(prefix)) return [];
    return [candidate];
  });
  const standalone = [...query.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)].flatMap((match) => {
    const candidate = match[0];
    const index = match.index ?? 0;
    const prefix = query.slice(Math.max(0, index - 24), index);
    if (/\b(?:client|cliente|project|progetto|system|sistema)\s+$/i.test(prefix)) return [];
    // Avoid treating ordinary sentence-initial prose ("Checkout loads …") as
    // an entity while retaining leading proper nouns in noun-phrase queries.
    const followingWord = query.slice(index + candidate.length).trimStart().match(/^[A-Za-z]+/)?.[0]?.toLowerCase();
    if (index === 0 && followingWord && LEADING_PROSE_VERBS.has(followingWord)) return [];
    return [candidate];
  });
  const introduced = [...query.matchAll(/\b(?:il|lo|la|i|gli|le|un|una|the|a|an)\s+([A-Z][a-zA-Z]{2,})\b/g)]
    .map((match) => match[1]!)
    .filter(Boolean);
  return uniqueStable([...subjects, ...technical, ...standalone, ...introduced].filter((candidate) => {
    const normalized = candidate.toLowerCase();
    // Generic domain nouns become named concepts only when deliberately
    // capitalized; ordinary lowercase prose remains excluded in both languages.
    const namedDomainConcept = candidate[0] === candidate[0]?.toUpperCase() &&
      NAMED_DOMAIN_STOP_WORDS.has(normalized);
    if (QUERY_STOP_WORDS.has(normalized) && !namedDomainConcept) return false;
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
  const entityTerms = new Set(extractQueryEntities(query).flatMap((entity) => tokenizeSearchText(entity)));
  return tokenizeSearchText(query).filter((term) =>
    term.length >= 2 && !QUERY_STOP_WORDS.has(term) && !entityTerms.has(term)
  );
}

function compactIdentifier(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function identifierAliases(hits: readonly RetrievalHit[]): Set<string> {
  const aliases = new Set<string>();
  for (const hit of hits) {
    const rawTokens = searchableHitText(hit).normalize("NFKC").toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
    for (let index = 0; index < rawTokens.length; index++) {
      let value = "";
      for (let width = 0; width < 3 && index + width < rawTokens.length; width++) {
        value += rawTokens[index + width]!;
        if (value.length >= 2) aliases.add(value);
      }
    }
  }
  return aliases;
}

function stemSearchTerm(value: string): string {
  if (/[_./:#-]|\d/u.test(value) || value.length < 4) return value;
  const englishSuffixes = ["izations", "isation", "ization", "ments", "ment", "ingly", "edly", "ing", "ies", "ed", "es", "s"];
  for (const suffix of englishSuffixes) {
    if (value.endsWith(suffix) && value.length - suffix.length >= 3) {
      if (suffix === "ies") return `${value.slice(0, -suffix.length)}y`;
      return value.slice(0, -suffix.length);
    }
  }
  const italianSuffixes = [
    "azioni", "azione", "amenti", "amento", "mente", "ando", "endo",
    "ato", "ata", "ati", "ate", "are", "ere", "ire",
  ];
  for (const suffix of italianSuffixes) {
    if (value.endsWith(suffix) && value.length - suffix.length >= 3) return value.slice(0, -suffix.length);
  }
  return value;
}

function lexicalCoverage(text: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const tokens = new Set(tokenizeSearchText(text).flatMap((term) => [term, stemSearchTerm(term)]));
  const matched = queryTerms.filter((term) =>
    tokens.has(term) || tokens.has(stemSearchTerm(term))
  ).length;
  return matched / queryTerms.length;
}

function typeSemanticText(pageType: string): string {
  if (pageType === "requirement") return "requirement requirements specification requested behavior";
  if (pageType === "test_result") return "test tests verification regression result";
  if (pageType === "implementation") return "implementation component service code integration";
  return pageType.replace(/[_-]+/g, " ");
}

function entitySemanticText(entity: string): string {
  return entity
    .normalize("NFKC")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_./:#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coverageConcepts(
  query: string,
  requirements: Required<RetrievalCoverageRequirements>
): CoverageConcept[] {
  return [
    ...relevantQueryTerms(query).map((term, index) => ({
      id: `facet:${index}`,
      kind: "facet" as const,
      value: term,
      text: term,
    })),
    ...extractQueryEntities(query).map((entity, index) => ({
      id: `entity:${index}`,
      kind: "entity" as const,
      value: entity,
      text: entitySemanticText(entity),
    })),
    ...requirements.requiredPageTypes.map((pageType, index) => ({
      id: `type:${index}`,
      kind: "type" as const,
      value: pageType,
      text: typeSemanticText(pageType),
    })),
  ];
}

export function semanticCoverageQueries(
  query: string,
  explicit: RetrievalCoverageRequirements = {}
): SemanticCoverageQuery[] {
  const requirements = inferCoverageRequirements(query, explicit);
  return coverageConcepts(query, requirements).map(({ id, text }) => ({ id, text }));
}

interface ConceptSemanticScores {
  pages: Map<string, number>;
  passages: Map<string, number>;
}

function semanticPassageKey(pagePath: string, passageId: string): string {
  return `${pagePath}\0${passageId}`;
}

function semanticScoresByConcept(scores: readonly SemanticCoverageScore[]): Map<string, ConceptSemanticScores> {
  return new Map(scores.map((score) => [score.id, {
    pages: new Map(score.pages.map((page) => [page.pagePath, page.score] as const)),
    passages: new Map(score.pages.flatMap((page) => (page.passages ?? []).map((passage) => [
      semanticPassageKey(page.pagePath, passage.passageId),
      passage.score,
    ] as const))),
  }] as const));
}

function semanticConceptCovered(
  id: string,
  paths: ReadonlySet<string>,
  scores: ReadonlyMap<string, ConceptSemanticScores>,
  threshold: number
): boolean {
  const conceptScores = scores.get(id);
  if (!conceptScores) return false;
  for (const pagePath of paths) {
    if ((conceptScores.pages.get(pagePath) ?? -1) >= threshold) return true;
  }
  return false;
}

function hitPassageId(hit: RetrievalHit): string | undefined {
  const excerpt = hit.excerpt.replace(/\s+/g, " ").trim();
  if (!excerpt) return undefined;
  const sameHeading = hit.record.passages.filter((passage) => passage.heading === hit.heading);
  const uniqueMatch = (passages: typeof hit.record.passages) => {
    const normalized = passages.map((passage) => ({
      passage,
      text: passage.text.replace(/\s+/g, " ").trim(),
    }));
    const exact = normalized.filter((candidate) => candidate.text === excerpt);
    if (exact.length === 1) return exact[0]!.passage;
    const prefixed = normalized.filter((candidate) => candidate.text.startsWith(excerpt));
    return prefixed.length === 1 ? prefixed[0]!.passage : undefined;
  };
  const passage = uniqueMatch(sameHeading) ?? uniqueMatch(hit.record.passages);
  return passage === undefined ? undefined : wikiPassageId(passage);
}

function semanticPassageConceptCovered(
  id: string,
  hits: readonly RetrievalHit[],
  scores: ReadonlyMap<string, ConceptSemanticScores>,
  threshold: number
): boolean {
  const conceptScores = scores.get(id);
  if (!conceptScores) return false;
  return hits.some((hit) => {
    const passageId = hitPassageId(hit);
    return passageId !== undefined &&
      (conceptScores.passages.get(semanticPassageKey(hit.path, passageId)) ?? -1) >= threshold;
  });
}

function hitSatisfiesRequiredType(hit: RetrievalHit, requiredType: string): boolean {
  if (hit.type === requiredType) return true;
  if (requiredType === "requirement") {
    return ["request", "candidate_request"].includes(hit.type);
  }
  if (requiredType === "implementation") return COMPONENT_TYPES.has(hit.type);
  if (requiredType === "test_result") {
    return hit.type === "analysis" &&
      /\b(test|tests|verification|regression|verifica|collaudo)\b/i.test(hit.tags.join(" "));
  }
  return false;
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
  /** Full fused candidate set, independent of the display budget. */
  hits: readonly RetrievalHit[];
  /** Budget-limited subset returned to the caller. Defaults to the full set. */
  displayHits?: readonly RetrievalHit[];
  graphResult: SeededGraphQueryResult;
  requirements?: RetrievalCoverageRequirements;
  coverageMode?: RetrievalCoverageMode;
  semanticScores?: readonly SemanticCoverageScore[];
  warnings?: readonly string[];
}): RetrievalCoverage {
  const requirements = inferCoverageRequirements(params.query, params.requirements);
  const queryTerms = relevantQueryTerms(params.query);
  const mode = params.coverageMode ?? "lexical";
  const concepts = coverageConcepts(params.query, requirements);
  const semanticScores = semanticScoresByConcept(params.semanticScores ?? []);

  const snapshot = (hits: readonly RetrievalHit[]): CoverageSnapshot => {
    const paths = new Set(hits.map((hit) => hit.path));
    const candidateText = hits.map(searchableHitText).join(" ");
    const passageText = hits.map((hit) => `${hit.heading} ${hit.excerpt}`).join(" ");
    const facetConcepts = concepts.filter((concept) => concept.kind === "facet");
    const semanticFacetCoverage = (text: string, scope: "page" | "passage"): number => {
      if (facetConcepts.length === 0) return 1;
      const lexicalTerms = new Set(tokenizeSearchText(text).flatMap((term) => [term, stemSearchTerm(term)]));
      const matched = facetConcepts.filter((concept) =>
        (scope === "page"
          ? semanticConceptCovered(concept.id, paths, semanticScores, SEMANTIC_FACET_THRESHOLD)
          : semanticPassageConceptCovered(concept.id, hits, semanticScores, SEMANTIC_FACET_THRESHOLD)) ||
        lexicalTerms.has(concept.value) || lexicalTerms.has(stemSearchTerm(concept.value))
      ).length;
      return matched / facetConcepts.length;
    };
    const facetCoverage = queryTerms.length === 0
      ? 1
      : mode === "semantic"
        ? semanticFacetCoverage(candidateText, "page")
        : lexicalCoverage(candidateText, queryTerms);
    // Broad task queries intentionally span multiple evidence passages. The
    // aggregate is bounded by selected pages rather than by one passage.
    const passageCoverage = hits.length === 0
      ? 0
      : queryTerms.length === 0
        ? 1
      : mode === "semantic"
        ? semanticFacetCoverage(passageText, "passage")
        : lexicalCoverage(passageText, queryTerms);
    const aliases = identifierAliases(hits);
    const entityConcepts = concepts.filter((concept) => concept.kind === "entity");
    const missingEntities = entityConcepts.filter((concept) => {
      const lexicalMatch = aliases.has(compactIdentifier(concept.value));
      return !lexicalMatch && !(
        mode === "semantic" &&
        semanticConceptCovered(concept.id, paths, semanticScores, SEMANTIC_ENTITY_THRESHOLD)
      );
    }).map((concept) => concept.value);
    const typeConcepts = concepts.filter((concept) => concept.kind === "type");
    const missingTypes = typeConcepts.filter((concept) => {
      const classifiedMatch = hits.some((hit) => hitSatisfiesRequiredType(hit, concept.value));
      return !classifiedMatch && !(
        mode === "semantic" &&
        semanticConceptCovered(concept.id, paths, semanticScores, SEMANTIC_ARTIFACT_THRESHOLD)
      );
    }).map((concept) => concept.value);
    const contradictions = contradictionCount(hits);
    const unresolvedRelations = [
      ...missingTypes.map((pageType) => `required_type:${pageType}`),
      ...(requirements.requireContradictionCheck && contradictions === 0
        ? ["contradiction_evidence"]
        : []),
    ];
    const sources = new Set(hits.flatMap((hit) => hit.sources));
    const evidenceGaps: string[] = [];
    if (facetCoverage < requirements.minimumQueryFacetCoverage) evidenceGaps.push("query_facets");
    if (passageCoverage < requirements.minimumPassageCoverage) evidenceGaps.push("passage_evidence");
    if (sources.size < requirements.minimumSourceDiversity) evidenceGaps.push("source_diversity");
    evidenceGaps.push(...missingEntities.map((entity) => `entity:${entity}`));
    evidenceGaps.push(...unresolvedRelations);
    return {
      queryFacetCoverage: facetCoverage,
      sourceDiversity: sources.size,
      unresolvedEntities: missingEntities,
      unresolvedRelations,
      contradictions,
      evidenceGaps: uniqueStable(evidenceGaps),
    };
  };

  const full = snapshot(params.hits);
  const displayed = params.displayHits === undefined || params.displayHits === params.hits
    ? full
    : snapshot(params.displayHits);
  const fullGaps = [...full.evidenceGaps];
  const displayedGaps = [...displayed.evidenceGaps];
  if (params.graphResult.stats.truncatedFrontierCount > 0) {
    fullGaps.push("truncated_frontier");
    displayedGaps.push("truncated_frontier");
  }
  const stableGaps = uniqueStable(fullGaps);
  const missingSet = new Set(stableGaps);
  const budgetLimitedGaps = uniqueStable(displayedGaps.filter((gap) => !missingSet.has(gap)));
  return {
    coverageMode: mode,
    warnings: uniqueStable(params.warnings ?? []),
    queryFacetCoverage: full.queryFacetCoverage,
    sourceDiversity: full.sourceDiversity,
    unresolvedEntities: full.unresolvedEntities,
    unresolvedRelations: full.unresolvedRelations,
    truncatedFrontierCount: params.graphResult.stats.truncatedFrontierCount,
    contradictions: full.contradictions,
    evidenceGaps: stableGaps,
    budgetLimitedGaps,
    displaySufficient: stableGaps.length === 0 && budgetLimitedGaps.length === 0,
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
