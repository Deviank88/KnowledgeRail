import type { McpServer, ResourceLink } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  TASK_CONTEXT_EVIDENCE_FIELDS,
  compileTaskContext,
  type TaskContext,
} from "../context/task-context-compiler.js";
import { readWikiResource } from "../context/resource-reader.js";
import { wikiDir } from "../core/paths.js";
import { errorResult } from "./helpers.js";
import { toolName } from "../mcp/tool-names.js";

const ResourceReadMetadataSchema = z.object({
  uri: z.string(),
  pageUri: z.string(),
  path: z.string(),
  passageId: z.string().optional(),
  title: z.string(),
  type: z.string(),
  heading: z.string().optional(),
  truncated: z.boolean(),
  totalCharacters: z.number().int().nonnegative(),
  returnedCharacters: z.number().int().nonnegative(),
});

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

function compactManifestText(manifest: TaskContext, includeUris: boolean): string {
  const catalog = new Map(manifest.evidence.map((evidence) => [evidence.uri, evidence] as const));
  const lines = [
    `Task context: ${manifest.evidence.length} evidence, ${manifest.unknowns.length} unknown(s), ` +
      `~${manifest.size.heuristicTokens} heuristic tokens (${manifest.size.estimator}).`,
    `Intent: ${manifest.task.intent}`,
    `Objective: ${manifest.task.objective}`,
    `Retrieval: ${manifest.retrieval.strategy} W${manifest.retrieval.wideningLevel}; ` +
      `coverage=${manifest.retrieval.coverageSufficient}; fallback=${manifest.retrieval.fallbackUsed}.`,
  ];

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
      if (includeUris) lines.push(`  ${evidenceRef.uri}`);
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
    name: evidence.heading ? `${evidence.title} — ${evidence.heading}` : evidence.title,
    description: evidence.reason,
    mimeType: "text/markdown",
  }));
}

function compactStructuredContext(manifest: TaskContext) {
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
    })),
    gaps: manifest.unknowns,
    retrieval: {
      profile: manifest.retrieval.profile,
      wideningLevel: manifest.retrieval.wideningLevel,
      coverageSufficient: manifest.retrieval.coverageSufficient,
      evidenceGaps: manifest.retrieval.evidenceGaps,
      estimatedContextTokens: manifest.retrieval.estimatedContextTokens,
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
  const modern = era === "modern";
  const menuName = toolName("menu", era);
  const contextName = toolName("context", era);
  server.registerTool(
    contextName,
    {
      title: "Compile task-aware wiki context",
      description: modern
        ? `Primary read path from ${menuName}: bounded task context, explicit unknowns and resource links. Prefer compact.`
        : `Primary read path from ${menuName}; read selected evidence with wiki_read_resource.`,
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
          content: modern
            ? [
                { type: "text" as const, text: compactManifestText(manifest, false) },
                ...evidenceLinks(manifest),
              ]
            : [{ type: "text" as const, text: compactManifestText(manifest, true) }],
          structuredContent: response_detail === "compact"
            ? compactStructuredContext(manifest)
            : { ...manifest },
        };
      } catch (error: unknown) {
        return errorResult(error);
      }
    }
  );

  if (modern) return;

  server.registerTool(
    "wiki_read_resource",
    {
      title: "Read referenced wiki evidence",
      description:
        "Read one KnowledgeRail page/passage URI returned by wiki_context. Passage URIs materialize only " +
        "that evidence; page reads are capped unless max_chars is explicitly increased.",
      inputSchema: z.object({
        resource_uri: z.string().startsWith("knowledge-rail://page/"),
        max_chars: z.number().int().min(1).max(50_000).default(6_000),
      }),
      outputSchema: ResourceReadMetadataSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ resource_uri, max_chars }) => {
      try {
        const read = await readWikiResource({
          wikiRoot: wikiDir(),
          resourceUri: resource_uri,
          maxCharacters: max_chars,
        });
        const returnedCharacters = [...read.text].length;
        const metadata = {
          uri: read.uri,
          pageUri: read.pageUri,
          path: read.path,
          passageId: read.passageId,
          title: read.title,
          type: read.type,
          heading: read.heading,
          truncated: read.truncated,
          totalCharacters: read.totalCharacters,
          returnedCharacters,
        };
        const label = read.heading ? `${read.title} — ${read.heading}` : read.title;
        const truncation = read.truncated
          ? `\n\n[Truncated: ${returnedCharacters}/${read.totalCharacters} characters returned]`
          : "";
        return {
          content: [{ type: "text" as const, text: `# ${label}\n\n${read.text}${truncation}` }],
          structuredContent: { ...metadata },
        };
      } catch (error: unknown) {
        return errorResult(error);
      }
    }
  );
}
