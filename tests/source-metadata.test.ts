import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { codeEvidenceIndexFile, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { ApexKnowledgeAdapter } from "../src/core/code-evidence/language-adapters.js";
import { KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import type { KnowledgeFragment, ProjectStructure } from "../src/core/code-evidence/types.js";
import { applyApexStatuses } from "../src/core/code-evidence/import-resolution/salesforce-config.js";

test("Apex companion refresh preserves deployment metadata owned by other languages", async () => {
  const source = { repositoryRoot: tmpdir(), path: "feature.ts", content: "export function feature() {}" };
  const typescript = (await new TypeScriptKnowledgeAdapter().extract(source)).map((fragment) => ({ ...fragment, deploymentStatus: "Inactive" as const }));
  const apex = (await new ApexKnowledgeAdapter().extract({ ...source, path: "Controller.CLS", content: "public class Controller {}" }))
    .map((fragment) => ({ ...fragment, deploymentStatus: "Active" as const }));
  assert.ok(typescript.length > 0 && apex.length > 0);
  const fragments = [...typescript, ...apex];
  const empty: ProjectStructure = { identity: "empty", manifests: new Map(), warnings: [] };
  const removed = applyApexStatuses(fragments, empty);
  assert.deepEqual(removed.filter((fragment) => fragment.path === source.path), typescript);
  assert.ok(removed.filter((fragment) => fragment.path === "Controller.CLS").every((fragment) => fragment.deploymentStatus === undefined));
  const foreign: ProjectStructure = { ...empty, manifests: new Map([["feature.ts-meta.xml", {
    path: "feature.ts-meta.xml", fileName: "custom-status", value: { status: "Active" },
  }]]) };
  assert.deepEqual(applyApexStatuses(fragments, foreign).filter((fragment) => fragment.path === source.path), typescript);
  assert.ok(fragments.every((fragment) => fragment.deploymentStatus !== undefined), "source records remain unchanged");
});

test("persisted companion enrichment is adapter-owned and works without Salesforce", async (t) => {
  class DocumentedTypeScript extends TypeScriptKnowledgeAdapter {
    readonly sourceMetadataVersion = "documented-typescript-v1";
    override readonly projectManifests = [{ fileName: "source.info.json",
      companion: { extensions: [".ts"], suffix: ".info.json" }, parse: (content: string) => JSON.parse(content) as unknown }];
    enrichSourceMetadata(fragments: readonly KnowledgeFragment[], structure: ProjectStructure) {
      return fragments.map((fragment) => {
        const value = structure.manifests.get(`${fragment.path}.info.json`)?.value as { configKey?: string } | undefined;
        return { ...fragment, configKeys: typeof value?.configKey === "string" ? [value.configKey] : [] };
      });
    }
  }
  const root = await fs.mkdtemp(join(tmpdir(), "kr-generic-companion-"));
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  const wikiRoot = join(root, "wiki"), registry = new KnowledgeAdapterRegistry([new DocumentedTypeScript()]);
  const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, registry });
  await fs.writeFile(join(root, "settings.ts"), "export function region() { return 'eu'; }");
  await fs.writeFile(join(root, "settings.ts.info.json"), '{"configKey":"REGION"}');
  await index().rebuild();
  const before = await index().snapshot();
  assert.deepEqual(before.sourceMetadata?.manifests.map((m) => m.path), ["settings.ts.info.json"]);
  await fs.writeFile(join(root, "settings.ts.info.json"), '{"configKey":"DEFAULT_REGION"}');
  clearWorkspaceStates();
  assert.deepEqual((await index().symbol("region"))[0]!.fragment.configKeys, ["REGION"]);
  assert.equal((await index().updateFile("settings.ts.info.json")).reparsedFiles, 0);
  clearWorkspaceStates();
  assert.deepEqual((await index().symbol("region"))[0]!.fragment.configKeys, ["DEFAULT_REGION"]);
  assert.deepEqual((await index().snapshot()).fragments, before.fragments);
  await fs.unlink(join(root, "settings.ts.info.json"));
  await index().removeFile("settings.ts.info.json");
  clearWorkspaceStates();
  assert.deepEqual((await index().symbol("region"))[0]!.fragment.configKeys, []);
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-source-metadata-"));
  const wikiRoot = join(root, "wiki"), sidecar = join(root, "Controller.cls-meta.xml");
  await fs.writeFile(join(root, "Controller.cls"), "public class Controller {\n public static void run() {}\n}");
  await fs.writeFile(sidecar, "<ApexClass><status>Active</status></ApexClass>");
  const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index().rebuild();
  const status = async () => (await index().symbol("Controller"))[0]!.fragment.deploymentStatus;
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot, sidecar, index, status };
}

test("explicit indexing persists metadata; cold queries do not read sidecars or rewrite old snapshots", async (t) => {
  const p = await fixture(t);
  const file = codeEvidenceIndexFile(p.wikiRoot), snapshot = await p.index().snapshot();
  assert.ok(snapshot.sourceMetadata?.manifests.some((m) => m.path === "Controller.cls-meta.xml"));
  const before = await fs.readFile(file);
  await fs.writeFile(p.sidecar, "<ApexClass><status>Inactive</status></ApexClass>");
  clearWorkspaceStates();
  const promises = (await import("node:fs/promises")).default;
  const original = promises.lstat;
  let reads = 0;
  t.mock.method(promises, "lstat", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === p.sidecar) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await p.status(), "Active", "explicit refresh defines freshness, even before the first query");
  assert.equal(reads, 0);
  assert.deepEqual(await fs.readFile(file), before);
  delete snapshot.sourceMetadata;
  await fs.writeFile(file, JSON.stringify(snapshot));
  const legacyBytes = await fs.readFile(file);
  clearWorkspaceStates();
  assert.equal(await p.status(), "Inactive");
  assert.equal(reads, 1);
  assert.deepEqual(await fs.readFile(file), legacyBytes, "fallback never migrates on read");
});

