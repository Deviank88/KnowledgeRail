import * as nodePath from "node:path";
import { setWikiRoot, uriToPath } from "../core/paths.js";

export type WorkspaceSource = "explicit" | "legacy_roots" | "env" | "cwd";

export interface WorkspaceResolution {
  root: string;
  source: WorkspaceSource;
}

export interface WorkspaceResolverOptions {
  /** Highest-priority application-level override. */
  explicitRoot?: string | null;
  /** Optional legacy MCP Roots provider. Omit it for modern 2026-07-28 sessions. */
  legacyRootProvider?: () => Promise<string | null | undefined>;
  /** Override for tests/configuration. `null` explicitly disables WIKI_ROOT. */
  envRoot?: string | null;
  /** Override for tests. Defaults to process.cwd(). */
  cwd?: string;
}

export interface LegacyRootsCapableServer {
  server: {
    listRoots(): Promise<{ roots: Array<{ uri: string }> }>;
  };
}

function normalizedRoot(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? nodePath.resolve(trimmed) : null;
}

/**
 * Resolve a project workspace without mutating global application state.
 *
 * Precedence is deliberately backward-compatible with v3 when a legacy Roots
 * provider is supplied: explicit override -> legacy MCP Roots -> WIKI_ROOT -> cwd.
 * Modern MCP sessions omit `legacyRootProvider`, yielding explicit -> WIKI_ROOT -> cwd.
 */
export async function resolveWorkspace(
  options: WorkspaceResolverOptions = {}
): Promise<WorkspaceResolution> {
  const explicit = normalizedRoot(options.explicitRoot);
  if (explicit) return { root: explicit, source: "explicit" };

  if (options.legacyRootProvider) {
    try {
      const legacy = normalizedRoot(await options.legacyRootProvider());
      if (legacy) return { root: legacy, source: "legacy_roots" };
    } catch {
      // Roots is a compatibility adapter only. Unsupported/failed Roots must not
      // prevent local/env workspace resolution.
    }
  }

  const configuredEnv = options.envRoot === undefined
    ? process.env["WIKI_ROOT"]
    : options.envRoot;
  const envRoot = normalizedRoot(configuredEnv);
  if (envRoot) return { root: envRoot, source: "env" };

  return {
    root: nodePath.resolve(options.cwd ?? process.cwd()),
    source: "cwd",
  };
}

export function activateWorkspace(resolution: WorkspaceResolution): WorkspaceResolution {
  setWikiRoot(resolution.root);
  return resolution;
}

export async function resolveAndActivateWorkspace(
  options: WorkspaceResolverOptions = {}
): Promise<WorkspaceResolution> {
  return activateWorkspace(await resolveWorkspace(options));
}

/**
 * Compatibility adapter for pre-2026 MCP clients exposing Roots.
 * Keep MCP-specific behavior here so the core path layer remains protocol-agnostic.
 */
export async function resolveLegacyMcpWorkspace(
  server: LegacyRootsCapableServer,
  options: Omit<WorkspaceResolverOptions, "legacyRootProvider"> = {}
): Promise<WorkspaceResolution> {
  return resolveAndActivateWorkspace({
    ...options,
    legacyRootProvider: async () => {
      const { roots } = await server.server.listRoots();
      for (const root of roots) {
        const resolved = uriToPath(root.uri);
        if (resolved) return resolved;
      }
      return null;
    },
  });
}
