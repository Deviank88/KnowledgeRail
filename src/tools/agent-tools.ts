import {
  fromJsonSchema,
  type CallToolResult,
  type ContentBlock,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_TYPES } from "../config/document-contracts.js";
import { EDITORIAL_EVIDENCE_KINDS } from "../config/editorial-plans.js";
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
  KNOWLEDGE_RECOVERY_RESOLUTIONS,
} from "../core/knowledge-recovery.js";
import { docsCategoryFilePath, wikiDir } from "../core/paths.js";
import { FILE_CATEGORIES } from "../core/report-workflow.js";
import { readFileSafe } from "../core/utils.js";
import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type ProtocolEra,
  type ToolKey,
} from "../mcp/tool-names.js";
import { errorResult, finalizePageMutation } from "./helpers.js";
import {
  CodeEvidenceInputSchema,
  EvidenceClaimInputSchema,
  RecoveryEventInputSchema,
} from "./input-schemas.js";
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
const RECOVERY_RESOLUTIONS = KNOWLEDGE_RECOVERY_RESOLUTIONS.filter(
  (resolution) => resolution !== "pending"
) as [
  Exclude<(typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number], "pending">,
  ...Exclude<(typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number], "pending">[],
];

const ContextSchema = z.object({
  mode: z.enum(["task", "list", "search", "graph"]).default("task")
    .describe("task=context/gaps; list=pages; search=passages; graph=relations/dependencies."),
  intent: z.enum(["understand", "implement", "modify", "debug", "review", "document"]).default("understand"),
  objective: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  changed_paths: z.array(z.string().min(1).max(1_024)).max(20).optional(),
  page_types: z.array(z.string().min(1).max(128)).max(20).optional(),
  retrieval_profile: z.enum(["precision", "balanced", "coverage"]).default("balanced"),
  max_evidence: z.number().int().min(1).max(20).default(8),
  heuristic_token_budget: z.number().int().min(256).max(12_000).default(2_000),
  response_detail: z.enum(["compact", "full"]).default("compact"),
  max_results: z.number().int().min(1).max(100).default(10),
  max_nodes: z.number().int().min(1).max(100).default(12),
  max_depth: z.number().int().min(0).max(8).default(1),
  view: z.enum(["subgraph", "traceability"]).default("subgraph"),
}).superRefine((value, context) => {
  if (value.mode === "task" && !value.objective) {
    context.addIssue({ code: "custom", path: ["objective"], message: "mode=task requires objective." });
  }
  if (value.mode === "search" && !value.query) {
    context.addIssue({ code: "custom", path: ["query"], message: "mode=search requires query; use mode=list to browse pages." });
  }
  if (value.mode === "graph" && value.view === "subgraph" && !value.query) {
    context.addIssue({ code: "custom", path: ["query"], message: "graph subgraph mode requires query." });
  }
});

