import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

const packageJson = await json("package.json");
const packageLock = await json("package-lock.json");
const server = await json("server.json");
const product = await readFile(new URL("src/product.ts", root), "utf8");
const changelog = await readFile(new URL("CHANGELOG.md", root), "utf8");
const readme = await readFile(new URL("README.md", root), "utf8");
const version = packageJson.version;
const requestedTag = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
if (requestedTag && requestedTag !== `v${version}`) {
  throw new Error(`Tag ${requestedTag} does not match package version v${version}.`);
}
if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
  throw new Error("package-lock.json is not aligned with package.json.");
}
if (server.version !== version || server.packages?.[0]?.version !== version) {
  throw new Error("server.json is not aligned with package.json.");
}
if (!packageJson.files?.includes("assets/knowledge-rail-logo.png")) {
  throw new Error("The public README logo is not included in the npm package.");
}
const repositoryUrl = typeof packageJson.repository === "string"
  ? packageJson.repository
  : packageJson.repository?.url;
const repositoryOwner = repositoryUrl?.match(/github\.com[/:]([^/]+)\//i)?.[1];
if (!repositoryOwner) throw new Error("package.json repository does not identify a GitHub owner.");
if (!String(packageJson.mcpName).startsWith(`io.github.${repositoryOwner}/`)) {
  throw new Error(
    `MCP namespace ${packageJson.mcpName} does not preserve the canonical GitHub owner casing ${repositoryOwner}.`
  );
}
if (server.name !== packageJson.mcpName) {
  throw new Error("server.json name is not aligned with package.json mcpName.");
}
if (!product.includes(`PRODUCT_VERSION = "${version}"`)) {
  throw new Error("src/product.ts is not aligned with package.json.");
}
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  throw new Error(`CHANGELOG.md has no dated ${version} release entry.`);
}
const pinnedReadmeVersions = [...readme.matchAll(/knowledge-rail@(\d+\.\d+\.\d+)/g)]
  .map((match) => match[1]);
if (pinnedReadmeVersions.length === 0 || pinnedReadmeVersions.some((item) => item !== version)) {
  throw new Error(`README.md installation examples are not aligned with ${version}.`);
}
if (!readme.includes(`stable release \`${version}\``)) {
  throw new Error(`README.md current status is not aligned with ${version}.`);
}
if (!readme.includes(
  `<img src="https://cdn.jsdelivr.net/npm/knowledge-rail@${version}/assets/knowledge-rail-logo.png"`
)) {
  throw new Error(`README.md must use the public versioned ${version} logo URL so npm can render it.`);
}

process.stdout.write(`Release metadata is aligned for v${version}.\n`);
