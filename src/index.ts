#!/usr/bin/env node

import { CLI_HELP, DOCTOR_CLI_HELP, DRIFT_CLI_HELP, CliUsageError, parseCli } from "./cli.js";
import { assertSupportedNodeRuntime } from "./core/runtime-compatibility.js";
import { logger } from "./core/logger.js";
import { PRODUCT_VERSION } from "./product.js";
import { closeStartupTiming, startupMark } from "./runtime/startup-timing.js";

startupMark("module_graph_ready");

function installShutdownHandlers(handle: { close(): Promise<void> }): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    void handle.close()
      .catch((error: unknown) => {
        logger.error("runtime", "shutdown_failed", { signal }, error);
      })
      .finally(() => {
        startupMark("shutdown_complete", { signal });
        closeStartupTiming();
        process.exit(0);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  // Environment compatibility is checked before selecting or touching any wiki.
  assertSupportedNodeRuntime();

  const command = parseCli(process.argv.slice(2));
  startupMark("cli_parsed", { command: command.kind });
  if (command.kind === "help") {
    process.stdout.write(`${CLI_HELP}\n`);
    return;
  }
  if (command.kind === "drift-help") {
    process.stdout.write(`${DRIFT_CLI_HELP}\n`);
    return;
  }
  if (command.kind === "doctor-help") {
    process.stdout.write(`${DOCTOR_CLI_HELP}\n`);
    return;
  }
  if (command.kind === "version") {
    process.stdout.write(`${PRODUCT_VERSION}\n`);
    return;
  }
  if (command.kind === "workspace-list") {
    const { runWorkspaceList } = await import("./runtime/workspace-cli.js");
    await runWorkspaceList();
    return;
  }
  if (command.kind === "workspace-register") {
    const { runWorkspaceRegister } = await import("./runtime/workspace-cli.js");
    await runWorkspaceRegister(command.path);
    return;
  }
  if (command.kind === "workspace-unregister") {
    const { runWorkspaceUnregister } = await import("./runtime/workspace-cli.js");
    await runWorkspaceUnregister(command.workspaceId);
    return;
  }
  if (command.kind === "setup-cursor") {
    const { runCursorSetup } = await import("./runtime/cursor-setup-cli.js");
    await runCursorSetup(command.path);
    return;
  }
  if (command.kind === "setup-clients") {
    const { configureClientIntegrations } = await import("./core/client-integration.js");
    const { discoverWorkspaceFromCwd } = await import("./mcp/workspace-discovery.js");
    const root = (await discoverWorkspaceFromCwd(command.path ?? process.cwd())).root;
    const result = await configureClientIntegrations({
      projectRoot: root,
      clients: command.clients,
      mode: command.apply ? "apply" : "preview",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command.kind === "hook") {
    const { runHookCli } = await import("./runtime/hook-cli.js");
    process.exitCode = await runHookCli(command.client, command.event);
    return;
  }
  if (command.kind === "doctor") {
    const { runDoctorCli } = await import("./runtime/doctor-cli.js");
    process.exitCode = await runDoctorCli(command.options);
    return;
  }
  if (command.kind === "drift") {
    const { runDriftCli } = await import("./runtime/drift-cli.js");
    process.exitCode = await runDriftCli(command.options);
    return;
  }
  if (command.kind === "desktop") {
    const { runDesktop } = await import("./desktop/runtime.js");
    const handle = await runDesktop();
    installShutdownHandlers(handle);
    return;
  }
  if (command.kind === "serve" && command.options.transport === "http") {
    const { runHttpGateway } = await import("./http/gateway.js");
    const handle = await runHttpGateway(command.options);
    installShutdownHandlers(handle);
    return;
  }
  if (command.kind !== "serve" || command.options.transport !== "stdio") {
    throw new CliUsageError("This command is not available until its runtime has been initialized.");
  }

  const { runStdio } = await import("./runtime/stdio.js");
  const handle = await runStdio({ root: command.options.root });
  installShutdownHandlers(handle);
}

main().catch((err: unknown) => {
  const usage = err instanceof CliUsageError;
  logger.error("runtime", usage ? "configuration_error" : "fatal_error", {}, err);
  closeStartupTiming();
  process.exit(usage ? err.exitCode : 1);
});
