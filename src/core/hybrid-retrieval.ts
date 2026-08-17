import { readWikiPageRecord } from "./page-record.js";
import {
  assessRetrievalCoverage,
  estimateRetrievalContextTokens,
  extractQueryEntities,
  semanticCoverageQueries,
  type RetrievalBudget,
  type RetrievalCoverage,
  type RetrievalCoverageRequirements,
} from "./retrieval-coverage.js";
import { logger } from "./logger.js";
import {
  getWikiPageRecords,
  searchRetrievalIndex,
  type RetrievalHit,
} from "./retrieval-index.js";
import {
  expandRuntimeGraphFromSeeds,
  getRuntimeWikiGraph,
  type SeededGraphQueryResult,
} from "./graph-runtime.js";
import type { RetrievalProfile } from "./text-analysis.js";
import { wikiPageUri } from "../context/resource-uri.js";
import { configuredSemanticIndex } from "./semantic/index.js";
import type {
  AnnSearchDiagnostics,
  SemanticIndex,
  SemanticIndexDescriptor,
  SemanticCoverageScore,
  SynchronizableSemanticIndex,
} from "./semantic/types.js";

export type RetrievalWideningLevel = 0 | 1 | 2 | 3;

export type {
  RetrievalBudget,
  RetrievalCoverage,
  RetrievalCoverageRequirements,
} from "./retrieval-coverage.js";

export interface HybridRetrievalChannels {
  lexicalRank?: number;
  semanticRank?: number;
  graphRank?: number;
  lexicalScore?: number;
  lexicalConfidence?: number;
  semanticScore?: number;
}

export interface HybridRetrievalHit extends RetrievalHit {
  channels: HybridRetrievalChannels;
}

export interface HybridRetrievalAttempt {
  level: RetrievalWideningLevel;
  budget: RetrievalBudget;
  coverage: RetrievalCoverage;
  hitCount: number;
  coverageCandidateCount: number;
  estimatedContextTokens: number;
  lexicalPoolSize: number;
  semanticCandidateCount: number;
  visitedNodes: number;
  visitedEdges: number;
  fallbackUsed: boolean;
}

export interface HybridRetrievalResult {
  hits: HybridRetrievalHit[];
  /** Full fused set used for coverage; never serialized as display evidence. */
  coverageHits: HybridRetrievalHit[];
  lexicalHits: RetrievalHit[];
  semanticHits: RetrievalHit[];
  semantic: HybridSemanticDiagnostics;
  graphResult: SeededGraphQueryResult;
  coverage: RetrievalCoverage;
  wideningLevel: RetrievalWideningLevel;
  attempts: HybridRetrievalAttempt[];
  initialBudget: RetrievalBudget;
  finalBudget: RetrievalBudget;
  estimatedContextTokens: number;
}

export interface HybridSemanticDiagnostics {
  enabled: boolean;
  available: boolean;
  candidateCount: number;
  visitedBuckets: number;
  vectorCount: number;
  descriptor?: SemanticIndexDescriptor;
  error?: string;
}

export interface HybridRetrievalFallbackRequest {
  wikiRoot: string;
  query: string;
  coverage: RetrievalCoverage;
  budget: RetrievalBudget;
}

export type HybridRetrievalFallbackProvider = (
  request: HybridRetrievalFallbackRequest
) => Promise<readonly RetrievalHit[]>;

export interface HybridRetrievalParams {
  wikiRoot: string;
  query: string;
  maxResults?: number;
  pageTypes?: readonly string[];
  profile?: RetrievalProfile;
  lexicalPoolSize?: number;
  seedCount?: number;
  graphMaxNodes?: number;
  graphMaxDepth?: number;
  graphBeamWidth?: number;
  graphMaxVisitedNodes?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
  graphWeight?: number;
  rrfK?: number;
  progressiveWidening?: boolean;
  maxWideningLevel?: RetrievalWideningLevel;
  initialBudget?: Partial<RetrievalBudget>;
  maximumBudget?: Partial<RetrievalBudget>;
  coverageRequirements?: RetrievalCoverageRequirements;
  fallbackProvider?: HybridRetrievalFallbackProvider;
  /** Enables the configured embedding provider. An injected index also enables this channel. */
  semanticEnabled?: boolean;
  /** Replaceable semantic backend, primarily for local providers and deterministic evaluation. */
  semanticIndex?: SemanticIndex;
  semanticPoolSize?: number;
  /** Persist disposable retrieval/graph/semantic indexes. Read-only consumers disable this. */
  persistDerivedIndexes?: boolean;
}

