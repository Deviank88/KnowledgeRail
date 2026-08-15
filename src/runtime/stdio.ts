import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../mcp/server.js";
import { activateWorkspace, resolveWorkspace } from "../mcp/workspace.js";
import { canonicalizeExistingDirectory } from "../mcp/workspace-discovery.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";

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
        process.stderr.write(`[knowledge-rail] MCP serving error: ${error.message}\n`);
      },
    }
  );

  process.stderr.write(
    `[knowledge-rail] MCP stdio ready; workspace source: ${initial.source}.\n`
  );
  void new WorkspaceRegistry().register(initial.root, "automatic").catch(() => {
    process.stderr.write("[knowledge-rail] Workspace catalog refresh failed; stdio remains available.\n");
  });
  return handle;
}
