#!/usr/bin/env node

import { CLI_HELP, CliUsageError, parseCli } from "./cli.js";
import { assertSupportedNodeRuntime } from "./core/runtime-compatibility.js";
import { PRODUCT_VERSION } from "./product.js";
import { runStdio } from "./runtime/stdio.js";
import { runHttpGateway } from "./http/gateway.js";
import { runDesktop } from "./desktop/runtime.js";
import {
  runWorkspaceList,
  runWorkspaceRegister,
  runWorkspaceUnregister,
} from "./runtime/workspace-cli.js";

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

  const command = parseCli(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${CLI_HELP}\n`);
    return;
  }
  if (command.kind === "version") {
    process.stdout.write(`${PRODUCT_VERSION}\n`);
    return;
  }
  if (command.kind === "workspace-list") {
    await runWorkspaceList();
    return;
  }
  if (command.kind === "workspace-register") {
    await runWorkspaceRegister(command.path);
    return;
  }
  if (command.kind === "workspace-unregister") {
    await runWorkspaceUnregister(command.workspaceId);
    return;
  }
  if (command.kind === "desktop") {
    const handle = await runDesktop();
    installShutdownHandlers(handle);
    return;
  }
  if (command.kind === "serve" && command.options.transport === "http") {
    const handle = await runHttpGateway(command.options);
    installShutdownHandlers(handle);
    return;
  }
  if (command.kind !== "serve" || command.options.transport !== "stdio") {
    throw new CliUsageError("This command is not available until its runtime has been initialized.");
  }

  const handle = await runStdio({ root: command.options.root });
  installShutdownHandlers(handle);
}

main().catch((err: unknown) => {
  const usage = err instanceof CliUsageError;
  process.stderr.write(`[knowledge-rail] ${usage ? "Configuration" : "Fatal"} error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(usage ? err.exitCode : 1);
});
