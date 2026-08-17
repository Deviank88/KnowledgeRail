import * as path from "node:path";
import { driftedClaimsByPage } from "../core/drift-detection.js";
import type { GraphEdge, GraphEdgeKind, GraphNode } from "../core/graph-index.js";
import { getRuntimeWikiGraph, type RuntimeGraph } from "../core/graph-runtime.js";
import {
  retrieveWikiHybrid,
  type HybridRetrievalHit,
  type RetrievalCoverage,
  type RetrievalCoverageRequirements,
  type RetrievalWideningLevel,
} from "../core/hybrid-retrieval.js";
import type { RetrievalProfile } from "../core/text-analysis.js";
import {
  estimateContextSize,
  evidenceFromRetrievalHit,
  type ContextIntent,
  type ContextSizeEstimate,
  type EvidenceRef,
  type KnowledgeGap,
} from "./context-manifest.js";

export const TASK_CONTEXT_EVIDENCE_FIELDS = [
  "currentState",
  "requirements",
  "decisions",
  "invariants",
  "constraints",
  "dependencies",
  "affectedComponents",
  "implementationEvidence",
  "tests",
  "incidents",
  "risks",
  "contradictions",
] as const;

export type TaskContextEvidenceField =
  (typeof TASK_CONTEXT_EVIDENCE_FIELDS)[number];

export interface TaskContextAttempt {
  level: RetrievalWideningLevel;
  hitCount: number;
  coverageCandidateCount: number;
  visitedNodes: number;
  visitedEdges: number;
  maxDepthReached: number;
  maxVisitedNodes: number;
  maxEvidence: number;
  tokenBudget: number;
  fallbackUsed: boolean;
}

export interface TaskContextRetrieval {
  strategy: "hybrid_progressive_widening";
  coverageMode: RetrievalCoverage["coverageMode"];
  coverageWarnings: string[];
  query: string;
  profile: RetrievalProfile;
  wideningLevel: RetrievalWideningLevel;
  coverageSufficient: boolean;
  evidenceGaps: string[];
  estimatedContextTokens: number;
  hitCount: number;
  coverageCandidateCount: number;
  selectedEvidenceCount: number;
  fallbackUsed: boolean;
  fullGraphScanAttempted: false;
  attempts: TaskContextAttempt[];
}

export interface ChangeImpactRelation {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  direction: "incoming" | "outgoing";
}

export interface TaskEvidenceRef {
  uri: string;
  path: string;
}

export interface ChangeImpact {
  mode: "explicit" | "inferred" | "not_applicable";
  requestedPaths: string[];
  changedComponents: TaskEvidenceRef[];
  incomingDependencies: TaskEvidenceRef[];
  outgoingDependencies: TaskEvidenceRef[];
  requirements: TaskEvidenceRef[];
  decisions: TaskEvidenceRef[];
  invariants: TaskEvidenceRef[];
  tests: TaskEvidenceRef[];
  incidents: TaskEvidenceRef[];
  risks: TaskEvidenceRef[];
  relations: ChangeImpactRelation[];
}

export interface TaskContext {
  version: 2;
  task: {
    intent: ContextIntent;
    objective: string;
  };
  currentState: TaskEvidenceRef[];
  requirements: TaskEvidenceRef[];
  decisions: TaskEvidenceRef[];
  invariants: TaskEvidenceRef[];
  constraints: TaskEvidenceRef[];
  dependencies: TaskEvidenceRef[];
  affectedComponents: TaskEvidenceRef[];
  implementationEvidence: TaskEvidenceRef[];
  tests: TaskEvidenceRef[];
  incidents: TaskEvidenceRef[];
  risks: TaskEvidenceRef[];
  contradictions: TaskEvidenceRef[];
  unknowns: KnowledgeGap[];
  changeImpact: ChangeImpact;
  retrieval: TaskContextRetrieval;
  /** Compatibility view for clients that consumed ContextManifest v1. */
  intent: ContextIntent;
  /** Compatibility view for clients that consumed ContextManifest v1. */
  objective: string;
  /** Stable, deduplicated union of every structured evidence bucket. */
  evidence: EvidenceRef[];
  /** Compatibility alias of `unknowns`. */
  gaps: KnowledgeGap[];
  size: ContextSizeEstimate;
  budget: {
    requestedHeuristicTokens: number;
    withinHeuristicBudget: boolean;
    omittedEvidenceCount: number;
  };
}

