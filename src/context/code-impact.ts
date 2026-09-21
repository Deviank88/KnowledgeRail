import { dirname } from "node:path";
import { codeResourceUri, PersistentCodeEvidenceIndex } from "../core/code-evidence/index.js";
import { DEFAULT_QUERY_ADAPTERS } from "../core/code-evidence/query-runtime.js";
import { parseCodeResourceUri } from "../core/code-evidence/resource-uri.js";
import { CODE_IMPACT_MAX_ROOTS, type CodeImpactTarget, type KnowledgeFragment } from "../core/code-evidence/types.js";
import { normalizeRepositoryPath, type StaleClaimsForPage } from "../core/drift-detection.js";
import type { RuntimeGraph } from "../core/graph-runtime.js";
import { pagePathsByClaim, type EvidenceIrStore } from "../core/ingestion/evidence-store.js";
import type { KnowledgeGap } from "./context-manifest.js";
import { wikiPageUri } from "./resource-uri.js";

export interface CodeImpactRef { uri: string; path: string; symbol: string; deploymentStatus?: KnowledgeFragment["deploymentStatus"] }
export interface CodeImpactRoot extends CodeImpactRef {
  origin: "changed_path" | "task_path" | "claim";
  claimId?: string;
  pagePath?: string;
}
export interface CodeImpactRelation extends CodeImpactRef {
  rootUri: string;
  relation: "call" | "reference" | "import";
}
export interface CodeImpactWikiPage {
  uri: string;
  path: string;
  title: string;
  type: string;
  rootUri: string;
  claimId: string;
}
export interface CodeImpactFields {
  codeRoots?: CodeImpactRoot[];
  codeRelations?: CodeImpactRelation[];
  codeWikiPages?: CodeImpactWikiPage[];
  codeSnapshot?: string;
  codeWarnings?: string[];
  codeTruncated?: boolean;
}
export interface CodeImpactExpansion {
  fields: CodeImpactFields;
  gaps: KnowledgeGap[];
  requestedPaths: string[];
}

/** Only syntactic source paths in the task, never guessed directories/symbols. */
export function taskCodePaths(text: string): string[] {
  const found = new Set<string>();
  const quoted: string[] = [];
  const unquoted = text.replace(/`([^`]+)`|"([^"\n]+)"|'([^'\n]+)'/gu, (_match, backtick: string, double: string, single: string) => {
    quoted.push(backtick ?? double ?? single); return " ";
  });
  for (const token of [...quoted, ...unquoted.split(/\s+/u)]) {
    const value = token.replace(/^[`'"([{]+|[`'"),;\]}]+$/gu, "").replace(/\.$/u, "").replace(/:\d+(?:[-:]\d+)?$/u, "");
    if (value.includes("://") || !DEFAULT_QUERY_ADAPTERS.resolve({ path: value })) continue;
    try { found.add(normalizeRepositoryPath(value)); } catch { continue; }
    if (found.size === 20) break;
  }
  return [...found].sort();
}

function codeRef(fragment: KnowledgeFragment): CodeImpactRef | undefined {
  const uri = codeResourceUri(fragment);
  try { parseCodeResourceUri(uri); } catch { return; }
  return { uri, path: fragment.path, symbol: fragment.symbol,
    ...(fragment.deploymentStatus ? { deploymentStatus: fragment.deploymentStatus } : {}) };
}

