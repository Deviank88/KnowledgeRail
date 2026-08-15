import * as nodePath from "node:path";

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "desktop" }
  | { kind: "workspace-list" }
  | { kind: "workspace-register"; path?: string }
  | { kind: "workspace-unregister"; workspaceId: string }
  | { kind: "serve"; options: ServeCliOptions };

export interface ServeCliOptions {
  transport: "stdio" | "http";
  root?: string;
  host: string;
  port: number;
  httpPath: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const CLI_HELP = `KnowledgeRail - local-first MCP project knowledge

Usage:
  knowledge-rail [--transport stdio|http] [--root <absolute-path>]
                 [--host <hostname-or-address>] [--port <port>]
                 [--http-path </path>] [--allowed-host <hostname>]...
                 [--allowed-origin <origin>]...
  knowledge-rail workspace list
  knowledge-rail workspace register [<path>]
  knowledge-rail workspace unregister <workspace-id>
  knowledge-rail desktop
  knowledge-rail --help
  knowledge-rail --version

The default transport is stdio. IDEs, Cursor and terminal agents infer the
opened project automatically; only context-free desktop chats select a catalog workspace.`;

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value.`);
  return value;
}

function normalizeHttpPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("\\")) {
    throw new CliUsageError("--http-path must be an absolute URL path without query, fragment or backslashes.");
  }
  if (value === "/" || value.endsWith("/") || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new CliUsageError("--http-path must be a non-root normalized path without dot segments or a trailing slash.");
  }
  try {
    if (decodeURIComponent(value) !== value) {
      throw new CliUsageError("--http-path must not contain percent-encoded normalization ambiguity.");
    }
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("--http-path contains invalid percent encoding.");
  }
  return value;
}

function normalizeHost(value: string, flag: string): string {
  const host = value.trim().toLowerCase();
  if (!host || /[\s/?#]/.test(host) || host.includes("://")) {
    throw new CliUsageError(`${flag} must be a hostname or IP address without a URL scheme or path.`);
  }
  return host;
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError("--allowed-origin must be an absolute http(s) origin.");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliUsageError("--allowed-origin must contain only an http(s) scheme, host and optional port.");
  }
  return url.origin.toLowerCase();
}

function parseWorkspaceCommand(args: readonly string[]): CliCommand {
  const action = args[1];
  if (action === "list" && args.length === 2) return { kind: "workspace-list" };
  if (action === "register" && args.length <= 3) {
    const supplied = args[2];
    if (supplied?.startsWith("--")) throw new CliUsageError(`Unknown workspace register argument: ${supplied}`);
    return { kind: "workspace-register", ...(supplied ? { path: supplied } : {}) };
  }
  if (action === "unregister" && args.length === 3 && args[2]) {
    return { kind: "workspace-unregister", workspaceId: args[2] };
  }
  throw new CliUsageError("Invalid workspace command. Use workspace list, register [path], or unregister <workspace-id>.");
}

export function parseCli(args: readonly string[]): CliCommand {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) return { kind: "version" };
  if (args[0] === "workspace") return parseWorkspaceCommand(args);
  if (args[0] === "desktop") {
    if (args.length !== 1) throw new CliUsageError("desktop does not accept serve options.");
    return { kind: "desktop" };
  }

  let transport: "stdio" | "http" = "stdio";
  let root: string | undefined;
  let host = "127.0.0.1";
  let port = 3333;
  let httpPath = "/mcp";
  const allowedHosts: string[] = [];
  const allowedOrigins: string[] = [];
  let sawHttpOnlyOption = false;
  const seenSingleValueFlags = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (["--transport", "--root", "--host", "--port", "--http-path"].includes(flag ?? "")) {
      if (seenSingleValueFlags.has(flag!)) throw new CliUsageError(`${flag} may be supplied only once.`);
      seenSingleValueFlags.add(flag!);
    }
    if (flag === "--transport") {
      const value = requireValue(args, index, flag);
      if (value !== "stdio" && value !== "http") throw new CliUsageError("--transport must be stdio or http.");
      transport = value;
      index++;
    } else if (flag === "--root") {
      const value = requireValue(args, index, flag);
      if (!nodePath.isAbsolute(value)) throw new CliUsageError("--root must be an absolute path.");
      root = nodePath.resolve(value);
      index++;
    } else if (flag === "--host") {
      host = normalizeHost(requireValue(args, index, flag), flag);
      sawHttpOnlyOption = true;
      index++;
    } else if (flag === "--port") {
      const value = requireValue(args, index, flag);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new CliUsageError("--port must be an integer from 1 to 65535.");
      port = parsed;
      sawHttpOnlyOption = true;
      index++;
    } else if (flag === "--http-path") {
      httpPath = normalizeHttpPath(requireValue(args, index, flag));
      sawHttpOnlyOption = true;
      index++;
    } else if (flag === "--allowed-host") {
      allowedHosts.push(normalizeHost(requireValue(args, index, flag), flag));
      sawHttpOnlyOption = true;
      index++;
    } else if (flag === "--allowed-origin") {
      allowedOrigins.push(normalizeOrigin(requireValue(args, index, flag)));
      sawHttpOnlyOption = true;
      index++;
    } else {
      throw new CliUsageError(`Unknown argument: ${flag ?? ""}`);
    }
  }

  if (transport === "stdio" && sawHttpOnlyOption) {
    throw new CliUsageError("--host, --port, --http-path and allowlists require --transport http.");
  }
  if (transport === "http" && root) {
    throw new CliUsageError("--root cannot pin the multi-workspace HTTP gateway; use workspace register instead.");
  }

  return {
    kind: "serve",
    options: {
      transport,
      ...(root ? { root } : {}),
      host,
      port,
      httpPath,
      allowedHosts: [...new Set(allowedHosts)],
      allowedOrigins: [...new Set(allowedOrigins)],
    },
  };
}
