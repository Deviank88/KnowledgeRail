import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../mcp/server.js";
import { activateWorkspace, resolveWorkspace } from "../mcp/workspace.js";
import { canonicalizeExistingDirectory } from "../mcp/workspace-discovery.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";
import { logger } from "../core/logger.js";

export interface StdioRuntimeHandle {
  close(): Promise<void>;
}

export async function runStdio(options: { root?: string } = {}): Promise<StdioRuntimeHandle> {
  const resolved = await resolveWorkspace({
    explicitRoot: options.root,
    automaticDiscovery: true,
  });
  const initial = activateWorkspace({
    ...resolved,
    root: await canonicalizeExistingDirectory(resolved.root),
  });

  const handle = serveStdio(
    (context) => buildServer(context),
    {
      legacy: "serve",
      onerror: (error) => {
        logger.error("stdio", "mcp_serving_error", {}, error);
      },
    }
  );

  logger.info("stdio", "ready", { workspaceSource: initial.source });
  void new WorkspaceRegistry().register(initial.root, "automatic").catch((error: unknown) => {
    logger.warn("stdio", "workspace_catalog_refresh_failed", {}, error);
  });
  return handle;
}