export interface CompileTaskContextParams {
  wikiRoot: string;
  intent: ContextIntent;
  objective: string;
  query?: string;
  changedPaths?: readonly string[];
  pageTypes?: readonly string[];
  retrievalProfile?: RetrievalProfile;
  maxEvidence?: number;
  heuristicTokenBudget?: number;
  /** Opt-in persistence for disposable indexes. Context compilation is read-only by default. */
  persistDerivedIndexes?: boolean;
  /** Additional accuracy requirements for a bounded consumer such as an editorial section. */
  coverageRequirements?: RetrievalCoverageRequirements;
  /** Declarative specialization of an intent policy; used by evidence-planned consumers. */
  evidencePolicy?: {
    requiredCategories?: readonly TaskContextEvidenceField[];
    priorityCategories?: readonly TaskContextEvidenceField[];
    requiredPageTypes?: readonly string[];
    replaceDefaults?: boolean;
  };
}

interface IntentPolicy {
  priorities: readonly TaskContextEvidenceField[];
  requiredCategories: readonly TaskContextEvidenceField[];
  requiredPageTypes: readonly string[];
  impact: boolean;
}

interface ClassifiedCandidate {
  hit: HybridRetrievalHit;
  categories: Set<TaskContextEvidenceField>;
  evidence?: EvidenceRef;
  driftClaimIds?: string[];
}

interface TaskGraphSlice {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type EvidenceBuckets = Record<TaskContextEvidenceField, TaskEvidenceRef[]>;

const COMPONENT_TYPES = new Set([
  "implementation",
  "api",
  "integration",
  "automation",
  "data_model",
]);

const CURRENT_STATE_TYPES = new Set([
  "entity",
  "concept",
  "summary",
  "comparison",
  "overview",
  "analysis",
  "client_source",
  "meeting_note",
  ...COMPONENT_TYPES,
]);

const INTENT_POLICIES: Readonly<Record<ContextIntent, IntentPolicy>> = {
  understand: {
    priorities: ["currentState", "implementationEvidence", "decisions", "dependencies", "requirements"],
    requiredCategories: ["currentState"],
    requiredPageTypes: [],
    impact: false,
  },
  implement: {
    priorities: [
      "requirements",
      "invariants",
      "constraints",
      "dependencies",
      "implementationEvidence",
      "decisions",
      "tests",
    ],
    requiredCategories: ["requirements", "invariants", "constraints", "dependencies", "tests"],
    requiredPageTypes: ["requirement", "implementation", "test_result"],
    impact: true,
  },
  modify: {
    priorities: [
      "affectedComponents",
      "implementationEvidence",
      "dependencies",
      "requirements",
      "decisions",
      "invariants",
      "tests",
      "incidents",
      "risks",
    ],
    requiredCategories: [
      "affectedComponents",
      "dependencies",
      "requirements",
      "decisions",
      "invariants",
      "tests",
      "incidents",
      "risks",
    ],
    requiredPageTypes: ["implementation", "requirement", "decision", "test_result"],
    impact: true,
  },
  debug: {
    priorities: ["incidents", "tests", "implementationEvidence", "dependencies", "decisions", "risks"],
    requiredCategories: ["incidents", "tests", "implementationEvidence", "dependencies"],
    requiredPageTypes: ["analysis", "test_result", "implementation"],
    impact: true,
  },
  review: {
    priorities: ["requirements", "invariants", "decisions", "tests", "risks", "contradictions"],
    requiredCategories: ["requirements", "invariants", "decisions", "tests", "risks"],
    requiredPageTypes: ["requirement", "decision", "test_result", "risk"],
    impact: true,
  },
  document: {
    priorities: [
      "requirements",
      "invariants",
      "constraints",
      "decisions",
      "currentState",
      "risks",
      "tests",
      "contradictions",
    ],
    requiredCategories: ["requirements", "decisions"],
    requiredPageTypes: ["requirement", "decision"],
    impact: false,
  },
};

const CATEGORY_LABELS: Readonly<Record<TaskContextEvidenceField, string>> = {
  currentState: "current state / architecture / concept",
  requirements: "requirements",
  decisions: "decisions",
  invariants: "invariants",
  constraints: "constraints",
  dependencies: "interfaces and dependencies",
  affectedComponents: "affected components",
  implementationEvidence: "current implementation evidence",
  tests: "tests and verification evidence",
  incidents: "incidents and known failures",
  risks: "known risks",
  contradictions: "contradiction evidence",
};

function boundedText(value: string, label: string, maximum = 4_096): string {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must contain 1-${maximum} printable characters.`);
  }
  return normalized;
}

function normalizedPagePath(value: string): string {
  if (value.length === 0 || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Changed path must be a normalized relative wiki Markdown path: ${value}`);
  }
  const slashes = value.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashes);
  const parts = normalized.split("/");
  if (
    path.posix.isAbsolute(slashes) || /^[A-Za-z]:/.test(slashes) || slashes.startsWith("//") ||
    normalized !== slashes || !normalized.toLowerCase().endsWith(".md") ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0")) ||
    parts[0]?.startsWith(".") || ["SCHEMA.md", "index.md", "log.md"].includes(normalized)
  ) {
    throw new Error(`Changed path must be a normalized relative wiki Markdown path: ${value}`);
  }
  return normalized;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function searchableCandidateText(hit: HybridRetrievalHit): string {
  return [
    hit.title,
    hit.type,
    hit.tags.join(" "),
    hit.heading,
    hit.excerpt,
    hit.record.body,
  ].join(" ");
}

