import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  MENU_AREAS,
  MENU_OPERATIONS,
  WORKFLOW_OUTCOMES,
  resolveWorkflowTransition,
  validateWorkflowOutcomeObservation,
  workflowFor,
} from "../mcp/workflows.js";
import { errorResult } from "./helpers.js";
import {
  toolName,
  toolNameForEra,
  toolReferencesForEra,
} from "../mcp/tool-names.js";

const AREA_MENU_ITEMS = [
  { id: "read", description: "Understand, implement, modify, debug or review from bounded wiki context." },
  { id: "ingest", description: "Integrate a source or development report with provenance and coverage." },
  { id: "code", description: "Search symbols/references or maintain the deterministic code index." },
  { id: "document", description: "Create, review or export a deliverable." },
  { id: "admin", description: "Initialize or perform a targeted structural wiki operation." },
] as const;

export function registerWorkflowTools(
  server: McpServer,
  era: "legacy" | "modern"
): void {
  const menuName = toolName("menu", era);
  server.registerTool(
    menuName,
    {
      title: "Choose and guide a KnowledgeRail operation",
      description:
        "START HERE. Returns one guided action for read/ingest/code/document/admin; call again after each step. Read-only.",
      inputSchema: z.object({
        area: z.enum(MENU_AREAS).optional()
          .describe("Choose an area."),
        operation: z.string().min(1).optional()
          .describe("Operation id from the submenu."),
        completed_step_id: z.string().min(1).optional()
          .describe("Last completed step id."),
        outcome: z.enum(WORKFLOW_OUTCOMES).optional()
          .describe("Observed allowed outcome, only when requested."),
        coverage_sufficient: z.boolean().optional()
          .describe(`Copy latest ${toolName("context", era)} coverageSufficient for read outcomes.`),
        evidence_gaps: z.array(z.string().min(1).max(256)).max(100).optional()
          .describe(`Copy latest ${toolName("context", era)} evidenceGaps for read outcomes.`),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ area, operation, completed_step_id, outcome, coverage_sufficient, evidence_gaps }) => {
      try {
        if (!area) {
          return {
            content: [{
              type: "text" as const,
              text: [
                "# KnowledgeRail operation menu",
                "",
                `Choose one area, then call ${menuName} again with that area:`,
                "",
                ...AREA_MENU_ITEMS.map((item) => `- ${item.id} — ${item.description}`),
                "",
                "Do not guess a lower-level tool before selecting the area.",
              ].join("\n"),
            }],
            structuredContent: {
              level: "areas",
              areas: AREA_MENU_ITEMS,
              next: { tool: menuName, arguments: { area: "<chosen area>" } },
              protocolEra: era,
            },
          };
        }

        if (!operation) {
          const operations = MENU_OPERATIONS[area];
          return {
            content: [{
              type: "text" as const,
              text: [
                `# ${area} operations`,
                "",
                ...operations.map((candidate) => `- ${candidate.id} — ${candidate.description}`),
                "",
                `Call ${menuName} with area=${area} and one operation id.`,
              ].join("\n"),
            }],
            structuredContent: {
              level: "operations",
              area,
              operations,
              next: {
                tool: menuName,
                arguments: { area, operation: "<chosen operation id>" },
              },
              protocolEra: era,
            },
          };
        }

        const workflow = workflowFor(area, operation);
        validateWorkflowOutcomeObservation(workflow, completed_step_id, outcome, {
          coverageSufficient: coverage_sufficient,
          evidenceGaps: evidence_gaps,
        });
        const transition = resolveWorkflowTransition(workflow, completed_step_id, outcome);
        const next = transition.next;
        const resolvedTool = next?.tool ? toolNameForEra(next.tool, era) : undefined;
        const nextLine = transition.complete
          ? `complete — ${workflow.completion}`
          : next
            ? `${next.id}: ${resolvedTool ?? "client capability"}` +
              `${next.action ? ` action=${next.action}` : ""}` +
              ` — ${toolReferencesForEra(next.instruction, era)}`
            : `report outcome — ${transition.allowedOutcomes.join(" | ")}`;
        const argumentLines = next?.suggestedArguments
          ? ["", "Suggested arguments:", "```json", JSON.stringify(next.suggestedArguments, null, 2), "```"]
          : [];
        const outcomeLines = transition.allowedOutcomes.length > 0 && !transition.complete
          ? [
              "",
              `Allowed outcomes after ${completed_step_id}: ${transition.allowedOutcomes.join(", ")}.`,
              `Call ${menuName} again with the same area/operation, completed_step_id and observed outcome.`,
              ...(workflow.area === "read" && completed_step_id === "read_selected_resources"
                ? [`Also copy coverage_sufficient and evidence_gaps from the latest ${toolName("context", era)} retrieval object.`]
                : []),
            ]
          : [];
        return {
          content: [{
            type: "text" as const,
            text: [
              `# ${workflow.key}`,
              "",
              `- next: ${nextLine}`,
              `- completion: ${toolReferencesForEra(workflow.completion, era)}`,
              ...argumentLines,
              ...outcomeLines,
              "",
              "Guardrails:",
              ...workflow.guardrails.map((guardrail) => `- ${toolReferencesForEra(guardrail, era)}`),
            ].join("\n"),
          }],
          structuredContent: {
            level: "step",
            area,
            operation,
            workflow: workflow.key,
            protocolEra: era,
            next: next ? {
              id: next.id,
              tool: resolvedTool,
              action: next.action,
              suggestedArguments: next.suggestedArguments,
            } : null,
            allowedOutcomes: transition.allowedOutcomes,
            complete: transition.complete,
            completion: toolReferencesForEra(workflow.completion, era),
            observedCoverage: coverage_sufficient === undefined && evidence_gaps === undefined
              ? undefined
              : { coverageSufficient: coverage_sufficient, evidenceGaps: evidence_gaps },
          },
        };
      } catch (error: unknown) {
        return errorResult(
          error instanceof Error
            ? toolReferencesForEra(error.message, era)
            : error
        );
      }
    }
  );
}
