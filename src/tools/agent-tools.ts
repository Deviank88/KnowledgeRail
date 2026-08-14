import type {
  CallToolResult,
  ContentBlock,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_TYPES } from "../config/document-contracts.js";
import { EDITORIAL_EVIDENCE_KINDS } from "../config/editorial-plans.js";
import {
  EVIDENCE_CLAIM_KINDS,
  EVIDENCE_CLAIM_ORIGINS,
  EVIDENCE_RELATION_TYPES,
} from "../core/ingestion/evidence-claim.js";
import { resolveEvidenceClaims } from "../core/ingestion/evidence-linker.js";
import {
  reconcileEvidenceCoverage,
  recordEvidenceClaims,
} from "../core/ingestion/evidence-pipeline.js";
import {
  applyEvidenceSynthesis,
  planEvidenceSynthesis,
} from "../core/ingestion/evidence-synthesis.js";
import {
  KNOWLEDGE_RECOVERY_DISCOVERY_METHODS,
  KNOWLEDGE_RECOVERY_RESOLUTIONS,
} from "../core/knowledge-recovery.js";
import { docsCategoryFilePath, wikiDir } from "../core/paths.js";
import { FILE_CATEGORIES } from "../core/report-workflow.js";
import { readFileSafe } from "../core/utils.js";
import { WIKI_PAGE_TYPES } from "../core/wiki-validation.js";
import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type ProtocolEra,
  type ToolKey,
} from "../mcp/tool-names.js";
import { errorResult, finalizePageMutation } from "./helpers.js";
import { createOperationRegistry } from "./operation-registry.js";

type OperationResult = CallToolResult | InputRequiredResult;

interface NextAction {
  tool: AgentToolName;
  action?: string;
  requiredArguments: string[];
  suggestedArguments?: Record<string, unknown>;
}

const CATEGORY_ENUM = [...FILE_CATEGORIES] as [
  (typeof FILE_CATEGORIES)[number],
  ...(typeof FILE_CATEGORIES)[number][],
];
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
const RECOVERY_RESOLUTIONS = KNOWLEDGE_RECOVERY_RESOLUTIONS.filter(
  (resolution) => resolution !== "pending"
) as [
  Exclude<(typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number], "pending">,
  ...Exclude<(typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number], "pending">[],
];

const ContextSchema = z.object({
  mode: z.enum(["task", "search", "graph"]).default("task")
    .describe("task=bounded agent context; search=lexical diagnostic; graph=relations/traceability."),
  intent: z.enum(["understand", "implement", "modify", "debug", "review", "document"]).default("understand"),
  objective: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  changed_paths: z.array(z.string().min(1).max(1_024)).max(20).optional(),
  page_types: z.array(z.string().min(1).max(128)).max(20).optional(),
  retrieval_profile: z.enum(["precision", "balanced", "coverage"]).default("balanced"),
  max_evidence: z.number().int().min(1).max(20).default(8),
  heuristic_token_budget: z.number().int().min(256).max(12_000).default(2_000),
  response_detail: z.enum(["compact", "full"]).default("compact")
    .describe("Keep compact for normal agent tasks; full is only for diagnostics or compatibility integrations."),
  max_results: z.number().int().min(1).max(100).default(10),
  max_nodes: z.number().int().min(1).max(100).default(12),
  max_depth: z.number().int().min(0).max(8).default(1),
  view: z.enum(["subgraph", "traceability"]).default("subgraph"),
}).superRefine((value, context) => {
  if (value.mode === "task" && !value.objective) {
    context.addIssue({ code: "custom", path: ["objective"], message: "mode=task requires objective." });
  }
  if (value.mode === "graph" && value.view === "subgraph" && !value.query) {
    context.addIssue({ code: "custom", path: ["query"], message: "graph subgraph mode requires query." });
  }
});

