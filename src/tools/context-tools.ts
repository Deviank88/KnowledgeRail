import type { McpServer, ResourceLink } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  TASK_CONTEXT_EVIDENCE_FIELDS,
  compileTaskContext,
  type TaskContext,
} from "../context/task-context-compiler.js";
import { wikiDir } from "../core/paths.js";
import { errorResult } from "./helpers.js";
import { toolName } from "../mcp/tool-names.js";

const CONTEXT_SECTION_LABELS: Readonly<Record<
  (typeof TASK_CONTEXT_EVIDENCE_FIELDS)[number],
  string
>> = {
  currentState: "Current state",
  requirements: "Requirements",
  decisions: "Decisions",
  invariants: "Invariants",
  constraints: "Constraints",
  dependencies: "Dependencies",
  affectedComponents: "Affected components",
  implementationEvidence: "Implementation evidence",
  tests: "Tests",
  incidents: "Incidents",
  risks: "Risks",
  contradictions: "Contradictions",
};

function compactManifestText(manifest: TaskContext): string {
  const catalog = new Map(manifest.evidence.map((evidence) => [evidence.uri, evidence] as const));
  const decisionCandidateCount = new Set(
    manifest.evidence
      .filter((evidence) => evidence.type === "decision")
      .map((evidence) => evidence.path)
  ).size;
  const dynamicLines = [
    `Task context: ${manifest.evidence.length} evidence, ${manifest.unknowns.length} unknown(s), ` +
      `~${manifest.size.heuristicTokens} heuristic tokens (${manifest.size.estimator}).`,
    `Intent: ${manifest.task.intent}`,
    `Objective: ${manifest.task.objective}`,
    `Retrieval: ${manifest.retrieval.strategy} W${manifest.retrieval.wideningLevel}; ` +
      `coverage=${manifest.retrieval.coverageSufficient}; mode=${manifest.retrieval.coverageMode}; ` +
      `fallback=${manifest.retrieval.fallbackUsed}.`,
  ];
  const lines = ["KnowledgeRail task context"];

  if (decisionCandidateCount > 0) {
    lines.push(
      `Decision candidates: ${decisionCandidateCount}. Inspect title, heading, retrieval reason, staleness, and ` +
        "change impact; materialize only an exact context match, never the whole decisions directory. Prefer its " +
        "passage URI. If that match has no reliable passage, read only its bounded page; if truncated, query the " +
        "missing section and never overwrite unread content. Surface the minimum conflicting set instead of " +
        "choosing by rank."
    );
  }

  const fields = ["currentState", "decisions", ...TASK_CONTEXT_EVIDENCE_FIELDS.filter((field) => field !== "currentState" && field !== "decisions")] as const;
  for (const field of fields) {
    const evidenceItems = manifest[field];
    if (evidenceItems.length === 0) continue;
    lines.push("", `${CONTEXT_SECTION_LABELS[field]}:`);
    for (const evidenceRef of evidenceItems) {
      const evidence = catalog.get(evidenceRef.uri);
      const heading = evidence?.heading ? ` — ${evidence.heading}` : "";
      lines.push(evidence
        ? `- [${evidence.type}] ${evidence.title}${heading}`
        : `- ${evidenceRef.path}`);
    }
  }
  if (manifest.changeImpact.relations.length > 0) {
    lines.push("", "Change impact:");
    for (const relation of manifest.changeImpact.relations) {
      lines.push(`- ${relation.direction} ${relation.kind}: ${relation.from} -> ${relation.to}`);
    }
  }
  if (manifest.changeImpact.codeRoots?.length) {
    lines.push("", "Code impact candidates (indexed snapshot; verify relevant resources before changing code):");
    for (const root of manifest.changeImpact.codeRoots) lines.push(`- ${root.origin}: ${root.path}#${root.symbol}`);
    for (const relation of manifest.changeImpact.codeRelations ?? []) lines.push(`- incoming ${relation.relation}: ${relation.path}#${relation.symbol}`);
  }
  for (const warning of manifest.changeImpact.codeWarnings ?? []) lines.push(`CODE WARNING: ${warning}`);
  if (manifest.repositoryMap) {
    lines.push("", "Repository map (indexed declarations; inspect relevant resources):");
    for (const node of manifest.repositoryMap.nodes) lines.push(`- ${node.path}: ${node.signature}`);
  }
  if (manifest.temporal) {
    lines.push("", `Historical claim validity at ${manifest.temporal.asOf} (page links open current pages):`);
    for (const claim of manifest.temporal.claims) lines.push(`- ${claim.id}: ${claim.text}`);
  }
  if (manifest.history) {
    lines.push("", `Recorded claim history at ${manifest.history.asOf}:`);
    for (const claim of manifest.history.claims) {
      lines.push(`- ${claim.id} [${claim.validity}; recorded=${claim.recordedStatus}] ${claim.validFrom}..${claim.validUntil ?? "open"}: ${claim.text} — ${claim.sourceUri}#${claim.segmentId}`);
      for (const event of claim.supersededBy) lines.push(`  superseded by ${event.claimId} from ${event.effectiveAt}: ${event.reason} — ${event.sourceUri}#${event.segmentId}`);
      for (const relation of claim.relations.filter((r) => r.type === "reinstates")) lines.push(`  explicitly reinstates ${relation.targetClaimId} in a new validity interval`);
    }
    for (const warning of manifest.history.warnings) lines.push(`HISTORY WARNING: ${warning}`);
    if (manifest.history.nextOffset !== undefined) lines.push(`Additional history is available at history_cursor=${manifest.history.nextOffset}:${manifest.history.revision}.`);
  }
  if (manifest.retrieval.nextEvidenceOffset !== undefined) lines.push(`Additional retrieved candidates remain available at evidence_cursor=${manifest.retrieval.nextEvidenceOffset}:${manifest.retrieval.evidenceRevision}; omission from this batch is not a relevance rejection.`);
  if (manifest.retrieval.candidateSearchLimited) lines.push("Candidate discovery is approximate or limited; this batch is not proof of exhaustive retrieval.");
  for (const gap of manifest.unknowns) lines.push(`UNKNOWN ${gap.kind}: ${gap.description}`);
  for (const warning of manifest.retrieval.coverageWarnings) lines.push(`WARNING: ${warning}`);
  lines.push("", ...dynamicLines);
  return lines.join("\n");
}

