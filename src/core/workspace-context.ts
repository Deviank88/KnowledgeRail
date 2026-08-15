import { AsyncLocalStorage } from "node:async_hooks";
import * as nodePath from "node:path";

export type WorkspaceAccessScope = "read" | "write";

export interface WorkspacePaths {
  projectRoot: string;
  wikiRoot: string;
  docsRoot: string;
}

export interface WorkspaceContext {
  /** Random registry identifier when the workspace comes from the local catalog. */
  workspaceId?: string;
  /** Monotonic connection/binding generation; never used as an authorization token. */
  generation: number;
  authorized: boolean;
  authorizationError?: string;
  /** Present only for catalog-profile responses that must qualify continuations. */
  binding?: string;
  source: string;
  scope: WorkspaceAccessScope;
  paths: WorkspacePaths;
}

const workspaceStorage = new AsyncLocalStorage<WorkspaceContext>();

export function createWorkspaceContext(
  projectRoot: string,
  options: {
    workspaceId?: string;
    generation?: number;
    source?: string;
    scope?: WorkspaceAccessScope;
    binding?: string;
  } = {}
): WorkspaceContext {
  const root = nodePath.resolve(projectRoot);
  return Object.freeze({
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    generation: options.generation ?? 1,
    authorized: true,
    source: options.source ?? "local",
    scope: options.scope ?? "write",
    ...(options.binding ? { binding: options.binding } : {}),
    paths: Object.freeze({
      projectRoot: root,
      wikiRoot: nodePath.join(root, "wiki"),
      docsRoot: nodePath.join(root, "docs"),
    }),
  });
}

export function createUnauthorizedWorkspaceContext(reason = "A valid workspace binding is required. Call knowledge_workspace list/select first."): WorkspaceContext {
  return Object.freeze({
    generation: 0,
    authorized: false,
    authorizationError: reason,
    source: "catalog-unbound",
    scope: "read",
    paths: Object.freeze({ projectRoot: "", wikiRoot: "", docsRoot: "" }),
  });
}

export function getActiveWorkspaceContext(): WorkspaceContext | undefined {
  return workspaceStorage.getStore();
}

/**
 * Compatibility seam for the current path-based domain implementation.
 * Every HTTP request enters here before its MCP server is constructed, so
 * asynchronous work inherits one immutable workspace without process globals.
 */
export function runWithWorkspaceContext<T>(
  context: WorkspaceContext,
  operation: () => T
): T {
  return workspaceStorage.run(context, operation);
}
