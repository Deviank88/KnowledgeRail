import type { RetrievalHit } from "../core/retrieval-index.js";
import type { WikiPassage } from "../core/page-record.js";
import { wikiPassageId } from "./passage-id.js";
import { wikiPageUri, wikiPassageUri } from "./resource-uri.js";

export type ContextIntent =
  | "understand"
  | "implement"
  | "modify"
  | "debug"
  | "review"
  | "document";

export interface ContextSizeEstimate {
  characters: number;
  utf8Bytes: number;
  /**
   * Model-agnostic heuristic, intentionally conservative for common text.
   * This is NOT an exact tokenizer result and must never be used for hard
   * provider limits without replacing the estimator with a model tokenizer.
   */
  heuristicTokens: number;
  estimator: "utf8-bytes-div-3-v1";
}

export interface EvidenceRef {
  uri: string;
  pageUri: string;
  path: string;
  passageId?: string;
  title: string;
  type: string;
  heading?: string;
  score: number;
  reason: string;
  /** Existing wiki `sources` values are references/paths, not guaranteed URIs. */
  sourceRefs: string[];
  preview: string;
  size: ContextSizeEstimate;
}

export interface KnowledgeGap {
  kind: "missing_evidence" | "contradiction" | "stale_evidence" | "budget_limited";
  description: string;
}

export interface ContextManifest {
  version: 1;
  intent: ContextIntent;
  objective: string;
  evidence: EvidenceRef[];
  gaps: KnowledgeGap[];
  size: ContextSizeEstimate;
  budget: {
    requestedHeuristicTokens?: number;
    withinHeuristicBudget: boolean;
  };
}

export function estimateContextSize(text: string): ContextSizeEstimate {
  const characters = [...text].length;
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  return {
    characters,
    utf8Bytes,
    heuristicTokens: Math.ceil(utf8Bytes / 3),
    estimator: "utf8-bytes-div-3-v1",
  };
}

function compactPreview(text: string, maxCharacters = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chars = [...normalized];
  if (chars.length <= maxCharacters) return normalized;
  return `${chars.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

function resolveHitPassage(hit: RetrievalHit): WikiPassage | undefined {
  const exactHeading = hit.record.passages.filter((passage) => passage.heading === hit.heading);
  if (exactHeading.length === 1) return exactHeading[0];
  if (exactHeading.length > 1) {
    const excerptStart = compactPreview(hit.excerpt, 80);
    return exactHeading.find((passage) => compactPreview(passage.text, 80).startsWith(excerptStart)) ?? exactHeading[0];
  }
  return undefined;
}

export function evidenceFromRetrievalHit(
  hit: RetrievalHit,
  reason = "lexical retrieval"
): EvidenceRef {
  const passage = resolveHitPassage(hit);
  const passageId = passage ? wikiPassageId(passage) : undefined;
  const preview = compactPreview(hit.excerpt);
  const pageUri = wikiPageUri(hit.path);
  return {
    uri: passageId ? wikiPassageUri(hit.path, passageId) : pageUri,
    pageUri,
    path: hit.path,
    passageId,
    title: hit.title,
    type: hit.type,
    heading: hit.heading || undefined,
    score: hit.score,
    reason,
    sourceRefs: [...hit.sources],
    preview,
    size: estimateContextSize(preview),
  };
}

function manifestSerialization(input: Omit<ContextManifest, "size">): string {
  // Exclude per-evidence size metadata from the estimate itself to avoid
  // recursively counting a representation of the count.
  return JSON.stringify({
    version: input.version,
    intent: input.intent,
    objective: input.objective,
    evidence: input.evidence.map(({ size: _size, ...evidence }) => evidence),
    gaps: input.gaps,
    budget: input.budget,
  });
}

export function buildRetrievalContextManifest(params: {
  intent: ContextIntent;
  objective: string;
  hits: readonly RetrievalHit[];
  maxEvidence?: number;
  heuristicTokenBudget?: number;
  reason?: string;
}): ContextManifest {
  const maxEvidence = Math.max(1, params.maxEvidence ?? 10);
  const requestedBudget = params.heuristicTokenBudget;
  const evidence: EvidenceRef[] = [];
  const gaps: KnowledgeGap[] = [];

  for (const hit of params.hits.slice(0, maxEvidence)) {
    const candidate = evidenceFromRetrievalHit(hit, params.reason);
    if (requestedBudget !== undefined) {
      const trialBase = {
        version: 1 as const,
        intent: params.intent,
        objective: params.objective,
        evidence: [...evidence, candidate],
        gaps,
        budget: {
          requestedHeuristicTokens: requestedBudget,
          withinHeuristicBudget: true,
        },
      };
      if (estimateContextSize(manifestSerialization(trialBase)).heuristicTokens > requestedBudget) {
        gaps.push({
          kind: "budget_limited",
          description: `Additional evidence omitted after reaching heuristic manifest budget (${requestedBudget}).`,
        });
        break;
      }
    }
    evidence.push(candidate);
  }

  const base = {
    version: 1 as const,
    intent: params.intent,
    objective: params.objective,
    evidence,
    gaps,
    budget: {
      requestedHeuristicTokens: requestedBudget,
      withinHeuristicBudget: true,
    },
  };
  const size = estimateContextSize(manifestSerialization(base));
  const withinHeuristicBudget = requestedBudget === undefined || size.heuristicTokens <= requestedBudget;

  return {
    ...base,
    budget: { ...base.budget, withinHeuristicBudget },
    size,
  };
}