const PageSchema = z.object({
  action: z.enum(["read", "write", "edit", "move", "delete", "append_log"])
    .describe("Required fields: read path|resource_uri; write path+content; edit path+old_string+new_string; move old_path+new_path; delete path; append_log entry."),
  path: z.string().optional(),
  resource_uri: z.string().startsWith("knowledge-rail://page/").optional(),
  max_chars: z.number().int().min(1).max(50_000).default(6_000),
  content: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().default(false),
  old_path: z.string().optional(),
  new_path: z.string().optional(),
  dry_run: z.boolean().default(false),
  entry: z.string().optional(),
  level: z.enum(["INFO", "WARN", "ACTION", "DECISION"]).default("ACTION"),
}).superRefine((value, context) => {
  const require = (field: keyof typeof value): void => {
    if (value[field] === undefined || value[field] === "") {
      context.addIssue({ code: "custom", path: [field], message: `action=${value.action} requires ${field}.` });
    }
  };
  if (value.action === "read") {
    if (Boolean(value.path) === Boolean(value.resource_uri)) {
      context.addIssue({ code: "custom", message: "action=read requires exactly one of path or resource_uri." });
    }
  } else if (value.action === "write") {
    require("path"); require("content");
  } else if (value.action === "edit") {
    require("path"); require("old_string"); require("new_string");
  } else if (value.action === "move") {
    require("old_path"); require("new_path");
  } else if (value.action === "delete") {
    require("path");
  } else {
    require("entry");
  }
});

const FilesSchema = z.object({
  action: z.enum(["list", "read", "normalize"]).default("list")
    .describe("read requires category+path; normalize requires a source category+path."),
  category: z.enum(CATEGORY_ENUM).optional(),
  pattern: z.string().default("**/*"),
  path: z.string().optional(),
  max_chars: z.number().int().positive().optional(),
  overwrite: z.boolean().default(false),
}).superRefine((value, context) => {
  if ((value.action === "read" || value.action === "normalize") && (!value.category || !value.path)) {
    context.addIssue({ code: "custom", message: `action=${value.action} requires category and path.` });
  }
});

const ClaimSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(CLAIM_KINDS),
  origin: z.enum(CLAIM_ORIGINS),
  confidence: z.number().min(0).max(1),
  target: z.object({
    entity_key: z.string().optional(),
    page_path: z.string().optional(),
    page_title: z.string().optional(),
    page_type: z.enum(PAGE_TYPES).optional(),
  }).optional(),
  relations: z.array(z.object({
    type: z.enum(RELATION_TYPES),
    target_claim_id: z.string(),
  })).optional(),
});

const RecoveryEventSchema = z.object({
  evidence_ref: z.string().min(1).max(4_096),
  source_uri: z.string().min(1).max(4_096),
  discovered_by: z.enum(RECOVERY_DISCOVERY_METHODS),
  expected_wiki_pages: z.array(z.string().min(1)).max(50).optional(),
  reason: z.string().min(1).max(1_024),
});

const IngestSchema = z.object({
  action: z.enum([
    "start",
    "next",
    "apply",
    "status",
    "finalize",
    "report",
    "record_recovery",
    "resolve_recovery",
  ]).describe("Source loop: start -> next -> apply -> status -> finalize. report handles development reports."),
  normalized_filename: z.string().optional(),
  max_chars: z.number().int().positive().default(12_000),
  segment_max_chars: z.number().int().min(256).max(50_000).optional(),
  segment_id: z.string().optional(),
  claims: z.array(ClaimSchema).min(1).optional(),
  segment_status: z.enum(["irrelevant", "unresolved", "legacy_unverified"]).optional(),
  evidence_refs: z.array(z.string()).optional(),
  page_refs: z.array(z.string()).optional(),
  reason: z.string().optional(),
  report_filename: z.string().optional(),
  claim_ids: z.array(z.string()).optional(),
  include_resolved: z.boolean().default(false),
  total_evidence_used: z.number().int().nonnegative().optional(),
  recovery_events: z.array(RecoveryEventSchema).max(100).optional(),
  recovery_event_id: z.string().optional(),
  recovery_resolution: z.enum(RECOVERY_RESOLUTIONS).optional(),
  recovery_page_refs: z.array(z.string().min(1)).max(50).optional(),
  recovery_reason: z.string().min(1).max(1_024).optional(),
}).superRefine((value, context) => {
  const sourceAction = ["start", "next", "apply", "finalize"].includes(value.action) ||
    (value.action === "status" && value.normalized_filename !== undefined);
  if (sourceAction && !value.normalized_filename) {
    context.addIssue({ code: "custom", path: ["normalized_filename"], message: `action=${value.action} requires normalized_filename.` });
  }
  if (value.action === "apply") {
    if (!value.segment_id) context.addIssue({ code: "custom", path: ["segment_id"], message: "action=apply requires segment_id." });
    if (Boolean(value.claims?.length) === Boolean(value.segment_status)) {
      context.addIssue({ code: "custom", message: "action=apply requires exactly one of claims or segment_status." });
    }
    if (value.segment_status && !value.reason) {
      context.addIssue({ code: "custom", path: ["reason"], message: "A manual segment status requires reason." });
    }
  }
  if (value.action === "report" && !value.report_filename) {
    context.addIssue({ code: "custom", path: ["report_filename"], message: "action=report requires report_filename." });
  }
  if (value.action === "record_recovery" &&
      (value.total_evidence_used === undefined || value.recovery_events === undefined)) {
    context.addIssue({ code: "custom", message: "action=record_recovery requires total_evidence_used and recovery_events." });
  }
  if (value.action === "resolve_recovery" &&
      (!value.recovery_event_id || !value.recovery_resolution || !value.recovery_reason)) {
    context.addIssue({ code: "custom", message: "action=resolve_recovery requires recovery_event_id, recovery_resolution and recovery_reason." });
  }
});

