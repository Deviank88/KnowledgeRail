import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
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
  ]) {
    if (!packedPaths.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }
  for (const forbidden of ["milestones/", "tests/", ".env", "wiki/", "docs/"]) {
    if ([...packedPaths].some((entry) => entry === forbidden || entry.startsWith(forbidden))) {
      throw new Error(`Packed artifact unexpectedly contains ${forbidden}.`);
    }
  }

  await fs.writeFile(path.join(installDirectory, "package.json"), JSON.stringify({ private: true }, null, 2));
  const tarball = path.join(packDirectory, path.basename(packResult.filename));
  await runNpm(["install", "--no-audit", "--no-fund", tarball], { cwd: installDirectory });
  const installedBin = path.join(installDirectory, "node_modules", "knowledge-rail", "dist", "index.js");
  const installedPackageRoot = path.dirname(path.dirname(installedBin));
  const installedPackage = JSON.parse(await fs.readFile(path.join(installedPackageRoot, "package.json"), "utf8"));
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
  const version = await run(process.execPath, [installedBin, "--version"], { cwd: projectDirectory });
  if (!/^\d+\.\d+\.\d+\s*$/.test(version.stdout)) throw new Error("Installed --version is invalid.");
  const installedShim = path.join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "knowledge-rail.cmd" : "knowledge-rail"
  );
  await fs.access(installedShim);
  const shimVersion = await run(installedShim, ["--version"], { cwd: projectDirectory });
  if (shimVersion.stdout.trim() !== installedPackage.version) {
    throw new Error("Installed knowledge-rail command shim is missing or reports the wrong version.");
  }

  const childEnvironment = { ...process.env, KNOWLEDGE_RAIL_STATE_DIR: stateDirectory };
  const stdioClient = new Client(
    { name: "package-stdio-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await stdioClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [installedBin],
    cwd: projectDirectory,
    env: childEnvironment,
    stderr: "pipe",
  }));
  if ((await stdioClient.listTools()).tools.length !== 8) throw new Error("Installed stdio catalog is not the bound eight-tool profile.");
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
  await desktopClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [installedBin, "desktop"],
    cwd: os.tmpdir(),
    env: childEnvironment,
    stderr: "pipe",
  }));
  const desktopTools = (await desktopClient.listTools()).tools;
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
    throw new Error("Installed desktop proxy did not expose the binding through portable text content.");
  }
  const initialized = await desktopClient.callTool({
    name: "knowledge_admin",
    arguments: { action: "init", workspace_binding: workspaceBinding },
  });
  if (initialized.isError) throw new Error("Installed desktop proxy rejected its text-carried workspace binding.");
  await fs.access(path.join(projectDirectory, "wiki", "SCHEMA.md"));
  await desktopClient.close();

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
  await autoDesktopClient.close();

  const runtimeStats = await directoryStats(path.join(installDirectory, "node_modules"));
  const runtimeTree = await runNpm(["ls", "--all", "--parseable", "--omit=dev"], { cwd: installDirectory });
  const runtimePackagePaths = runtimeTree.stdout.split(/\r?\n/).filter(Boolean).length;
  process.stdout.write(
    `PACKAGE_SMOKE platform=${process.platform} tarball_bytes=${packResult.size} unpacked_bytes=${packResult.unpackedSize} ` +
    `files=${packResult.entryCount} runtime_bytes=${runtimeStats.bytes} runtime_paths=${runtimeStats.paths} ` +
    `runtime_package_paths=${runtimePackagePaths}\n`
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
