import { discoverWorkspaceFromCwd } from "../mcp/workspace-discovery.js";
import { WorkspaceRegistry } from "../workspaces/registry.js";

export async function runWorkspaceList(registry = new WorkspaceRegistry()): Promise<void> {
  const entries = await registry.listSafe();
  if (entries.length === 0) {
    process.stdout.write("No registered workspaces. Open a project with KnowledgeRail or run workspace register.\n");
    return;
  }
  for (const entry of entries) {
    process.stdout.write(`${entry.id}\t${entry.displayName}\t${entry.availability}\t${entry.allowedScopes.join(",")}\n`);
  }
}

export async function runWorkspaceRegister(
  suppliedPath: string | undefined,
  registry = new WorkspaceRegistry()
): Promise<void> {
  const root = suppliedPath
    ? suppliedPath
    : (await discoverWorkspaceFromCwd()).root;
  const entry = await registry.register(root, "operator");
  process.stdout.write(`Registered ${entry.displayName} as ${entry.id}.\n`);
}

export async function runWorkspaceUnregister(
  workspaceId: string,
  registry = new WorkspaceRegistry()
): Promise<void> {
  if (!/^ws_[A-Za-z0-9_-]{8,}$/.test(workspaceId)) {
    throw new Error("Invalid workspace ID.");
  }
  const removed = await registry.unregister(workspaceId);
  if (!removed) throw new Error("Workspace ID was not found.");
  process.stdout.write(`Unregistered ${workspaceId}; no project files were deleted.\n`);
}
