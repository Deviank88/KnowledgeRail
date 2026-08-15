import type { SeededGraphQueryResult } from "./graph-runtime.js";

export function graphSummaryForSeededResult(
  result: SeededGraphQueryResult,
  pagePaths: readonly string[]
): string {
  if (pagePaths.length === 0 || result.edges.length === 0) return "";
  const selectedPageIds = new Set(
    result.nodes
      .filter((node) => node.kind === "page" && node.path && pagePaths.includes(node.path))
      .map((node) => node.id)
  );
  if (selectedPageIds.size === 0) return "";

  const labels = new Map(result.nodes.map((node) => [node.id, node.label] as const));
  const relevant = result.edges.filter(
    (edge) => selectedPageIds.has(edge.from) || selectedPageIds.has(edge.to)
  );
  if (relevant.length === 0) return "";

  return [
    "## Sintesi graph-based",
    "",
    ...relevant.slice(0, 40).map(
      (edge) => `- ${labels.get(edge.from) ?? edge.from} --${edge.kind}--> ${labels.get(edge.to) ?? edge.to}`
    ),
    "",
  ].join("\n");
}
