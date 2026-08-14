import * as path from "node:path";
import { createHash } from "node:crypto";
import { WIKI_PAGE_TYPES, type WikiPageType } from "../wiki-validation.js";

export const EVIDENCE_CLAIM_KINDS = [
  "fact",
  "requirement",
  "decision",
  "constraint",
  "invariant",
  "exception",
  "behavior",
  "risk",
  "incident",
  "procedure",
  "inference",
  "hypothesis",
] as const;

export const EVIDENCE_CLAIM_ORIGINS = [
  "explicit",
  "extracted",
  "inferred",
  "synthesized",
] as const;

export const EVIDENCE_CLAIM_STATUSES = [
  "active",
  "ambiguous",
  "contradicted",
  "superseded",
] as const;

export const EVIDENCE_RELATION_TYPES = [
  "duplicate",
  "contradicts",
  "supersedes",
] as const;

export type EvidenceClaimKind = (typeof EVIDENCE_CLAIM_KINDS)[number];
export type EvidenceClaimOrigin = (typeof EVIDENCE_CLAIM_ORIGINS)[number];
export type EvidenceClaimStatus = (typeof EVIDENCE_CLAIM_STATUSES)[number];
export type EvidenceRelationType = (typeof EVIDENCE_RELATION_TYPES)[number];

export interface EvidenceRelationHint {
  type: EvidenceRelationType;
  targetClaimId: string;
}

export interface EvidenceTargetHint {
  entityKey?: string;
  pagePath?: string;
  pageTitle?: string;
  pageType?: WikiPageType;
}

export interface EvidenceClaim {
  id: string;
  sourceUri: string;
  segmentId: string;
  text: string;
  kind: EvidenceClaimKind;
  origin: EvidenceClaimOrigin;
  confidence: number;
  status: EvidenceClaimStatus;
  target?: EvidenceTargetHint;
  relations: EvidenceRelationHint[];
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceClaimInput {
  id?: string;
  text: string;
  kind: EvidenceClaimKind;
  origin: EvidenceClaimOrigin;
  confidence: number;
  status?: EvidenceClaimStatus;
  target?: EvidenceTargetHint;
  relations?: readonly EvidenceRelationHint[];
}

const KINDS = new Set<string>(EVIDENCE_CLAIM_KINDS);
const ORIGINS = new Set<string>(EVIDENCE_CLAIM_ORIGINS);
const STATUSES = new Set<string>(EVIDENCE_CLAIM_STATUSES);
const RELATIONS = new Set<string>(EVIDENCE_RELATION_TYPES);
const PAGE_TYPES = new Set<string>(WIKI_PAGE_TYPES);

function normalizedIdentityText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizedSourceUri(sourceUri: string): string {
  const slashPath = sourceUri.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashPath);
  if (
    path.posix.isAbsolute(slashPath) || normalized !== slashPath ||
    !normalized.startsWith("docs/") || normalized.split("/").some((part) => part === "." || !part)
  ) {
    throw new Error(`Evidence source URI must stay inside docs/: ${sourceUri}`);
  }
  return normalized;
}

function normalizedPagePath(pagePath: string): string {
  const slashPath = pagePath.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashPath);
  const parts = normalized.split("/");
  if (
    path.posix.isAbsolute(slashPath) || normalized !== slashPath ||
    parts.includes("..") || parts.includes(".") || parts.some((part) => !part) || parts[0]?.startsWith(".") ||
    ["SCHEMA.md", "index.md", "log.md"].includes(normalized) ||
    !normalized.toLowerCase().endsWith(".md")
  ) {
    throw new Error(`Evidence target page must be a relative Markdown path: ${pagePath}`);
  }
  return normalized;
}