function evidenceLinks(manifest: TaskContext): ResourceLink[] {
  const links: ResourceLink[] = manifest.evidence.map((evidence) => ({
    type: "resource_link",
    uri: evidence.uri,
    name: `${evidence.stale ? "[STALE] " : ""}${
      evidence.heading ? `${evidence.title} — ${evidence.heading}` : evidence.title
    }`,
    description: evidence.reason,
    mimeType: "text/markdown",
  }));
  for (const code of [...(manifest.changeImpact.codeRoots ?? []), ...(manifest.changeImpact.codeRelations ?? [])]) {
    links.push({ type: "resource_link", uri: code.uri, name: `${code.path}#${code.symbol}`, mimeType: "text/plain",
      description: "Indexed code impact candidate; materialize only if relevant. Call/reference edges are lexical, not proof of execution." });
  }
  for (const page of manifest.changeImpact.codeWikiPages ?? []) links.push({ type: "resource_link", uri: page.uri, name: page.title,
    mimeType: "text/markdown", description: "Related wiki page with an active anchored claim; inspect before relying on it." });
  for (const node of manifest.repositoryMap?.nodes ?? []) links.push({ type: "resource_link", uri: node.uri,
    name: `${node.path}#${node.symbol}`, mimeType: "text/plain", description: "Repository map declaration; lexical edges do not prove execution." });
  return [...new Map(links.map((link) => [link.uri, link])).values()];
}

export function compactStructuredContext(manifest: TaskContext) {
  return {
    version: manifest.version,
    decisions: manifest.decisions,
    evidence: manifest.evidence.map((evidence) => ({
      uri: evidence.uri,
      path: evidence.path,
      title: evidence.title,
      type: evidence.type,
      heading: evidence.heading,
      reason: evidence.reason,
      stale: evidence.stale,
      staleReason: evidence.staleReason,
      driftClaimIds: evidence.driftClaimIds,
    })),
    ...(manifest.repositoryMap ? { repositoryMap: manifest.repositoryMap } : {}),
    ...(manifest.temporal ? { temporal: manifest.temporal } : {}),
    ...(manifest.history ? { history: manifest.history } : {}),
    changeImpact: {
      mode: manifest.changeImpact.mode,
      decisions: manifest.changeImpact.decisions,
      ...(manifest.changeImpact.codeRoots ? {
        codeRoots: manifest.changeImpact.codeRoots,
        codeRelations: manifest.changeImpact.codeRelations,
        codeWikiPages: manifest.changeImpact.codeWikiPages,
        codeSnapshot: manifest.changeImpact.codeSnapshot,
        codeWarnings: manifest.changeImpact.codeWarnings,
        codeTruncated: manifest.changeImpact.codeTruncated,
      } : {}),
    },
    gaps: manifest.unknowns,
    retrieval: {
      evidenceOffset: manifest.retrieval.evidenceOffset,
      evidenceRevision: manifest.retrieval.evidenceRevision,
      nextEvidenceOffset: manifest.retrieval.nextEvidenceOffset,
      remainingEvidenceCount: manifest.retrieval.remainingEvidenceCount,
      candidateSearchLimited: manifest.retrieval.candidateSearchLimited,
      profile: manifest.retrieval.profile,
      coverageMode: manifest.retrieval.coverageMode,
      coverageWarnings: manifest.retrieval.coverageWarnings,
      wideningLevel: manifest.retrieval.wideningLevel,
      coverageSufficient: manifest.retrieval.coverageSufficient,
      evidenceGaps: manifest.retrieval.evidenceGaps,
      estimatedContextTokens: manifest.retrieval.estimatedContextTokens,
      coverageCandidateCount: manifest.retrieval.coverageCandidateCount,
      selectedEvidenceCount: manifest.retrieval.selectedEvidenceCount,
      fallbackUsed: manifest.retrieval.fallbackUsed,
    },
    budget: manifest.budget,
    task: manifest.task,
  };
}