function classifyCandidate(hit: HybridRetrievalHit): Set<TaskContextEvidenceField> {
  const categories = new Set<TaskContextEvidenceField>();
  const type = hit.type;
  const text = searchableCandidateText(hit);
  const tags = hit.tags.join(" ");

  if (CURRENT_STATE_TYPES.has(type)) categories.add("currentState");
  if (["requirement", "request", "candidate_request"].includes(type)) categories.add("requirements");
  if (type === "decision") categories.add("decisions");
  if (COMPONENT_TYPES.has(type)) {
    categories.add("affectedComponents");
    categories.add("implementationEvidence");
  }
  if (type === "test_result" || /\b(test|tests|verification|regression|verifica|collaudo)\b/i.test(tags)) {
    categories.add("tests");
  }
  if (
    /\b(invariant|invariante|must always|must never|deve sempre|non deve mai)\b/i.test(text) ||
    /\bonly after\b/i.test(text)
  ) categories.add("invariants");
  if (
    /\b(constraint|constraints|vincolo|vincoli|restriction|restricted|limit|limite|cannot|must not)\b/i.test(text) ||
    /\b(non pu[oò]|non deve|at most|no more than)\b/i.test(text)
  ) categories.add("constraints");
  if (
    ["api", "integration", "data_model", "automation"].includes(type) ||
    /\b(dependency|dependencies|dipendenz\w*|interface|interfaces|endpoint|schema|contract|contratto)\b/i.test(text)
  ) categories.add("dependencies");
  if (
    type === "analysis" &&
    /\b(incident|incidente|outage|failure|failures|guasto|postmortem|known failure|regression)\b/i.test(text)
  ) categories.add("incidents");
  if (type === "risk" || /\b(risk|risks|rischio|rischi)\b/i.test(tags)) categories.add("risks");
  const contradictionTagged = /\b(contradiction|contradictory|conflict|contraddizione|conflitto)\b/i.test(tags);
  const explicitContradiction = /\b(?:not marked superseded|unresolved contradict\w*|contradicts?|conflicting (?:claim|decision|evidence|requirement|rule)|in conflitto con|contraddice\w*|evidenz[ae] contraddittori[ae])\b/i.test(text);
  if (contradictionTagged || explicitContradiction) {
    categories.add("contradictions");
  }
  return categories;
}

function localTaskGraph(
  runtime: RuntimeGraph,
  candidates: readonly ClassifiedCandidate[]
): TaskGraphSlice {
  const selectedNodeIds = new Set(
    candidates
      .map((candidate) => runtime.pageNodeByPath.get(candidate.hit.path))
      .filter((nodeId): nodeId is string => Boolean(nodeId))
  );
  const nodes = [...selectedNodeIds]
    .map((nodeId) => runtime.nodesById.get(nodeId))
    .filter((node): node is GraphNode => Boolean(node))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = new Map<string, GraphEdge>();
  for (const from of selectedNodeIds) {
    for (const neighbor of runtime.outgoing.get(from) ?? []) {
      if (!selectedNodeIds.has(neighbor.id)) continue;
      const edge = { from, to: neighbor.id, kind: neighbor.edgeKind };
      edges.set(`${edge.from}\0${edge.kind}\0${edge.to}`, edge);
    }
  }
  return {
    nodes,
    edges: [...edges.values()].sort((left, right) =>
      left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind) ||
      left.to.localeCompare(right.to)
    ),
  };
}

