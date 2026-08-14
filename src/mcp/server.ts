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
import { registerContextTools } from "../tools/context-tools.js";
import { registerDocumentTools } from "../tools/document-tools.js";
import { registerWikiPrompts } from "../tools/prompts.js";
import { registerSourceTools } from "../tools/source-tools.js";
import { registerWikiTools } from "../tools/wiki-tools.js";
import { registerWikiResources } from "../tools/resources.js";
import { registerEvidenceTools } from "../tools/evidence-tools.js";
import { registerCodeEvidenceTools } from "../tools/code-evidence-tools.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";
import { toolName, type ProtocolEra } from "./tool-names.js";

const STATIC_CATALOG_TTL_MS = 5 * 60 * 1_000;

export function mcpAgentInstructions(era: ProtocolEra): string {
  const menu = toolName("menu", era);
  const context = toolName("context", era);
  return (
    `Start every KnowledgeRail task by calling ${menu} with no arguments. ` +
    "Choose an area and operation from its responses, execute only the returned next tool/action, " +
    `then call ${menu} again with completed_step_id and any requested outcome. For read workflows, ` +
    "materialize selected passage links with resources/read and copy coverageSufficient/evidenceGaps " +
    `from the latest ${context} when reporting the coverage outcome. ` +
    "This preserves coverage, provenance and bounded context across models with different capabilities."
  );
}

export const MCP_AGENT_INSTRUCTIONS = mcpAgentInstructions("modern");

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
        process.stderr.write(
          `[knowledge-rail] Legacy workspace ${reason}: ${resolution.root} (${resolution.source})\n`
        );
      }
    }).catch(async (error: unknown) => {
      // Roots failures normally fall back inside the resolver. This final
      // safety net guarantees that an unexpected adapter failure still
      // reopens the workspace gate on deterministic env/cwd resolution.
      const fallback = await resolveAndActivateWorkspace();
      process.stderr.write(
        `[knowledge-rail] Legacy workspace resolution failed; using ${fallback.root} ` +
        `(${fallback.source}): ${String(error)}\n`
      );
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
  context: McpRequestContext = { era: "modern" }
): McpServer {
  const server = new McpServer(
    {
      name: "knowledge-rail",
      version: "1.0.0",
    },
    {
      instructions: mcpAgentInstructions(context.era),
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

  registerWorkflowTools(server, context.era);
  registerWikiTools(server, context.era);
  registerContextTools(server, context.era);
  registerSourceTools(server, context.era);
  registerEvidenceTools(server, context.era);
  registerCodeEvidenceTools(server, context.era);
  registerDocumentTools(server, context.era);
  registerWikiPrompts(server, context.era);
  registerWikiResources(server);

  if (context.era === "legacy") {
    configureLegacyWorkspace(server);
  }

  return server;
}