export async function expandCodeImpact(params: {
  wikiRoot: string;
  explicitPaths: readonly string[];
  taskPaths: readonly string[];
  selectedPages: readonly string[];
  inferClaims: boolean;
  readStore: () => Promise<EvidenceIrStore>;
  staleClaims: ReadonlyMap<string, StaleClaimsForPage>;
  graph: RuntimeGraph;
}): Promise<CodeImpactExpansion> {
  const gaps: KnowledgeGap[] = [];
  const fields: CodeImpactFields = { codeRoots: [], codeRelations: [], codeWikiPages: [] };
  const requestedPaths = [...new Set([...params.explicitPaths, ...params.taskPaths])];
  // Keep one lookahead request to report truncation without accumulating every
  // anchored claim on a large knowledge page.
  const requests: Array<{ target: CodeImpactTarget; origin: CodeImpactRoot["origin"]; pagePath?: string; claimId?: string }> = requestedPaths.slice(0, CODE_IMPACT_MAX_ROOTS + 1).map((path) => ({
    target: { path }, origin: params.explicitPaths.includes(path) ? "changed_path" : "task_path",
  }));
  let store: EvidenceIrStore;
  try { store = await params.readStore(); }
  catch {
    fields.codeWarnings = ["Evidence store unavailable; claim-based code impact was skipped."];
    store = { version: 1, compilerVersion: "", createdAt: "", updatedAt: "", claims: [], resolutions: [], syntheses: [] };
  }
  const associations = pagePathsByClaim(store);
  const staleIds = new Set([...params.staleClaims.values()].flatMap((state) => state.claimIds));
  const active = store.claims.filter((claim) => claim.status === "active" && claim.codeAnchor && claim.target?.codeResourceUri && !staleIds.has(claim.id));
  if (params.inferClaims) {
    const byPage = new Map(params.selectedPages.map((path) => [path, [] as typeof active]));
    for (const claim of active) for (const page of associations.get(claim.id) ?? []) byPage.get(page)?.push(claim);
    claimRoots: for (const page of params.selectedPages) for (const claim of (byPage.get(page) ?? []).sort((a, b) => a.id.localeCompare(b.id))) {
      if (requests.length > CODE_IMPACT_MAX_ROOTS) break claimRoots;
      if (requestedPaths.includes(claim.codeAnchor!.path)) continue;
      try {
        const ref = parseCodeResourceUri(claim.target!.codeResourceUri!);
        if (ref.path !== claim.codeAnchor!.path) continue;
        if (requests.some((request) => request.target.path === ref.path && request.target.fragmentId === ref.fragmentId)) continue;
        requests.push({ target: { path: ref.path, fragmentId: ref.fragmentId }, origin: "claim", pagePath: page, claimId: claim.id });
      } catch { continue; }
    }
  }
  if (requests.length === 0) return { fields: fields.codeWarnings ? fields : {}, gaps, requestedPaths };
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: dirname(params.wikiRoot), wikiRoot: params.wikiRoot });
  let result;
  try { result = await index.impact(requests.map((request) => request.target)); }
  catch {
    gaps.push({ kind: "missing_evidence", description: "Code impact unavailable: the existing code index could not be read. Run knowledge_code rebuild, then retry; context did not rebuild it." });
    return { fields, gaps, requestedPaths };
  }
  if (result.roots.length) fields.codeSnapshot = result.generatedAt;
  for (const missing of result.unresolved) gaps.push({ kind: "missing_evidence", paths: [missing.path],
    description: `Code impact root is not indexed: ${missing.path}. Refresh the code index explicitly; an empty result does not establish that it is unused.`,
  });
  if (result.manifestWarnings.length) fields.codeWarnings = [...(fields.codeWarnings ?? []), ...result.manifestWarnings.slice(0, 3).map((warning) => `${warning.path}: ${warning.reason}`)];
  if (result.importDiagnostics?.unresolvedImports.length) fields.codeWarnings = [...(fields.codeWarnings ?? []),
    `Some indexed imports are ambiguous or unresolved: ${[...new Set(result.importDiagnostics.unresolvedImports.map((issue) => issue.reason))].join(", ")}. Incoming candidates may be incomplete; knowledge_code references exposes snapshot-wide examples and inventory counts.`];
  fields.codeTruncated = result.omittedRoots > 0 || result.relationsTruncated || result.manifestWarnings.length > 3;
  const relatedIds = new Map<string, string>();
  const relatedFiles = new Map<string, string>();
  for (const root of result.roots) {
    const ref = codeRef(root.fragment);
    if (!ref) continue;
    const request = requests.find((request) => request.target.path === root.requested.path && request.target.fragmentId === root.requested.fragmentId)!;
    fields.codeRoots!.push({ ...ref, origin: request.origin,
      ...(request.pagePath ? { pagePath: request.pagePath, claimId: request.claimId } : {}),
    });
    relatedIds.set(root.fragment.id, ref.uri);
    if (!root.requested.fragmentId) relatedFiles.set(root.fragment.path, ref.uri);
    for (const reference of root.references) {
      const source = codeRef(reference.source);
      if (!source) continue;
      fields.codeRelations!.push({ ...source, rootUri: ref.uri, relation: reference.relation });
      if (!relatedIds.has(reference.source.id)) relatedIds.set(reference.source.id, ref.uri);
      if (reference.source.kind === "module" && !relatedFiles.has(reference.source.path)) relatedFiles.set(reference.source.path, ref.uri);
    }
  }
  const pages = new Map<string, CodeImpactWikiPage>();
  relatedPages: for (const claim of active) {
    let target;
    try { target = parseCodeResourceUri(claim.target!.codeResourceUri!); } catch { continue; }
    const rootUri = relatedIds.get(target.fragmentId) ?? relatedFiles.get(target.path);
    if (!rootUri) continue;
    for (const page of associations.get(claim.id) ?? []) {
      if (pages.has(page) || params.staleClaims.has(page)) continue;
      const node = params.graph.nodesById.get(params.graph.pageNodeByPath.get(page) ?? "");
      if (node) pages.set(page, { uri: wikiPageUri(page), path: page, title: node.label, type: node.pageType ?? "unknown", rootUri, claimId: claim.id });
      if (pages.size > 6) break relatedPages;
    }
  }
  fields.codeWikiPages = [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 6);
  fields.codeTruncated ||= pages.size > 6;
  if (fields.codeTruncated) gaps.push({ kind: "budget_limited", widenable: false, description: "Code impact is limited to 3 roots, 12 incoming candidates per root and 6 related wiki pages; additional candidates or diagnostics were omitted. Narrow the source scope or inspect a specific code reference target." });
  return { fields, gaps, requestedPaths };
}
