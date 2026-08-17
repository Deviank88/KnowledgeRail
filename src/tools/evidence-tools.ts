import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveEvidenceClaims } from "../core/ingestion/evidence-linker.js";
import {
  evidenceIrStatus,
  reconcileEvidenceCoverage,
  recordEvidenceClaims,
} from "../core/ingestion/evidence-pipeline.js";
import { readEvidenceIrStore } from "../core/ingestion/evidence-store.js";
import {
  applyEvidenceSynthesis,
  planEvidenceSynthesis,
} from "../core/ingestion/evidence-synthesis.js";
import {
  KNOWLEDGE_RECOVERY_RESOLUTIONS,
  knowledgeRecoveryStatus,
  recordKnowledgeRecoveryUsage,
  resolveKnowledgeRecoveryEvent,
} from "../core/knowledge-recovery.js";
import { docsCategoryFilePath, wikiDir } from "../core/paths.js";
import { readFileSafe } from "../core/utils.js";
import { errorResult, finalizePageMutation, structuredTextResult, textResult } from "./helpers.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";
import {
  EvidenceClaimInputSchema,
  RecoveryEventInputSchema,
} from "./input-schemas.js";

const RECOVERY_RESOLUTIONS = KNOWLEDGE_RECOVERY_RESOLUTIONS.filter(
  (resolution) => resolution !== "pending"
) as [
  Exclude<(typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number], "pending">,
  ...Exclude<(typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number], "pending">[],
];

function sourceUri(normalizedFilename: string): string {
  return `docs/normalized/${normalizedFilename.replace(/\\/g, "/")}`;
}

function draftBlock(pagePath: string, content: string): string {
  return [`## ${pagePath}`, "", "```markdown", content, "```"].join("\n");
}