const CodeSchema = z.object({
  action: z.enum(["status", "rebuild", "update", "remove", "search", "symbol", "references", "read", "record_fallback"])
    .describe("Required: update/remove path; search query; symbol symbol; references symbol_id; read resource_uri; record_fallback query+fallback_reason+fallback_result_count."),
  path: z.string().min(1).optional(),
  query: z.string().min(1).max(4_096).optional(),
  symbol: z.string().min(1).max(512).optional(),
  symbol_id: z.string().min(1).max(256).optional(),
  resource_uri: z.string().startsWith("code://repo/").optional(),
  path_prefixes: z.array(z.string().min(1)).max(20).optional(),
  kinds: z.array(z.enum(["module", "class", "function", "method", "route", "test", "comment"])).max(7).optional(),
  max_results: z.number().int().min(1).max(100).default(12),
  max_chars: z.number().int().min(1).max(50_000).default(6_000),
  fallback_reason: z.string().min(1).max(1_024).optional(),
  fallback_result_count: z.number().int().nonnegative().optional(),
  recovered_evidence: z.array(z.object({
    evidence_ref: z.string().min(1).max(4_096),
    source_uri: z.string().min(1).max(4_096),
    expected_wiki_pages: z.array(z.string().min(1)).max(50).optional(),
    reason: z.string().min(1).max(1_024).optional(),
  })).max(100).optional(),
}).superRefine((value, context) => {
  const required: Partial<Record<typeof value.action, keyof typeof value>> = {
    update: "path", remove: "path", search: "query", symbol: "symbol",
    references: "symbol_id", read: "resource_uri", record_fallback: "query",
  };
  const field = required[value.action];
  if (field && value[field] === undefined) {
    context.addIssue({ code: "custom", path: [field], message: `action=${value.action} requires ${field}.` });
  }
  if (value.action === "record_fallback" &&
      (!value.fallback_reason || value.fallback_result_count === undefined)) {
    context.addIssue({ code: "custom", message: "action=record_fallback requires fallback_reason and fallback_result_count." });
  }
});

const DocumentContextSchema = z.object({
  action: z.enum(["plan", "section"]),
  document_type: z.enum(DOCUMENT_TYPES),
  project_name: z.string().optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  max_sections: z.number().int().positive().optional(),
  section_title: z.string().optional(),
  query: z.string().optional(),
  language: z.string().optional(),
  required_evidence: z.array(z.enum(EDITORIAL_EVIDENCE_KINDS)).optional(),
  preferred_evidence: z.array(z.enum(EDITORIAL_EVIDENCE_KINDS)).optional(),
  page_paths: z.array(z.string()).optional(),
  page_types: z.array(z.string()).optional(),
  max_pages: z.number().int().positive().default(8),
  max_chars_per_page: z.number().int().positive().default(6_000),
  max_total_chars: z.number().int().positive().default(30_000),
  max_output_chars: z.number().int().positive().optional(),
  heuristic_token_budget: z.number().int().min(256).max(12_000).optional(),
  retrieval_profile: z.enum(["precision", "balanced", "coverage"]).default("coverage"),
}).superRefine((value, context) => {
  if (value.action === "section" && !value.section_title) {
    context.addIssue({ code: "custom", path: ["section_title"], message: "action=section requires section_title." });
  }
});

