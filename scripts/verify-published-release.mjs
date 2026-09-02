import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = new URL("../", import.meta.url);
const args = process.argv.slice(2);
const requestedTag = args.find((arg) => !arg.startsWith("--"));
const githubOnly = args.includes("--github-only");
const packageJson = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
if (requestedTag && requestedTag !== tag) {
  throw new Error(`Tag ${requestedTag} does not match package version ${tag}.`);
}

const repositoryUrl = typeof packageJson.repository === "string"
  ? packageJson.repository
  : packageJson.repository?.url;
const repositoryMatch = repositoryUrl?.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i);
const owner = repositoryMatch?.[1];
const repository = repositoryMatch?.[2];
if (!owner || !repository) throw new Error("Cannot resolve the GitHub repository from package.json.");

const localReadme = await fs.readFile(new URL("README.md", root));
const localLogo = await fs.readFile(new URL("assets/knowledge-rail-logo.png", root));
const rawBase = `https://raw.githubusercontent.com/${owner}/${repository}/${tag}`;
const logoUrl = `${rawBase}/assets/knowledge-rail-logo.png`;
if (!localReadme.toString("utf8").includes(`<img src="${logoUrl}"`)) {
  throw new Error(`README.md does not reference ${logoUrl}.`);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function retry(label, operation, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(5_000);
    }
  }
  throw new Error(`${label} did not become available after ${attempts} attempts.`, { cause: lastError });
}

async function fetchBytes(url, expectedContentType) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "knowledge-rail-release-verifier" },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (expectedContentType && !contentType.toLowerCase().startsWith(expectedContentType)) {
    throw new Error(`${url} returned unexpected content type ${contentType || "unknown"}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

const [taggedReadme, taggedLogo] = await Promise.all([
  retry("Tagged GitHub README", () => fetchBytes(`${rawBase}/README.md`, "text/plain")),
  retry("Tagged GitHub logo", () => fetchBytes(logoUrl, "image/png")),
]);
if (!taggedReadme.equals(localReadme)) throw new Error("Tagged GitHub README differs from the release source.");
if (!taggedLogo.equals(localLogo)) throw new Error("Tagged GitHub logo differs from the release source.");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
if (githubOnly) {
  process.stdout.write(`Published GitHub README assets verified for ${tag}; logo_sha256=${sha256(localLogo)}\n`);
  process.exit(0);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required; run this verifier through npm.");
function runNpm(npmArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...npmArgs], {
      cwd,
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
      if (code === 0 && !signal) resolve(stdout);
      else reject(new Error(`npm ${npmArgs.join(" ")} failed (${code ?? signal})\n${stderr}`));
    });
  });
}

const packageSpec = `${packageJson.name}@${version}`;
const publishedReadme = await retry("Published npm README", async () => {
  const output = await runNpm(["view", packageSpec, "readme", "--json"], process.cwd());
  const value = JSON.parse(output);
  if (typeof value !== "string" || value.length === 0) throw new Error("npm returned no README.");
  return Buffer.from(value);
});
if (!publishedReadme.equals(localReadme)) throw new Error("npm registry README differs from the release source.");

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-published-assets-"));
try {
  await fs.writeFile(path.join(temporaryRoot, "package.json"), "{\"private\":true}\n");
  await retry("Published npm tarball", () => runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--save-exact",
    packageSpec,
  ], temporaryRoot));
  const installedRoot = path.join(temporaryRoot, "node_modules", packageJson.name);
  const [installedPackage, installedReadme, installedLogo] = await Promise.all([
    fs.readFile(path.join(installedRoot, "package.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(installedRoot, "README.md")),
    fs.readFile(path.join(installedRoot, "assets", "knowledge-rail-logo.png")),
  ]);
  if (installedPackage.version !== version) throw new Error(`npm installed ${installedPackage.version}, expected ${version}.`);
  if (!installedReadme.equals(localReadme)) throw new Error("Installed npm README differs from the release source.");
  if (!installedLogo.equals(localLogo)) throw new Error("Installed npm logo differs from the release source.");
} finally {
  if (path.basename(temporaryRoot).startsWith("knowledge-rail-published-assets-")) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

process.stdout.write(
  `Published GitHub and npm README assets verified for ${tag}; logo_sha256=${sha256(localLogo)}\n`
);
