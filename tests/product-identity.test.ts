import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { wikiPageUri } from "../src/context/resource-uri.js";
import { PRODUCT_VERSION } from "../src/product.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8")) as Record<string, unknown>;
}

test("product, npm and MCP Registry identities remain aligned", async () => {
  const packageJson = await readJson("package.json");
  const registryJson = await readJson("server.json");
  const packages = registryJson.packages as Array<Record<string, unknown>>;
  const registryPackage = packages[0]!;

  assert.equal(packageJson.name, "knowledge-rail");
  assert.equal(packageJson.version, PRODUCT_VERSION);
  assert.equal(packageJson.mcpName, "io.github.Deviank88/knowledge-rail");
  assert.equal(registryJson.title, "KnowledgeRail");
  assert.equal(registryJson.name, packageJson.mcpName);
  assert.equal(registryJson.version, packageJson.version);
  assert.equal(registryPackage.identifier, packageJson.name);
  assert.equal(registryPackage.version, packageJson.version);
  assert.deepEqual(registryPackage.transport, { type: "stdio" });
  assert.match(wikiPageUri("requirements/REQ_1.md"), /^knowledge-rail:\/\/page\//);
});

test("the current package version has a dated changelog release", async () => {
  const packageJson = await readJson("package.json");
  const changelog = await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
  const version = String(packageJson.version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  assert.match(changelog, new RegExp(`^## \\[${version}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
});

test("public documentation distinguishes local self-hosting from future remote service", async () => {
  const [readme, selfHosting, security] = await Promise.all([
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "SELF_HOSTING.md"), "utf8"),
    readFile(path.join(repositoryRoot, "SECURITY.md"), "utf8"),
  ]);
  assert.match(readme, /operates no hosted service/i);
  assert.match(readme, /Claude Desktop/i);
  assert.match(readme, /Windows/);
  assert.match(readme, /macOS/);
  assert.match(readme, /Linux/);
  assert.match(selfHosting, /rejects non-loopback/i);
  assert.match(security, /opaque workspace binding/i);
});

test("public attribution credits the conceptual origin without redefining the product", async () => {
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const acknowledgements = await readFile(path.join(repositoryRoot, "ACKNOWLEDGEMENTS.md"), "utf8");
  const primarySource = "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f";

  assert.equal(readme.includes(primarySource), true);
  assert.equal(acknowledgements.includes(primarySource), true);
  assert.match(readme, /independent project/i);
  assert.match(readme, /distinct MCP 2\.0 agent-memory system/i);
  assert.match(acknowledgements, /not affiliated with or endorsed/i);
});
