import { invalidateWikiGraph } from "../core/graph-index.js";
import { updateRuntimeWikiGraphPaths } from "../core/graph-runtime.js";
import { invalidateManifestEntries } from "../core/manifest-service.js";
import { getWikiRoot, wikiDir } from "../core/paths.js";
import { updateRetrievalPaths } from "../core/retrieval-index.js";
import { rebuildIndex } from "../core/wiki-index-service.js";
import { WorkspaceAuthorizationError } from "../core/paths.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function structuredTextResult(
  text: string,
  structuredContent: Record<string, unknown>
): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactWorkspacePaths(text: string): string {
  let redacted = text;
  try {
    const root = getWikiRoot();
    const variants = new Set([root, root.replace(/\\/g, "/")]);
    for (const variant of variants) {
      if (!variant) continue;
      redacted = redacted.replace(
        new RegExp(escapedRegExp(variant), process.platform === "win32" ? "gi" : "g"),
        "<workspace>"
      );
    }
  } catch {
    // Workspace negotiation errors intentionally contain no resolved root.
  }
  return redacted;
}

export function errorResult(error: unknown): ToolResult {
  const text = redactWorkspacePaths(error instanceof Error ? error.message : String(error));
  if (error instanceof WorkspaceAuthorizationError) {
    return {
      content: [{ type: "text", text }],
      isError: true,
      structuredContent: {
        state: "blocked",
        reason: "workspace_binding_required",
        nextAction: {
          tool: "knowledge_workspace",
          action: "list",
          requiredArguments: ["action"],
          suggestedArguments: { action: "list" },
        },
      },
    };
  }
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Post-mutation bookkeeping shared by every page-writing tool: invalidate the
 * manifest for the touched pages and regenerate index.md. Returns the status
 * line to append to the tool output.
 */
export async function finalizePageMutation(relPaths: string[]): Promise<string> {
  await invalidateManifestEntries(wikiDir(), relPaths);
  await updateRetrievalPaths(wikiDir(), relPaths);
  const runtimeUpdated = await updateRuntimeWikiGraphPaths(wikiDir(), relPaths);
  if (!runtimeUpdated) invalidateWikiGraph(wikiDir());
  const pageCount = await rebuildIndex();
  await invalidateManifestEntries(wikiDir(), ["index.md"]);
  return `Index updated (${pageCount} pages).`;
}