function markGraphDependencies(candidates: readonly ClassifiedCandidate[], graph: TaskGraphSlice): void {
  const byPath = new Map(candidates.map((candidate) => [candidate.hit.path, candidate] as const));
  const pathByNode = new Map(
    graph.nodes
      .filter((node) => node.kind === "page" && node.path)
      .map((node) => [node.id, node.path!] as const)
  );
  for (const edge of graph.edges) {
    const fromPath = pathByNode.get(edge.from);
    const toPath = pathByNode.get(edge.to);
    if (!fromPath || !toPath || !byPath.has(fromPath) || !byPath.has(toPath)) continue;
    if (!["links_to", "implements", "tests", "released_by"].includes(edge.kind)) continue;
    byPath.get(fromPath)!.categories.add("dependencies");
    byPath.get(toPath)!.categories.add("dependencies");
  }
}

function markContradictionGroups(candidates: readonly ClassifiedCandidate[]): void {
  const byRequest = new Map<string, ClassifiedCandidate[]>();
  for (const candidate of candidates) {
    const requestId = candidate.hit.requestId;
    if (!requestId) continue;
    const group = byRequest.get(requestId) ?? [];
    group.push(candidate);
    byRequest.set(requestId, group);
  }
  for (const group of byRequest.values()) {
    if (group.length < 2) continue;
    const numbers = new Set(
      group.flatMap((candidate) =>
        candidate.hit.record.body.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []
      ).map((value) => value.replace(",", "."))
    );
    const explicit = group.some((candidate) => candidate.categories.has("contradictions"));
    if (numbers.size >= 2 || explicit) {
      for (const candidate of group) candidate.categories.add("contradictions");
    }
  }
}

function orderCandidates(
  candidates: readonly ClassifiedCandidate[],
  priorities: readonly TaskContextEvidenceField[]
): ClassifiedCandidate[] {
  const selected = new Set<string>();
  const ordered: ClassifiedCandidate[] = [];
  for (const category of priorities) {
    if (ordered.some((item) => item.categories.has(category))) continue;
    const candidate = candidates.find((item) =>
      !selected.has(item.hit.path) && item.categories.has(category)
    );
    if (!candidate) continue;
    selected.add(candidate.hit.path);
    ordered.push(candidate);
  }
  for (const candidate of candidates) {
    if (selected.has(candidate.hit.path)) continue;
    selected.add(candidate.hit.path);
    ordered.push(candidate);
  }
  return ordered;
}

function emptyBuckets(): EvidenceBuckets {
  return {
    currentState: [],
    requirements: [],
    decisions: [],
    invariants: [],
    constraints: [],
    dependencies: [],
    affectedComponents: [],
    implementationEvidence: [],
    tests: [],
    incidents: [],
    risks: [],
    contradictions: [],
  };
}

function buildBuckets(candidates: readonly ClassifiedCandidate[]): EvidenceBuckets {
  const buckets = emptyBuckets();
  for (const candidate of candidates) {
    if (candidate.driftClaimIds?.length) continue;
    const evidence = compactTaskEvidence(candidate.evidence!);
    for (const category of candidate.categories) buckets[category].push(evidence);
  }
  return buckets;
}

function compactTaskEvidence(evidence: EvidenceRef): TaskEvidenceRef {
  return {
    uri: evidence.uri,
    path: evidence.path,
  };
}

function uniqueEvidence(values: readonly EvidenceRef[]): EvidenceRef[] {
  const byUri = new Map<string, EvidenceRef>();
  for (const value of values) if (!byUri.has(value.uri)) byUri.set(value.uri, value);
  return [...byUri.values()];
}

function uniqueTaskEvidence(values: readonly TaskEvidenceRef[]): TaskEvidenceRef[] {
  const byUri = new Map<string, TaskEvidenceRef>();
  for (const value of values) if (!byUri.has(value.uri)) byUri.set(value.uri, value);
  return [...byUri.values()];
}

function gapKind(value: string): KnowledgeGap["kind"] {
  if (value.includes("contradiction")) return "contradiction";
  if (value.includes("stale")) return "stale_evidence";
  if (value.includes("budget") || value.includes("truncated")) return "budget_limited";
  return "missing_evidence";
}

