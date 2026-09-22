import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalCodeResourceUri, parseCodeResourceUri } from "../code-evidence/resource-uri.js";
import type { CodeAnchor } from "../code-evidence/types.js";
import { WIKI_PAGE_TYPES, type WikiPageType } from "../wiki-validation.js";
import { normalizeWikiPagePath } from "../wiki-page-path.js";
import {
  emailDomainsInText,
  normalizeEmailDomain,
  redactEmailAddresses,
  stakeholderAffiliation,
  STAKEHOLDER_AFFILIATIONS,
  type StakeholderAffiliation,
} from "../stakeholder.js";

export const EVIDENCE_CLAIM_KINDS = [
  "fact",
  "stakeholder",
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
  role?: string;
  organization?: string;
  emailDomain?: string;
  affiliation?: StakeholderAffiliation;
  codeResourceUri?: string;
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
  codeAnchor?: CodeAnchor;
  relations: EvidenceRelationHint[];
  createdAt: string;
  updatedAt: string;
  validFrom?: string;
  validUntil?: string;
  provenance?: Array<{ kind: "commit" | "pull_request"; reference: string }>;
  testEvidence?: Array<{ resourceUri: string; anchor: CodeAnchor }>;
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
  validFrom?: string;
  validUntil?: string;
  provenance?: EvidenceClaim["provenance"];
  verifiedBy?: readonly string[];
}

const KINDS = new Set<string>(EVIDENCE_CLAIM_KINDS);
const ORIGINS = new Set<string>(EVIDENCE_CLAIM_ORIGINS);
const STATUSES = new Set<string>(EVIDENCE_CLAIM_STATUSES);
const RELATIONS = new Set<string>(EVIDENCE_RELATION_TYPES);
const PAGE_TYPES = new Set<string>(WIKI_PAGE_TYPES);
const AFFILIATIONS = new Set<string>(STAKEHOLDER_AFFILIATIONS);

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
  try {
    return normalizeWikiPagePath(pagePath, { allowWikiRootPrefix: true });
  } catch {
    throw new Error(`Evidence target page must be a relative Markdown path: ${pagePath}`);
  }
}

