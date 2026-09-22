import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required; run this smoke test through npm.");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-package-smoke-"));
const packDirectory = path.join(temporaryRoot, "pack");
const installDirectory = path.join(temporaryRoot, "install");
const projectDirectory = path.join(temporaryRoot, "project with spaces ü");
const stateDirectory = path.join(temporaryRoot, "state");
await Promise.all([
  fs.mkdir(packDirectory, { recursive: true }),
  fs.mkdir(installDirectory, { recursive: true }),
  fs.mkdir(projectDirectory, { recursive: true }),
]);
await fs.writeFile(path.join(projectDirectory, "package.json"), "{}\n");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${stderr}`));
    });
  });
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a loopback smoke-test port.");
  return port;
}

async function waitForJson(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

async function directoryStats(root) {
  let bytes = 0;
  let paths = 0;
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const abs = path.join(directory, entry.name);
      paths++;
      if (entry.isDirectory()) await visit(abs);
      else if (entry.isFile()) bytes += (await fs.stat(abs)).size;
    }
  };
  await visit(root);
  return { bytes, paths };
}

let gatewayProcess;
const startupTimings = {};
try {
  const packed = await runNpm(["pack", "--json", "--pack-destination", packDirectory], { cwd: process.cwd() });
  const packResult = JSON.parse(packed.stdout)[0];
  const packedPaths = new Set(packResult.files.map((entry) => entry.path));
  for (const required of [
    "dist/index.js",
    "README.md",
    "LICENSE",
    "package.json",
    "server.json",
    "assets/knowledge-rail-logo.png",
    "docs/guides/claude-code-hooks.md",
    "docs/guides/code-evidence-retrieval.md",
    "docs/guides/memory-evolution.md",
  ]) {
    if (!packedPaths.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }
  for (const forbidden of ["milestones/", "docs/milestones/", "tests/", ".env", "wiki/"]) {
    if ([...packedPaths].some((entry) => entry === forbidden || entry.startsWith(forbidden))) {
      throw new Error(`Packed artifact unexpectedly contains ${forbidden}.`);
    }
  }
  const publicDocs = new Set([
    "docs/guides/claude-code-hooks.md",
    "docs/guides/code-evidence-retrieval.md",
    "docs/guides/memory-evolution.md",
  ]);
  const unexpectedDocs = [...packedPaths].filter((entry) => entry.startsWith("docs/") && !publicDocs.has(entry));
  if (unexpectedDocs.length > 0) {
    throw new Error(`Packed artifact unexpectedly contains private docs: ${unexpectedDocs.join(", ")}.`);
  }

  await fs.writeFile(path.join(installDirectory, "package.json"), JSON.stringify({ private: true }, null, 2));
  const tarball = path.join(packDirectory, path.basename(packResult.filename));
  await runNpm(["install", "--no-audit", "--no-fund", tarball], { cwd: installDirectory });
  const installedBin = path.join(installDirectory, "node_modules", "knowledge-rail", "dist", "index.js");
  const installedPackageRoot = path.dirname(path.dirname(installedBin));
  const installedPackage = JSON.parse(await fs.readFile(path.join(installedPackageRoot, "package.json"), "utf8"));
  const [sourceReadme, installedReadme, sourceLogo, installedLogo] = await Promise.all([
    fs.readFile(path.join(process.cwd(), "README.md")),
    fs.readFile(path.join(installedPackageRoot, "README.md")),
    fs.readFile(path.join(process.cwd(), "assets", "knowledge-rail-logo.png")),
    fs.readFile(path.join(installedPackageRoot, "assets", "knowledge-rail-logo.png")),
  ]);
  if (!installedReadme.equals(sourceReadme)) {
    throw new Error("Packed README.md differs from the release source.");
  }
  if (!installedLogo.equals(sourceLogo)) {
    throw new Error("Packed README logo differs from the release source.");
  }
  if (installedPackage.dependencies?.marked !== "18.0.9") {
    throw new Error("Packed runtime must exact-pin marked@18.0.9.");
  }
  const installedMarkedPackage = JSON.parse(await fs.readFile(
    path.join(installDirectory, "node_modules", "marked", "package.json"),
    "utf8"
  ));
  if (installedMarkedPackage.version !== "18.0.9") {
    throw new Error(`Packed runtime installed unexpected marked version ${installedMarkedPackage.version}.`);
  }
  if (Object.keys(installedMarkedPackage.dependencies ?? {}).length > 0) {
    throw new Error("Pinned marked runtime unexpectedly gained transitive dependencies.");
  }
  for (const forbiddenDependency of ["@mermaid-js/mermaid-cli", "docx", "puppeteer", "puppeteer-core"]) {
    if (installedPackage.dependencies?.[forbiddenDependency]) {
      throw new Error("Packed runtime declares forbidden renderer dependency " + forbiddenDependency + ".");
    }
    try {
      await fs.access(path.join(installDirectory, "node_modules", ...forbiddenDependency.split("/")));
      throw new Error("Packed runtime installed forbidden renderer dependency " + forbiddenDependency + ".");
    } catch (error) {
      if (error instanceof Error && error.message.includes("forbidden renderer dependency")) throw error;
    }
  }
  const firstLine = (await fs.readFile(installedBin, "utf8")).split(/\r?\n/, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") throw new Error("Installed CLI lost its portable Node shebang.");
  const help = await run(process.execPath, [installedBin, "--help"], { cwd: projectDirectory });
  if (!help.stdout.includes("knowledge-rail desktop")) throw new Error("Installed --help is incomplete.");
  const driftHelp = await run(process.execPath, [installedBin, "drift", "--help"], { cwd: projectDirectory });
  if (!driftHelp.stdout.includes("knowledge-rail drift") || !driftHelp.stdout.includes("--no-ledger")) {
    throw new Error("Installed drift subcommand help is incomplete.");
  }
  const doctorHelp = await run(process.execPath, [installedBin, "doctor", "--help"], { cwd: projectDirectory });
  if (!doctorHelp.stdout.includes("knowledge-rail doctor") || !doctorHelp.stdout.includes("read-only")) {
    throw new Error("Installed doctor subcommand help is incomplete.");
  }
  const version = await run(process.execPath, [installedBin, "--version"], { cwd: projectDirectory });
  if (!/^\d+\.\d+\.\d+\s*$/.test(version.stdout)) throw new Error("Installed --version is invalid.");
  const installedShim = path.join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "knowledge-rail.cmd" : "knowledge-rail"
  );
  await fs.access(installedShim);
  const shimVersion = await runNpm(
    ["exec", "--offline", "--", "knowledge-rail", "--version"],
    { cwd: installDirectory }
  );
  if (shimVersion.stdout.trim() !== installedPackage.version) {
    throw new Error("Installed knowledge-rail command shim is missing or reports the wrong version.");
  }

  const doctor = await run(process.execPath, [installedBin, "doctor"], { cwd: projectDirectory });
  if (
    !doctor.stdout.includes("status: ready") ||
    !doctor.stdout.includes(`workspace_root: ${await fs.realpath(projectDirectory)}`) ||
    !doctor.stdout.includes("workspace_source: project_marker")
  ) {
    throw new Error("Installed doctor command did not report the discovered project.");
  }
  const nestedCursorDirectory = path.join(projectDirectory, "packages", "app");
  await fs.mkdir(nestedCursorDirectory, { recursive: true });
  const cursorSetup = await run(
    process.execPath,
    [installedBin, "setup", "cursor"],
    { cwd: nestedCursorDirectory }
  );
  if (!cursorSetup.stdout.startsWith("Configured Cursor for ")) {
    throw new Error("Installed Cursor setup command did not configure the project.");
  }
  const cursorConfigPath = path.join(projectDirectory, ".cursor", "mcp.json");
  const cursorConfigRaw = await fs.readFile(cursorConfigPath, "utf8");
  const cursorConfig = JSON.parse(cursorConfigRaw);
  const cursorServer = cursorConfig.mcpServers?.["knowledge-rail"];
  if (
    cursorServer?.type !== "stdio" ||
    cursorServer.command !== "npx" ||
    JSON.stringify(cursorServer.args) !== JSON.stringify([
      "-y",
      `knowledge-rail@${installedPackage.version}`,
      "--root",
      "${workspaceFolder}",
    ])
  ) {
    throw new Error("Installed Cursor setup command wrote an invalid project binding.");
  }
  const repeatedCursorSetup = await run(
    process.execPath,
    [installedBin, "setup", "cursor"],
    { cwd: projectDirectory }
  );
  if (!repeatedCursorSetup.stdout.startsWith("Already configured Cursor for ")) {
    throw new Error("Installed Cursor setup command is not idempotent.");
  }
  if (await fs.readFile(cursorConfigPath, "utf8") !== cursorConfigRaw) {
    throw new Error("Installed Cursor setup rewrote an already-correct configuration.");
  }

  const existingClaudeInstructions = "# Existing installed-package instructions\n";
  await fs.writeFile(path.join(projectDirectory, "CLAUDE.md"), existingClaudeInstructions);
  const clientPreview = await run(
    process.execPath,
    [installedBin, "setup", "clients"],
    { cwd: projectDirectory }
  );
  const previewResult = JSON.parse(clientPreview.stdout);
  if (previewResult.applied !== false || previewResult.changes.length !== 6) {
    throw new Error("Installed client integration preview returned an invalid plan.");
  }
  try {
    await fs.access(path.join(projectDirectory, ".claude", "settings.json"));
    throw new Error("Installed client integration preview wrote project files.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("preview wrote")) throw error;
  }
  const clientApply = await run(
    process.execPath,
    [installedBin, "setup", "clients", "--apply"],
    { cwd: projectDirectory }
  );
  const applyResult = JSON.parse(clientApply.stdout);
  if (applyResult.applied !== true || applyResult.changes.filter((entry) => entry.status !== "unchanged").length !== 6) {
    throw new Error("Installed client integration apply returned an invalid result.");
  }
  const backupManifestPath = applyResult.backup?.manifest;
  if (
    applyResult.backup?.fileCount !== 1 ||
    typeof backupManifestPath !== "string" ||
    path.isAbsolute(backupManifestPath) ||
    backupManifestPath.split("/").includes("..") ||
    !backupManifestPath.startsWith(".knowledge-rail/backups/client-setup/")
  ) {
    throw new Error("Installed client integration did not return a safe project-local backup manifest.");
  }
  const backupManifest = JSON.parse(await fs.readFile(
    path.join(projectDirectory, ...backupManifestPath.split("/")),
    "utf8"
  ));
  if (
    backupManifest.state !== "applied" ||
    backupManifest.files.length !== 6 ||
    backupManifest.files.filter((entry) => entry.existed).length !== 1
  ) {
    throw new Error("Installed client integration wrote an invalid recovery manifest.");
  }
  const claudeBackup = backupManifest.files.find((entry) => entry.path === "CLAUDE.md");
  if (
    claudeBackup?.backupPath !== "files/CLAUDE.md" ||
    await fs.readFile(path.join(
      projectDirectory,
      ...applyResult.backup.directory.split("/"),
      ...claudeBackup.backupPath.split("/")
    ), "utf8") !== existingClaudeInstructions
  ) {
    throw new Error("Installed client integration did not preserve the original project instructions.");
  }
  for (const relative of [
    "CLAUDE.md",
    ".claude/settings.json",
    "AGENTS.md",
    ".codex/hooks.json",
    ".cursor/rules/knowledge-rail.mdc",
    ".cursor/hooks.json",
  ]) await fs.access(path.join(projectDirectory, ...relative.split("/")));
  const codexHooks = await fs.readFile(path.join(projectDirectory, ".codex", "hooks.json"), "utf8");
  if (!codexHooks.includes(`knowledge-rail@${installedPackage.version} hook --client codex`)) {
    throw new Error("Installed client integration did not pin the packaged release.");
  }
  const repeatedClientApply = JSON.parse((await run(
    process.execPath,
    [installedBin, "setup", "clients", "--apply"],
    { cwd: projectDirectory }
  )).stdout);
  if (!repeatedClientApply.changes.every((entry) => entry.status === "unchanged")) {
    throw new Error("Installed client integration setup is not idempotent.");
  }
  if (repeatedClientApply.backup !== undefined) {
    throw new Error("Installed idempotent client integration setup created an unnecessary backup.");
  }

  const childEnvironment = { ...process.env, KNOWLEDGE_RAIL_STATE_DIR: stateDirectory };
  const stdioClient = new Client(
    { name: "package-stdio-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const stdioStartupStartedAt = performance.now();
  await stdioClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [installedBin],
    cwd: projectDirectory,
    env: childEnvironment,
    stderr: "pipe",
  }));
  if ((await stdioClient.listTools()).tools.length !== 8) throw new Error("Installed stdio catalog is not the bound eight-tool profile.");
  startupTimings.stdioReadyMs = performance.now() - stdioStartupStartedAt;
  await stdioClient.close();

  const registration = await run(
    process.execPath,
    [installedBin, "workspace", "register", projectDirectory],
    { cwd: projectDirectory, env: childEnvironment }
  );
  const workspaceId = registration.stdout.match(/\b(ws_[A-Za-z0-9_-]{8,})\b/)?.[1];
  if (!workspaceId) throw new Error("Installed workspace registration did not return a workspace ID.");

  const port = await availablePort();
  gatewayProcess = spawn(process.execPath, [installedBin, "--transport", "http", "--port", String(port)], {
    cwd: projectDirectory,
    env: childEnvironment,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let gatewayErrors = "";
  gatewayProcess.stderr.setEncoding("utf8");
  gatewayProcess.stderr.on("data", (chunk) => { gatewayErrors += chunk; });
  const rendezvous = await waitForJson(path.join(stateDirectory, "gateway.json"));
  const credential = (await fs.readFile(path.join(stateDirectory, "gateway.credential"), "utf8")).trim();
  const httpClient = new Client(
    { name: "package-http-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(rendezvous.endpoint), {
    authProvider: { token: async () => credential },
  }));
  if ((await httpClient.listTools()).tools.length !== 9) throw new Error("Installed HTTP catalog is not the nine-tool catalog profile.");
  await httpClient.close();

  const desktopClient = new Client(
    { name: "package-desktop-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } }
  );
  const existingGatewayDesktopStartedAt = performance.now();
  await desktopClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [installedBin, "desktop"],
    cwd: os.tmpdir(),
    env: childEnvironment,
    stderr: "pipe",
  }));
  const desktopTools = (await desktopClient.listTools()).tools;
  startupTimings.desktopExistingGatewayReadyMs = performance.now() - existingGatewayDesktopStartedAt;
  if (desktopTools.length !== 9) throw new Error("Installed desktop proxy did not expose the catalog profile.");
  if (!desktopTools.find((tool) => tool.name === "knowledge_workspace")?.outputSchema) {
    throw new Error("Installed desktop proxy did not advertise the workspace output contract.");
  }
  const listed = await desktopClient.callTool({
    name: "knowledge_workspace",
    arguments: { action: "list" },
  });
  if (!Array.isArray(listed.structuredContent?.workspaces) || listed.structuredContent.workspaces.length !== 1) {
    throw new Error("Installed desktop proxy did not return the registered workspace.");
  }
  const selected = await desktopClient.callTool({
    name: "knowledge_workspace",
    arguments: { action: "select", workspace_id: workspaceId, scope: "write", confirmed: true },
  });
  const selectionText = selected.content.find((item) => item.type === "text")?.text ?? "";
  const workspaceBinding = selectionText.match(/^workspace_binding: (krb[0-9]+_[A-Za-z0-9_-]+)$/m)?.[1];
  if (!workspaceBinding || workspaceBinding !== selected.structuredContent?.binding) {
    const state = typeof selected.structuredContent?.state === "string" ? selected.structuredContent.state : "missing";
    const reason = typeof selected.structuredContent?.reason === "string" ? selected.structuredContent.reason : "missing";
    const cause = typeof selected.structuredContent?.cause === "string" ? selected.structuredContent.cause : "missing";
    throw new Error(
      "Installed desktop proxy did not expose the binding through portable text content " +
      `(isError=${selected.isError === true}, state=${state}, reason=${reason}, cause=${cause}, ` +
      `structuredBinding=${typeof selected.structuredContent?.binding === "string"}, textBinding=${Boolean(workspaceBinding)}).`
    );
  }
  const initialized = await desktopClient.callTool({
    name: "knowledge_admin",
    arguments: { action: "init", workspace_binding: workspaceBinding },
  });
  if (initialized.isError) throw new Error("Installed desktop proxy rejected its text-carried workspace binding.");
  await fs.access(path.join(projectDirectory, "wiki", "SCHEMA.md"));
  await desktopClient.close();

  const drift = await run(
    process.execPath,
    [installedBin, "drift", "--no-ledger"],
    { cwd: projectDirectory, env: childEnvironment }
  );
  if (drift.stdout !== "" || drift.stderr !== "") {
    throw new Error("Installed drift command was not silent for an all-fresh project.");
  }
  const scopedDrift = await run(
    process.execPath,
    [installedBin, "drift", "--no-ledger", "--path", path.join(projectDirectory, "package.json")],
    { cwd: projectDirectory, env: childEnvironment }
  );
  if (scopedDrift.stdout !== "" || scopedDrift.stderr !== "") {
    throw new Error("Installed path-scoped drift command was not hook-safe.");
  }

  gatewayProcess.kill("SIGTERM");
  await new Promise((resolve) => gatewayProcess.once("exit", resolve));
  gatewayProcess = undefined;
  if (gatewayErrors.includes("Fatal error")) throw new Error(gatewayErrors);

  const autoStateDirectory = path.join(temporaryRoot, "desktop-auto-state");
  const autoDesktopPort = await availablePort();
  const autoDesktopClient = new Client(
    { name: "package-desktop-autostart-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const coldDesktopStartedAt = performance.now();
  await autoDesktopClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [installedBin, "desktop"],
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      KNOWLEDGE_RAIL_STATE_DIR: autoStateDirectory,
      KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT: String(autoDesktopPort),
    },
    stderr: "pipe",
  }));
  if ((await autoDesktopClient.listTools()).tools.length !== 9) {
    throw new Error("Installed desktop adapter did not auto-start its catalog gateway.");
  }
  startupTimings.desktopColdGatewayReadyMs = performance.now() - coldDesktopStartedAt;
  await autoDesktopClient.close();

  const runtimeStats = await directoryStats(path.join(installDirectory, "node_modules"));
  const runtimeTree = await runNpm(["ls", "--all", "--parseable", "--omit=dev"], { cwd: installDirectory });
  const runtimePackagePaths = runtimeTree.stdout.split(/\r?\n/).filter(Boolean).length;
  process.stdout.write(
    `PACKAGE_SMOKE platform=${process.platform} tarball_bytes=${packResult.size} unpacked_bytes=${packResult.unpackedSize} ` +
      `files=${packResult.entryCount} runtime_bytes=${runtimeStats.bytes} runtime_paths=${runtimeStats.paths} ` +
      `runtime_package_paths=${runtimePackagePaths} ` +
      `stdio_ready_ms=${startupTimings.stdioReadyMs.toFixed(2)} ` +
      `desktop_existing_ready_ms=${startupTimings.desktopExistingGatewayReadyMs.toFixed(2)} ` +
      `desktop_cold_ready_ms=${startupTimings.desktopColdGatewayReadyMs.toFixed(2)}\n`
  );
} finally {
  if (gatewayProcess && gatewayProcess.exitCode === null) {
    gatewayProcess.kill("SIGTERM");
    await new Promise((resolve) => gatewayProcess.once("exit", resolve));
  }
  if (path.basename(temporaryRoot).startsWith("knowledge-rail-package-smoke-")) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