function uniqueGaps(values: readonly KnowledgeGap[]): KnowledgeGap[] {
  const byKey = new Map<string, KnowledgeGap>();
  for (const value of values) {
    const key = `${value.kind}\0${value.description}`;
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()];
}

function knowledgeGaps(params: {
  coverage: RetrievalCoverage;
  buckets: EvidenceBuckets;
  policy: IntentPolicy;
  selected: readonly ClassifiedCandidate[];
  available: readonly ClassifiedCandidate[];
  requestedPaths: readonly string[];
  omittedEvidenceCount: number;
  tokenBudget: number;
  intent: ContextIntent;
}): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = params.coverage.evidenceGaps.map((gap) => ({
    kind: gapKind(gap),
    description: `Hybrid coverage gap: ${gap}.`,
  }));
  gaps.push(...params.coverage.budgetLimitedGaps.map((gap) => ({
    kind: "budget_limited" as const,
    description: `Hybrid coverage evidence was retrieved but omitted by the display budget: ${gap}.`,
  })));
  for (const category of params.policy.requiredCategories) {
    if (params.buckets[category].length > 0) continue;
    const staleAvailable = params.available.some((candidate) =>
      candidate.categories.has(category) && Boolean(candidate.driftClaimIds?.length)
    );
    if (staleAvailable) continue;
    const availableBeyondDisplay = params.available.some((candidate) =>
      candidate.categories.has(category) && !candidate.driftClaimIds?.length
    );
    gaps.push({
      kind: availableBeyondDisplay ? "budget_limited" : "missing_evidence",
      description: availableBeyondDisplay
        ? `${CATEGORY_LABELS[category]} was retrieved but omitted by the display budget for intent ${params.intent}.`
        : `No ${CATEGORY_LABELS[category]} was recovered for intent ${params.intent}.`,
    });
  }
  const selectedPaths = new Set(params.selected.map((candidate) => candidate.hit.path));
  const availablePaths = new Set(params.available.map((candidate) => candidate.hit.path));
  for (const requestedPath of params.requestedPaths) {
    if (!selectedPaths.has(requestedPath)) {
      const availableBeyondDisplay = availablePaths.has(requestedPath);
      gaps.push({
        kind: availableBeyondDisplay ? "budget_limited" : "missing_evidence",
        description: availableBeyondDisplay
          ? `Requested changed component was retrieved but omitted by the display budget: ${requestedPath}.`
          : `Requested changed component was not recovered by the bounded hybrid path: ${requestedPath}.`,
      });
    }
  }
  const stale = params.selected
    .filter((candidate) => /\b(stale|obsolete|outdated|legacy_unverified)\b/i.test(
      `${candidate.hit.tags.join(" ")} ${candidate.hit.record.body}`
    ))
    .map((candidate) => candidate.hit.path);
  if (stale.length > 0) {
    gaps.push({
      kind: "stale_evidence",
      description: `Potentially stale evidence requires validation: ${uniqueSorted(stale).join(", ")}.`,
    });
  }
  const drifted = params.selected.filter((candidate) => candidate.driftClaimIds?.length);
  if (drifted.length > 0) {
    gaps.push({
      kind: "stale_evidence",
      reason: "drift_suspected",
      paths: uniqueSorted(drifted.map((candidate) => candidate.hit.path)),
      claimIds: uniqueSorted(drifted.flatMap((candidate) => candidate.driftClaimIds ?? [])),
      description: `Code-backed evidence changed and requires re-verification: ${
        uniqueSorted(drifted.map((candidate) => candidate.hit.path)).join(", ")
      }.`,
    });
  }
  if (params.buckets.contradictions.length > 0) {
    gaps.push({
      kind: "contradiction",
      description: `Conflicting evidence requires resolution: ${params.buckets.contradictions
        .map((evidence) => evidence.path).join(", ")}.`,
    });
  }
  if (params.intent === "document" && !params.selected.some((candidate) => candidate.hit.sources.length > 0)) {
    const provenanceAvailable = params.available.some((candidate) => candidate.hit.sources.length > 0);
    gaps.push({
      kind: provenanceAvailable ? "budget_limited" : "missing_evidence",
      description: provenanceAvailable
        ? "Source provenance was retrieved but omitted by the display budget for the document task."
        : "No source provenance was recovered for the document task.",
    });
  }
  if (params.omittedEvidenceCount > 0) {
    gaps.push({
      kind: "budget_limited",
      description: `${params.omittedEvidenceCount} evidence item(s) omitted to respect the ` +
        `${params.tokenBudget}-token heuristic task-context budget.`,
    });
  }
  return uniqueGaps(gaps);
}

