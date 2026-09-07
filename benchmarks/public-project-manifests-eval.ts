import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { evaluateImportResolution } from "./import-resolution-eval.js";

const bytes = await fs.readFile(new URL("fixtures/public-project-manifests.json", import.meta.url), "utf8");
const corpus = JSON.parse(bytes) as { version: number; provenance: string; samples: Array<{
  repository: string; commit: string; path: string; url: string; sha256: string; content: string;
}> };
const overlays = JSON.parse(await fs.readFile(new URL("fixtures/public-project-imports.json", import.meta.url), "utf8")) as {
  cases: Array<{ repository: string; split: string; files: Record<string, string>; edges: string[][]; issues: string[][] }>;
};
const cases = overlays.cases.map((sample) => {
  const manifest = corpus.samples.find((entry) => entry.repository === sample.repository);
  assert.ok(manifest, sample.repository);
  assert.equal(createHash("sha256").update(manifest.content).digest("hex"), manifest.sha256);
  assert.match(manifest.commit, /^[a-f0-9]{40}$/u);
  assert.equal(manifest.url, `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${manifest.path}`);
  assert.ok(!Object.hasOwn(sample.files, manifest.path), "overlays must not replace real manifest bytes");
  return { ...sample, id: sample.repository.replaceAll("/", "-"), files: { ...sample.files, [manifest.path]: manifest.content } };
});
const result = await evaluateImportResolution(undefined, JSON.stringify({ version: corpus.version, scope: corpus.provenance, cases }));
const report = { ...result, corpusSha256: createHash("sha256").update(bytes).digest("hex"),
  manifests: corpus.samples.map(({ content, ...sample }) => ({ ...sample, bytes: Buffer.byteLength(content) })) };
const output = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--gate")) assert.ok(report.pass, "Public manifest corpus failed.");