interface AttemptResult {
  hits: HybridRetrievalHit[];
  coverageHits: HybridRetrievalHit[];
  lexicalHits: RetrievalHit[];
  semanticHits: RetrievalHit[];
  semantic: HybridSemanticDiagnostics;
  graphResult: SeededGraphQueryResult;
  estimatedContextTokens: number;
  lexicalPoolSize: number;
  semanticCandidateCount: number;
  fallbackUsed: boolean;
  semanticIndex?: SemanticIndex;
}

interface ResolvedSemantic {
  hits: RetrievalHit[];
  diagnostics: HybridSemanticDiagnostics;
  index?: SemanticIndex;
}

let missingEmbeddingNoticeEmitted = false;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? value! : fallback;
}

function reciprocalRank(rank: number | undefined, weight: number, k: number): number {
  return rank === undefined ? 0 : weight / (k + rank);
}

function hasExactIdentifierSignal(query: string): boolean {
  return /(?:[\p{L}][\p{L}\p{N}]*[-_:/][\p{L}\p{N}._:/-]*\d|\d{2,})/u.test(query);
}

function fallbackExcerpt(record: NonNullable<Awaited<ReturnType<typeof readWikiPageRecord>>>): {
  heading: string;
  excerpt: string;
} {
  const passage = record.passages[0];
  return {
    heading: passage?.heading ?? "",
    excerpt: passage?.text.replace(/\s+/g, " ").trim().slice(0, 420) ?? "",
  };
}

function safeSemanticError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Semantic retrieval failed.";
  return message.normalize("NFKC").replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

function safeSemanticPagePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  try {
    wikiPageUri(normalized);
    return normalized;
  } catch {
    return null;
  }
}

async function resolveSemantic(
  request: HybridRetrievalParams,
  maxResults: number
): Promise<ResolvedSemantic> {
  const enabled = request.semanticEnabled === true || request.semanticIndex !== undefined;
  const unavailable: HybridSemanticDiagnostics = {
    enabled,
    available: false,
    candidateCount: 0,
    visitedBuckets: 0,
    vectorCount: 0,
  };
  if (!enabled) return { hits: [], diagnostics: unavailable };
  try {
    const index = request.semanticIndex ?? await configuredSemanticIndex(request.wikiRoot, {
      persist: request.persistDerivedIndexes,
    });
    if (!index) {
      if (!missingEmbeddingNoticeEmitted) {
        missingEmbeddingNoticeEmitted = true;
        logger.info("semantic-coverage", "lexical_mode_active", {
          localOption: "Ollama",
          configuration: "KNOWLEDGE_RAIL_EMBEDDING_*",
        });
      }
      return { hits: [], diagnostics: unavailable };
    }
    const poolSize = Math.min(1_000, Math.max(
      maxResults,
      positiveInteger(request.semanticPoolSize, Math.max(maxResults * 4, 20))
    ));
    let diagnostics: AnnSearchDiagnostics = {
      candidateCount: 0,
      visitedBuckets: 0,
      vectorCount: index.descriptor.passageCount,
    };
    let semanticHits;
    const synchronizable = index as Partial<SynchronizableSemanticIndex>;
    if (typeof synchronizable.searchWithDiagnostics === "function") {
      const result = await synchronizable.searchWithDiagnostics(request.query, poolSize);
      semanticHits = result.hits;
      diagnostics = result.diagnostics;
    } else {
      semanticHits = await index.search(request.query, poolSize);
      diagnostics = {
        ...diagnostics,
        candidateCount: semanticHits.length,
      };
    }
    const typeFilter = request.pageTypes ? new Set(request.pageTypes) : null;
    const recordsByPath = new Map(
      (await getWikiPageRecords(request.wikiRoot, false, {
        persist: request.persistDerivedIndexes,
      })).map((record) => [record.path, record] as const)
    );
    const byPath = new Map<string, RetrievalHit>();
    const orderedSemanticHits = [...semanticHits]
      .filter((hit) => Number.isFinite(hit.score))
      .sort((left, right) =>
        right.score - left.score || left.pagePath.localeCompare(right.pagePath) ||
        left.passageId.localeCompare(right.passageId)
      )
      .slice(0, poolSize);
    for (const hit of orderedSemanticHits) {
      const pagePath = safeSemanticPagePath(hit.pagePath);
      if (!pagePath || byPath.has(pagePath)) continue;
      const record = recordsByPath.get(pagePath);
      if (!record || (typeFilter && !typeFilter.has(record.type))) continue;
      byPath.set(pagePath, {
        path: record.path,
        title: record.title,
        type: record.type,
        tags: record.tags,
        sources: record.sources,
        requestId: record.requestId,
        score: hit.score,
        excerpt: hit.text.replace(/\s+/g, " ").trim().slice(0, 420),
        heading: hit.heading.normalize("NFKC").replace(/[\r\n\t]+/g, " ").slice(0, 256),
        record,
      });
    }
    return {
      hits: [...byPath.values()],
      index,
      diagnostics: {
        enabled: true,
        available: true,
        ...diagnostics,
        descriptor: { ...index.descriptor },
      },
    };
  } catch (error: unknown) {
    return {
      hits: [],
      diagnostics: { ...unavailable, error: safeSemanticError(error) },
    };
  }
}