function impactFor(params: {
  policy: IntentPolicy;
  requestedPaths: readonly string[];
  selected: readonly ClassifiedCandidate[];
  buckets: EvidenceBuckets;
  graph: TaskGraphSlice;
}): ChangeImpact {
  const evidenceByPath = new Map(
    params.selected.map((candidate) => [
      candidate.hit.path,
      compactTaskEvidence(candidate.evidence!),
    ] as const)
  );
  const candidateByPath = new Map(
    params.selected.map((candidate) => [candidate.hit.path, candidate] as const)
  );
  let roots: TaskEvidenceRef[] = [];
  if (params.requestedPaths.length > 0) {
    roots = params.requestedPaths
      .map((requestedPath) => evidenceByPath.get(requestedPath))
      .filter((evidence): evidence is TaskEvidenceRef => Boolean(evidence));
  } else if (params.policy.impact) {
    const inferred = params.selected.find((candidate) => candidate.categories.has("affectedComponents")) ??
      params.selected[0];
    if (inferred) roots = [compactTaskEvidence(inferred.evidence!)];
  }
  const rootPaths = new Set(roots.map((evidence) => evidence.path));
  const pathByNode = new Map(
    params.graph.nodes
      .filter((node) => node.kind === "page" && node.path)
      .map((node) => [node.id, node.path!] as const)
  );
  const incoming: TaskEvidenceRef[] = [];
  const outgoing: TaskEvidenceRef[] = [];
  const relations: ChangeImpactRelation[] = [];
  const relatedPaths = new Set(rootPaths);
  for (const edge of params.graph.edges) {
    const fromPath = pathByNode.get(edge.from);
    const toPath = pathByNode.get(edge.to);
    if (!fromPath || !toPath || !evidenceByPath.has(fromPath) || !evidenceByPath.has(toPath)) continue;
    if (rootPaths.has(toPath) && fromPath !== toPath) {
      incoming.push(evidenceByPath.get(fromPath)!);
      relatedPaths.add(fromPath);
      relations.push({ from: fromPath, to: toPath, kind: edge.kind, direction: "incoming" });
    }
    if (rootPaths.has(fromPath) && fromPath !== toPath) {
      outgoing.push(evidenceByPath.get(toPath)!);
      relatedPaths.add(toPath);
      relations.push({ from: fromPath, to: toPath, kind: edge.kind, direction: "outgoing" });
    }
  }
  const rootRequestIds = new Set(
    [...rootPaths]
      .map((rootPath) => candidateByPath.get(rootPath)?.hit.requestId)
      .filter((value): value is string => Boolean(value))
  );
  for (const candidate of params.selected) {
    if (candidate.hit.requestId && rootRequestIds.has(candidate.hit.requestId)) {
      relatedPaths.add(candidate.hit.path);
    }
  }
  const related = (values: readonly TaskEvidenceRef[]): TaskEvidenceRef[] =>
    uniqueTaskEvidence(values.filter((evidence) => relatedPaths.has(evidence.path)));
  return {
    mode: params.requestedPaths.length > 0
      ? "explicit"
      : params.policy.impact
        ? "inferred"
        : "not_applicable",
    requestedPaths: [...params.requestedPaths],
    changedComponents: uniqueTaskEvidence(roots),
    incomingDependencies: uniqueTaskEvidence(incoming),
    outgoingDependencies: uniqueTaskEvidence(outgoing),
    requirements: related(params.buckets.requirements),
    decisions: related(params.buckets.decisions),
    invariants: related(params.buckets.invariants),
    tests: related(params.buckets.tests),
    incidents: related(params.buckets.incidents),
    risks: related(params.buckets.risks),
    relations: relations.sort((left, right) =>
      left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind) ||
      left.to.localeCompare(right.to) || left.direction.localeCompare(right.direction)
    ),
  };
}

