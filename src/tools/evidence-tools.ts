import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  EVIDENCE_CLAIM_KINDS,
  EVIDENCE_CLAIM_ORIGINS,
  EVIDENCE_RELATION_TYPES,
} from "../core/ingestion/evidence-claim.js";
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
  KNOWLEDGE_RECOVERY_DISCOVERY_METHODS,
  KNOWLEDGE_RECOVERY_RESOLUTIONS,
  knowledgeRecoveryStatus,
  recordKnowledgeRecoveryUsage,
  resolveKnowledgeRecoveryEvent,
} from "../core/knowledge-recovery.js";
import { docsCategoryFilePath, wikiDir } from "../core/paths.js";
import { WIKI_PAGE_TYPES } from "../core/wiki-validation.js";
import { readFileSafe } from "../core/utils.js";
import { errorResult, finalizePageMutation, textResult } from "./helpers.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";

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

function sourceUri(normalizedFilename: string): string {
  return `docs/normalized/${normalizedFilename.replace(/\\/g, "/")}`;
}

function draftBlock(pagePath: string, content: string): string {
  return [`## ${pagePath}`, "", "```markdown", content, "```"].join("\n");
}

export function registerEvidenceTools(server: McpServer, era: ProtocolEra = "modern"): void {
  server.registerTool(toolName("evidenceIr", era), {
    description: `Evidence state machine selected by ${toolName("menu", era)} ingest/code: record -> link -> plan_synthesis -> synthesize; status inspects IR. Recovery actions record/resolve/status durable knowledge debt.`,
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
      claims: z.array(z.object({
        text: z.string(),
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
      })).optional(),
      total_evidence_used: z.number().int().nonnegative().optional(),
      recovery_events: z.array(z.object({
        evidence_ref: z.string().min(1).max(4_096),
        source_uri: z.string().min(1).max(4_096),
        discovered_by: z.enum(RECOVERY_DISCOVERY_METHODS),
        expected_wiki_pages: z.array(z.string().min(1)).max(50).optional(),
        reason: z.string().min(1).max(1_024),
      })).max(100).optional(),
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
            "total_evidence_used e recovery_events sono obbligatori per action=recovery_record; " +
            "recovery_events può essere vuoto quando tutta l'evidence usata era già rappresentata."
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
        return textResult([
          "Knowledge recovery usage registrato senza modificare la wiki canonica.",
          `Eventi creati: ${result.created}; riusati: ${result.reused}; riaperti: ${result.reopened}.`,
          `LateRecoveryRate: ${result.metrics.lateRecoveryRate.toFixed(4)} ` +
            `(${result.metrics.lateRecoveryEvidenceUsed}/${result.metrics.totalEvidenceUsed}).`,
          `KnowledgeRecoveryPending: ${result.metrics.knowledgeRecoveryPending}.`,
          ...result.events.map((event) =>
            `- ${event.id} [${event.discoveredBy}/${event.resolution}] ${event.evidenceRef}`
          ),
        ].join("\n"));
      }

      if (action === "recovery_resolve") {
        if (!recovery_event_id || !recovery_resolution || !recovery_reason) {
          return errorResult(
            "recovery_event_id, recovery_resolution e recovery_reason sono obbligatori per action=recovery_resolve."
          );
        }
        const result = await resolveKnowledgeRecoveryEvent({
          wikiRoot: wikiDir(),
          eventId: recovery_event_id,
          resolution: recovery_resolution,
          pageRefs: recovery_page_refs,
          reason: recovery_reason,
        });
        return textResult([
          `Knowledge recovery risolta: ${result.event.id} -> ${result.event.resolution}.`,
          `Page refs: ${result.event.pageRefs.join(", ") || "none"}.`,
          `KnowledgeRecoveryPending: ${result.metrics.knowledgeRecoveryPending}.`,
          "Le pagine vengono accettate solo dopo la normale mutation/synthesis pipeline e la verifica della provenance.",
        ].join("\n"));
      }

      if (action === "recovery_status") {
        const result = await knowledgeRecoveryStatus(wikiDir());
        const events = include_resolved
          ? result.events
          : result.events.filter((event) => event.resolution === "pending");
        return textResult([
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
            `${event.expectedWikiPages.join(", ") || "target da definire"}`
          ),
        ].join("\n"));
      }

      if (action === "record") {
        if (!normalized_filename || !segment_id || !claims?.length) {
          return errorResult("normalized_filename, segment_id e claims sono obbligatori per action=record.");
        }
        const content = await readFileSafe(docsCategoryFilePath("normalized", normalized_filename));
        if (content === null) return errorResult(`Fonte normalizzata non trovata: ${normalized_filename}`);
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
            } : undefined,
            relations: claim.relations?.map((relation) => ({
              type: relation.type,
              targetClaimId: relation.target_claim_id,
            })),
          })),
        });
        return textResult([
          "Evidence registrata prima della synthesis.",
          `Creati: ${result.created}; riusati: ${result.reused}.`,
          ...result.claims.map((claim) =>
            `- ${claim.id} [${claim.kind}/${claim.origin}/${claim.status}] ${claim.sourceUri}#${claim.segmentId}`
          ),
          "Usare action=link prima della synthesis.",
        ].join("\n"));
      }

      if (action === "link") {
        const resolutions = await resolveEvidenceClaims({ wikiRoot: wikiDir(), claimIds: claim_ids });
        const coverage = await reconcileEvidenceCoverage(wikiDir());
        return textResult([
          `Claim risolti: ${resolutions.length}.`,
          ...resolutions.map((item) =>
            `- ${item.claimId}: ${item.disposition} -> ${item.targetPagePath ?? (item.targetClaimIds.join(",") || "unresolved")} (${item.reason})`
          ),
          `Coverage riconciliata: ${coverage.segmentsRecorded} segmenti; pending: ${coverage.segmentsPending}.`,
        ].join("\n"));
      }

      if (action === "plan_synthesis") {
        const drafts = await planEvidenceSynthesis({ wikiRoot: wikiDir(), claimIds: claim_ids });
        return textResult([
          `Bozze synthesis: ${drafts.length}. Nessuna pagina scritta.`,
          ...drafts.map((draft) => draftBlock(draft.pagePath, draft.content)),
        ].join("\n\n"));
      }

      if (action === "synthesize") {
        const drafts = await applyEvidenceSynthesis({ wikiRoot: wikiDir(), claimIds: claim_ids });
        const indexLine = drafts.length > 0
          ? await finalizePageMutation(drafts.map((draft) => draft.pagePath))
          : "Nessuna pagina da aggiornare.";
        const coverage = await reconcileEvidenceCoverage(wikiDir());
        return textResult([
          `Synthesis completata: ${drafts.length} pagina/e.`,
          ...drafts.map((draft) => `- ${draft.mode}: ${draft.pagePath} (${draft.claimIds.length} claim)`),
          `Coverage aggiornata: ${coverage.segmentsRecorded} segmenti; pending: ${coverage.segmentsPending}.`,
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
      return textResult([
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
      ].join("\n"));
    } catch (error: unknown) {
      return errorResult(error);
    }
  });
}
