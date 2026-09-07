import { createRetrievalEvidenceSignals, inferCoverageRequirements, type RetrievalCoverageRequirements } from "./retrieval-coverage.js";
import type { HybridRetrievalHit } from "./hybrid-retrieval.js";

/** Remove only strictly dominated lexical candidates of the same artifact type
 * covering less than half the query signals. Substantial independent coverage
 * preserves specific pages even when an overview matches additional terms.
 * Semantic matches, independent graph evidence, traceability chains and requests
 * for conflicting/multiple sources or explicit artifact chains retain their
 * existing evidence selection and widening behavior. */
export function selectLexicalEvidence(query: string, hits: readonly HybridRetrievalHit[], explicit?: RetrievalCoverageRequirements,
  evidenceSignals = createRetrievalEvidenceSignals(query)): readonly HybridRetrievalHit[] {
  const requirements = inferCoverageRequirements(query, explicit);
  if (hits.length < 2 || requirements.requireContradictionCheck || requirements.minimumSourceDiversity > 0 || explicit?.requiredPageTypes?.length) return hits;
  const types = new Set<string>();
  if (!hits.some((hit) => {
    const eligible = types.has(hit.type) && hit.channels.graphRank === undefined && hit.channels.semanticRank === undefined && !hit.requestId;
    types.add(hit.type); return eligible;
  })) return hits;
  const signals = hits.map(evidenceSignals);
  return hits.filter((hit, index) => {
    if (hit.channels.graphRank !== undefined || hit.channels.semanticRank !== undefined || hit.requestId) return true;
    const own = signals[index]!;
    if (own.size * 2 >= evidenceSignals.querySignalCount) return true;
    for (let before = 0; before < index; before++) {
      const candidate = hits[before]!, other = signals[before]!;
      if (candidate.type !== hit.type || other.size <= own.size) continue;
      if ([...own].every((signal) => other.has(signal))) return false;
    }
    return true;
  });
}