const PageSchema = z.object({
  action: z.enum(["read", "write", "edit", "move", "delete", "append_log"])
    .describe("read=open; write=create; edit=replace; move=rename; delete=remove; append_log=event."),
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
    .describe("list=sources; read=open; normalize=convert to Markdown."),
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

const IngestSchema = z.object({
  action: z.enum([
    "start",
    "next",
    "apply_claims",
    "record_segment",
    "source_status",
    "evidence_status",
    "finalize",
    "report",
    "record_recovery",
    "resolve_recovery",
  ]).describe("start=begin; next=segment; apply_claims=integrate; record_segment=classify; source_status=coverage; evidence_status=debt; finalize=close; report=drafts; record_recovery=track; resolve_recovery=resolve."),
  normalized_filename: z.string().optional().describe("docs/normalized file."),
  max_chars: z.number().int().positive().default(12_000).describe("Next response limit."),
  segment_max_chars: z.number().int().min(256).max(50_000).optional().describe("Start segment size."),
  segment_id: z.string().optional().describe("ID from next."),
  claims: z.array(z.record(z.string(), z.unknown())).min(1).optional()
    .describe("Claim: text, kind, origin, confidence; optional target/relations."),
  segment_status: z.enum(["irrelevant", "unresolved", "legacy_unverified"]).optional()
    .describe("record_segment class."),
  evidence_refs: z.array(z.string()).optional().describe("Evidence refs."),
  page_refs: z.array(z.string()).optional().describe("Page refs."),
  reason: z.string().optional().describe("Classification reason."),
  report_filename: z.string().optional().describe("docs/reports file."),
  claim_ids: z.array(z.string()).optional().describe("Claim IDs filter."),
  include_resolved: z.boolean().default(false).describe("Include resolved."),
  total_evidence_used: z.number().int().nonnegative().optional().describe("Evidence total."),
  recovery_events: z.array(z.record(z.string(), z.unknown())).max(100).optional()
    .describe("Recovery: evidence_ref, source_uri, discovered_by, reason; optional pages."),
  recovery_event_id: z.string().optional().describe("Recovery event ID."),
  recovery_resolution: z.enum(RECOVERY_RESOLUTIONS).optional().describe("Recovery disposition."),
  recovery_page_refs: z.array(z.string().min(1)).max(50).optional().describe("Representing pages."),
  recovery_reason: z.string().min(1).max(1_024).optional().describe("Resolution reason."),
}).superRefine((value, context) => {
  const sourceAction = [
    "start",
    "next",
    "apply_claims",
    "record_segment",
    "source_status",
    "finalize",
  ].includes(value.action);
  if (sourceAction && !value.normalized_filename) {
    context.addIssue({ code: "custom", path: ["normalized_filename"], message: `action=${value.action} requires normalized_filename.` });
  }
  if (value.action === "apply_claims" && (!value.segment_id || !value.claims?.length)) {
    context.addIssue({ code: "custom", message: "action=apply_claims requires segment_id and claims." });
  }
  if (value.action === "apply_claims") {
    for (const [index, claim] of (value.claims ?? []).entries()) {
      const parsed = EvidenceClaimInputSchema.safeParse(claim);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["claims", index],
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
    }
  }
  if (value.action === "record_segment" && (!value.segment_id || !value.segment_status || !value.reason)) {
    context.addIssue({ code: "custom", message: "action=record_segment requires segment_id, segment_status and reason." });
  }
  if (value.action === "report" && !value.report_filename) {
    context.addIssue({ code: "custom", path: ["report_filename"], message: "action=report requires report_filename." });
  }
  if (value.action === "record_recovery" &&
      (value.total_evidence_used === undefined || value.recovery_events === undefined)) {
    context.addIssue({ code: "custom", message: "action=record_recovery requires total_evidence_used and recovery_events." });
  }
  if (value.action === "record_recovery") {
    for (const [index, event] of (value.recovery_events ?? []).entries()) {
      const parsed = RecoveryEventInputSchema.safeParse(event);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["recovery_events", index],
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
    }
  }
  if (value.action === "resolve_recovery" &&
      (!value.recovery_event_id || !value.recovery_resolution || !value.recovery_reason)) {
    context.addIssue({ code: "custom", message: "action=resolve_recovery requires recovery_event_id, recovery_resolution and recovery_reason." });
  }
});

const CodeSchema = CodeEvidenceInputSchema;

const DocumentContextSchema = z.object({
  action: z.enum(["plan", "section"]).describe("plan=design outline; section=collect evidence."),
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
    .describe("write=save Markdown; review=check required sections; export=render Word/DOCX."),
  filename: z.string(),
  document_type: z.enum(DOCUMENT_TYPES),
  title: z.string().optional(),
  content: z.string().optional(),
  project_name: z.string().optional(),
  language: z.string().optional(),
  client_facing: z.boolean().optional(),
  include_wiki_update_plan: z.boolean().default(true),
  client: z.string().optional(),
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
  if (value.action === "export" && (!value.client || !value.project_name)) {
    context.addIssue({ code: "custom", message: "action=export requires client and project_name." });
  }
});

const AdminSchema = z.object({
  action: z.enum(["init", "lint", "migrate"])
    .describe("init=bootstrap; lint=validate broken links/orphans; migrate=upgrade storage format."),
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

export const AGENT_STATES = [
  "blocked",
  "context_ready",
  "context_incomplete",
  "pages_listed",
  "search_complete",
  "graph_complete",
  "page_read",
  "page_updated",
  "page_move_preview",
  "files_listed",
  "file_read",
  "source_normalized",
  "report_prepared",
  "recovery_updated",
  "evidence_status_ready",
  "segment_applied",
  "segment_classified",
  "ingest_started",
  "segment_ready",
  "source_queue_empty",
  "coverage_complete",
  "coverage_incomplete",
  "source_finalized",
  "code_status_complete",
  "code_rebuild_complete",
  "code_update_complete",
  "code_remove_complete",
  "code_search_complete",
  "code_symbol_complete",
  "code_references_complete",
  "code_read_complete",
  "code_record_fallback_complete",
  "code_no_matches",
  "document_planned",
  "section_context_ready",
  "document_written",
  "document_reviewed",
  "document_needs_revision",
  "document_exported",
  "workspace_initialized",
  "lint_complete",
  "migration_plan_complete",
  "migration_apply_complete",
  "migration_rollback_complete",
] as const;

type AgentState = (typeof AGENT_STATES)[number];

const AgentOutputSchema = fromJsonSchema({
  type: "object",
  properties: {
    state: { type: "string" },
    nextAction: { type: ["object", "null"] },
    guidance: { type: "string" },
    resultText: { type: "string" },
  },
  required: ["state", "nextAction"],
  additionalProperties: true,
});

function isCallToolResult(result: OperationResult): result is CallToolResult {
  return "content" in result && Array.isArray(result.content);
}

function withGuidance(
  result: OperationResult,
  state: AgentState,
  nextAction: NextAction | null,
  guidance?: string,
  mirrorText = false
): OperationResult {
  if (!isCallToolResult(result)) return result;
  const content: ContentBlock[] = [...result.content];
  const previous: Record<string, unknown> = result.structuredContent && typeof result.structuredContent === "object" &&
      !Array.isArray(result.structuredContent)
    ? result.structuredContent as Record<string, unknown>
    : {};
  const errorNext = previous.nextAction && typeof previous.nextAction === "object"
    ? previous.nextAction as NextAction
    : null;
  const effectiveNext = result.isError ? errorNext : nextAction;
  const guidanceLines: string[] = [];
  if (!result.isError && effectiveNext) {
    guidanceLines.push(
      `Next: ${effectiveNext.tool}${effectiveNext.action ? ` action=${effectiveNext.action}` : ""}; ` +
      `required arguments: ${effectiveNext.requiredArguments.join(", ") || "none"}.`
    );
  }
  if (!result.isError && guidance) guidanceLines.push(`Guidance: ${guidance}`);
  if (guidanceLines.length > 0) {
    content.push({
      type: "text",
      text: guidanceLines.join("\n"),
    });
  }
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
  if (content === null) return errorResult(`Normalized source not found: ${normalizedFilename}`);
  const claims = z.array(EvidenceClaimInputSchema).parse(args.claims);
  const recorded = await recordEvidenceClaims({
    wikiRoot: wikiDir(),
    sourceUri: sourceUri(normalizedFilename),
    sourceContent: content,
    segmentId,
    claims: claims.map((claim) => ({
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
    : "No pages to update.";
  const coverage = await reconcileEvidenceCoverage(wikiDir());
  return {
    content: [{
      type: "text",
      text: [
        `Segmento applicato: ${segmentId}.`,
        `Claim: ${recorded.claims.length} (${recorded.created} nuovi, ${recorded.reused} riusati).`,
        `Resolutions: ${resolutions.length}; validated drafts: ${planned.length}; pages updated: ${drafts.length}.`,
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

export function registerAgentTools(
  server: McpServer,
  era: ProtocolEra = "modern",
  options: { includeWorkspaceBinding?: boolean } = {}
): void {
  const operations = createOperationRegistry(era);
  const call = (key: ToolKey, args: unknown, context: ServerContext) =>
    operations.call(
      key,
      args && typeof args === "object" && !Array.isArray(args)
        ? omit(args as Record<string, unknown>, ["workspace_binding"])
        : args,
      context
    );
  const bindingField = {
    workspace_binding: z.string().min(20).optional()
      .describe("Opaque binding returned by knowledge_workspace; desktop/catalog profile only."),
  };
  const schemas = options.includeWorkspaceBinding ? {
    context: ContextSchema.safeExtend(bindingField),
    page: PageSchema.safeExtend(bindingField),
    files: FilesSchema.safeExtend(bindingField),
    ingest: IngestSchema.safeExtend(bindingField),
    code: CodeSchema.safeExtend(bindingField),
    documentContext: DocumentContextSchema.safeExtend(bindingField),
    document: DocumentSchema.safeExtend(bindingField),
    admin: AdminSchema.safeExtend(bindingField),
  } : {
    context: ContextSchema,
    page: PageSchema,
    files: FilesSchema,
    ingest: IngestSchema,
    code: CodeSchema,
    documentContext: DocumentContextSchema,
    document: DocumentSchema,
    admin: AdminSchema,
  };

  server.registerTool(AGENT_TOOL_NAMES.context, {
    description: "Project evidence and gaps; page list/search; relation graph.",
    inputSchema: schemas.context,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, context) => {
    try {
      if (args.mode === "list" || args.mode === "search") {
        return withGuidance(await call("search", {
          query: args.mode === "list" ? undefined : args.query,
          max_results: args.max_results,
          page_types: args.page_types,
          retrieval_profile: args.retrieval_profile,
        }, context), args.mode === "list" ? "pages_listed" : "search_complete", null);
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
    description: "Canonical page CRUD and durable log.",
    inputSchema: schemas.page,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args, context) => {
    const keys = {
      read: "readPage", write: "writePage", edit: "editPage", move: "movePage",
      delete: "deletePage", append_log: "appendLog",
    } as const;
    try {
      const result = await call(keys[args.action], omit(args, ["action"]), context);
      const preview = args.action === "move" && args.dry_run;
      const mutation = args.action !== "read" && !preview;
      return withGuidance(result, preview ? "page_move_preview" : mutation ? "page_updated" : "page_read", mutation ? {
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
    description: "Controlled source files: list, read or normalize to Markdown.",
    inputSchema: schemas.files,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    description: "Source ingestion: claims, coverage, recovery and report drafts.",
    inputSchema: schemas.ingest,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      if (args.action === "evidence_status") {
        const [evidence, recovery] = await Promise.all([
          call("evidenceIr", { action: "status", claim_ids: args.claim_ids }, context),
          call("evidenceIr", { action: "recovery_status", include_resolved: args.include_resolved }, context),
        ]);
        if (!isCallToolResult(evidence) || !isCallToolResult(recovery)) return evidence;
        const evidenceStructured = evidence.structuredContent && typeof evidence.structuredContent === "object"
          ? evidence.structuredContent
          : {};
        const recoveryStructured = recovery.structuredContent && typeof recovery.structuredContent === "object"
          ? recovery.structuredContent
          : {};
        return withGuidance({
          content: [...evidence.content, ...recovery.content],
          isError: evidence.isError || recovery.isError,
          structuredContent: { evidence: evidenceStructured, recovery: recoveryStructured },
        }, "evidence_status_ready", null);
      }
      if (args.action === "apply_claims") {
        return withGuidance(await applyEvidenceSegment(args), "segment_applied", {
          tool: "knowledge_ingest",
          action: "next",
          requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: "next", normalized_filename: args.normalized_filename },
        });
      }
      const sourceAction = {
        start: "plan",
        next: "next",
        record_segment: "record",
        source_status: "coverage",
        finalize: "finalize",
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
      const structured = isCallToolResult(result) && result.structuredContent &&
          typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
        ? result.structuredContent as Record<string, unknown>
        : {};
      if (args.action === "start") {
        return withGuidance(result, "ingest_started", {
          tool: "knowledge_ingest", action: "next", requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: "next", normalized_filename: args.normalized_filename },
        });
      }
      if (args.action === "next") {
        const empty = structured.queueEmpty === true;
        return withGuidance(result, empty ? "source_queue_empty" : "segment_ready", {
          tool: "knowledge_ingest",
          action: empty ? "source_status" : "apply_claims",
          requiredArguments: empty
            ? ["action", "normalized_filename"]
            : ["action", "normalized_filename", "segment_id", "claims"],
          suggestedArguments: {
            action: empty ? "source_status" : "apply_claims",
            normalized_filename: args.normalized_filename,
          },
        });
      }
      if (args.action === "source_status") {
        const ready = structured.readyForFinalization === true;
        return withGuidance(result, ready ? "coverage_complete" : "coverage_incomplete", {
          tool: "knowledge_ingest",
          action: ready ? "finalize" : "next",
          requiredArguments: ["action", "normalized_filename"],
          suggestedArguments: { action: ready ? "finalize" : "next", normalized_filename: args.normalized_filename },
        });
      }
      if (args.action === "record_segment") {
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
    description: "Code index, symbols, callers and raw fallback.",
    inputSchema: schemas.code,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args, context) => {
    try {
      const result = await call("codeEvidence", args, context);
      const next = ["rebuild", "update", "remove"].includes(args.action) ? {
        tool: "knowledge_code" as const,
        action: "status",
        requiredArguments: ["action"],
        suggestedArguments: { action: "status" },
      } : null;
      const structured = isCallToolResult(result) && result.structuredContent &&
          typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
        ? result.structuredContent as Record<string, unknown>
        : {};
      const matches = args.action === "references" ? structured.references : structured.hits;
      const noMatches = ["search", "symbol", "references"].includes(args.action) &&
        Array.isArray(matches) && matches.length === 0;
      const state = noMatches
        ? "code_no_matches"
        : `code_${args.action}_complete` as AgentState;
      return withGuidance(result, state, next,
        noMatches
          ? "No indexed match was found. Report the code-evidence gap; use and record a raw fallback only when the task authorizes it."
          : ["search", "symbol", "references"].includes(args.action)
            ? "Materialize only the returned code:// resource links needed for the task."
            : undefined,
        args.action === "read");
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });

  server.registerTool(AGENT_TOOL_NAMES.documentContext, {
    description: "Plan a typed document or gather section evidence.",
    inputSchema: schemas.documentContext,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    description: "Write, review or export a typed deliverable.",
    inputSchema: schemas.document,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args, context) => {
    try {
      const keys = { write: "writeDocument", review: "reviewDocument", export: "exportDocx" } as const;
      const operationArgs = omit(
        args,
        args.action === "review" ? ["action"] : ["action", "include_wiki_update_plan"]
      );
      if (args.action === "export") {
        delete operationArgs.project_name;
        operationArgs.project = args.project_name;
      }
      const result = await call(
        keys[args.action],
        operationArgs,
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
          requiredArguments: ["action", "filename", "document_type", "client", "project_name"],
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
    description: "Initialize, lint or migrate storage.",
    inputSchema: schemas.admin,
    outputSchema: AgentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      return withGuidance(result, `migration_${args.migration_action}_complete` as AgentState, next);
    } catch (error: unknown) {
      return withGuidance(errorResult(error), "blocked", null);
    }
  });
}
