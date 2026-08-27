import { invalidateWikiGraph } from "../core/graph-index.js";
import { updateRuntimeWikiGraphPaths } from "../core/graph-runtime.js";
import { withDerivedCheckpointLock } from "../core/checkpoint-lock.js";
import { invalidateManifestEntries } from "../core/manifest-service.js";
import { getWikiRoot, wikiDir } from "../core/paths.js";
import { updateRetrievalPaths } from "../core/retrieval-index.js";
import { rebuildIndex } from "../core/wiki-index-service.js";
export {
  errorResult,
  redactWorkspacePaths,
  structuredTextResult,
  textResult,
  type ToolResult,
} from "./tool-results.js";

/**
 * Post-mutation bookkeeping shared by every page-writing tool: invalidate the
 * manifest for the touched pages and regenerate index.md. Returns the status
 * line to append to the tool output.
 */
export async function finalizePageMutation(relPaths: string[]): Promise<string> {
  await invalidateManifestEntries(wikiDir(), relPaths);
  const runtimeUpdated = await withDerivedCheckpointLock(wikiDir(), async (checkpointLock) => {
    await updateRetrievalPaths(wikiDir(), relPaths, { checkpointLock });
    return updateRuntimeWikiGraphPaths(wikiDir(), relPaths, { checkpointLock });
  });
  if (!runtimeUpdated) invalidateWikiGraph(wikiDir());
  const pageCount = await rebuildIndex();
  await invalidateManifestEntries(wikiDir(), ["index.md"]);
  return `Index updated (${pageCount} pages).`;
}
