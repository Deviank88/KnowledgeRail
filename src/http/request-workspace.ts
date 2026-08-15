import type { WorkspaceContext } from "../core/workspace-context.js";
import { createUnauthorizedWorkspaceContext } from "../core/workspace-context.js";
import { WorkspaceBindingError, WorkspaceBindingManager } from "../workspaces/bindings.js";

interface JsonRpcRequestShape {
  method?: unknown;
  params?: unknown;
}

export interface WorkspaceRequestResolution {
  context: WorkspaceContext;
  binding?: string;
  method?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function bindingFromUri(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  try {
    return new URL(uri).searchParams.get("workspace_binding") ?? undefined;
  } catch {
    return undefined;
  }
}

export function isMutatingDomainCall(name: string, args: Record<string, unknown>): boolean {
  const action = typeof args.action === "string" ? args.action : "";
  if (name === "knowledge_context" || name === "knowledge_document_context") return false;
  if (name === "knowledge_page") return action !== "read" && !(action === "move" && args.dry_run === true);
  if (name === "knowledge_files") return action === "normalize";
  if (name === "knowledge_ingest") return !["source_status", "evidence_status", "report"].includes(action);
  if (name === "knowledge_code") return ["rebuild", "update", "remove", "record_fallback"].includes(action);
  if (name === "knowledge_document") return action !== "review";
  if (name === "knowledge_admin") {
    return action === "init" || (action === "migrate" && args.migration_action !== "plan");
  }
  return true;
}

async function parseJsonRpc(request: Request): Promise<JsonRpcRequestShape | null> {
  if (request.method !== "POST") return null;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  try {
    const parsed = await request.clone().json();
    return record(parsed) as JsonRpcRequestShape | null;
  } catch {
    return null;
  }
}

export async function resolveRequestWorkspace(
  request: Request,
  bindings: WorkspaceBindingManager,
  principalId: string
): Promise<WorkspaceRequestResolution> {
  const rpc = await parseJsonRpc(request);
  const method = typeof rpc?.method === "string" ? rpc.method : undefined;
  const params = record(rpc?.params);
  const args = record(params?.arguments);
  const toolName = method === "tools/call" && typeof params?.name === "string" ? params.name : undefined;
  const headerBinding = request.headers.get("mcp-param-workspace-binding") ??
    request.headers.get("x-knowledge-rail-workspace-binding") ?? undefined;
  const bodyBinding = typeof args?.workspace_binding === "string"
    ? args.workspace_binding
    : method === "resources/read" ? bindingFromUri(params?.uri) : undefined;

  if (headerBinding && bodyBinding && headerBinding !== bodyBinding) {
    return {
      context: createUnauthorizedWorkspaceContext("Workspace binding header/body mismatch."),
      method,
    };
  }
  const binding = bodyBinding ?? headerBinding;

  const filesystemMethod =
    (method === "tools/call" && toolName !== "knowledge_workspace") ||
    method === "resources/read" ||
    method === "prompts/get";
  if (!filesystemMethod) {
    return { context: createUnauthorizedWorkspaceContext(), ...(binding ? { binding } : {}), method };
  }

  if (!binding) {
    return { context: createUnauthorizedWorkspaceContext(), method };
  }
  try {
    const requireWrite = Boolean(toolName && args && isMutatingDomainCall(toolName, args));
    return {
      context: await bindings.resolve(binding, principalId, requireWrite),
      binding,
      method,
    };
  } catch (error) {
    const message = error instanceof WorkspaceBindingError
      ? error.message
      : "Workspace authorization failed.";
    return {
      context: createUnauthorizedWorkspaceContext(message),
      binding,
      method,
    };
  }
}

function qualifyUri(uri: string, binding: string): string {
  try {
    const url = new URL(uri);
    if (!["knowledge-rail:", "code:", "wiki:"].includes(url.protocol)) return uri;
    url.searchParams.set("workspace_binding", binding);
    return url.toString();
  } catch {
    return uri;
  }
}

function qualifyLinks(value: unknown, binding: string): void {
  if (Array.isArray(value)) {
    for (const item of value) qualifyLinks(item, binding);
    return;
  }
  const item = record(value);
  if (!item) return;
  if (item.type === "resource_link" && typeof item.uri === "string") {
    item.uri = qualifyUri(item.uri, binding);
  }
  for (const nested of Object.values(item)) qualifyLinks(nested, binding);
}

export async function qualifyWorkspaceResponse(response: Response, binding?: string): Promise<Response> {
  if (!binding || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) return response;
  try {
    const body = await response.json();
    qualifyLinks(body, binding);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}
