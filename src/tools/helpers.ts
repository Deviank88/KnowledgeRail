import { invalidateWikiGraph } from "../core/graph-index.js";
import { updateRuntimeWikiGraphPaths } from "../core/graph-runtime.js";
import { invalidateManifestEntries } from "../core/manifest-service.js";
import { wikiDir } from "../core/paths.js";
import { updateRetrievalPaths } from "../core/retrieval-index.js";
import { rebuildIndex } from "../core/wiki-index-service.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: unknown): ToolResult {
  const text = error instanceof Error ? error.message : String(error);
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
  return `Index aggiornato (${pageCount} pagine).`;
}
