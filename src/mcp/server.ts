import {
  McpServer,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {
  getWikiRoot,
  isWikiRootReady,
  markWikiRootPending,
} from "../core/paths.js";
import {
  resolveAndActivateWorkspace,
  resolveLegacyMcpWorkspace,
} from "./workspace.js";
import { registerAgentTools } from "../tools/agent-tools.js";
import { registerWikiPrompts } from "../tools/prompts.js";
import { registerWikiResources } from "../tools/resources.js";
import { type ProtocolEra } from "./tool-names.js";
import { registerWorkspaceTool } from "../tools/workspace-tool.js";
import type { WorkspaceBindingManager } from "../workspaces/bindings.js";
import { PRODUCT_VERSION } from "../product.js";
import { logger } from "../core/logger.js";

const STATIC_CATALOG_TTL_MS = 5 * 60 * 1_000;

export function mcpAgentInstructions(era: ProtocolEra): string {
  void era;
  return (
    "Use one of the eight KnowledgeRail domain tools directly; do not look for a navigation menu. " +
    "For normal project work start with knowledge_context mode=task and a concrete objective; " +
    "omit response_detail so the compact default is used. " +
    "Follow the structured nextAction returned by each operation. Materialize only relevant " +
    "knowledge-rail:// or code:// links with resources/read when available; otherwise use " +
    "knowledge_page action=read for knowledge-rail:// links. If coverage remains insufficient after " +
    "the suggested widening, preserve evidenceGaps as explicit unknowns instead of guessing."
  );
}

export const MCP_AGENT_INSTRUCTIONS = mcpAgentInstructions("modern");

export interface ServerBuildOptions {
  profile?:
    | { kind: "bound" }
    | { kind: "catalog"; bindings: WorkspaceBindingManager; principalId: string };
}

function configureLegacyWorkspace(server: McpServer): void {
  let refreshQueue: Promise<void> = Promise.resolve();

  const refreshWorkspace = (reason: "initialized" | "roots_changed"): Promise<void> => {
    const previous = isWikiRootReady() ? getWikiRoot() : null;

    // Close the path gate synchronously before the first await. The MCP core
    // dispatches notifications asynchronously, so a tool racing the legacy
    // Roots request fails closed instead of touching a fallback project.
    markWikiRootPending();

    refreshQueue = refreshQueue.then(async () => {
      const resolution = await resolveLegacyMcpWorkspace(server);
      if (previous !== resolution.root || reason === "initialized") {
        logger.info("workspace", "legacy_workspace_resolved", {
          reason,
          source: resolution.source,
        });
      }
    }).catch(async (error: unknown) => {
      // Roots failures normally fall back inside the resolver. This final
      // safety net guarantees that an unexpected adapter failure still
      // reopens the workspace gate on deterministic env/cwd resolution.
      const fallback = await resolveAndActivateWorkspace();
      logger.warn("workspace", "legacy_workspace_resolution_failed", {
        fallbackSource: fallback.source,
      }, error);
    });

    return refreshQueue;
  };

  // Only 2025-era instances receive deprecated Roots compatibility hooks.
  // Modern 2026-07-28 instances never negotiate Roots.
  server.server.oninitialized = () => {
    void refreshWorkspace("initialized");
  };

  server.server.setNotificationHandler(
    "notifications/roots/list_changed",
    async () => {
      await refreshWorkspace("roots_changed");
    }
  );
}

export function buildServer(
  context: McpRequestContext = { era: "modern" },
  options: ServerBuildOptions = {}
): McpServer {
  const profile = options.profile ?? { kind: "bound" as const };
  const server = new McpServer(
    {
      name: "knowledge-rail",
      version: PRODUCT_VERSION,
    },
    {
      instructions: profile.kind === "catalog"
        ? "This is a context-free desktop chat. First call knowledge_workspace list, ask the user which workspace to use, then select it with explicit confirmation. Keep the returned opaque workspace_binding only in this conversation and include it in every domain call. Never invent an ID or filesystem path. Prefer a new chat when changing customer workspace."
        : mcpAgentInstructions(context.era),
      // These catalogs are registration metadata and do not depend on wiki
      // contents. Modern clients may safely reuse them, reducing repeated
      // schema/context transfer. Mutable knowledge reads deliberately remain
      // uncached.
      cacheHints: {
        "server/discover": { ttlMs: STATIC_CATALOG_TTL_MS, cacheScope: "private" },
        "tools/list": { ttlMs: STATIC_CATALOG_TTL_MS, cacheScope: "private" },
        "prompts/list": { ttlMs: STATIC_CATALOG_TTL_MS, cacheScope: "private" },
        "resources/list": { ttlMs: STATIC_CATALOG_TTL_MS, cacheScope: "private" },
        "resources/templates/list": { ttlMs: STATIC_CATALOG_TTL_MS, cacheScope: "private" },
      },
    }
  );

  registerAgentTools(server, context.era, { includeWorkspaceBinding: profile.kind === "catalog" });
  registerWikiPrompts(server, context.era, { includeWorkspaceBinding: profile.kind === "catalog" });
  registerWikiResources(server, { includeWorkspaceBinding: profile.kind === "catalog" });

  if (profile.kind === "catalog") {
    registerWorkspaceTool(server, profile.bindings, profile.principalId);
  }

  if (context.era === "legacy" && profile.kind === "bound") {
    configureLegacyWorkspace(server);
  }

  return server;
}