function resolveInitialBudget(params: HybridRetrievalParams, maxResults: number): RetrievalBudget {
  const defaults: RetrievalBudget = {
    maxSeedCandidates: positiveInteger(
      params.seedCount,
      Math.min(8, Math.max(maxResults, 4))
    ),
    maxVisitedNodes: positiveInteger(
      params.graphMaxVisitedNodes,
      Math.max(maxResults * 6, 48)
    ),
    maxDepth: nonNegativeInteger(params.graphMaxDepth, 1),
    maxEvidence: maxResults,
    tokenBudget: Math.max(2_000, maxResults * 200),
  };
  return {
    maxSeedCandidates: positiveInteger(
      params.initialBudget?.maxSeedCandidates,
      defaults.maxSeedCandidates
    ),
    maxVisitedNodes: positiveInteger(
      params.initialBudget?.maxVisitedNodes,
      defaults.maxVisitedNodes
    ),
    maxDepth: nonNegativeInteger(params.initialBudget?.maxDepth, defaults.maxDepth),
    maxEvidence: Math.min(
      maxResults,
      positiveInteger(params.initialBudget?.maxEvidence, defaults.maxEvidence)
    ),
    tokenBudget: positiveInteger(params.initialBudget?.tokenBudget, defaults.tokenBudget),
  };
}

function resolveMaximumBudget(
  params: HybridRetrievalParams,
  initial: RetrievalBudget,
  maxResults: number
): RetrievalBudget {
  return {
    maxSeedCandidates: Math.max(
      initial.maxSeedCandidates,
      positiveInteger(
        params.maximumBudget?.maxSeedCandidates,
        Math.min(32, initial.maxSeedCandidates * 4)
      )
    ),
    maxVisitedNodes: Math.max(
      initial.maxVisitedNodes,
      positiveInteger(
        params.maximumBudget?.maxVisitedNodes,
        initial.maxVisitedNodes * 4
      )
    ),
    maxDepth: Math.max(
      initial.maxDepth,
      nonNegativeInteger(
        params.maximumBudget?.maxDepth,
        Math.max(initial.maxDepth, Math.min(3, initial.maxDepth + 3))
      )
    ),
    maxEvidence: Math.min(
      maxResults,
      Math.max(
        initial.maxEvidence,
        positiveInteger(params.maximumBudget?.maxEvidence, maxResults)
      )
    ),
    tokenBudget: Math.max(
      initial.tokenBudget,
      positiveInteger(
        params.maximumBudget?.tokenBudget,
        Math.max(initial.tokenBudget * 2, maxResults * 256)
      )
    ),
  };
}