const DocumentSchema = z.object({
  action: z.enum(["write", "review", "export"])
    .describe("write requires filename+title+document_type+content; review filename+document_type; export adds client+project."),
  filename: z.string(),
  document_type: z.enum(DOCUMENT_TYPES),
  title: z.string().optional(),
  content: z.string().optional(),
  project_name: z.string().optional(),
  language: z.string().optional(),
  client_facing: z.boolean().optional(),
  include_wiki_update_plan: z.boolean().default(true),
  client: z.string().optional(),
  project: z.string().optional(),
  category_label: z.string().optional(),
  subtitle: z.string().default(""),
  version: z.string().default("1.0"),
  date: z.string().optional(),
  status: z.string().default("Reviewed"),
  overwrite: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.action === "write" && (!value.title || !value.content)) {
    context.addIssue({ code: "custom", message: "action=write requires title and content." });
  }
  if (value.action === "export" && (!value.client || !value.project)) {
    context.addIssue({ code: "custom", message: "action=export requires client and project." });
  }
});

const AdminSchema = z.object({
  action: z.enum(["init", "lint", "migrate"]),
  force: z.boolean().default(false),
  include_orphans: z.boolean().default(true),
  include_missing: z.boolean().default(true),
  include_broken_links: z.boolean().default(true),
  migration_action: z.enum(["plan", "apply", "rollback"]).default("plan"),
  target_version: z.string().default("4"),
  dry_run: z.boolean().optional(),
  backup: z.boolean().default(false),
  run_id: z.string().optional(),
}).superRefine((value, context) => {
  if (value.action === "migrate" && value.migration_action === "rollback" && !value.run_id) {
    context.addIssue({ code: "custom", path: ["run_id"], message: "migration_action=rollback requires run_id." });
  }
});

const REFERENCE_REPLACEMENTS = new Map<string, string>([
  ["knowledge_menu", "the appropriate KnowledgeRail domain tool"],
  ["wiki_menu", "the appropriate KnowledgeRail domain tool"],
  ["knowledge_normalize_source", "knowledge_files action=normalize"],
  ["knowledge_prepare_request_ingestion", "knowledge_ingest action=report"],
  ["knowledge_prepare_source_ingestion", "knowledge_ingest"],
  ["knowledge_evidence_ir", "knowledge_ingest"],
  ["knowledge_code_evidence", "knowledge_code"],
  ["knowledge_plan_document", "knowledge_document_context action=plan"],
  ["knowledge_section_context", "knowledge_document_context action=section"],
  ["knowledge_write_document", "knowledge_document action=write"],
  ["knowledge_review_document", "knowledge_document action=review"],
  ["knowledge_export_docx", "knowledge_document action=export"],
  ["knowledge_init", "knowledge_admin action=init"],
  ["wiki_init", "knowledge_admin action=init"],
  ["wiki_write_page", "knowledge_page action=write"],
  ["wiki_edit_page", "knowledge_page action=edit"],
  ["wiki_read_page", "knowledge_page action=read"],
  ["wiki_read_resource", "knowledge_page action=read"],
  ["wiki_delete_page", "knowledge_page action=delete"],
  ["wiki_move_page", "knowledge_page action=move"],
  ["wiki_append_log", "knowledge_page action=append_log"],
  ["wiki_search", "knowledge_context mode=search"],
  ["wiki_graph_query", "knowledge_context mode=graph"],
  ["wiki_lint", "knowledge_admin action=lint"],
  ["wiki_migrate", "knowledge_admin action=migrate"],
]);

function publicText(text: string): string {
  let output = text;
  for (const [oldReference, replacement] of REFERENCE_REPLACEMENTS) {
    output = output.replaceAll(oldReference, replacement);
  }
  return output;
}

function isCallToolResult(result: OperationResult): result is CallToolResult {
  return "content" in result && Array.isArray(result.content);
}

