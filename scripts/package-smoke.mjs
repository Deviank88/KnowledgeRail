import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
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

let gatewayProcess;
try {
  const packed = await run(npmCommand, ["pack", "--json", "--pack-destination", packDirectory], { cwd: process.cwd() });
  const packResult = JSON.parse(packed.stdout)[0];
  const packedPaths = new Set(packResult.files.map((entry) => entry.path));
  for (const required of ["dist/index.js", "README.md", "LICENSE", "package.json", "server.json"]) {
    if (!packedPaths.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }
  for (const forbidden of ["milestones/", "tests/", ".env", "wiki/", "docs/"]) {
    if ([...packedPaths].some((entry) => entry === forbidden || entry.startsWith(forbidden))) {
      throw new Error(`Packed artifact unexpectedly contains ${forbidden}.`);
    }
  }

  await fs.writeFile(path.join(installDirectory, "package.json"), JSON.stringify({ private: true }, null, 2));
  const tarball = path.join(packDirectory, path.basename(packResult.filename));
  await run(npmCommand, ["install", "--no-audit", "--no-fund", tarball], { cwd: installDirectory });
  const installedBin = path.join(installDirectory, "node_modules", "knowledge-rail", "dist", "index.js");
  const firstLine = (await fs.readFile(installedBin, "utf8")).split(/\r?\n/, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") throw new Error("Installed CLI lost its portable Node shebang.");
  const help = await run(process.execPath, [installedBin, "--help"], { cwd: projectDirectory });
  if (!help.stdout.includes("knowledge-rail desktop")) throw new Error("Installed --help is incomplete.");
  const version = await run(process.execPath, [installedBin, "--version"], { cwd: projectDirectory });
  if (!/^\d+\.\d+\.\d+\s*$/.test(version.stdout)) throw new Error("Installed --version is invalid.");

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
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await desktopClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [installedBin, "desktop"],
    cwd: os.tmpdir(),
    env: childEnvironment,
    stderr: "pipe",
  }));
  if ((await desktopClient.listTools()).tools.length !== 9) throw new Error("Installed desktop proxy did not expose the catalog profile.");
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

  process.stdout.write(
    `PACKAGE_SMOKE platform=${process.platform} tarball_bytes=${packResult.size} unpacked_bytes=${packResult.unpackedSize} files=${packResult.entryCount}\n`
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
