import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { ProtocolEra, ToolKey } from "../mcp/tool-names.js";
import { toolName } from "../mcp/tool-names.js";
import { registerCodeEvidenceTools } from "./code-evidence-tools.js";
import { registerContextTools } from "./context-tools.js";
import { registerDocumentTools } from "./document-tools.js";
import { registerEvidenceTools } from "./evidence-tools.js";
import { registerSourceTools } from "./source-tools.js";
import { registerWikiTools } from "./wiki-tools.js";

type OperationResult = CallToolResult | InputRequiredResult;
type OperationHandler = (
  args: unknown,
  context: ServerContext
) => OperationResult | Promise<OperationResult>;

interface ParseableSchema {
  parseAsync(value: unknown): Promise<unknown>;
}

interface RegisteredOperation {
  schema: ParseableSchema;
  handler: OperationHandler;
}

/**
 * Captures the established operation handlers without advertising their old
 * one-tool-per-operation names. The public MCP surface dispatches through this
 * registry after validating its smaller domain-oriented schemas.
 */
export function createOperationRegistry(era: ProtocolEra): {
  call(key: ToolKey, args: unknown, context: ServerContext): Promise<OperationResult>;
} {
  const operations = new Map<string, RegisteredOperation>();
  const registrar = {
    registerTool(
      name: string,
      config: { inputSchema?: ParseableSchema },
      handler: OperationHandler
    ) {
      if (!config.inputSchema) throw new Error(`Internal operation ${name} has no input schema.`);
      if (operations.has(name)) throw new Error(`Duplicate internal operation: ${name}.`);
      operations.set(name, { schema: config.inputSchema, handler });
      return {};
    },
  } as unknown as McpServer;

  registerWikiTools(registrar, era);
  registerContextTools(registrar, era);
  registerSourceTools(registrar, era);
  registerEvidenceTools(registrar, era);
  registerCodeEvidenceTools(registrar, era);
  registerDocumentTools(registrar, era);

  return {
    async call(key, args, context) {
      const name = toolName(key, era);
      const operation = operations.get(name);
      if (!operation) throw new Error(`Internal KnowledgeRail operation is unavailable: ${key}.`);
      const parsed = await operation.schema.parseAsync(args);
      return await operation.handler(parsed, context);
    },
  };
}
