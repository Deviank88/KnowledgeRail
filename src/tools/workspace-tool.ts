import { fromJsonSchema, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BINDING_FORMAT_VERSION } from "../product.js";
import { WorkspaceBindingError, WorkspaceBindingManager } from "../workspaces/bindings.js";

const WorkspaceToolSchema = z.object({
  action: z.enum(["list", "select", "status", "renew", "release"]),
  workspace_id: z.string().startsWith("ws_").optional(),
  scope: z.enum(["read", "write"]).default("read"),
  confirmed: z.boolean().default(false)
    .describe("Set true only after the user explicitly confirms the workspace and requested scope."),
  workspace_binding: z.string().optional(),
}).superRefine((value, context) => {
  if (value.action === "select" && !value.workspace_id) {
    context.addIssue({ code: "custom", path: ["workspace_id"], message: "action=select requires workspace_id." });
  }
  if (["status", "renew", "release"].includes(value.action) && !value.workspace_binding) {
    context.addIssue({ code: "custom", path: ["workspace_binding"], message: `action=${value.action} requires workspace_binding.` });
  }
});

const WorkspaceOutputSchema = fromJsonSchema({
  type: "object",
  properties: {
    state: { type: "string" },
    binding: {
      type: "string",
      pattern: `^krb${BINDING_FORMAT_VERSION}_[A-Za-z0-9_-]{40,}$`,
      description: "Opaque per-chat workspace binding to copy unchanged into subsequent domain calls.",
    },
    workspace: {
      type: "object",
      properties: {
        id: { type: "string" },
        displayName: { type: "string" },
        disambiguator: { type: "string" },
        availability: { type: "string", enum: ["available", "unavailable"] },
        allowedScopes: { type: "array", items: { type: "string", enum: ["read", "write"] } },
      },
      additionalProperties: true,
    },
    scope: { type: "string", enum: ["read", "write"] },
    expiresAt: { type: "string" },
    nextAction: { type: ["object", "null"] },
  },
  required: ["state", "nextAction"],
  additionalProperties: true,
});

function result(text: string, structuredContent: Record<string, unknown>, isError = false): CallToolResult {
  const binding = typeof structuredContent.binding === "string"
    ? structuredContent.binding
    : undefined;
  const portableText = binding
    ? [
        text,
        `workspace_binding: ${binding}`,
        "Copy this exact workspace_binding into every subsequent KnowledgeRail domain call in this chat.",
      ].join("\n")
    : text;
  return {
    content: [{ type: "text", text: portableText }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export function registerWorkspaceTool(
  server: McpServer,
  bindings: WorkspaceBindingManager,
  principalId: string
): void {
  server.registerTool("knowledge_workspace", {
    description: "List user-approved workspaces and manage one opaque per-chat binding.",
    inputSchema: WorkspaceToolSchema,
    outputSchema: WorkspaceOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      if (args.action === "list") {
        const workspaces = await bindings.registry.listSafe();
        return result(
          workspaces.length > 0
            ? `Available workspaces:\n${workspaces.map((item) => `- ${item.displayName} (${item.disambiguator}): ${item.id} [${item.availability}]`).join("\n")}`
            : "No workspace is registered. Open one from an IDE/terminal or use the local operator command.",
          {
            state: "workspaces_listed",
            workspaces,
            nextAction: workspaces.some((item) => item.availability === "available")
              ? { tool: "knowledge_workspace", action: "select", requiredArguments: ["action", "workspace_id", "scope", "confirmed"] }
              : null,
          }
        );
      }

      if (args.action === "select") {
        const workspace = (await bindings.registry.listSafe()).find((item) => item.id === args.workspace_id);
        if (!workspace) return result("Workspace not found.", { state: "blocked", nextAction: { tool: "knowledge_workspace", action: "list" } }, true);
        if (!args.confirmed) {
          return result(
            `Ask the user to confirm access to ${workspace.displayName} (${workspace.disambiguator}) with ${args.scope} scope. ` +
            "For strict customer separation, use a new chat before changing an existing chat to another workspace.",
            {
              state: "confirmation_required",
              workspace,
              requestedScope: args.scope,
              warning: "Filesystem isolation cannot remove information already present in this conversation.",
              nextAction: {
                tool: "knowledge_workspace",
                action: "select",
                requiredArguments: ["action", "workspace_id", "scope", "confirmed"],
                suggestedArguments: { action: "select", workspace_id: workspace.id, scope: args.scope, confirmed: true },
              },
            }
          );
        }
        const status = await bindings.issue(args.workspace_id!, args.scope, principalId);
        return result(
          `Workspace ${status.workspace.displayName} selected for this chat with ${status.scope} scope.`,
          { state: "workspace_selected", ...status, nextAction: { tool: "knowledge_context", requiredArguments: ["mode", "objective", "workspace_binding"] } }
        );
      }

      if (args.action === "status") {
        const status = await bindings.status(args.workspace_binding!, principalId);
        return result(`Binding is active for ${status.workspace.displayName} until ${status.expiresAt}.`, {
          state: "workspace_binding_active", ...status, nextAction: null,
        });
      }
      if (args.action === "renew") {
        const status = await bindings.renew(args.workspace_binding!, principalId);
        return result(`Binding renewed until ${status.expiresAt}.`, {
          state: "workspace_binding_renewed", ...status, nextAction: null,
        });
      }

      bindings.release(args.workspace_binding!, principalId);
      return result("Workspace binding released. Select a workspace before another domain operation.", {
        state: "workspace_binding_released",
        nextAction: { tool: "knowledge_workspace", action: "list", requiredArguments: ["action"] },
      });
    } catch (error) {
      const message = error instanceof WorkspaceBindingError ? error.message : "Workspace operation failed.";
      return result(message, {
        state: "blocked",
        reason: error instanceof WorkspaceBindingError ? error.code : "internal",
        nextAction: { tool: "knowledge_workspace", action: "list", requiredArguments: ["action"] },
      }, true);
    }
  });
}
