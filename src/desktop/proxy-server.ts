import {
  fromJsonSchema,
  McpServer,
  ResourceTemplate,
  type JsonSchemaType,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { Client } from "@modelcontextprotocol/client";
import { PRODUCT_VERSION } from "../product.js";

export interface DesktopRemoteCatalog {
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  prompts: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
  resources: Awaited<ReturnType<Client["listResources"]>>["resources"];
  resourceTemplates: Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
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
