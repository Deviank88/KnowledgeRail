import {
  type CallToolResult,
  fromJsonSchema,
  McpServer,
  type McpRequestContext,
  ResourceTemplate,
  type JsonSchemaType,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { Client } from "@modelcontextprotocol/client";
import { PRODUCT_VERSION } from "../product.js";
import { buildServer } from "../mcp/server.js";
import type { WorkspaceBindingManager } from "../workspaces/bindings.js";
import type { DesktopClientProvider } from "./connection-manager.js";

export interface DesktopRemoteCatalog {
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  prompts: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
  resources: Awaited<ReturnType<Client["listResources"]>>["resources"];
  resourceTemplates: Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
}

export interface DeferredDesktopProxyOptions {
  bindings: WorkspaceBindingManager;
  principalId: string;
}

type DesktopClientSource = Promise<Client> | DesktopClientProvider;

function clientProvider(source: DesktopClientSource): DesktopClientProvider {
  if ("getClient" in source) return source;
  return { getClient: () => source, invalidate: () => undefined };
}

function gatewayFailureCause(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code === "connection_timeout" || name === "DesktopGatewayAttemptTimeoutError" || message.includes("timed out")) {
    return "connection_timeout";
  }
  if (name === "GatewayOwnershipError" || message.includes("owns the state directory")) return "ownership_conflict";
  if (message.includes("incompatible")) return "version_mismatch";
  if (code === "ECONNREFUSED" || message.includes("connection refused")) return "connect_refused";
  return "connection_failed";
}

function gatewayUnavailable(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: "KnowledgeRail is protocol-ready, but its local workspace gateway is unavailable. Inspect the local KnowledgeRail stderr log and retry.",
    }],
    structuredContent: {
      state: "blocked",
      reason: "gateway_unavailable",
      cause: gatewayFailureCause(error),
      retryable: true,
      nextAction: null,
    },
  };
}

function gatewayUnavailableError(error: unknown): Error {
  return new Error(`KnowledgeRail local gateway unavailable (${gatewayFailureCause(error)}); retry the request.`);
}

/**
 * Builds the desktop-facing catalog from the same local registrations as the
 * gateway, then forwards only data-bearing operations once the gateway is
 * ready. This keeps MCP initialization and list operations independent from
 * loopback recovery without duplicating schemas in a generated JSON artifact.
 */
export function buildDeferredDesktopProxyServer(
  context: McpRequestContext,
  clientSource: DesktopClientSource,
  options: DeferredDesktopProxyOptions
): McpServer {
  const clients = clientProvider(clientSource);
  const server = buildServer(context, {
    profile: { kind: "catalog", bindings: options.bindings, principalId: options.principalId },
  });

  server.server.setRequestHandler("tools/call", async (request) => {
    try {
      const client = await clients.getClient();
      let result;
      try {
        result = await client.callTool({
          name: request.params.name,
          arguments: request.params.arguments,
        });
      } catch (error) {
        clients.invalidate(client, error);
        throw error;
      }
      // Every public KnowledgeRail tool currently advertises an object-root
      // output schema. The local server still owns era projection so a modern
      // gateway result remains portable to legacy desktop clients.
      return server.server.projectCallToolResult(result, undefined);
    } catch (error) {
      return server.server.projectCallToolResult(gatewayUnavailable(error), undefined);
    }
  });
  server.server.setRequestHandler("prompts/get", async (request) => {
    try {
      const client = await clients.getClient();
      try {
        return await client.getPrompt(request.params);
      } catch (error) {
        clients.invalidate(client, error);
        throw error;
      }
    } catch (error) {
      throw gatewayUnavailableError(error);
    }
  });
  server.server.setRequestHandler("resources/read", async (request) => {
    try {
      const client = await clients.getClient();
      try {
        return await client.readResource(request.params);
      } catch (error) {
        clients.invalidate(client, error);
        throw error;
      }
    } catch (error) {
      throw gatewayUnavailableError(error);
    }
  });

  return server;
}

export async function loadDesktopRemoteCatalog(client: Client): Promise<DesktopRemoteCatalog> {
  const [tools, prompts, resources, resourceTemplates] = await Promise.all([
    client.listTools(),
    client.listPrompts(),
    client.listResources(),
    client.listResourceTemplates(),
  ]);
  return {
    tools: tools.tools,
    prompts: prompts.prompts,
    resources: resources.resources,
    resourceTemplates: resourceTemplates.resourceTemplates,
  };
}

function promptJsonSchema(prompt: DesktopRemoteCatalog["prompts"][number]): JsonSchemaType {
  const properties = Object.fromEntries((prompt.arguments ?? []).map((argument) => [
    argument.name,
    { type: "string", ...(argument.description ? { description: argument.description } : {}) },
  ]));
  return {
    type: "object",
    properties,
    required: (prompt.arguments ?? []).filter((argument) => argument.required).map((argument) => argument.name),
    additionalProperties: false,
  };
}

export function buildDesktopProxyServer(client: Client, catalog: DesktopRemoteCatalog): McpServer {
  const server = new McpServer(
    { name: "knowledge-rail-desktop", version: PRODUCT_VERSION },
    {
      instructions: "First list and select a user-approved workspace with knowledge_workspace. Keep its opaque binding in this chat and include it in every domain call. Never invent paths or workspace IDs; use a new chat when changing customer workspace.",
    }
  );

  for (const tool of catalog.tools) {
    server.registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
      ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) } : {}),
      ...(tool.annotations ? { annotations: tool.annotations as ToolAnnotations } : {}),
    }, async (args) => client.callTool({
      name: tool.name,
      arguments: args as Record<string, unknown>,
    }));
  }

  for (const prompt of catalog.prompts) {
    server.registerPrompt(prompt.name, {
      ...(prompt.title ? { title: prompt.title } : {}),
      ...(prompt.description ? { description: prompt.description } : {}),
      argsSchema: fromJsonSchema<Record<string, string>>(promptJsonSchema(prompt)),
    }, async (args) => client.getPrompt({ name: prompt.name, arguments: args }));
  }

  for (const resource of catalog.resources) {
    server.registerResource(resource.name, resource.uri, {
      ...(resource.title ? { title: resource.title } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    }, async (uri) => client.readResource({ uri: uri.href }));
  }

  for (const template of catalog.resourceTemplates) {
    server.registerResource(
      template.name,
      new ResourceTemplate(template.uriTemplate, { list: undefined }),
      {
        ...(template.title ? { title: template.title } : {}),
        ...(template.description ? { description: template.description } : {}),
        ...(template.mimeType ? { mimeType: template.mimeType } : {}),
      },
      async (uri) => client.readResource({ uri: uri.href })
    );
  }

  return server;
}
