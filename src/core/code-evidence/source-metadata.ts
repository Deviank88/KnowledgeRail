import { createHash } from "node:crypto";
import type { KnowledgeAdapterRegistry } from "./adapter-registry.js";
import { ProjectStructureReader } from "./project-structure.js";
import type { CodeEvidenceSnapshot, CodeSourceMetadata, ProjectStructure } from "./types.js";

function signature(registry: KnowledgeAdapterRegistry): string | undefined {
  const registrations = registry.registrations.filter(({ adapter }) => adapter.enrichSourceMetadata);
  if (!registrations.length || registrations.some(({ adapter }) => !adapter.sourceMetadataVersion)) return;
  return createHash("sha256").update(JSON.stringify({ roster: registry.roster(), enrichments: registrations.map(({ adapter, extensionClaims }) => ({
    parserVersion: adapter.parserVersion, extensions: [...extensionClaims].sort(), version: adapter.sourceMetadataVersion,
  })) })).digest("hex");
}

/** Invalid additive data does not invalidate valid source evidence or trigger a
 * rebuild from a read operation. The shared reader remains the fallback. */
export function persistedSourceMetadata(snapshot: CodeEvidenceSnapshot, registry: KnowledgeAdapterRegistry): ProjectStructure | undefined {
  const value: unknown = snapshot.sourceMetadata;
  if (!value || typeof value !== "object") return;
  const metadata = value as Partial<CodeSourceMetadata>;
  const expected = signature(registry);
  if (!expected || metadata.version !== 1 || metadata.adapterSignature !== expected || typeof metadata.identity !== "string" ||
      !Array.isArray(metadata.manifests) || !Array.isArray(metadata.warnings)) return;
  if (!metadata.manifests.every((entry) => entry && typeof entry.path === "string" && typeof entry.fileName === "string" &&
      (entry.warning === undefined || typeof entry.warning === "string")) ||
      !metadata.warnings.every((entry) => entry && typeof entry.path === "string" && typeof entry.reason === "string")) return;
  if (new Set(metadata.manifests.map((entry) => entry.path)).size !== metadata.manifests.length) return;
  return { identity: metadata.identity, manifests: new Map(metadata.manifests.map((entry) => [entry.path, entry])), warnings: metadata.warnings };
}

/** Only explicit index writes prepare companions; publication stays within the
 * existing index lock and atomic snapshot write. No fragment or anchor changes. */
export async function prepareSourceMetadata(repositoryRoot: string, snapshot: CodeEvidenceSnapshot, registry: KnowledgeAdapterRegistry): Promise<void> {
  const adapterSignature = signature(registry);
  if (!adapterSignature) { delete snapshot.sourceMetadata; return; }
  const reader = new ProjectStructureReader(repositoryRoot, new Set(snapshot.fragments.map((f) => f.path)), registry, true);
  const structure = await reader.load();
  snapshot.sourceMetadata = { version: 1, adapterSignature, identity: structure.identity,
    manifests: [...structure.manifests.values()], warnings: [...structure.warnings] };
}