function normalizeTarget(target: EvidenceTargetHint | undefined): EvidenceTargetHint | undefined {
  if (!target) return undefined;
  const entityKey = target.entityKey?.replace(/\s+/g, " ").trim() || undefined;
  const pagePath = target.pagePath ? normalizedPagePath(target.pagePath) : undefined;
  const pageTitle = target.pageTitle?.replace(/\s+/g, " ").trim() || undefined;
  const role = target.role?.replace(/\s+/g, " ").trim() || undefined;
  if (role && (role.length > 256 || /[\u0000-\u001f\u007f]/u.test(role))) {
    throw new Error("Stakeholder role must contain at most 256 printable characters.");
  }
  const organization = target.organization?.replace(/\s+/g, " ").trim() || undefined;
  if (organization && (organization.length > 256 || /[\u0000-\u001f\u007f]/u.test(organization))) {
    throw new Error("Stakeholder organization must contain at most 256 printable characters.");
  }
  const emailDomain = target.emailDomain ? normalizeEmailDomain(target.emailDomain) : undefined;
  if (target.emailDomain && !emailDomain) {
    throw new Error("Stakeholder emailDomain must contain a domain only, never a complete address.");
  }
  if (target.affiliation && !AFFILIATIONS.has(target.affiliation)) {
    throw new Error(`Unsupported stakeholder affiliation: ${target.affiliation}.`);
  }
  const codeResourceUri = target.codeResourceUri
    ? canonicalCodeResourceUri(target.codeResourceUri)
    : undefined;
  if (target.pageType && !PAGE_TYPES.has(target.pageType)) {
    throw new Error(`Unsupported evidence target page type: ${target.pageType}.`);
  }
  if (
    !entityKey && !pagePath && !pageTitle && !target.pageType && !role && !organization &&
    !emailDomain && !target.affiliation && !codeResourceUri
  ) return undefined;
  return {
    ...(entityKey ? { entityKey } : {}),
    ...(pagePath ? { pagePath } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(target.pageType ? { pageType: target.pageType } : {}),
    ...(role ? { role } : {}),
    ...(organization ? { organization } : {}),
    ...(emailDomain ? { emailDomain } : {}),
    ...(target.affiliation ? { affiliation: target.affiliation } : {}),
    ...(codeResourceUri ? { codeResourceUri } : {}),
  };
}

function normalizeCodeAnchor(anchor: CodeAnchor | undefined, historical = false): CodeAnchor | undefined {
  if (!anchor) return undefined;
  const normalizedPath = anchor.path.replace(/\\/g, "/").normalize("NFC");
  if (
    !normalizedPath || normalizedPath !== anchor.path || path.posix.isAbsolute(normalizedPath) ||
    /^[A-Za-z]:/u.test(normalizedPath) ||
    path.posix.normalize(normalizedPath) !== normalizedPath ||
    normalizedPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Evidence code anchor must be repository-relative: ${anchor.path}`);
  }
  if (
    !Number.isInteger(anchor.startLine) || !Number.isInteger(anchor.endLine) ||
    anchor.startLine < 1 || anchor.endLine < anchor.startLine
  ) throw new Error("Evidence code anchor line range is invalid.");
  if (!/^[a-f0-9]{64}$/.test(anchor.rangeHash)) {
    throw new Error("Evidence code anchor rangeHash must be a lowercase SHA-256 digest.");
  }
  if (typeof anchor.parserVersion !== "string") {
    throw new Error("Evidence code anchor parserVersion must be a string.");
  }
  const parserVersion = anchor.parserVersion.normalize("NFKC").trim();
  if (!parserVersion || parserVersion.length > 256 || /[\u0000-\u001f\u007f]/.test(parserVersion)) {
    throw new Error("Evidence code anchor parserVersion must contain 1-256 printable characters.");
  }
  if (typeof anchor.capturedAt !== "string" || Number.isNaN(Date.parse(anchor.capturedAt))) {
    throw new Error("Evidence code anchor capturedAt must be ISO-8601 compatible.");
  }
  if (anchor.revision !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(anchor.revision)) throw new Error("Invalid Git anchor revision.");
  if (anchor.history !== undefined && (historical || !Array.isArray(anchor.history))) throw new Error("Invalid anchor history.");
  return {
    path: normalizedPath,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    rangeHash: anchor.rangeHash,
    parserVersion,
    capturedAt: anchor.capturedAt,
    ...(anchor.revision ? { revision: anchor.revision } : {}),
    ...(anchor.history ? { history: anchor.history.map((item) => normalizeCodeAnchor(item, true)!) } : {}),
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
  const durableText = params.kind === "stakeholder"
    ? redactEmailAddresses(params.text)
    : params.text;
  const identity = [
    "evidence-claim-v1",
    normalizedSourceUri(params.sourceUri),
    params.segmentId,
    normalizedIdentityText(durableText),
    params.kind,
    params.origin,
  ].join("\0");
  return `claim-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

export function createEvidenceClaim(params: {
  sourceUri: string;
  segmentId: string;
  input: EvidenceClaimInput;
  codeAnchor?: CodeAnchor;
  testEvidence?: EvidenceClaim["testEvidence"];
  now?: string;
  /** `null` means identity was resolved but its domain is unknown. */
  userEmailDomain?: string | null;
}): EvidenceClaim {
  const sourceUri = normalizedSourceUri(params.sourceUri);
  if (!/^seg-[a-f0-9]{24}$/.test(params.segmentId)) {
    throw new Error(`Invalid source segment ID: ${params.segmentId}.`);
  }
  let text = normalizedIdentityText(params.input.text);
  if (!text) throw new Error("Evidence claim text must not be empty.");
  if (!KINDS.has(params.input.kind)) throw new Error(`Unsupported evidence claim kind: ${params.input.kind}.`);
  if (!ORIGINS.has(params.input.origin)) throw new Error(`Unsupported evidence claim origin: ${params.input.origin}.`);
  if (!Number.isFinite(params.input.confidence) || params.input.confidence < 0 || params.input.confidence > 1) {
    throw new Error("Evidence claim confidence must be between 0 and 1.");
  }
  const status = params.input.status ?? "active";
  if (!STATUSES.has(status)) throw new Error(`Unsupported evidence claim status: ${status}.`);
  let target = normalizeTarget(params.input.target);
  if (params.input.kind === "stakeholder") {
    if (target?.pageType && target.pageType !== "stakeholder") {
      throw new Error("Stakeholder evidence must target a stakeholder page.");
    }
    if (!target?.entityKey && !target?.pageTitle && !target?.pagePath) {
      throw new Error("Stakeholder evidence requires a stable entity key, page title, or page path.");
    }
    const detectedDomains = emailDomainsInText(text);
    if (target?.emailDomain && detectedDomains.length > 0 && !detectedDomains.includes(target.emailDomain)) {
      throw new Error(
        `Stakeholder target emailDomain ${target.emailDomain} contradicts the email domain(s) in the claim text.`
      );
    }
    const emailDomain = target?.emailDomain ?? (detectedDomains.length === 1 ? detectedDomains[0] : undefined);
    const classifyAffiliation = Object.prototype.hasOwnProperty.call(params, "userEmailDomain");
    target = normalizeTarget({
      ...(target ?? {}),
      ...(emailDomain ? { emailDomain } : {}),
      ...(classifyAffiliation ? {
        affiliation: stakeholderAffiliation({
          stakeholderEmailDomain: emailDomain,
          userEmailDomain: params.userEmailDomain,
          explicitAffiliation: target?.affiliation,
        }),
      } : {}),
      pageType: "stakeholder",
    });
    text = normalizedIdentityText(redactEmailAddresses(text));
  } else if (
    target?.role || target?.organization || target?.emailDomain || target?.affiliation
  ) {
    throw new Error("Stakeholder profile fields are valid only for kind=stakeholder claims.");
  }
  const codeAnchor = normalizeCodeAnchor(params.codeAnchor);
  if (codeAnchor && !target?.codeResourceUri) {
    throw new Error("Evidence code anchors require a codeResourceUri target.");
  }
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
  const validFrom = params.input.validFrom, validUntil = params.input.validUntil;
  for (const timestamp of [now, validFrom, validUntil]) if (timestamp !== undefined &&
    (typeof timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))) throw new Error("Claim validity requires UTC ISO timestamps.");
  if (validUntil && Date.parse(validUntil) < Date.parse(validFrom ?? now)) throw new Error("Claim validUntil precedes validFrom.");
  const provenance = params.input.provenance?.map((item) => {
    if (item.kind === "commit" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(item.reference)) return { ...item };
    if (item.kind === "pull_request") {
      const url = new URL(item.reference);
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname !== "/" &&
        !/[\u0000-\u0020<>`]/u.test(item.reference)) return { ...item };
    }
    throw new Error("Provenance requires a full commit hash or HTTPS pull-request URL.");
  });
  if ((provenance?.length ?? 0) > 16 || (params.testEvidence?.length ?? 0) > 8) throw new Error("Too many evidence references.");
  const testEvidence = params.testEvidence?.map((item) => {
    const resourceUri = canonicalCodeResourceUri(item.resourceUri), anchor = normalizeCodeAnchor(item.anchor)!;
    if (!anchor || parseCodeResourceUri(resourceUri).path !== anchor.path) throw new Error("Test evidence URI and anchor path differ.");
    return { resourceUri, anchor };
  });
  if (testEvidence && new Set(testEvidence.map((item) => item.resourceUri)).size !== testEvidence.length) throw new Error("Duplicate test evidence references.");
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
    ...(codeAnchor ? { codeAnchor } : {}),
    relations: normalizeRelations(params.input.relations),
    createdAt: now,
    updatedAt: now,
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(provenance?.length ? { provenance } : {}),
    ...(testEvidence?.length ? { testEvidence } : {}),
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
        validFrom: claim.validFrom,
        validUntil: claim.validUntil,
        provenance: claim.provenance,
      },
      codeAnchor: claim.codeAnchor,
      testEvidence: claim.testEvidence,
      now: claim.createdAt,
    });
    return normalized.sourceUri === claim.sourceUri && normalized.segmentId === claim.segmentId &&
      normalized.text === claim.text && normalized.kind === claim.kind &&
      normalized.origin === claim.origin && normalized.confidence === claim.confidence &&
      normalized.status === claim.status &&
      JSON.stringify(normalized.target ?? null) === JSON.stringify(claim.target ?? null) &&
      JSON.stringify(normalized.codeAnchor ?? null) === JSON.stringify(claim.codeAnchor ?? null) &&
      JSON.stringify(normalized.testEvidence ?? null) === JSON.stringify(claim.testEvidence ?? null) &&
      JSON.stringify(normalized.provenance ?? null) === JSON.stringify(claim.provenance ?? null) &&
      normalized.validFrom === claim.validFrom && normalized.validUntil === claim.validUntil &&
      JSON.stringify(normalized.relations) === JSON.stringify(claim.relations);
  } catch {
    return false;
  }
}

export function normalizedClaimText(text: string): string {
  return normalizedIdentityText(text).toLocaleLowerCase("en-US");
}

/** Valid time is independent of recording time; the upper bound is exclusive. */
export function claimValidAt(claim: EvidenceClaim, asOf: string): boolean {
  const at = Date.parse(asOf);
  return Number.isFinite(at) && Date.parse(claim.validFrom ?? claim.createdAt) <= at &&
    (!claim.validUntil || at < Date.parse(claim.validUntil)) &&
    (claim.status !== "superseded" || !!claim.validUntil);
}
