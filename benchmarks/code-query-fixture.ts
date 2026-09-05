import { createDefaultKnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { TYPESCRIPT_ADAPTER_VERSION, type CodeEvidenceSnapshot, type KnowledgeFragment } from "../src/core/code-evidence/types.js";

export function codeQueryFixture(count: number): CodeEvidenceSnapshot {
  const fragments: KnowledgeFragment[] = Array.from({ length: count }, (_, index) => ({
    id: `fragment-${index}`, path: `src/Service${Math.floor(index / 5)}.ts`,
    symbol: `handleOrder${index}`, qualifiedName: `Service${Math.floor(index / 5)}.handleOrder${index}`,
    kind: "method", definition: `async handleOrder${index}(order: Order): Promise<void>`,
    range: { startLine: 10 + index % 5 * 5, endLine: 14 + index % 5 * 5 },
    imports: ["./orders.js"], references: ["Order"], calls: [`handleOrder${Math.max(0, index - 1)}`],
    routes: [], configKeys: ["ORDER_RETRY_LIMIT"], databaseRefs: ["orders"],
    isTest: index % 17 === 0, docComment: "Validate and persist the order with bounded retries.",
  }));
  const files = new Map<string, string[]>();
  for (const fragment of fragments) {
    const ids = files.get(fragment.path) ?? [];
    ids.push(fragment.id);
    files.set(fragment.path, ids);
  }
  return {
    version: 2, generatedAt: "2026-09-05T00:00:00.000Z",
    adapters: createDefaultKnowledgeAdapterRegistry().roster(), fragments,
    files: [...files].map(([filePath, fragmentIds]) => ({
      path: filePath, fragmentIds, contentHash: "synthetic", fingerprint: "synthetic",
      parserVersion: TYPESCRIPT_ADAPTER_VERSION,
    })),
  };
}