function budgetForLevel(
  initial: RetrievalBudget,
  maximum: RetrievalBudget,
  level: RetrievalWideningLevel
): RetrievalBudget {
  if (level === 0) return { ...initial };
  if (level >= 2) return { ...maximum };
  return {
    maxSeedCandidates: Math.min(
      maximum.maxSeedCandidates,
      Math.max(initial.maxSeedCandidates + 1, initial.maxSeedCandidates * 2)
    ),
    maxVisitedNodes: Math.min(
      maximum.maxVisitedNodes,
      Math.max(initial.maxVisitedNodes + 1, initial.maxVisitedNodes * 2)
    ),
    maxDepth: Math.min(maximum.maxDepth, initial.maxDepth + 1),
    maxEvidence: Math.min(
      maximum.maxEvidence,
      Math.max(initial.maxEvidence + 1, Math.ceil(initial.maxEvidence * 1.5))
    ),
    tokenBudget: Math.min(
      maximum.tokenBudget,
      Math.max(initial.tokenBudget + 1, Math.ceil(initial.tokenBudget * 1.5))
    ),
  };
}

function mergeRetrievalHits(
  groups: readonly (readonly RetrievalHit[])[],
  maxResults: number
): RetrievalHit[] {
  const byPath = new Map<string, { hit: RetrievalHit; fusedScore: number; bestNormalizedScore: number }>();
  for (const group of groups) {
    const maximumScore = Math.max(group[0]?.score ?? 0, 1e-9);
    for (let index = 0; index < group.length; index++) {
      const hit = group[index]!;
      const normalizedScore = Math.max(0, hit.score) / maximumScore;
      const contribution = normalizedScore + reciprocalRank(index + 1, 1, 60);
      const current = byPath.get(hit.path);
      if (!current) {
        byPath.set(hit.path, {
          hit,
          fusedScore: contribution,
          bestNormalizedScore: normalizedScore,
        });
        continue;
      }
      current.fusedScore += contribution;
      if (normalizedScore > current.bestNormalizedScore) {
        current.hit = hit;
        current.bestNormalizedScore = normalizedScore;
      }
    }
  }
  return [...byPath.values()]
    .map(({ hit, fusedScore }) => ({ ...hit, score: fusedScore }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxResults);
}

function limitHitsByBudget(
  hits: readonly HybridRetrievalHit[],
  maxResults: number,
  budget: RetrievalBudget
): HybridRetrievalHit[] {
  const selected: HybridRetrievalHit[] = [];
  const evidenceLimit = Math.min(maxResults, budget.maxEvidence);
  for (const hit of hits) {
    if (selected.length >= evidenceLimit) break;
    const candidate = [...selected, hit];
    if (selected.length > 0 && estimateRetrievalContextTokens(candidate) > budget.tokenBudget) break;
    selected.push(hit);
  }
  return selected;
}

async function retrieveAttempt(params: {
  request: HybridRetrievalParams;
  level: RetrievalWideningLevel;
  budget: RetrievalBudget;
  maxResults: number;
  fallbackHits: readonly RetrievalHit[];
  resolveSemantic: () => Promise<ResolvedSemantic>;
}): Promise<AttemptResult> {
  const { request, level, budget, maxResults } = params;
  const baseLexicalPool = Math.max(
    maxResults,
    request.lexicalPoolSize ?? Math.max(maxResults * 4, 20)
  );
  const lexicalMultiplier = level === 0 ? 1 : level === 1 ? 2 : 4;
  const lexicalPoolSize = baseLexicalPool * lexicalMultiplier;
  const entityQueries = level >= 2
    ? extractQueryEntities(request.query).slice(0, 4)
    : [];
  const queryVariants = [...new Set([request.query, ...entityQueries])];
  const lexicalGroups = await Promise.all(queryVariants.map((query) => searchRetrievalIndex({
    wikiRoot: request.wikiRoot,
    query,
    maxResults: lexicalPoolSize,
    pageTypes: request.pageTypes,
    profile: level >= 2 ? "coverage" : request.profile ?? "balanced",
    persist: request.persistDerivedIndexes,
  })));
  const lexicalHits = mergeRetrievalHits(
    [...lexicalGroups, params.fallbackHits],
    lexicalPoolSize
  );
  // The lexical search refreshes canonical page records first; the semantic
  // index can now synchronize its disposable derived state to that generation.
  const semantic = await params.resolveSemantic();
  const semanticHits = semantic.hits;

  const runtime = await getRuntimeWikiGraph(request.wikiRoot, false, {
    persist: request.persistDerivedIndexes,
  });
  const lexicalSeedRanks = new Map(
    lexicalHits.map((hit, index) => [hit.path, { hit, rank: index + 1 }] as const)
  );
  const semanticSeedRanks = new Map(
    semanticHits.map((hit, index) => [hit.path, { hit, rank: index + 1 }] as const)
  );
  const rrfK = Math.max(1, request.rrfK ?? 60);
  const lexicalWeight = Math.max(0, request.lexicalWeight ?? 1);
  const semanticWeight = Math.max(0, request.semanticWeight ?? 0.7);
  const seedHits = semanticHits.length === 0
    ? lexicalHits.slice(0, budget.maxSeedCandidates).map((hit) => ({
      pagePath: hit.path,
      score: Math.max(0, hit.score),
    }))
    : [...new Set([...lexicalSeedRanks.keys(), ...semanticSeedRanks.keys()])]
      .map((pagePath) => ({
        pagePath,
        score:
          reciprocalRank(lexicalSeedRanks.get(pagePath)?.rank, lexicalWeight, rrfK) +
          reciprocalRank(semanticSeedRanks.get(pagePath)?.rank, semanticWeight, rrfK),
      }))
      .sort((left, right) => right.score - left.score || left.pagePath.localeCompare(right.pagePath))
      .slice(0, budget.maxSeedCandidates);
  const seedNodeIds: string[] = [];
  const seedScores = new Map<string, number>();
  const maxLexicalScore = Math.max(lexicalHits[0]?.score ?? 0, 1e-9);
  const maxSeedScore = Math.max(seedHits[0]?.score ?? 0, 1e-9);

  for (const hit of seedHits) {
    const nodeId = runtime.pageNodeByPath.get(hit.pagePath);
    if (!nodeId) continue;
    seedNodeIds.push(nodeId);
    seedScores.set(nodeId, Math.max(0, hit.score) / maxSeedScore);
  }

  const graphMultiplier = level === 0 ? 1 : level === 1 ? 2 : 4;
  const requestedGraphNodes = (request.graphMaxNodes ?? Math.max(maxResults * 3, 24)) * graphMultiplier;
  const graphMaxNodes = Math.max(1, Math.min(budget.maxVisitedNodes, requestedGraphNodes));
  const requestedBeam = (request.graphBeamWidth ?? Math.max(maxResults * 2, 16)) * graphMultiplier;
  const graphResult = expandRuntimeGraphFromSeeds(runtime, {
    seedNodeIds,
    seedScores,
    maxNodes: graphMaxNodes,
    maxDepth: budget.maxDepth,
    beamWidth: Math.max(1, Math.min(budget.maxVisitedNodes, requestedBeam)),
    maxVisitedNodes: budget.maxVisitedNodes,
    pageTypes: request.pageTypes,
  });

  const lexicalByPath = new Map(
    lexicalHits.map((hit, index) => [hit.path, { hit, rank: index + 1 }] as const)
  );
  const semanticByPath = new Map(
    semanticHits.map((hit, index) => [hit.path, { hit, rank: index + 1 }] as const)
  );
  const graphPageRanks = new Map<string, number>();
  const seedNodeSet = new Set(seedNodeIds);
  let graphRank = 0;
  for (const node of graphResult.nodes) {
    if (node.kind !== "page" || !node.path) continue;
    // A lexical seed is the traversal origin, not independent graph evidence.
    if (seedNodeSet.has(node.id)) continue;
    graphRank++;
    if (!graphPageRanks.has(node.path)) graphPageRanks.set(node.path, graphRank);
  }

  const paths = new Set<string>([
    ...lexicalByPath.keys(),
    ...semanticByPath.keys(),
    ...graphPageRanks.keys(),
  ]);
  const graphWeight = Math.max(0, request.graphWeight ?? 0.65);
  const typeFilter = request.pageTypes ? new Set(request.pageTypes) : null;
  const fused: HybridRetrievalHit[] = [];

  for (const pagePath of paths) {
    const lexical = lexicalByPath.get(pagePath);
    const semantic = semanticByPath.get(pagePath);
    const graphPageRank = graphPageRanks.get(pagePath);
    const lexicalConfidence = lexical
      ? Math.min(1, Math.max(0, lexical.hit.score) / maxLexicalScore)
      : 0;
    const graphConfidence = lexical ? 0.25 + lexicalConfidence * 0.75 : 1;
    let baseHit = lexical?.hit ?? semantic?.hit;

    if (!baseHit) {
      const record = await readWikiPageRecord(request.wikiRoot, pagePath);
      if (!record || (typeFilter && !typeFilter.has(record.type))) continue;
      const fallback = fallbackExcerpt(record);
      baseHit = {
        path: record.path,
        title: record.title,
        type: record.type,
        tags: record.tags,
        sources: record.sources,
        requestId: record.requestId,
        score: 0,
        excerpt: fallback.excerpt,
        heading: fallback.heading,
        record,
      };
    }

    fused.push({
      ...baseHit,
      score:
        reciprocalRank(lexical?.rank, lexicalWeight, rrfK) *
          (lexical ? 0.2 + lexicalConfidence * 0.8 : 0) +
        reciprocalRank(semantic?.rank, semanticWeight, rrfK) +
        reciprocalRank(graphPageRank, graphWeight, rrfK) * graphConfidence,
      channels: {
        lexicalRank: lexical?.rank,
        semanticRank: semantic?.rank,
        graphRank: graphPageRank,
        lexicalScore: lexical?.hit.score,
        lexicalConfidence: lexical ? lexicalConfidence : undefined,
        semanticScore: semantic?.hit.score,
      },
    });
  }

  const exactAnchorPath = semanticHits.length > 0 && hasExactIdentifierSignal(request.query)
    ? lexicalHits[0]?.path
    : undefined;
  fused.sort((a, b) => {
    if (a.path === exactAnchorPath && b.path !== exactAnchorPath) return -1;
    if (b.path === exactAnchorPath && a.path !== exactAnchorPath) return 1;
    return b.score - a.score || a.path.localeCompare(b.path);
  });
  const hits = limitHitsByBudget(fused, maxResults, budget);
  return {
    hits,
    coverageHits: fused,
    lexicalHits,
    semanticHits,
    semantic: semantic.diagnostics,
    graphResult,
    estimatedContextTokens: estimateRetrievalContextTokens(hits),
    lexicalPoolSize,
    semanticCandidateCount: semanticHits.length,
    fallbackUsed: params.fallbackHits.length > 0,
    semanticIndex: semantic.index,
  };
}

function lexicalCoverageWarning(semantic: HybridSemanticDiagnostics): string[] {
  if (!semantic.enabled) return [];
  if (semantic.error) {
    return [`Semantic coverage degraded to lexical mode: ${semantic.error}`];
  }
  if (!semantic.available) {
    return [
      "Lexical coverage mode is active. Configure a local Ollama or remote OpenAI-compatible " +
      "embedding provider with KNOWLEDGE_RAIL_EMBEDDING_* to improve GAP precision.",
    ];
  }
  return ["Semantic retrieval is active, but this backend does not support semantic coverage; lexical coverage is active."];
}

async function assessAttemptCoverage(
  request: HybridRetrievalParams,
  result: AttemptResult
): Promise<RetrievalCoverage> {
  let coverageMode: RetrievalCoverage["coverageMode"] = "lexical";
  let semanticScores: readonly SemanticCoverageScore[] = [];
  let warnings = lexicalCoverageWarning(result.semantic);
  if (result.semantic.available && result.semanticIndex?.assessCoverage) {
    try {
      semanticScores = await result.semanticIndex.assessCoverage(
        semanticCoverageQueries(request.query, request.coverageRequirements),
        result.coverageHits.map((hit) => hit.path)
      );
      coverageMode = "semantic";
      warnings = [];
    } catch (error: unknown) {
      const safeError = safeSemanticError(error);
      result.semantic = {
        ...result.semantic,
        available: false,
        error: safeError,
      };
      warnings = [`Semantic coverage degraded to lexical mode: ${safeError}`];
    }
  }
  return assessRetrievalCoverage({
    query: request.query,
    hits: result.coverageHits,
    displayHits: result.hits,
    graphResult: result.graphResult,
    requirements: request.coverageRequirements,
    coverageMode,
    semanticScores,
    warnings,
  });
}

export async function retrieveWikiHybrid(
  params: HybridRetrievalParams
): Promise<HybridRetrievalResult> {
  const maxResults = Math.max(1, params.maxResults ?? 10);
  const initialBudget = resolveInitialBudget(params, maxResults);
  const maximumBudget = resolveMaximumBudget(params, initialBudget, maxResults);
  const progressive = params.progressiveWidening ?? true;
  const requestedMaxLevel = progressive ? params.maxWideningLevel ?? 3 : 0;
  const availableMaxLevel = params.fallbackProvider ? 3 : 2;
  const maxLevel = Math.min(
    availableMaxLevel,
    Math.max(0, requestedMaxLevel)
  ) as RetrievalWideningLevel;
  const attempts: HybridRetrievalAttempt[] = [];
  let semanticPromise: Promise<ResolvedSemantic> | undefined;
  let previousCoverage: RetrievalCoverage | undefined;
  let finalAttempt: AttemptResult | undefined;
  let finalCoverage: RetrievalCoverage | undefined;
  let finalBudget = initialBudget;
  let finalLevel: RetrievalWideningLevel = 0;

  for (let rawLevel = 0; rawLevel <= maxLevel; rawLevel++) {
    const level = rawLevel as RetrievalWideningLevel;
    const budget = budgetForLevel(initialBudget, maximumBudget, level);
    const fallbackHits = level === 3 && params.fallbackProvider && previousCoverage
      ? await params.fallbackProvider({
        wikiRoot: params.wikiRoot,
        query: params.query,
        coverage: previousCoverage,
        budget,
      })
      : [];
    const result = await retrieveAttempt({
      request: params,
      level,
      budget,
      maxResults,
      fallbackHits,
      resolveSemantic: () => {
        semanticPromise ??= resolveSemantic(params, maxResults);
        return semanticPromise;
      },
    });
    const coverage = await assessAttemptCoverage(params, result);
    attempts.push({
      level,
      budget,
      coverage,
      hitCount: result.hits.length,
      coverageCandidateCount: result.coverageHits.length,
      estimatedContextTokens: result.estimatedContextTokens,
      lexicalPoolSize: result.lexicalPoolSize,
      semanticCandidateCount: result.semanticCandidateCount,
      visitedNodes: result.graphResult.stats.visitedNodes,
      visitedEdges: result.graphResult.stats.visitedEdges,
      fallbackUsed: result.fallbackUsed,
    });
    previousCoverage = coverage;
    finalAttempt = result;
    finalCoverage = coverage;
    finalBudget = budget;
    finalLevel = level;
    // The explicit coverage profile spends the bounded retrieval budget to
    // maximize recall even after the known facets are covered. This avoids
    // making graph depth depend on accidental false gaps from entity parsing.
    if (coverage.sufficient && (params.profile !== "coverage" || level >= maxLevel)) break;
  }

  if (!finalAttempt || !finalCoverage) {
    throw new Error("Hybrid retrieval did not execute an evaluation attempt.");
  }
  return {
    hits: finalAttempt.hits,
    coverageHits: finalAttempt.coverageHits,
    lexicalHits: finalAttempt.lexicalHits,
    semanticHits: finalAttempt.semanticHits,
    semantic: finalAttempt.semantic,
    graphResult: finalAttempt.graphResult,
    coverage: finalCoverage,
    wideningLevel: finalLevel,
    attempts,
    initialBudget,
    finalBudget,
    estimatedContextTokens: finalAttempt.estimatedContextTokens,
  };
}
