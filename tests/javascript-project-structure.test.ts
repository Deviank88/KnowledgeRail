import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import { KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { codeEvidenceIndexFile, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { parseManifestJson } from "../src/core/code-evidence/manifest-json.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

async function project(t: TestContext, files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-js-structure-"));
  const wikiRoot = path.join(root, "wiki");
  const registry = new KnowledgeAdapterRegistry([new TypeScriptKnowledgeAdapter()]);
  const write = async (name: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  };
  for (const [name, content] of Object.entries(files)) await write(name, content);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, registry });
  await index.rebuild();
  const snapshot = await index.snapshot();
  const incoming = async (name: string) => {
    const target = snapshot.fragments.find((fragment) => fragment.path === name && fragment.kind === "module")!;
    assert.ok(target, name);
    return [...new Set((await index.references(target.id, { maxResults: 100 })).filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
  };
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot, index, incoming, write };
}

const moduleText = "export const value = 1;";
const config = (options: Record<string, unknown>, base?: string) => JSON.stringify({ ...(base ? { extends: base } : {}), compilerOptions: options });

test("manifest JSONC preserves strings and rejects malformed JSON beyond comments and trailing commas", () => {
  assert.deepEqual(parseManifestJson('\uFEFF{/* comment */"url":"https://host/*literal*/",// line\r\n"quote":"a\\\"//b","list":[1, /* tail */],}'),
    { url: "https://host/*literal*/", quote: 'a"//b', list: [1] });
  for (const malformed of ["{,}", "[,]", "[1,,]", "{a:1}", "{\"x\":undefined}", "{/* unfinished", "{\"x\":\"unfinished}"]) {
    assert.throws(() => parseManifestJson(malformed), malformed);
  }
});

test("declared JS/TS aliases use exact patterns, longest prefixes, suffixes and ordered fallback in arbitrary layouts", async (t) => {
  const p = await project(t, {
    "odd/place/tsconfig.json": `{
      // Deliberately no baseUrl or conventional src directory.
      "compilerOptions": { "paths": {
        "@app/*": ["../../domain/*"],
        "@app/special/*": ["../../specific/*"],
        "@app/special/Exact": ["../../exact/Exact.ts"],
        "@suffix/*/end": ["../../domain/*"],
        "@fallback": ["../../missing", "../../domain/Order", "../../exact/Exact.ts"],
        "@ambiguous": ["../../domain/Ambiguous", "../../exact/Exact.ts"],
        "@tie/*": ["../../domain/Order"],
        "@tie/*end": ["../../exact/Exact.ts"],
      }, },
    }`,
    "domain/Order.ts": moduleText,
    "domain/Ambiguous.ts": moduleText,
    "domain/Ambiguous.tsx": moduleText,
    "specific/Order.ts": moduleText,
    "specific/Exact.ts": moduleText,
    "exact/Exact.ts": moduleText,
    "odd/place/alias.ts": 'import "@app/Order";',
    "odd/place/runtime.mts": 'import "@app/Order.js";',
    "odd/place/longer.ts": 'import "@app/special/Order";',
    "odd/place/exact.ts": 'import "@app/special/Exact";',
    "odd/place/suffix.js": 'import "@suffix/Order/end";',
    "odd/place/fallback.cjs": 'require("@fallback");',
    "odd/place/negative.ts": 'import "@app/order"; import "@ambiguous"; import "@tie/Orderend"; import "@other/Order"; import "Order"; import "@app/../../../outside";',
    "outside.ts": moduleText,
    "elsewhere.ts": 'import "@app/Order";',
  });
  assert.deepEqual(await p.incoming("domain/Order.ts"), ["odd/place/alias.ts", "odd/place/fallback.cjs", "odd/place/runtime.mts", "odd/place/suffix.js"]);
  assert.deepEqual(await p.incoming("specific/Order.ts"), ["odd/place/longer.ts"]);
  assert.deepEqual(await p.incoming("exact/Exact.ts"), ["odd/place/exact.ts"]);
  for (const name of ["specific/Exact.ts", "domain/Ambiguous.ts", "domain/Ambiguous.tsx", "outside.ts"]) assert.deepEqual(await p.incoming(name), []);
  // Independent compiler oracle for the supported, unambiguous configuration.
  // TypeScript is already a dev dependency; the runtime uses no external parser.
  const file = path.join(p.root, "odd/place/tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(file, ts.sys.readFile).config, ts.sys, path.dirname(file));
  for (const [specifier, expected] of [["@app/Order", "domain/Order.ts"], ["@app/special/Order", "specific/Order.ts"], ["@app/special/Exact", "exact/Exact.ts"], ["@suffix/Order/end", "domain/Order.ts"], ["@fallback", "domain/Order.ts"]]) {
    const resolved = ts.resolveModuleName(specifier!, path.join(p.root, "odd/place/alias.ts"), parsed.options, ts.sys).resolvedModule;
    assert.equal(path.relative(p.root, resolved!.resolvedFileName).replace(/\\/g, "/"), expected);
  }
});

test("baseUrl is declared explicitly, rootDir does not create aliases, and nested configs define boundaries", async (t) => {
  const p = await project(t, {
    "tsconfig.json": config({ baseUrl: "", rootDir: "/compiler/output/root", paths: { "@root": ["domain/Root.ts"] } }),
    "domain/Root.ts": moduleText,
    "domain/Root.js": moduleText,
    "domain/Bare.ts": moduleText,
    "base.ts": 'import "domain/Bare"; import "domain/Root.js"; import "@root";',
    "negative.ts": 'import "Bare"; import "node:fs";',
    "nested/jsconfig.json": config({ paths: { "@nested": ["../domain/Bare"] } }),
    "nested/use.js": 'import "@nested"; import "@root"; import "domain/Bare";',
    "both/tsconfig.json": "{}",
    "both/jsconfig.json": config({ baseUrl: ".." }),
    "both/use.js": 'import "domain/Bare"; import "@root";',
    "root-only/tsconfig.json": config({ rootDir: "../domain" }),
    "root-only/use.ts": 'import "Bare"; import "@root";',
  });
  assert.deepEqual(await p.incoming("domain/Root.ts"), ["base.ts"]);
  assert.deepEqual(await p.incoming("domain/Root.js"), ["base.ts"]);
  assert.deepEqual(await p.incoming("domain/Bare.ts"), ["base.ts", "nested/use.js"]);
});

test("local extends retains option origins and child paths replace the inherited mapping", async (t) => {
  const p = await project(t, {
    "settings/base.json": config({ paths: { "@value": ["../domain/Value"], "@parent": ["../domain/Parent"] } }),
    "app/tsconfig.json": config({}, "../settings/base"),
    "app/use.ts": 'import "@value"; import "@parent";',
    "other/tsconfig.json": config({ paths: { "@child": ["../domain/Child"] } }, "../settings/base.json"),
    "other/use.ts": 'import "@child"; import "@parent";',
    "redirect/tsconfig.json": config({ baseUrl: "./target" }, "../settings/base.json"),
    "redirect/use.ts": 'import "@value";',
    "domain/Value.ts": moduleText,
    "domain/Parent.ts": moduleText,
    "domain/Child.ts": moduleText,
    "redirect/domain/Value.ts": moduleText,
    "with-base/base.json": config({ baseUrl: "../domain", paths: { "@inherited": ["Value"] } }),
    "with-base/app/tsconfig.json": config({}, "../base.json"),
    "with-base/app/use.ts": 'import "@inherited"; import "Value";',
  });
  assert.deepEqual(await p.incoming("domain/Value.ts"), ["app/use.ts", "with-base/app/use.ts"]);
  assert.deepEqual(await p.incoming("domain/Parent.ts"), ["app/use.ts"]);
  assert.deepEqual(await p.incoming("domain/Child.ts"), ["other/use.ts"]);
  assert.deepEqual(await p.incoming("redirect/domain/Value.ts"), ["redirect/use.ts"]);
  const file = path.join(p.root, "redirect/tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(file, ts.sys.readFile).config, ts.sys, path.dirname(file));
  assert.equal(path.relative(p.root, ts.resolveModuleName("@value", path.join(p.root, "redirect/use.ts"), parsed.options, ts.sys).resolvedModule!.resolvedFileName).replace(/\\/g, "/"), "redirect/domain/Value.ts");
});

test("known config and dependency changes refresh references without source extraction or snapshot writes", async (t) => {
  const p = await project(t, {
    "app/tsconfig.json": config({}, "../settings/base.json"),
    "settings/base.json": config({ paths: { "@value": ["../domain/First"] } }),
    "app/use.ts": 'import "@value";',
    "domain/First.ts": moduleText,
    "domain/Other.ts": moduleText,
  });
  const snapshotBefore = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8");
  assert.deepEqual(await p.incoming("domain/First.ts"), ["app/use.ts"]);
  const stat = await fs.stat(path.join(p.root, "settings/base.json"));
  await p.write("settings/base.json", config({ paths: { "@value": ["../domain/Other"] } }));
  await fs.utimes(path.join(p.root, "settings/base.json"), stat.atime, stat.mtime);
  assert.deepEqual(await p.incoming("domain/First.ts"), []);
  assert.deepEqual(await p.incoming("domain/Other.ts"), ["app/use.ts"]);
  await fs.unlink(path.join(p.root, "settings/base.json"));
  assert.deepEqual(await p.incoming("domain/Other.ts"), []);
  assert.deepEqual(await p.index.projectStructureWarnings(), [{ path: "settings/base.json", reason: "missing_manifest" }]);
  await p.write("settings/next.json", config({ paths: { "@value": ["../domain/First"] } }));
  await p.write("app/tsconfig.json", config({}, "../settings/next.json"));
  assert.deepEqual(await p.incoming("domain/First.ts"), ["app/use.ts"]);
  assert.deepEqual(await p.index.projectStructureWarnings(), []);
  assert.equal(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot), "utf8"), snapshotBefore);
});

test("unsupported, cyclic and escaping extends report diagnostics while relative imports keep working", async (t) => {
  const p = await project(t, {
    "target.ts": moduleText,
    "remote/tsconfig.json": config({ paths: { "@value": ["../target"] } }, "@vendor/base"),
    "array/tsconfig.json": JSON.stringify({ extends: ["../base.json"] }),
    "escape/tsconfig.json": config({}, "../../outside.json"),
    "cycle/tsconfig.json": config({}, "./tsconfig.json"),
    "deep/tsconfig.json": config({}, "../settings/base.json"),
    "settings/base.json": config({}, "./deeper.json"),
    "missing/tsconfig.json": config({}, "../absent.json"),
    "invalid/tsconfig.json": "{/* incomplete",
    "remote/use.ts": 'import "@value"; import "../target.ts";',
    "array/use.ts": 'import "@value";',
    "escape/use.ts": 'import "@value";',
    "cycle/use.ts": 'import "@value";',
    "deep/use.ts": 'import "@value";',
    "missing/use.ts": 'import "@value";',
    "invalid/use.ts": 'import "@value";',
  });
  assert.deepEqual(await p.incoming("target.ts"), ["remote/use.ts"]);
  const warnings = await p.index.projectStructureWarnings();
  for (const file of ["remote", "array", "escape", "invalid"]) assert.ok(warnings.some((warning) => warning.path === `${file}/tsconfig.json` && warning.reason === "invalid_manifest"));
  for (const file of ["cycle", "deep"]) assert.ok(warnings.some((warning) => warning.path === `${file}/tsconfig.json` && warning.reason === "manifest_reference_depth"));
  assert.ok(warnings.some((warning) => warning.path === "absent.json" && warning.reason === "missing_manifest"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "kr-config-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "base.json"), config({ paths: { "@value": ["target.ts"] } }));
  await fs.symlink(path.join(outside, "base.json"), path.join(p.root, "absent.json"));
  assert.ok((await p.index.projectStructureWarnings()).some((warning) => warning.path === "absent.json" && warning.reason === "outside_repository"));
});

test("new nested JS config is discovered by explicit manifest update with source fragments reused", async (t) => {
  const p = await project(t, {
    "target.ts": moduleText,
    "nested/use.ts": 'import "@value";',
  });
  assert.deepEqual(await p.incoming("target.ts"), []);
  await p.write("nested/tsconfig.json", config({ paths: { "@value": ["../target"] } }));
  assert.deepEqual(await p.incoming("target.ts"), []);
  const updated = await p.index.updateFile("nested/tsconfig.json");
  assert.equal(updated.reparsedFiles, 0);
  assert.equal(updated.reusedFiles, 2);
  assert.deepEqual(await p.incoming("target.ts"), ["nested/use.ts"]);
});
