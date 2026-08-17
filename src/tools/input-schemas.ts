import { z } from "zod";
import {
  EVIDENCE_CLAIM_KINDS,
  EVIDENCE_CLAIM_ORIGINS,
  EVIDENCE_RELATION_TYPES,
} from "../core/ingestion/evidence-claim.js";
import {
  KNOWLEDGE_RECOVERY_DISCOVERY_METHODS,
} from "../core/knowledge-recovery.js";
import { WIKI_PAGE_TYPES } from "../core/wiki-validation.js";

const CLAIM_KINDS = [...EVIDENCE_CLAIM_KINDS] as [
  (typeof EVIDENCE_CLAIM_KINDS)[number],
  ...(typeof EVIDENCE_CLAIM_KINDS)[number][],
];
const CLAIM_ORIGINS = [...EVIDENCE_CLAIM_ORIGINS] as [
  (typeof EVIDENCE_CLAIM_ORIGINS)[number],
  ...(typeof EVIDENCE_CLAIM_ORIGINS)[number][],
];
const RELATION_TYPES = [...EVIDENCE_RELATION_TYPES] as [
  (typeof EVIDENCE_RELATION_TYPES)[number],
  ...(typeof EVIDENCE_RELATION_TYPES)[number][],
];
const PAGE_TYPES = [...WIKI_PAGE_TYPES] as [
  (typeof WIKI_PAGE_TYPES)[number],
  ...(typeof WIKI_PAGE_TYPES)[number][],
];
const RECOVERY_DISCOVERY_METHODS = [...KNOWLEDGE_RECOVERY_DISCOVERY_METHODS] as [
  (typeof KNOWLEDGE_RECOVERY_DISCOVERY_METHODS)[number],
  ...(typeof KNOWLEDGE_RECOVERY_DISCOVERY_METHODS)[number][],
];

export const EvidenceClaimInputSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(CLAIM_KINDS),
  origin: z.enum(CLAIM_ORIGINS),
  confidence: z.number().min(0).max(1),
  target: z.object({
    entity_key: z.string().optional(),
    page_path: z.string().optional(),
    page_title: z.string().optional(),
    page_type: z.enum(PAGE_TYPES).optional(),
    code_resource_uri: z.string().startsWith("code://repo/").max(4_096).optional(),
  }).optional(),
  relations: z.array(z.object({
    type: z.enum(RELATION_TYPES),
    target_claim_id: z.string().min(1),
  })).optional(),
});

export const RecoveryEventInputSchema = z.object({
  evidence_ref: z.string().min(1).max(4_096),
  source_uri: z.string().min(1).max(4_096),
  discovered_by: z.enum(RECOVERY_DISCOVERY_METHODS),
  expected_wiki_pages: z.array(z.string().min(1)).max(50).optional(),
  reason: z.string().min(1).max(1_024),
});

const CodeActionSchema = z.enum([
  "rebuild",
  "update",
  "remove",
  "search",
  "symbol",
  "references",
  "read",
  "status",
  "record_fallback",
]);

export const RecoveredCodeEvidenceInputSchema = z.object({
  evidence_ref: z.string().min(1).max(4_096),
  source_uri: z.string().min(1).max(4_096),
  expected_wiki_pages: z.array(z.string().min(1)).max(50).optional(),
  reason: z.string().min(1).max(1_024).optional(),
});

export const CodeEvidenceInputSchema = z.object({
  action: CodeActionSchema.describe(
    "status=index; rebuild=recreate; update=refresh; remove=drop; search=find; symbol=definition; references=callers of symbol; read=open URI; record_fallback=raw lookup."
  ),
  path: z.string().min(1).optional(),
  query: z.string().min(1).max(4_096).optional(),
  symbol: z.string().min(1).max(512).optional(),
  symbol_id: z.string().min(1).max(256).optional(),
  resource_uri: z.string().startsWith("code://repo/").optional(),
  path_prefixes: z.array(z.string().min(1)).max(20).optional(),
  kinds: z.array(z.enum(["module", "class", "function", "method", "route", "test", "comment"]))
    .max(7).optional(),
  max_results: z.number().int().min(1).max(100).default(12),
  max_chars: z.number().int().min(1).max(50_000).default(6_000),
  fallback_reason: z.string().min(1).max(1_024).optional(),
  fallback_result_count: z.number().int().nonnegative().optional(),
  recovered_evidence: z.array(RecoveredCodeEvidenceInputSchema).max(100).optional(),
}).superRefine((value, context) => {
  const requiredByAction = {
    update: "path",
    remove: "path",
    search: "query",
    symbol: "symbol",
    references: "symbol_id",
    read: "resource_uri",
    record_fallback: "query",
  } as const;
  const field = requiredByAction[value.action as keyof typeof requiredByAction];
  if (field && value[field] === undefined) {
    context.addIssue({ code: "custom", path: [field], message: `action=${value.action} requires ${field}.` });
  }
  if (value.action === "record_fallback" &&
      (!value.fallback_reason || value.fallback_result_count === undefined)) {
    context.addIssue({
      code: "custom",
      message: "action=record_fallback requires query, fallback_reason and fallback_result_count.",
    });
  }
});
