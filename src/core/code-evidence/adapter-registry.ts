import * as nodePath from "node:path";
import { TypeScriptKnowledgeAdapter } from "./typescript-adapter.js";
import {
  ApexKnowledgeAdapter,
  CKnowledgeAdapter,
  CppKnowledgeAdapter,
  CSharpKnowledgeAdapter,
  GoKnowledgeAdapter,
  JavaKnowledgeAdapter,
  PhpKnowledgeAdapter,
  RustKnowledgeAdapter,
} from "./language-adapters.js";
import type {
  CodeEvidenceAdapterRosterEntry,
  CodeSource,
  KnowledgeAdapter,
} from "./types.js";

export interface AdapterRegistration {
  adapter: KnowledgeAdapter;
  extensionClaims: readonly string[];
}

export interface ExtensionClaimingAdapter extends KnowledgeAdapter {
  readonly extensionClaims: readonly string[];
}

const KNOWN_EXTENSION_CLAIMS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".js-meta.xml",
  ".java", ".cls", ".trigger", ".cs", ".go", ".rs", ".php", ".c", ".cpp", ".cc", ".cxx",
  ".h", ".hpp", ".hh",
] as const;

function normalizedClaim(value: string): string {
  const claim = value.trim().toLowerCase();
  if (!claim.startsWith(".") || claim.includes("/") || claim.includes("\\") || claim.includes("\0")) {
    throw new Error(`Invalid code-evidence extension claim: ${value}`);
  }
  return claim;
}

function claimsFromAdapter(adapter: KnowledgeAdapter): string[] {
  const declared = "extensionClaims" in adapter && Array.isArray(adapter.extensionClaims)
    ? adapter.extensionClaims
    : KNOWN_EXTENSION_CLAIMS.filter((claim) => adapter.supports({ path: `fixture${claim}` }));
  const claims = [...new Set([...declared].map(normalizedClaim))].sort();
  if (claims.length === 0) {
    throw new Error(`Code-evidence adapter ${adapter.parserVersion} declares no extension claims.`);
  }
  return claims;
}

function registration(value: KnowledgeAdapter | AdapterRegistration): AdapterRegistration {
  if ("adapter" in value) {
    return {
      adapter: value.adapter,
      extensionClaims: [...new Set(value.extensionClaims.map(normalizedClaim))].sort(),
    };
  }
  return { adapter: value, extensionClaims: claimsFromAdapter(value) };
}

function pathMatchesClaim(path: string, claim: string): boolean {
  return path.toLowerCase().endsWith(claim);
}

export class KnowledgeAdapterRegistry {
  readonly registrations: readonly AdapterRegistration[];

  constructor(values: readonly (KnowledgeAdapter | AdapterRegistration)[]) {
    if (values.length === 0) throw new Error("Code-evidence adapter registry must not be empty.");
    const registrations = values.map(registration);
    const ownerByClaim = new Map<string, string>();
    const ownedClaims: Array<{
      adapter: KnowledgeAdapter;
      claim: string;
      owner: string;
      registrationIndex: number;
    }> = [];
    for (const [registrationIndex, item] of registrations.entries()) {
      if (item.extensionClaims.length === 0) {
        throw new Error(`Code-evidence adapter ${item.adapter.parserVersion} declares no extension claims.`);
      }
      for (const claim of item.extensionClaims) {
        const owner = ownerByClaim.get(claim);
        if (owner) {
          throw new Error(
            `Code-evidence extension ${claim} is claimed by both ${owner} and ${item.adapter.parserVersion}.`
          );
        }
        const overlapping = ownedClaims.find((entry) => {
          if (entry.registrationIndex === registrationIndex ||
              (!claim.endsWith(entry.claim) && !entry.claim.endsWith(claim))) return false;
          const narrowerClaim = claim.length >= entry.claim.length ? claim : entry.claim;
          const probe = { path: `fixture${narrowerClaim}` };
          return entry.adapter.supports(probe) && item.adapter.supports(probe);
        });
        if (overlapping) {
          throw new Error(
            `Code-evidence extension claims ${overlapping.claim} (${overlapping.owner}) and ` +
              `${claim} (${item.adapter.parserVersion}) overlap.`
          );
        }
        if (!item.adapter.supports({ path: `fixture${claim}` })) {
          throw new Error(`Code-evidence adapter ${item.adapter.parserVersion} does not support its claim ${claim}.`);
        }
        ownerByClaim.set(claim, item.adapter.parserVersion);
        ownedClaims.push({
          adapter: item.adapter,
          claim,
          owner: item.adapter.parserVersion,
          registrationIndex,
        });
      }
    }
    this.registrations = registrations;
  }

  resolve(source: Pick<CodeSource, "path">): KnowledgeAdapter | undefined {
    const matches = this.registrations.filter((item) =>
      item.extensionClaims.some((claim) => pathMatchesClaim(source.path, claim)) && item.adapter.supports(source)
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple code-evidence adapters support ${source.path}: ` +
          matches.map((item) => item.adapter.parserVersion).join(", ")
      );
    }
    return matches[0]?.adapter;
  }

  extensionClaimsFor(adapter: KnowledgeAdapter): readonly string[] {
    return this.registrations.find((item) => item.adapter === adapter)?.extensionClaims ?? [];
  }

  roster(): CodeEvidenceAdapterRosterEntry[] {
    return this.registrations.map((item) => ({
      extensionClaims: [...item.extensionClaims].sort(),
      parserVersion: item.adapter.parserVersion,
    })).sort((left, right) => left.extensionClaims.join("\0").localeCompare(right.extensionClaims.join("\0")));
  }

  globPatterns(): string[] {
    return [...new Set(this.registrations.flatMap((item) => item.extensionClaims))]
      .sort()
      .map((claim) => `**/*${claim}`);
  }

  parserVersionForPath(path: string): string | undefined {
    return this.resolve({ path: path.replaceAll(nodePath.sep, "/") })?.parserVersion;
  }
}

export function createDefaultKnowledgeAdapterRegistry(): KnowledgeAdapterRegistry {
  return new KnowledgeAdapterRegistry([
    new TypeScriptKnowledgeAdapter(),
    new JavaKnowledgeAdapter(),
    new ApexKnowledgeAdapter(),
    new CSharpKnowledgeAdapter(),
    new GoKnowledgeAdapter(),
    new RustKnowledgeAdapter(),
    new PhpKnowledgeAdapter(),
    new CKnowledgeAdapter(),
    new CppKnowledgeAdapter(),
  ]);
}

const DEFAULT_VERSION_REGISTRY = createDefaultKnowledgeAdapterRegistry();

export function defaultParserVersionForPath(path: string): string | undefined {
  return DEFAULT_VERSION_REGISTRY.parserVersionForPath(path);
}

export function sameAdapterRoster(
  left: readonly CodeEvidenceAdapterRosterEntry[],
  right: readonly CodeEvidenceAdapterRosterEntry[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
