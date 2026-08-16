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
if (!product.includes(`PRODUCT_VERSION = "${version}"`)) {
  throw new Error("src/product.ts is not aligned with package.json.");
}
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  throw new Error(`CHANGELOG.md has no dated ${version} release entry.`);
}

process.stdout.write(`Release metadata is aligned for v${version}.\n`);
