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
import { toolReferencesForEra, type ProtocolEra } from "../mcp/tool-names.js";

type PromptResult = {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

function promptText(text: string): PromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function registerWikiPrompts(server: McpServer, era: ProtocolEra = "modern"): void {
  server.registerPrompt(
    "plan_document",
    {
      title: "Piano editoriale documento",
      description:
        "Genera il piano editoriale (sezioni, writer, context pack, checklist) per un documento in docs/deliverables.",
      argsSchema: z.object({
              document_type: z
                .enum(DOCUMENT_TYPES)
                .describe(DOCUMENT_TYPES.join(" | ")),
              project_name: z.string().optional(),
              objective: z.string().optional(),
              audience: z.string().optional(),
            }),
    },
    async ({ document_type, project_name, objective, audience }) =>
      promptText(
        toolReferencesForEra(await buildDocumentPlan(wikiDir(), {
          documentType: document_type,
          projectName: project_name,
          objective,
          audience,
        }), era)
      )
  );

  server.registerPrompt(
    "plan_dev_report",
    {
      title: "Template development report",
      description:
        "Restituisce il template obbligatorio del development report da compilare prima dell'ingestione wiki.",
      argsSchema: z.object({
              client: z.string(),
              project: z.string(),
              request_id: z.string(),
              objective: z.string(),
            }),
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
      title: "Prepara aggiornamento wiki",
      description: "Genera una bozza wiki valida da una lacuna e dalle evidenze disponibili.",
      argsSchema: z.object({
              finding: z.string(),
              target_page_path: z.string().optional(),
              page_type: z.enum(WIKI_PAGE_TYPES).optional(),
              title: z.string().optional(),
              knowledge_context: z.string().optional(),
              code_context: z.string().optional(),
              sources: z.string().optional().describe("Fonti separate da virgola"),
            }),
    },
    ({ finding, target_page_path, page_type, title, knowledge_context, code_context, sources }) => {
      const draft = prepareKnowledgeUpdateDraft({
        finding,
        targetPagePath: target_page_path,
        pageType: page_type,
        title,
        wikiContext: knowledge_context,
        codeContext: code_context,
        sources: sources?.split(",").map((source) => source.trim()).filter(Boolean),
      });
      return promptText(toolReferencesForEra([
        `Percorso suggerito: ${draft.path}`,
        "Applica la bozza con wiki_write_page e registra la decisione con wiki_append_log.",
        "```markdown",
        draft.content,
        "```",
      ].join("\n"), era));
    }
  );
}