function contextWithoutSize(params: {
  intent: ContextIntent;
  objective: string;
  requestedPaths: readonly string[];
  selected: readonly ClassifiedCandidate[];
  available: readonly ClassifiedCandidate[];
  allHitCount: number;
  policy: IntentPolicy;
  graph: TaskGraphSlice;
  coverage: RetrievalCoverage;
  retrieval: TaskContextRetrieval;
  tokenBudget: number;
}): Omit<TaskContext, "size"> {
  const buckets = buildBuckets(params.selected);
  const omittedEvidenceCount = params.allHitCount - params.selected.length;
  const unknowns = knowledgeGaps({
    coverage: params.coverage,
    buckets,
    policy: params.policy,
    selected: params.selected,
    available: params.available,
    requestedPaths: params.requestedPaths,
    omittedEvidenceCount,
    tokenBudget: params.tokenBudget,
    intent: params.intent,
  });
  const evidence = uniqueEvidence(params.selected.map((candidate) => candidate.evidence!));
  const cleanSelected = params.selected.filter((candidate) => !candidate.driftClaimIds?.length);
  return {
    version: 2,
    task: { intent: params.intent, objective: params.objective },
    ...buckets,
    unknowns,
    changeImpact: impactFor({
      policy: params.policy,
      requestedPaths: params.requestedPaths,
      selected: cleanSelected,
      buckets,
      graph: params.graph,
    }),
    retrieval: {
      ...params.retrieval,
      selectedEvidenceCount: evidence.length,
    },
    intent: params.intent,
    objective: params.objective,
    evidence,
    gaps: unknowns,
    budget: {
      requestedHeuristicTokens: params.tokenBudget,
      withinHeuristicBudget: true,
      omittedEvidenceCount,
    },
  };
}

function withSize(base: Omit<TaskContext, "size">, tokenBudget: number): TaskContext {
  const size = estimateContextSize(JSON.stringify(base));
  return {
    ...base,
    budget: {
      ...base.budget,
      withinHeuristicBudget: size.heuristicTokens <= tokenBudget,
    },
    size,
  };
}

function requiredPageTypes(
  policy: IntentPolicy,
  pageTypes: readonly string[] | undefined,
  additional: readonly string[] = []
): string[] {
  const required = [...new Set([...policy.requiredPageTypes, ...additional])];
  if (!pageTypes) return required;
  const allowed = new Set(pageTypes);
  return required.filter((pageType) => allowed.has(pageType));
}

function resolvedIntentPolicy(
  base: IntentPolicy,
  override: CompileTaskContextParams["evidencePolicy"]
): IntentPolicy {
  if (!override) return base;
  const combine = <T>(defaults: readonly T[], additions: readonly T[] | undefined): T[] =>
    [...new Set(override.replaceDefaults ? additions ?? [] : [...(additions ?? []), ...defaults])];
  return {
    priorities: combine(base.priorities, override.priorityCategories),
    requiredCategories: combine(base.requiredCategories, override.requiredCategories),
    requiredPageTypes: combine(base.requiredPageTypes, override.requiredPageTypes),
    impact: base.impact,
  };
}

