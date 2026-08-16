import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  buildDocumentPlan,
  DOCUMENT_TYPES,
  prepareKnowledgeUpdateDraft,
  WIKI_PAGE_TYPES,
} from "../core/document-workflow.js";
import { buildDevReportPlan } from "../core/report-workflow.js";
import { wikiDir } from "../core/paths.js";
import type { ProtocolEra } from "../mcp/tool-names.js";

type PromptResult = {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

function promptText(text: string): PromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

const PlanDocumentPromptSchema = z.object({
  document_type: z.enum(DOCUMENT_TYPES).describe(DOCUMENT_TYPES.join(" | ")),
  project_name: z.string().optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  language: z.string().optional().describe("Output language; defaults to the user's current request language."),
});

const DevReportPromptSchema = z.object({
  client: z.string(),
  project: z.string(),
  request_id: z.string(),
  objective: z.string(),
});

const KnowledgeUpdatePromptSchema = z.object({
  finding: z.string(),
  target_page_path: z.string().optional(),
  page_type: z.enum(WIKI_PAGE_TYPES).optional(),
  title: z.string().optional(),
  knowledge_context: z.string().optional(),
  code_context: z.string().optional(),
  sources: z.string().optional().describe("Comma-separated sources"),
  language: z.string().optional().describe("Wiki output language; defaults to the user's current request language."),
});

export function registerWikiPrompts(
  server: McpServer,
  era: ProtocolEra = "modern",
  options: { includeWorkspaceBinding?: boolean } = {}
): void {
  void era;
  const bindingField = {
    workspace_binding: z.string().min(20).optional()
      .describe("Opaque binding returned by knowledge_workspace; desktop/catalog profile only."),
  };
  const schemas = options.includeWorkspaceBinding ? {
    document: PlanDocumentPromptSchema.safeExtend(bindingField),
    report: DevReportPromptSchema.safeExtend(bindingField),
    update: KnowledgeUpdatePromptSchema.safeExtend(bindingField),
  } : {
    document: PlanDocumentPromptSchema,
    report: DevReportPromptSchema,
    update: KnowledgeUpdatePromptSchema,
  };
  server.registerPrompt(
    "plan_document",
    {
      title: "Document editorial plan",
      description:
        "Generate an editorial plan (sections, writers, context packs, checklist) for a document in docs/deliverables.",
      argsSchema: schemas.document,
    },
    async ({ document_type, project_name, objective, audience, language }) =>
      promptText(
        await buildDocumentPlan(wikiDir(), {
          documentType: document_type,
          projectName: project_name,
          objective,
          audience,
          language,
        })
      )
  );

  server.registerPrompt(
    "plan_dev_report",
    {
      title: "Template development report",
      description:
        "Return the required development-report template to complete before wiki ingestion.",
      argsSchema: schemas.report,
    },
    ({ client, project, request_id, objective }) =>
      promptText(
        buildDevReportPlan({
          client,
          project,
          requestId: request_id,
          objective,
        })
      )
  );

  server.registerPrompt(
    "prepare_knowledge_update",
    {
      title: "Prepare wiki update",
      description: "Generate a valid wiki draft from a gap and the available evidence.",
      argsSchema: schemas.update,
    },
    ({ finding, target_page_path, page_type, title, knowledge_context, code_context, sources, language }) => {
      const draft = prepareKnowledgeUpdateDraft({
        finding,
        targetPagePath: target_page_path,
        pageType: page_type,
        title,
        wikiContext: knowledge_context,
        codeContext: code_context,
        sources: sources?.split(",").map((source) => source.trim()).filter(Boolean),
      });
      return promptText([
        `Output language: ${language?.trim() || "the user's current request language"}. Translate all human-readable headings and prose in the draft before writing; keep technical frontmatter values stable.`,
        `Suggested path: ${draft.path}`,
        "Apply the draft with knowledge_page action=write and record the decision with action=append_log.",
        "```markdown",
        draft.content,
        "```",
      ].join("\n"));
    }
  );
}
