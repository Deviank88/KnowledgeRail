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
  const lines = [
    `Task context: ${manifest.evidence.length} evidence, ${manifest.unknowns.length} unknown(s), ` +
      `~${manifest.size.heuristicTokens} heuristic tokens (${manifest.size.estimator}).`,
    `Intent: ${manifest.task.intent}`,
    `Objective: ${manifest.task.objective}`,
    `Retrieval: ${manifest.retrieval.strategy} W${manifest.retrieval.wideningLevel}; ` +
      `coverage=${manifest.retrieval.coverageSufficient}; mode=${manifest.retrieval.coverageMode}; ` +
      `fallback=${manifest.retrieval.fallbackUsed}.`,
  ];

  for (const warning of manifest.retrieval.coverageWarnings) lines.push(`WARNING: ${warning}`);

  for (const field of TASK_CONTEXT_EVIDENCE_FIELDS) {
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
  for (const gap of manifest.unknowns) lines.push(`UNKNOWN ${gap.kind}: ${gap.description}`);
  return lines.join("\n");
}

function evidenceLinks(manifest: TaskContext): ResourceLink[] {
  return manifest.evidence.map((evidence) => ({
    type: "resource_link",
    uri: evidence.uri,
    name: `${evidence.stale ? "[STALE] " : ""}${
      evidence.heading ? `${evidence.title} — ${evidence.heading}` : evidence.title
    }`,
    description: evidence.reason,
    mimeType: "text/markdown",
  }));
}

export function compactStructuredContext(manifest: TaskContext) {
  return {
    version: manifest.version,
    task: manifest.task,
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
    gaps: manifest.unknowns,
    retrieval: {
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
  };
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
        objective: z.string().min(1),
        query: z.string().min(1).optional().describe("Retrieval query; defaults to objective."),
        changed_paths: z.array(z.string().min(1).max(1_024)).max(20).optional()
          .describe("Wiki-relative changed components for impact analysis."),
        page_types: z.array(z.string().min(1).max(128)).max(20).optional(),
        retrieval_profile: z.enum(["precision", "balanced", "coverage"]).default("balanced"),
        max_evidence: z.number().int().min(1).max(20).default(8),
        heuristic_token_budget: z.number().int().min(256).max(12_000).default(2_000),
        response_detail: z.enum(["full", "compact"]).default("full"),
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
        });
        return {
          content: [
            { type: "text" as const, text: compactManifestText(manifest) },
            ...evidenceLinks(manifest),
          ],
          structuredContent: response_detail === "compact"
            ? compactStructuredContext(manifest)
            : { ...manifest },
        };
      } catch (error: unknown) {
        return errorResult(error);
      }
    }
  );

}
