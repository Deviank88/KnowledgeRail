import type { JSONRPCMessage, JSONRPCRequest, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildServer } from "../src/mcp/server.js";
import { MCP_PROTOCOL_VERSION } from "../src/product.js";

type RpcId = string | number;

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  private started = false;
  private closed = false;

  async start(): Promise<void> { this.started = true; }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || !this.peer?.started || this.peer.closed) {
      throw new Error("Memory transport is not open.");
    }
    const peer = this.peer;
    queueMicrotask(() => peer.onmessage?.(structuredClone(message)));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

interface SchemaProperty {
  type?: string | string[];
  enum?: string[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  items?: { type?: string; enum?: string[] };
}

interface CatalogTool {
  name: string;
  description?: string;
  inputSchema: {
    required?: string[];
    properties?: Record<string, SchemaProperty>;
  };
}

function schemaType(property: SchemaProperty): string {
  if (property.enum) return property.enum.map((value) => `\`${value}\``).join(" | ");
  const type = Array.isArray(property.type) ? property.type.join(" | ") : property.type;
  if (type === "array") {
    const item = property.items?.enum?.join(" | ") ?? property.items?.type ?? "value";
    return `array<${item}>`;
  }
  return type ?? "value";
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r?\n/g, " ");
}

function schemaConstraints(property: SchemaProperty): string {
  const constraints: string[] = [];
  if (property.minimum !== undefined) constraints.push(`≥ ${property.minimum}`);
  if (property.exclusiveMinimum !== undefined) constraints.push(`> ${property.exclusiveMinimum}`);
  if (property.maximum !== undefined) constraints.push(`≤ ${property.maximum}`);
  if (property.exclusiveMaximum !== undefined) constraints.push(`< ${property.exclusiveMaximum}`);
  if (property.minLength !== undefined) constraints.push(`length ≥ ${property.minLength}`);
  if (property.maxLength !== undefined) constraints.push(`length ≤ ${property.maxLength}`);
  if (property.minItems !== undefined) constraints.push(`items ≥ ${property.minItems}`);
  if (property.maxItems !== undefined) constraints.push(`items ≤ ${property.maxItems}`);
  if (property.pattern !== undefined) constraints.push(`pattern ${JSON.stringify(property.pattern)}`);
  return constraints.join("; ") || "—";
}

function renderTool(tool: CatalogTool): string {
  const required = new Set(tool.inputSchema.required ?? []);
  const properties = Object.entries(tool.inputSchema.properties ?? {});
  const actions = tool.inputSchema.properties?.action?.enum ?? tool.inputSchema.properties?.mode?.enum ?? [];
  const coverageNote = tool.name === "knowledge_context"
    ? "Task responses report `retrieval.coverageMode` (`lexical` or `semantic`) and `coverageWarnings`. " +
      "Coverage uses the full fused candidate set while returned evidence remains bounded; relevant " +
      "evidence excluded from display is `budget_limited`, not `missing_evidence`. Configured embedding " +
      "provider failures degrade to lexical mode without failing the tool call."
    : undefined;
  const contractNote = tool.name === "knowledge_admin"
    ? "For `action=\"lint\"`, `force=true` enables nested-wiki recovery. Omit `dry_run` or set it to `true` to preview; set `dry_run=false` to apply. Recovery removes nested `wiki` path segments, updates relative links, and blocks the complete operation if any destination collides."
    : tool.name === "knowledge_ingest"
      ? "Each claim contains `text`, `kind`, `origin`, and `confidence`, plus optional `target` and `relations`. A target supports `page_path`, `page_title`, `page_type`, and `code_resource_uri`: use an indexed knowledge_code resource when the claim explains code, so synthesis can show a verified code link and line range; omit it for claims without code evidence. Stakeholders additionally support `entity_key`, `role`, `organization`, `email_domain`, and `affiliation`. `email_domain` is domain-only; `client`/`internal` may be source-declared when comparison is unavailable, while `partner` must be explicit."
      : undefined;
  return [
    `## \`${tool.name}\``,
    "",
    tool.description ?? "",
    "",
    ...(coverageNote ? [coverageNote, ""] : []),
    ...(contractNote ? [contractNote, ""] : []),
    ...(actions.length > 0 ? [`Actions/modes: ${actions.map((value) => `\`${value}\``).join(", ")}.`, ""] : []),
    "| Parameter | Type / values | Required | Default | Constraints | Description |",
    "|---|---|---:|---|---|---|",
    ...properties.map(([name, property]) =>
      `| \`${name}\` | ${escapeCell(schemaType(property))} | ${required.has(name) ? "yes" : "no"} | ` +
      `${property.default === undefined ? "—" : `\`${JSON.stringify(property.default)}\``} | ${escapeCell(schemaConstraints(property))} | ` +
      `${escapeCell(property.description ?? "—")} |`
    ),
    "",
  ].join("\n");
}

async function listTools(): Promise<CatalogTool[]> {
  const peer = new MemoryTransport();
  const wire = new MemoryTransport();
  peer.peer = wire;
  wire.peer = peer;
  const waiters = new Map<RpcId, (message: JSONRPCMessage) => void>();
  peer.onmessage = (message) => {
    if (!("id" in message) || message.id === undefined) return;
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  };
  await peer.start();
  const handle = serveStdio((context) => buildServer(context), { transport: wire, legacy: "serve" });
  try {
    const response = await new Promise<JSONRPCMessage>((resolve, reject) => {
      const id = "tool-reference";
      waiters.set(id, resolve);
      const request: JSONRPCRequest = {
        jsonrpc: "2.0",
        id,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "knowledge-rail-doc-generator", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      };
      void peer.send(request).catch(reject);
    });
    if (!("result" in response)) throw new Error(`tools/list failed: ${JSON.stringify(response)}`);
    return (response.result as { tools: CatalogTool[] }).tools;
  } finally {
    await handle.close();
    await peer.close();
  }
}

const tools = (await listTools()).sort((left, right) => left.name.localeCompare(right.name));
const output = [
  "# KnowledgeRail tool/action reference",
  "",
  "<!-- Generated by npm run docs:generate. Do not edit by hand. -->",
  "",
  "This reference is generated from the public MCP catalog backed by the runtime Zod schemas.",
  "",
  "## Return envelope",
  "",
  "Every successful domain operation returns `structuredContent.state` and `structuredContent.nextAction`. " +
    "`nextAction` is either `null` or contains the next tool/action plus required and suggested arguments. " +
    "Text content remains a concise model-readable rendering of the same result.",
  "",
  "## Error taxonomy",
  "",
  "- Input-schema errors: missing, malformed, out-of-range, or action-incompatible arguments.",
  "- Workspace errors: unavailable, read-only, expired, released, or wrong-principal bindings.",
  "- Filesystem-boundary errors: traversal, absolute patterns, symlink escapes, or missing controlled files.",
  "- Contract errors: invalid wiki frontmatter, incomplete evidence coverage, or document review blockers.",
  "- Concurrency/recovery errors: lock ownership, stale-operation recovery, or migration/move rollback failures.",
  "",
  ...tools.map(renderTool),
].join("\n").trimEnd() + "\n";

const outputDirectory = path.resolve("docs", "reference");
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "tool-actions.md"), output, "utf8");
process.stdout.write(`Generated docs/reference/tool-actions.md for ${tools.length} tools.\n`);