function withGuidance(
  result: OperationResult,
  state: string,
  nextAction: NextAction | null,
  guidance?: string,
  mirrorText = false
): OperationResult {
  if (!isCallToolResult(result)) return result;
  const content = result.content.map((item): ContentBlock =>
    item.type === "text" ? { ...item, text: publicText(item.text) } : item
  );
  const effectiveNext = result.isError ? null : nextAction;
  if (!result.isError && effectiveNext) {
    content.push({
      type: "text",
      text: `Next: ${effectiveNext.tool}${effectiveNext.action ? ` action=${effectiveNext.action}` : ""}; ` +
        `required arguments: ${effectiveNext.requiredArguments.join(", ") || "none"}.`,
    });
  }
  const previous = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : {};
  const resultText = content
    .filter((item): item is Extract<ContentBlock, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const includeResultText = Boolean(resultText) && (
    result.isError === true ||
    Object.keys(previous).length === 0 ||
    mirrorText
  );
  return {
    ...result,
    content,
    structuredContent: {
      ...previous,
      ...(includeResultText ? { resultText } : {}),
      state: result.isError ? "blocked" : state,
      nextAction: effectiveNext,
      ...(guidance ? { guidance } : {}),
    },
  };
}

function sourceUri(normalizedFilename: string): string {
  return `docs/normalized/${normalizedFilename.replace(/\\/g, "/")}`;
}

async function applyEvidenceSegment(args: z.output<typeof IngestSchema>): Promise<CallToolResult> {
  const normalizedFilename = args.normalized_filename!;
  const segmentId = args.segment_id!;
  const content = await readFileSafe(docsCategoryFilePath("normalized", normalizedFilename));
  if (content === null) return errorResult(`Fonte normalizzata non trovata: ${normalizedFilename}`);
  const recorded = await recordEvidenceClaims({
    wikiRoot: wikiDir(),
    sourceUri: sourceUri(normalizedFilename),
    sourceContent: content,
    segmentId,
    claims: args.claims!.map((claim) => ({
      text: claim.text,
      kind: claim.kind,
      origin: claim.origin,
      confidence: claim.confidence,
      target: claim.target ? {
        entityKey: claim.target.entity_key,
        pagePath: claim.target.page_path,
        pageTitle: claim.target.page_title,
        pageType: claim.target.page_type,
      } : undefined,
      relations: claim.relations?.map((relation) => ({
        type: relation.type,
        targetClaimId: relation.target_claim_id,
      })),
    })),
  });
  const claimIds = recorded.claims.map((claim) => claim.id);
  const resolutions = await resolveEvidenceClaims({ wikiRoot: wikiDir(), claimIds });
  const planned = await planEvidenceSynthesis({ wikiRoot: wikiDir(), claimIds });
  const drafts = await applyEvidenceSynthesis({ wikiRoot: wikiDir(), claimIds });
  const index = drafts.length > 0
    ? await finalizePageMutation(drafts.map((draft) => draft.pagePath))
    : "Nessuna pagina da aggiornare.";
  const coverage = await reconcileEvidenceCoverage(wikiDir());
  return {
    content: [{
      type: "text",
      text: [
        `Segmento applicato: ${segmentId}.`,
        `Claim: ${recorded.claims.length} (${recorded.created} nuovi, ${recorded.reused} riusati).`,
        `Risoluzioni: ${resolutions.length}; bozze validate: ${planned.length}; pagine aggiornate: ${drafts.length}.`,
        `Coverage: ${coverage.segmentsRecorded} segmenti rappresentati; ${coverage.segmentsPending} pending.`,
        index,
      ].join("\n"),
    }],
    structuredContent: {
      segmentId,
      claimIds,
      resolutions,
      pages: drafts.map((draft) => ({ path: draft.pagePath, mode: draft.mode, claimIds: draft.claimIds })),
      coverage,
    },
  };
}

function omit<T extends Record<string, unknown>>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

export function registerAgentTools(server: McpServer, era: ProtocolEra = "modern"): void {
  const operations = createOperationRegistry(era);
  const call = (key: ToolKey, args: unknown, context: ServerContext) =>
    operations.call(key, args, context);

  server.registerTool(AGENT_TOOL_NAMES.context, {
    title: "Retrieve project knowledge",
    description: "Primary read tool. Use mode=task with default compact output; search/graph and full detail are diagnostics.",
    inputSchema: ContextSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args, context) => {
    try {
      if (args.mode === "search") {
        return withGuidance(await call("search", {
          query: args.query,
          max_results: args.max_results,
          page_types: args.page_types,
          retrieval_profile: args.retrieval_profile,
        }, context), "search_complete", null);
      }
      if (args.mode === "graph") {
        return withGuidance(await call("graphQuery", {
          query: args.query,
          max_nodes: args.max_nodes,
          max_depth: args.max_depth,
          page_types: args.page_types,
          view: args.view,
        }, context), "graph_complete", null);
      }
      const result = await call("context", omit(args, ["mode", "max_results", "max_nodes", "max_depth", "view"]), context);
      const structured = isCallToolResult(result) && result.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent as Record<string, unknown>
        : {};
      const retrieval = structured.retrieval && typeof structured.retrieval === "object"
        ? structured.retrieval as Record<string, unknown>
        : {};
      const gaps = Array.isArray(structured.gaps)
        ? structured.gaps
        : Array.isArray(structured.unknowns) ? structured.unknowns : [];
      const hasGaps = gaps.length > 0;
      const hasBudgetGap = gaps.some((gap) =>
        gap && typeof gap === "object" && (gap as { kind?: unknown }).kind === "budget_limited"
      );
      const retrievalSufficient = retrieval.coverageSufficient === true;
      const sufficient = retrievalSufficient && !hasGaps;
      const canWiden = hasBudgetGap && args.heuristic_token_budget < 12_000;
      return withGuidance(
        result,
        sufficient ? "context_ready" : "context_incomplete",
        canWiden ? {
          tool: "knowledge_context",
          requiredArguments: ["mode", "objective", "heuristic_token_budget"],
          suggestedArguments: {
            mode: "task",
            objective: args.objective,
            intent: args.intent,
            retrieval_profile: "coverage",
            heuristic_token_budget: Math.min(args.heuristic_token_budget * 2, 12_000),
          },
        } : null,
        sufficient
          ? "Materialize only the returned resource links needed for the task; use resources/read when available, otherwise knowledge_page action=read with the exact knowledge-rail:// URI."
          : canWiden
            ? "Repeat with the suggested wider budget; never infer missing evidence."
            : "No bounded widening can close the remaining gaps: materialize relevant evidence and report those gaps as unknowns."
      );
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.page, {
    title: "Manage canonical knowledge pages",
    description: "Read, write, edit, move or delete one canonical knowledge page, or append the durable log; then lint mutations.",
    inputSchema: PageSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async (args, context) => {
    const keys = {
      read: "readPage", write: "writePage", edit: "editPage", move: "movePage",
      delete: "deletePage", append_log: "appendLog",
    } as const;
    try {
      const result = await call(keys[args.action], omit(args, ["action"]), context);
      const mutation = args.action !== "read";
      return withGuidance(result, mutation ? "page_updated" : "page_read", mutation ? {
        tool: "knowledge_admin",
        action: "lint",
        requiredArguments: ["action"],
        suggestedArguments: { action: "lint" },
      } : null);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.files, {
    title: "Inspect and normalize source files",
    description: "List/read controlled docs files or normalize a source into docs/normalized without changing the original.",
    inputSchema: FilesSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args, context) => {
    try {
      if (args.action === "normalize") {
        const result = await call("normalizeSource", {
          category: args.category,
          path: args.path,
          overwrite: args.overwrite,
        }, context);
        return withGuidance(result, "source_normalized", {
          tool: "knowledge_ingest",
          action: "start",
          requiredArguments: ["action", "normalized_filename"],
        });
      }
      const result = await call("files", {
        action: args.action,
        category: args.category,
        pattern: args.pattern,
        path: args.path,
        max_chars: args.max_chars,
      }, context);
      return withGuidance(result, args.action === "list" ? "files_listed" : "file_read", null);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.ingest, {
    title: "Integrate evidence into agent memory",
    description: "Guided source loop. apply records, links, validates and synthesizes Evidence IR before updating canonical pages.",
    inputSchema: IngestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args, context) => {
    try {
      if (args.action === "report") {
        return withGuidance(await call("prepareRequestIngestion", {
          report_filename: args.report_filename,
        }, context), "report_prepared", {
          tool: "knowledge_page",
          action: "write",
          requiredArguments: ["action", "path", "content"],
        }, "Apply every validated draft, append the log, then run knowledge_admin action=lint.");
      }
      if (args.action === "record_recovery" || args.action === "resolve_recovery") {
        const evidenceAction = args.action === "record_recovery" ? "recovery_record" : "recovery_resolve";
        const result = await call("evidenceIr", {
          action: evidenceAction,
          total_evidence_used: args.total_evidence_used,
          recovery_events: args.recovery_events,
          recovery_event_id: args.recovery_event_id,
          recovery_resolution: args.recovery_resolution,
          recovery_page_refs: args.recovery_page_refs,
          recovery_reason: args.recovery_reason,
        }, context);
        return withGuidance(result, "recovery_updated", null);
      }
      if (args.action === "status" && !args.normalized_filename) {
        const [evidence, recovery] = await Promise.all([
          call("evidenceIr", { action: "status", claim_ids: args.claim_ids }, context),
          call("evidenceIr", { action: "recovery_status", include_resolved: args.include_resolved }, context),
        ]);
        if (!isCallToolResult(evidence) || !isCallToolResult(recovery)) return evidence;
        return withGuidance({
          content: [...evidence.content, ...recovery.content],
          isError: evidence.isError || recovery.isError,
        }, "ingest_status_ready", null);
      }
      if (args.action === "apply" && args.claims?.length) {
        return withGuidance(await applyEvidenceSegment(args), "segment_applied", {
          tool: "knowledge_ingest",
          action: "next",
          requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: "next", normalized_filename: args.normalized_filename },
        });
      }
      const sourceAction = {
        start: "plan", next: "next", apply: "record", status: "coverage", finalize: "finalize",
      } as const;
      const result = await call("prepareSourceIngestion", {
        action: sourceAction[args.action as keyof typeof sourceAction],
        normalized_filename: args.normalized_filename,
        max_chars: args.max_chars,
        segment_max_chars: args.segment_max_chars,
        segment_id: args.segment_id,
        status: args.segment_status,
        evidence_refs: args.evidence_refs,
        page_refs: args.page_refs,
        reason: args.reason,
      }, context);
      const text = isCallToolResult(result)
        ? result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        : "";
      if (args.action === "start") {
        return withGuidance(result, "ingest_started", {
          tool: "knowledge_ingest", action: "next", requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: "next", normalized_filename: args.normalized_filename },
        });
      }
      if (args.action === "next") {
        const empty = text.includes("Nessun segmento unresolved");
        return withGuidance(result, empty ? "source_queue_empty" : "segment_ready", {
          tool: "knowledge_ingest",
          action: empty ? "status" : "apply",
          requiredArguments: empty
            ? ["action", "normalized_filename"]
            : ["action", "normalized_filename", "segment_id", "claims|segment_status"],
          suggestedArguments: { action: empty ? "status" : "apply", normalized_filename: args.normalized_filename },
        });
      }
      if (args.action === "status") {
        const ready = /sourceCoveragePercent:\s*100(?:\.0+)?/.test(text) &&
          /unresolvedSegmentCount:\s*0/.test(text);
        return withGuidance(result, ready ? "coverage_complete" : "coverage_incomplete", {
          tool: "knowledge_ingest",
          action: ready ? "finalize" : "next",
          requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: ready ? "finalize" : "next", normalized_filename: args.normalized_filename },
        });
      }
      if (args.action === "apply") {
        return withGuidance(result, "segment_classified", {
          tool: "knowledge_ingest", action: "next", requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: "next", normalized_filename: args.normalized_filename },
        });
      }
      return withGuidance(result, "source_finalized", null);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.code, {
    title: "Retrieve deterministic code evidence",
    description: "Maintain/search the code index, resolve symbols/references and record any authorized raw fallback.",
    inputSchema: CodeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args, context) => {
    try {
      const result = await call("codeEvidence", args, context);
      const next = ["rebuild", "update", "remove"].includes(args.action) ? {
        tool: "knowledge_code" as const,
        action: "status",
        requiredArguments: ["action"],
        suggestedArguments: { action: "status" },
      } : null;
      return withGuidance(result, `code_${args.action}_complete`, next,
        ["search", "symbol", "references"].includes(args.action)
          ? "Materialize only the returned code:// resource links needed for the task."
          : undefined,
        args.action === "read");
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.documentContext, {
    title: "Plan evidence-backed documents",
    description: "Plan a typed deliverable or compile the bounded evidence pack for one section.",
    inputSchema: DocumentContextSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args, context) => {
    try {
      const key = args.action === "plan" ? "documentPlan" : "sectionContext";
      const result = await call(key, omit(args, ["action"]), context);
      return withGuidance(result, args.action === "plan" ? "document_planned" : "section_context_ready",
        args.action === "plan" ? {
          tool: "knowledge_document_context",
          action: "section",
          requiredArguments: ["action", "document_type", "section_title"],
          suggestedArguments: { action: "section", document_type: args.document_type },
        } : null,
        args.action === "section" ? "Materialize selected evidence and preserve explicit GAP markers." : undefined,
        true);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.document, {
    title: "Write, review and export documents",
    description: "Save a typed Markdown deliverable, review its contract, or export a review-ready document to DOCX.",
    inputSchema: DocumentSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args, context) => {
    try {
      const keys = { write: "writeDocument", review: "reviewDocument", export: "exportDocx" } as const;
      const result = await call(
        keys[args.action],
        omit(args, args.action === "review" ? ["action"] : ["action", "include_wiki_update_plan"]),
        context
      );
      if (args.action === "write") {
        return withGuidance(result, "document_written", {
          tool: "knowledge_document", action: "review", requiredArguments: ["action", "filename", "document_type"],
          suggestedArguments: { action: "review", filename: args.filename, document_type: args.document_type },
        });
      }
      if (args.action === "review") {
        const structured = isCallToolResult(result) && result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent as Record<string, unknown>
          : {};
        const ready = structured.readyForExport === true;
        return withGuidance(result, ready ? "document_reviewed" : "document_needs_revision", ready ? {
          tool: "knowledge_document", action: "export",
          requiredArguments: ["action", "filename", "document_type", "client", "project"],
          suggestedArguments: { action: "export", filename: args.filename, document_type: args.document_type },
        } : {
          tool: "knowledge_document", action: "write",
          requiredArguments: ["action", "filename", "title", "document_type", "content", "overwrite"],
          suggestedArguments: { action: "write", filename: args.filename, document_type: args.document_type, overwrite: true },
        }, undefined, true);
      }
      return withGuidance(result, "document_exported", null);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.admin, {
    title: "Initialize and validate KnowledgeRail",
    description: "Initialize storage, lint canonical knowledge, or plan/apply/rollback conservative data migration.",
    inputSchema: AdminSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async (args, context) => {
    try {
      if (args.action === "init") {
        return withGuidance(await call("init", { force: args.force }, context), "workspace_initialized", {
          tool: "knowledge_context", requiredArguments: ["mode", "objective"],
          suggestedArguments: { mode: "task" },
        });
      }
      if (args.action === "lint") {
        return withGuidance(await call("lint", {
          include_orphans: args.include_orphans,
          include_missing: args.include_missing,
          include_broken_links: args.include_broken_links,
        }, context), "lint_complete", null);
      }
      const result = await call("migrate", {
        action: args.migration_action,
        target_version: args.target_version,
        dry_run: args.dry_run,
        backup: args.backup,
        run_id: args.run_id,
      }, context);
      const next = args.migration_action === "plan" ? {
        tool: "knowledge_admin" as const,
        action: "migrate",
        requiredArguments: ["action", "migration_action", "target_version", "backup"],
        suggestedArguments: {
          action: "migrate", migration_action: "apply", target_version: args.target_version, backup: true,
        },
      } : args.migration_action === "apply" ? {
        tool: "knowledge_admin" as const,
        action: "lint",
        requiredArguments: ["action"],
        suggestedArguments: { action: "lint" },
      } : null;
      return withGuidance(result, `migration_${args.migration_action}_complete`, next);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });
}