export async function compileTaskContext(params: CompileTaskContextParams): Promise<TaskContext> {
  const objective = boundedText(params.objective, "Task objective");
  const query = boundedText(params.query ?? objective, "Task retrieval query");
  const requestedPaths = uniqueSorted((params.changedPaths ?? []).map(normalizedPagePath));
  const retrievalQuery = requestedPaths.length === 0
    ? query
    : `${query} ${requestedPaths.join(" ")}`;
  const maxEvidence = Math.max(1, Math.min(20, params.maxEvidence ?? 8));
  const tokenBudget = Math.max(256, Math.min(12_000, params.heuristicTokenBudget ?? 2_000));
  const profile = params.retrievalProfile ?? "balanced";
  const policy = resolvedIntentPolicy(INTENT_POLICIES[params.intent], params.evidencePolicy);
  const coverageRequirements: RetrievalCoverageRequirements = {
    ...params.coverageRequirements,
    requiredPageTypes: requiredPageTypes(
      policy,
      params.pageTypes,
      params.coverageRequirements?.requiredPageTypes
    ),
  };
  const hybrid = await retrieveWikiHybrid({
    wikiRoot: params.wikiRoot,
    query: retrievalQuery,
    maxResults: maxEvidence,
    pageTypes: params.pageTypes,
    profile,
    semanticEnabled: true,
    persistDerivedIndexes: params.persistDerivedIndexes ?? false,
    coverageRequirements,
    initialBudget: {
      maxSeedCandidates: Math.max(1, Math.min(4, maxEvidence)),
      maxVisitedNodes: Math.max(24, maxEvidence * 4),
      maxDepth: 1,
      maxEvidence,
      tokenBudget,
    },
    maximumBudget: {
      maxSeedCandidates: Math.max(4, Math.min(12, maxEvidence * 2)),
      maxVisitedNodes: Math.max(48, maxEvidence * 8),
      maxDepth: 3,
      maxEvidence,
      tokenBudget,
    },
  });
  const availableCandidates: ClassifiedCandidate[] = hybrid.coverageHits.map((hit) => ({
    hit,
    categories: classifyCandidate(hit),
  }));
  const driftClaims = await driftedClaimsByPage(params.wikiRoot);
  for (const candidate of availableCandidates) {
    const claimIds = driftClaims.get(candidate.hit.path);
    if (claimIds?.length) candidate.driftClaimIds = claimIds;
  }
  const candidateByPath = new Map(availableCandidates.map((candidate) => [candidate.hit.path, candidate] as const));
  const candidates = hybrid.hits
    .map((hit) => candidateByPath.get(hit.path))
    .filter((candidate): candidate is ClassifiedCandidate => candidate !== undefined);
  const runtime = await getRuntimeWikiGraph(params.wikiRoot, false, {
    persist: params.persistDerivedIndexes ?? false,
  });
  const availableGraph = localTaskGraph(runtime, availableCandidates);
  markGraphDependencies(availableCandidates, availableGraph);
  markContradictionGroups(availableCandidates);
  const taskGraph = localTaskGraph(runtime, candidates);
  const ordered = orderCandidates(candidates, policy.priorities);
  for (const candidate of ordered) {
    const categoryLabels = [...candidate.categories]
      .map((category) => CATEGORY_LABELS[category])
      .join(", ") || "supporting evidence";
    const evidence = evidenceFromRetrievalHit(
      candidate.hit,
      `task ${params.intent}; ${categoryLabels}; hybrid ${profile} W${hybrid.wideningLevel}`
    );
    candidate.evidence = candidate.driftClaimIds?.length ? {
      ...evidence,
      reason: `${evidence.reason}; stale: drift_suspected`,
      stale: true,
      staleReason: "drift_suspected",
      driftClaimIds: [...candidate.driftClaimIds],
    } : evidence;
  }
  const retrieval: TaskContextRetrieval = {
    strategy: "hybrid_progressive_widening",
    coverageMode: hybrid.coverage.coverageMode,
    coverageWarnings: [...hybrid.coverage.warnings],
    query: retrievalQuery,
    profile,
    wideningLevel: hybrid.wideningLevel,
    coverageSufficient: hybrid.coverage.displaySufficient,
    evidenceGaps: [
      ...hybrid.coverage.evidenceGaps,
      ...hybrid.coverage.budgetLimitedGaps.map((gap) => `display_budget:${gap}`),
    ],
    estimatedContextTokens: hybrid.estimatedContextTokens,
    hitCount: hybrid.hits.length,
    coverageCandidateCount: hybrid.coverageHits.length,
    selectedEvidenceCount: hybrid.hits.length,
    fallbackUsed: hybrid.attempts.some((attempt) => attempt.fallbackUsed),
    fullGraphScanAttempted: false,
    attempts: hybrid.attempts.map((attempt) => ({
      level: attempt.level,
      hitCount: attempt.hitCount,
      coverageCandidateCount: attempt.coverageCandidateCount,
      visitedNodes: attempt.visitedNodes,
      visitedEdges: attempt.visitedEdges,
      maxDepthReached: attempt.maxDepthReached,
      maxVisitedNodes: attempt.budget.maxVisitedNodes,
      maxEvidence: attempt.budget.maxEvidence,
      tokenBudget: attempt.budget.tokenBudget,
      fallbackUsed: attempt.fallbackUsed,
    })),
  };

  let selected = [...ordered];
  let context = withSize(contextWithoutSize({
    intent: params.intent,
    objective,
    requestedPaths,
    selected,
    available: availableCandidates,
    allHitCount: ordered.length,
    policy,
    graph: taskGraph,
    coverage: hybrid.coverage,
    retrieval,
    tokenBudget,
  }), tokenBudget);
  while (context.size.heuristicTokens > tokenBudget && selected.length > 1) {
    selected = selected.slice(0, -1);
    context = withSize(contextWithoutSize({
      intent: params.intent,
      objective,
      requestedPaths,
      selected,
      available: availableCandidates,
      allHitCount: ordered.length,
      policy,
      graph: taskGraph,
      coverage: hybrid.coverage,
      retrieval,
      tokenBudget,
    }), tokenBudget);
  }
  return context;
}