test("sidecar add, edit, deletion, invalid XML and absent status preserve source identities", async (t) => {
  const p = await fixture(t);
  const before = await p.index().snapshot();
  for (const [content, expected] of [
    ["<ApexClass><status>Inactive</status></ApexClass>", "Inactive"],
    ["<ApexClass><status>Deleted</status></ApexClass>", "Deleted"],
    ["<ApexClass>", undefined],
    ["<ApexClass><status>invalid</status></ApexClass>", undefined],
    ["<ApexClass></ApexClass>", undefined],
    [null, undefined],
    ["<ApexClass><status>Active</status></ApexClass>", "Active"],
  ] as const) {
    if (content === null) await fs.unlink(p.sidecar);
    else await fs.writeFile(p.sidecar, content);
    const update = content === null ? await p.index().removeFile("Controller.cls-meta.xml") : await p.index().updateFile("Controller.cls-meta.xml");
    assert.equal(update.reparsedFiles, 0);
    clearWorkspaceStates();
    assert.equal(await p.status(), expected);
    const snapshot = await p.index().snapshot();
    assert.deepEqual(snapshot.files, before.files);
    assert.deepEqual(snapshot.fragments, before.fragments);
  }
  await fs.unlink(join(p.root, "Controller.cls"));
  await p.index().removeFile("Controller.cls");
  assert.deepEqual((await p.index().snapshot()).sourceMetadata?.manifests, []);
});

test("corrupt or incompatible projections fall back without stale status or writes", async (t) => {
  const p = await fixture(t), file = codeEvidenceIndexFile(p.wikiRoot);
  const snapshot = await p.index().snapshot();
  await fs.unlink(p.sidecar);
  for (const invalid of [null, { version: 999 }, { ...snapshot.sourceMetadata, manifests: [null] },
    { ...snapshot.sourceMetadata, adapterSignature: "old" }, { ...snapshot.sourceMetadata, warnings: [{}] }]) {
    await fs.writeFile(file, JSON.stringify({ ...snapshot, fragments: snapshot.fragments.map((f) => ({ ...f, deploymentStatus: "Active" })), sourceMetadata: invalid }));
    const before = await fs.readFile(file);
    clearWorkspaceStates();
    assert.equal(await p.status(), undefined);
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test("unchanged source updates refresh companion state, including concurrent explicit writes", async (t) => {
  const p = await fixture(t);
  const before = await p.index().snapshot();
  await fs.writeFile(p.sidecar, "<ApexClass><status>Inactive</status></ApexClass>");
  const reports = await Promise.all([p.index().updateFile("Controller.cls"), p.index().updateFile("Controller.cls-meta.xml")]);
  assert.ok(reports.every((r) => r.reparsedFiles === 0));
  assert.equal(await p.status(), "Inactive");
  assert.deepEqual((await p.index().snapshot()).files, before.files);
  assert.deepEqual((await p.index().snapshot()).fragments, before.fragments);
});

test("adapter enrichment-version changes invalidate persisted metadata independently of parser version", async (t) => {
  const p = await fixture(t);
  const snapshot = await p.index().snapshot();
  await fs.writeFile(p.sidecar, "<ApexClass><status>Inactive</status></ApexClass>");
  const adapter = new ApexKnowledgeAdapter();
  Object.defineProperty(adapter, "sourceMetadataVersion", { value: `${adapter.sourceMetadataVersion}-next` });
  const runtime = new CodeQueryRuntime(snapshot, new KnowledgeAdapterRegistry([adapter]));
  await runtime.refreshSourceMetadata(p.root);
  assert.ok(runtime.snapshot.fragments.every((f) => f.deploymentStatus === "Inactive"));
  assert.equal(snapshot.fragments[0]!.deploymentStatus, undefined, "enrichment does not mutate source evidence");
});

test("a sidecar changed during reading publishes an explicit warning instead of a mixed status", async (t) => {
  const p = await fixture(t);
  const realSidecar = await fs.realpath(p.sidecar);
  const promises = (await import("node:fs/promises")).default;
  const open = promises.open;
  let changed = false;
  t.mock.method(promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === realSidecar && !changed) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...values: Parameters<typeof handle.read>) => {
        const result = await read(...values);
        if (!changed) {
          changed = true;
          await fs.writeFile(p.sidecar, "<ApexClass><status>Inactive</status></ApexClass>");
        }
        return result;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await p.index().updateFile("Controller.cls-meta.xml");
  assert.equal(changed, true);
  assert.equal(await p.status(), undefined);
  assert.ok((await p.index().snapshot()).sourceMetadata?.warnings.some((w) => w.reason === "changed_during_read"));
  await p.index().updateFile("Controller.cls-meta.xml");
  assert.equal(await p.status(), "Inactive");
});
