#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { assertSupportedNodeRuntime } from "./core/runtime-compatibility.js";
import { buildServer } from "./mcp/server.js";
import { resolveAndActivateWorkspace } from "./mcp/workspace.js";

function installShutdownHandlers(handle: { close(): Promise<void> }): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    void handle.close()
      .catch((error: unknown) => {
        process.stderr.write(`[knowledge-rail] Error during ${signal} shutdown: ${String(error)}\n`);
      })
      .finally(() => process.exit(0));
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  // Environment compatibility is checked before selecting or touching any wiki.
  assertSupportedNodeRuntime();

  // Establish a deterministic, safe workspace before the first MCP message.
  // Modern sessions keep this env/cwd resolution. Legacy sessions may replace
  // it with MCP Roots after their initialization handshake.
  const initial = await resolveAndActivateWorkspace();

  const handle = serveStdio(
    (context) => buildServer(context),
    {
      legacy: "serve",
      onerror: (error) => {
        process.stderr.write(`[knowledge-rail] MCP serving error: ${error.message}\n`);
      },
    }
  );
  installShutdownHandlers(handle);

  process.stderr.write(
    `[knowledge-rail] MCP server ready for legacy and 2026-07-28 clients. ` +
    `Initial wiki root: ${initial.root} (${initial.source})\n`
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[knowledge-rail] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