export function registerEvidenceTools(server: McpServer, era: ProtocolEra = "modern"): void {
  server.registerTool(toolName("evidenceIr", era), {
    description: "Internal Evidence IR and knowledge-recovery operation.",
    inputSchema: z.object({
      action: z.enum([
        "record",
        "link",
        "plan_synthesis",
        "synthesize",
        "status",
        "recovery_record",
        "recovery_resolve",
        "recovery_status",
      ]),
      normalized_filename: z.string().optional(),
      segment_id: z.string().optional(),
      claim_ids: z.array(z.string()).optional(),
      claims: z.array(EvidenceClaimInputSchema).optional(),
      total_evidence_used: z.number().int().nonnegative().optional(),
      recovery_events: z.array(RecoveryEventInputSchema).max(100).optional(),
      recovery_event_id: z.string().optional(),
      recovery_resolution: z.enum(RECOVERY_RESOLUTIONS).optional(),
      recovery_page_refs: z.array(z.string().min(1)).max(50).optional(),
      recovery_reason: z.string().min(1).max(1_024).optional(),
      include_resolved: z.boolean().optional().default(false),
    }),
  }, async ({
    action,
    normalized_filename,
    segment_id,
    claim_ids,
    claims,
    total_evidence_used,
    recovery_events,
    recovery_event_id,
    recovery_resolution,
    recovery_page_refs,
    recovery_reason,
    include_resolved,
  }) => {
    try {
      if (action === "recovery_record") {
        if (total_evidence_used === undefined || recovery_events === undefined) {
          return errorResult(
            "total_evidence_used and recovery_events are required for action=recovery_record; " +
            "recovery_events may be empty when all used evidence was already represented."
          );
        }
        const result = await recordKnowledgeRecoveryUsage({
          wikiRoot: wikiDir(),
          totalEvidenceUsed: total_evidence_used,
          events: recovery_events.map((event) => ({
            evidenceRef: event.evidence_ref,
            sourceUri: event.source_uri,
            discoveredBy: event.discovered_by,
            expectedWikiPages: event.expected_wiki_pages,
            reason: event.reason,
          })),
        });
        return structuredTextResult([
          "Knowledge-recovery usage recorded without changing the canonical wiki.",
          `Events created: ${result.created}; reused: ${result.reused}; reopened: ${result.reopened}.`,
          `LateRecoveryRate: ${result.metrics.lateRecoveryRate.toFixed(4)} ` +
            `(${result.metrics.lateRecoveryEvidenceUsed}/${result.metrics.totalEvidenceUsed}).`,
          `KnowledgeRecoveryPending: ${result.metrics.knowledgeRecoveryPending}.`,
          ...result.events.map((event) =>
            `- ${event.id} [${event.discoveredBy}/${event.resolution}] ${event.evidenceRef}`
          ),
        ].join("\n"), {
          action,
          created: result.created,
          reused: result.reused,
          reopened: result.reopened,
          metrics: result.metrics,
          events: result.events,
        });
      }

      if (action === "recovery_resolve") {
        if (!recovery_event_id || !recovery_resolution || !recovery_reason) {
          return errorResult(
            "recovery_event_id, recovery_resolution, and recovery_reason are required for action=recovery_resolve."
          );
        }
        const result = await resolveKnowledgeRecoveryEvent({
          wikiRoot: wikiDir(),
          eventId: recovery_event_id,
          resolution: recovery_resolution,
          pageRefs: recovery_page_refs,
          reason: recovery_reason,
        });
        return structuredTextResult([
          `Knowledge recovery resolved: ${result.event.id} -> ${result.event.resolution}.`,
          `Page refs: ${result.event.pageRefs.join(", ") || "none"}.`,
          `KnowledgeRecoveryPending: ${result.metrics.knowledgeRecoveryPending}.`,
          "Pages are accepted only after the normal mutation/synthesis pipeline and provenance verification.",
        ].join("\n"), {
          action,
          event: result.event,
          metrics: result.metrics,
        });
      }

      if (action === "recovery_status") {
        const result = await knowledgeRecoveryStatus(wikiDir());
        const events = include_resolved
          ? result.events
          : result.events.filter((event) => event.resolution === "pending");
        return structuredTextResult([
          "# Knowledge recovery status",
          "",
          `- LateRecoveryRate: ${result.metrics.lateRecoveryRate.toFixed(4)}`,
          `- totalEvidenceUsed: ${result.metrics.totalEvidenceUsed}`,
          `- lateRecoveryEvidenceUsed: ${result.metrics.lateRecoveryEvidenceUsed}`,
          `- KnowledgeRecoveryPending: ${result.metrics.knowledgeRecoveryPending}`,
          `- resolvedEventCount: ${result.metrics.resolvedEventCount}`,
          `- uniqueRecoveryEventCount: ${result.metrics.uniqueRecoveryEventCount}`,
          "",
          ...events.map((event) =>
            `- ${event.id} [${event.discoveredBy}/${event.resolution}] ${event.evidenceRef} -> ` +
            `${event.expectedWikiPages.join(", ") || "target to be defined"}`
          ),
        ].join("\n"), {
          action,
          metrics: result.metrics,
          events,
          includeResolved: include_resolved,
        });
      }

      if (action === "record") {
        if (!normalized_filename || !segment_id || !claims?.length) {
          return errorResult("normalized_filename, segment_id, and claims are required for action=record.");
        }
        const content = await readFileSafe(docsCategoryFilePath("normalized", normalized_filename));
        if (content === null) return errorResult(`Normalized source not found: ${normalized_filename}`);
        const result = await recordEvidenceClaims({
          wikiRoot: wikiDir(),
          sourceUri: sourceUri(normalized_filename),
          sourceContent: content,
          segmentId: segment_id,
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
              codeResourceUri: claim.target.code_resource_uri,
            } : undefined,
            relations: claim.relations?.map((relation) => ({
              type: relation.type,
              targetClaimId: relation.target_claim_id,
            })),
          })),
        });
        return textResult([
          "Evidence recorded before synthesis.",
          `Created: ${result.created}; reused: ${result.reused}.`,
          ...result.anchorWarnings.map((warning) => `Anchor warning: ${warning}`),
          ...result.claims.map((claim) =>
            `- ${claim.id} [${claim.kind}/${claim.origin}/${claim.status}] ${claim.sourceUri}#${claim.segmentId}`
          ),
          "Use action=link before synthesis.",
        ].join("\n"));
      }

      if (action === "link") {
        const resolutions = await resolveEvidenceClaims({ wikiRoot: wikiDir(), claimIds: claim_ids });
        const coverage = await reconcileEvidenceCoverage(wikiDir());
        return textResult([
          `Claims resolved: ${resolutions.length}.`,
          ...resolutions.map((item) =>
            `- ${item.claimId}: ${item.disposition} -> ${item.targetPagePath ?? (item.targetClaimIds.join(",") || "unresolved")} (${item.reason})`
          ),
          `Coverage reconciled: ${coverage.segmentsRecorded} segments; pending: ${coverage.segmentsPending}.`,
        ].join("\n"));
      }

      if (action === "plan_synthesis") {
        const drafts = await planEvidenceSynthesis({ wikiRoot: wikiDir(), claimIds: claim_ids });
        return textResult([
          `Synthesis drafts: ${drafts.length}. No pages written.`,
          ...drafts.map((draft) => draftBlock(draft.pagePath, draft.content)),
        ].join("\n\n"));
      }

      if (action === "synthesize") {
        const drafts = await applyEvidenceSynthesis({ wikiRoot: wikiDir(), claimIds: claim_ids });
        const indexLine = drafts.length > 0
          ? await finalizePageMutation(drafts.map((draft) => draft.pagePath))
          : "No pages to update.";
        const coverage = await reconcileEvidenceCoverage(wikiDir());
        return textResult([
          `Synthesis completed: ${drafts.length} page(s).`,
          ...drafts.map((draft) => `- ${draft.mode}: ${draft.pagePath} (${draft.claimIds.length} claim)`),
          `Coverage updated: ${coverage.segmentsRecorded} segments; pending: ${coverage.segmentsPending}.`,
          indexLine,
        ].join("\n"));
      }

      const [status, store] = await Promise.all([
        evidenceIrStatus(wikiDir()),
        readEvidenceIrStore(wikiDir()),
      ]);
      const resolutionByClaim = new Map(store.resolutions.map((item) => [item.claimId, item] as const));
      const selected = claim_ids?.length
        ? store.claims.filter((claim) => claim_ids.includes(claim.id))
        : store.claims;
      return structuredTextResult([
        "# Evidence IR status",
        "",
        `- claimCount: ${status.claimCount}`,
        `- claimsWithProvenancePercent: ${status.claimsWithProvenancePercent.toFixed(2)}`,
        `- unresolvedLinkCount: ${status.unresolvedLinkCount}`,
        `- contradictionCount: ${status.contradictionCount}`,
        `- synthesisCount: ${status.synthesisCount}`,
        "",
        ...selected.map((claim) => {
          const resolution = resolutionByClaim.get(claim.id);
          return `- ${claim.id} [${claim.kind}/${claim.origin}/${claim.status}] -> ${resolution?.disposition ?? "unlinked"} (${claim.sourceUri}#${claim.segmentId})`;
        }),
      ].join("\n"), {
        action: "status",
        metrics: status,
        claims: selected.map((claim) => ({
          ...claim,
          resolution: resolutionByClaim.get(claim.id),
        })),
      });
    } catch (error: unknown) {
      return errorResult(error);
    }
  });
}