/** Preserve values and ranking while putting volatile task and snapshot data last. */
export function stableContextPayload(manifest: TaskContext): TaskContext {
  const { version, currentState, decisions, repositoryMap, task, intent, objective, retrieval, size, budget, ...rest } = manifest;
  return { version, currentState, decisions, ...rest,
    ...(repositoryMap ? { repositoryMap: { components: repositoryMap.components, nodes: repositoryMap.nodes,
      relations: repositoryMap.relations, truncated: repositoryMap.truncated, widenable: repositoryMap.widenable, snapshot: repositoryMap.snapshot } } : {}),
    budget, size, task, intent, objective, retrieval };
}

export function registerContextTools(
  server: McpServer,
  // Direct registration defaults to the public MCP 2.0 surface. The real
  // server always passes the negotiated era explicitly.
  era: "legacy" | "modern" = "modern"
): void {
  const contextName = toolName("context", era);
  server.registerTool(
    contextName,
    {
      title: "Compile task-aware wiki context",
      description: "Internal bounded task-context operation with explicit unknowns and provenance.",
      inputSchema: z.object({
        intent: z.enum(["understand", "implement", "modify", "debug", "review", "document"]),
        objective: z.string().min(1).max(4_096),
        query: z.string().min(1).max(4_096).optional().describe("Retrieval query; defaults to objective."),
        changed_paths: z.array(z.string().min(1).max(1_024)).max(20).optional()
          .describe("Changed wiki Markdown paths or repository-relative indexed source files for bounded impact analysis."),
        page_types: z.array(z.string().min(1).max(128)).max(20).optional(),
        retrieval_profile: z.enum(["precision", "balanced", "coverage"]).default("balanced"),
        max_evidence: z.number().int().min(1).max(20).default(8),
        heuristic_token_budget: z.number().int().min(256).max(12_000).default(2_000),
        response_detail: z.enum(["full", "compact"]).default("full"),
        include_repository_map: z.boolean().optional(),
        as_of: z.iso.datetime().optional(),
        evidence_cursor: z.string().refine((v) => v.length <= 72 && /^(start|[0-9]{1,7}:[a-f0-9]{64})$/u.test(v)).optional().describe("start or returned cursor."),
        history_cursor: z.string().refine((v) => v.length <= 72 && /^(start|[0-9]{1,7}:[a-f0-9]{64})$/u.test(v)).optional().describe("start or returned cursor."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({
      intent,
      objective,
      query,
      changed_paths,
      page_types,
      retrieval_profile,
      max_evidence,
      heuristic_token_budget,
      response_detail,
      include_repository_map,
      as_of,
      evidence_cursor, history_cursor,
    }) => {
      try {
        const manifest = await compileTaskContext({
          wikiRoot: wikiDir(),
          intent,
          objective,
          query,
          changedPaths: changed_paths,
          pageTypes: page_types,
          retrievalProfile: retrieval_profile,
          maxEvidence: max_evidence,
          heuristicTokenBudget: heuristic_token_budget,
          includeRepositoryMap: include_repository_map,
          asOf: as_of,
          includeAdditional: evidence_cursor !== undefined,
          evidenceOffset: evidence_cursor && evidence_cursor !== "start" ? Number(evidence_cursor.split(":")[0]) : undefined,
          evidenceRevision: evidence_cursor?.split(":")[1],
          includeHistory: history_cursor !== undefined,
          historyOffset: history_cursor && history_cursor !== "start" ? Number(history_cursor.split(":")[0]) : undefined,
          historyRevision: history_cursor?.split(":")[1],
        });
        return {
          content: [
            { type: "text" as const, text: compactManifestText(manifest) },
            ...evidenceLinks(manifest),
          ],
          structuredContent: response_detail === "compact"
            ? compactStructuredContext(manifest)
            : { ...stableContextPayload(manifest) },
        };
      } catch (error: unknown) {
        return errorResult(error);
      }
    }
  );

}
