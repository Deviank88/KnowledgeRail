import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDocument = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required; run this builder through npm.");

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-mcpb-"));
const packDirectory = path.join(temporaryRoot, "pack");
const installDirectory = path.join(temporaryRoot, "install");
const bundleDirectory = path.join(temporaryRoot, "bundle");
const outputDirectory = path.join(repositoryRoot, "artifacts");
const outputPath = path.join(outputDirectory, `knowledge-rail-${packageDocument.version}.mcpb`);
const FIXED_ARCHIVE_DATE = new Date("1980-01-01T00:00:00.000Z");

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

async function addDirectoryToArchive(zip, root, relative = "") {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, ...childRelative.split("/"));
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await addDirectoryToArchive(zip, root, childRelative);
    } else if (entry.isFile()) {
      zip.file(childRelative, await fs.readFile(absolute), {
        createFolders: false,
        date: FIXED_ARCHIVE_DATE,
        unixPermissions: childRelative === "server/index.js" ? 0o755 : 0o644,
      });
    }
  }
}

try {
  await Promise.all([
    fs.mkdir(packDirectory),
    fs.mkdir(installDirectory),
    fs.mkdir(bundleDirectory),
    fs.mkdir(outputDirectory, { recursive: true }),
  ]);
  const packed = await runNpm(["pack", "--json", "--pack-destination", packDirectory], {
    cwd: repositoryRoot,
  });
  const packResult = JSON.parse(packed.stdout)[0];
  const tarball = path.join(packDirectory, path.basename(packResult.filename));
  await fs.writeFile(path.join(installDirectory, "package.json"), `${JSON.stringify({
    private: true,
    dependencies: { "knowledge-rail": `file:${tarball}` },
  }, null, 2)}\n`);
  await runNpm([
    "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
  ], { cwd: installDirectory });

  const installedPackageRoot = path.join(installDirectory, "node_modules", "knowledge-rail");
  await Promise.all([
    fs.cp(path.join(installedPackageRoot, "dist"), path.join(bundleDirectory, "server"), { recursive: true }),
    fs.cp(path.join(installDirectory, "node_modules"), path.join(bundleDirectory, "node_modules"), { recursive: true }),
    fs.cp(path.join(repositoryRoot, "assets"), path.join(bundleDirectory, "assets"), { recursive: true }),
    fs.copyFile(path.join(repositoryRoot, "LICENSE"), path.join(bundleDirectory, "LICENSE")),
    fs.copyFile(path.join(repositoryRoot, "ACKNOWLEDGEMENTS.md"), path.join(bundleDirectory, "ACKNOWLEDGEMENTS.md")),
  ]);
  await fs.rm(path.join(bundleDirectory, "node_modules", "knowledge-rail"), { recursive: true, force: true });
  // npm records the temporary tarball's absolute path here, which is neither
  // needed at runtime nor reproducible across builds.
  await fs.rm(path.join(bundleDirectory, "node_modules", ".package-lock.json"), { force: true });

  const manifestPath = path.join(repositoryRoot, "packaging", "mcpb", "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.manifest_version !== "0.3") throw new Error("Unsupported MCPB manifest version.");
  if (manifest.version !== packageDocument.version) throw new Error("MCPB and npm package versions differ.");
  if (manifest.server?.mcp_config?.args?.at(-1) !== "desktop") {
    throw new Error("MCPB must launch the context-free desktop adapter.");
  }
  await fs.writeFile(path.join(bundleDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const version = await run(process.execPath, [path.join(bundleDirectory, "server", "index.js"), "--version"], {
    cwd: bundleDirectory,
  });
  if (version.stdout.trim() !== packageDocument.version) {
    throw new Error("Bundled server reports a different product version.");
  }

  const zip = new JSZip();
  await addDirectoryToArchive(zip, bundleDirectory);
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });
  await fs.writeFile(outputPath, archive, { mode: 0o644 });
  process.stdout.write(`MCPB path=${outputPath} bytes=${archive.byteLength}\n`);
} finally {
  if (path.basename(temporaryRoot).startsWith("knowledge-rail-mcpb-")) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