function normalizeTarget(target: EvidenceTargetHint | undefined): EvidenceTargetHint | undefined {
  if (!target) return undefined;
  const entityKey = target.entityKey?.replace(/\s+/g, " ").trim() || undefined;
  const pagePath = target.pagePath ? normalizedPagePath(target.pagePath) : undefined;
  const pageTitle = target.pageTitle?.replace(/\s+/g, " ").trim() || undefined;
  if (target.pageType && !PAGE_TYPES.has(target.pageType)) {
    throw new Error(`Unsupported evidence target page type: ${target.pageType}.`);
  }
  if (!entityKey && !pagePath && !pageTitle && !target.pageType) return undefined;
  return {
    ...(entityKey ? { entityKey } : {}),
    ...(pagePath ? { pagePath } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(target.pageType ? { pageType: target.pageType } : {}),
  };
}

function normalizeRelations(relations: readonly EvidenceRelationHint[] | undefined): EvidenceRelationHint[] {
  const unique = new Map<string, EvidenceRelationHint>();
  for (const relation of relations ?? []) {
    const targetClaimId = relation.targetClaimId.trim();
    if (!RELATIONS.has(relation.type)) throw new Error(`Unsupported evidence relation: ${relation.type}.`);
    if (!/^claim-[a-f0-9]{32}$/.test(targetClaimId)) {
      throw new Error(`Invalid target evidence claim ID: ${relation.targetClaimId}.`);
    }
    unique.set(`${relation.type}\0${targetClaimId}`, { type: relation.type, targetClaimId });
  }
  return [...unique.values()].sort((a, b) =>
    a.type.localeCompare(b.type) || a.targetClaimId.localeCompare(b.targetClaimId)
  );
}

export function evidenceClaimId(params: {
  sourceUri: string;
  segmentId: string;
  text: string;
  kind: EvidenceClaimKind;
  origin: EvidenceClaimOrigin;
}): string {
  const identity = [
    "evidence-claim-v1",
    normalizedSourceUri(params.sourceUri),
    params.segmentId,
    normalizedIdentityText(params.text),
    params.kind,
    params.origin,
  ].join("\0");
  return `claim-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

export function createEvidenceClaim(params: {
  sourceUri: string;
  segmentId: string;
  input: EvidenceClaimInput;
  now?: string;
}): EvidenceClaim {
  const sourceUri = normalizedSourceUri(params.sourceUri);
  if (!/^seg-[a-f0-9]{24}$/.test(params.segmentId)) {
    throw new Error(`Invalid source segment ID: ${params.segmentId}.`);
  }
  const text = normalizedIdentityText(params.input.text);
  if (!text) throw new Error("Evidence claim text must not be empty.");
  if (!KINDS.has(params.input.kind)) throw new Error(`Unsupported evidence claim kind: ${params.input.kind}.`);
  if (!ORIGINS.has(params.input.origin)) throw new Error(`Unsupported evidence claim origin: ${params.input.origin}.`);
  if (!Number.isFinite(params.input.confidence) || params.input.confidence < 0 || params.input.confidence > 1) {
    throw new Error("Evidence claim confidence must be between 0 and 1.");
  }
  const status = params.input.status ?? "active";
  if (!STATUSES.has(status)) throw new Error(`Unsupported evidence claim status: ${status}.`);
  const target = normalizeTarget(params.input.target);
  const id = evidenceClaimId({
    sourceUri,
    segmentId: params.segmentId,
    text,
    kind: params.input.kind,
    origin: params.input.origin,
  });
  if (params.input.id && params.input.id !== id) {
    throw new Error(`Evidence claim ID does not match its content-addressed identity: ${params.input.id}.`);
  }
  const now = params.now ?? new Date().toISOString();
  return {
    id,
    sourceUri,
    segmentId: params.segmentId,
    text,
    kind: params.input.kind,
    origin: params.input.origin,
    confidence: params.input.confidence,
    status,
    ...(target ? { target } : {}),
    relations: normalizeRelations(params.input.relations),
    createdAt: now,
    updatedAt: now,
  };
}

export function evidenceClaimIsValid(value: unknown): value is EvidenceClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<EvidenceClaim>;
  try {
    if (
      typeof claim.id !== "string" || typeof claim.sourceUri !== "string" ||
      typeof claim.segmentId !== "string" || typeof claim.text !== "string" ||
      typeof claim.kind !== "string" || typeof claim.origin !== "string" ||
      typeof claim.confidence !== "number" || typeof claim.status !== "string" ||
      !Array.isArray(claim.relations) || typeof claim.createdAt !== "string" ||
      typeof claim.updatedAt !== "string"
    ) return false;
    const normalized = createEvidenceClaim({
      sourceUri: claim.sourceUri,
      segmentId: claim.segmentId,
      input: {
        id: claim.id,
        text: claim.text,
        kind: claim.kind as EvidenceClaimKind,
        origin: claim.origin as EvidenceClaimOrigin,
        confidence: claim.confidence,
        status: claim.status as EvidenceClaimStatus,
        target: claim.target,
        relations: claim.relations,
      },
      now: claim.createdAt,
    });
    return normalized.sourceUri === claim.sourceUri && normalized.segmentId === claim.segmentId &&
      normalized.text === claim.text && normalized.kind === claim.kind &&
      normalized.origin === claim.origin && normalized.confidence === claim.confidence &&
      normalized.status === claim.status &&
      JSON.stringify(normalized.target ?? null) === JSON.stringify(claim.target ?? null) &&
      JSON.stringify(normalized.relations) === JSON.stringify(claim.relations);
  } catch {
    return false;
  }
}

export function normalizedClaimText(text: string): string {
  return normalizedIdentityText(text).toLocaleLowerCase("en-US");
}
