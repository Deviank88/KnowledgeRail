import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import JSZip from "jszip";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDocument = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const artifact = path.join(repositoryRoot, "artifacts", `knowledge-rail-${packageDocument.version}.mcpb`);
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-mcpb-smoke-"));
const extracted = path.join(temporaryRoot, "bundle");
const stateDirectory = path.join(temporaryRoot, "state");
let client;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a loopback MCPB smoke-test port.");
  return port;
}

try {
  await fs.mkdir(extracted);
  const zip = await JSZip.loadAsync(await fs.readFile(artifact));
  const names = Object.keys(zip.files).sort();
  for (const required of ["manifest.json", "server/index.js", "assets/knowledge-rail-logo.png"]) {
    if (!names.includes(required)) throw new Error(`MCPB is missing ${required}.`);
  }
  for (const name of names) {
    if (path.posix.isAbsolute(name) || name.split("/").includes("..")) {
      throw new Error(`MCPB contains an unsafe path: ${name}.`);
    }
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const target = path.join(extracted, ...name.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async("nodebuffer"));
  }

  const manifest = JSON.parse(await fs.readFile(path.join(extracted, "manifest.json"), "utf8"));
  if (manifest.version !== packageDocument.version || manifest.manifest_version !== "0.3") {
    throw new Error("Extracted MCPB manifest identity is invalid.");
  }
  client = new Client(
    { name: "knowledge-rail-mcpb-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const startedAt = performance.now();
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(extracted, "server", "index.js"), "desktop"],
    cwd: extracted,
    env: {
      ...process.env,
      KNOWLEDGE_RAIL_STATE_DIR: stateDirectory,
      KNOWLEDGE_RAIL_DESKTOP_GATEWAY_PORT: String(await availablePort()),
      KNOWLEDGE_RAIL_LOG_LEVEL: "error",
    },
    stderr: "pipe",
  }));
  const tools = (await client.listTools()).tools;
  const readyMs = performance.now() - startedAt;
  if (tools.length !== 9 || !tools.some((tool) => tool.name === "knowledge_workspace")) {
    throw new Error("MCPB desktop adapter exposed an invalid tool catalog.");
  }
  const listed = await client.callTool({ name: "knowledge_workspace", arguments: { action: "list" } });
  if (listed.isError) throw new Error("MCPB workspace catalog call failed.");
  await client.close();
  process.stdout.write(`MCPB_SMOKE files=${names.length} bytes=${(await fs.stat(artifact)).size} ready_ms=${readyMs.toFixed(2)}\n`);
} finally {
  await client?.close().catch(() => undefined);
  if (path.basename(temporaryRoot).startsWith("knowledge-rail-mcpb-smoke-")) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
