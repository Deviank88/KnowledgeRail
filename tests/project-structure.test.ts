import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { codeEvidenceIndexFile, getCodeQueryCacheDiagnostics, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { GoKnowledgeAdapter } from "../src/core/code-evidence/language-adapters.js";
import { GO_MODULE_MANIFEST } from "../src/core/code-evidence/import-resolution/go.js";
import { MAX_PROJECT_MANIFEST_BYTES, ProjectStructureReader } from "../src/core/code-evidence/project-structure.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { setWikiRoot } from "../src/core/paths.js";
import { registerCodeEvidenceTools } from "../src/tools/code-evidence-tools.js";
import type { McpServer } from "@modelcontextprotocol/server";

async function project(t: TestContext, files: Record<string, string>, adapter = new GoKnowledgeAdapter()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-project-structure-"));
  const wikiRoot = path.join(root, "wiki");
  const registry = new KnowledgeAdapterRegistry([adapter]);
  const write = async (name: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  };
  for (const [name, content] of Object.entries(files)) await write(name, content);
  const index = () => new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, registry });
  await index().rebuild();
  const snapshot = await index().snapshot();
  const incoming = async (name: string) => {
    const target = snapshot.fragments.find((fragment) => fragment.path === name && fragment.kind === "module" && fragment.qualifiedName === name)!;
    assert.ok(target, name);
    return [...new Set((await index().references(target.id, { maxResults: 100 })).filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
  };
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot, registry, index, incoming, write, snapshot };
}

test("Go uses declared module identities in arbitrary directories, excluding external same-suffix imports", async (t) => {
  const { incoming } = await project(t, {
    "unusual/backend/go.mod": "// project identity\r\nmodule \"example.com/local\" // note\r\ngo 1.22\r\n",
    "unusual/backend/internal/orders/create.go": "package orders\nfunc Create() {}",
    "unusual/backend/internal/orders/cancel.go": "package orders\nfunc Cancel() {}",
    "unusual/backend/internal/orders/orders_test.go": "package orders\nfunc TestCreate() {}",
    "unusual/backend/entry/main.go": 'package main\nimport "example.com/local/internal/orders"\nfunc main() {}',
    "unusual/backend/entry/external.go": 'package main\nimport "example.net/remote/internal/orders"\nimport "example.com/locality/internal/orders"\nfunc other() {}',
  });
  for (const target of ["create.go", "cancel.go"]) assert.deepEqual(await incoming(`unusual/backend/internal/orders/${target}`), ["unusual/backend/entry/main.go"]);
  assert.deepEqual(await incoming("unusual/backend/internal/orders/orders_test.go"), []);
});

test("nested Go modules retain their own boundaries and do not infer cross-module dependencies", async (t) => {
  const { incoming } = await project(t, {
    "go.mod": "module example.com/app\n",
    "internal/orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/app/internal/orders"\nimport "example.com/app/plugins/nested/internal/orders"\nimport "example.com/nested/internal/orders"',
    "plugins/nested/go.mod": "module example.com/nested\n",
    "plugins/nested/internal/orders/create.go": "package orders\nfunc Create() {}",
    "plugins/nested/main.go": 'package main\nimport "example.com/nested/internal/orders"\nimport "example.com/app/internal/orders"',
  });
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"]);
  assert.deepEqual(await incoming("plugins/nested/internal/orders/create.go"), ["plugins/nested/main.go"]);
});

test("known manifest edits, atomic replacement and recreation invalidate imports without reparsing code or writing snapshots", async (t) => {
  const adapter = new GoKnowledgeAdapter();
  const { root, wikiRoot, incoming, write } = await project(t, {
    "go.mod": "module example.com/alpha\n",
    "internal/orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/alpha/internal/orders"',
  }, adapter);
  t.mock.method(adapter, "extract", () => { throw new Error("Source reparse on query"); });
  const snapshotBefore = await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8");
  const manifest = path.join(root, "go.mod");
  const date = new Date("2026-01-01T00:00:00Z");
  await fs.utimes(manifest, date, date);
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"]);
  await write("go.mod", "module example.com/bravo\n");
  await fs.utimes(manifest, date, date);
  assert.deepEqual(await incoming("internal/orders/create.go"), []);
  await write("replacement", "module example.com/alpha\n");
  await fs.rename(path.join(root, "replacement"), manifest);
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"]);
  await fs.unlink(manifest);
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"], "manifest-free compatibility remains available");
  await write("go.mod", "module example.com/bravo\n");
  assert.deepEqual(await incoming("internal/orders/create.go"), []);
  assert.equal(await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8"), snapshotBefore);
});

test("new nested manifests are discovered through targeted update and rebuild with unchanged source fragments", async (t) => {
  const adapter = new GoKnowledgeAdapter();
  const { root, incoming, write, index, snapshot } = await project(t, {
    "go.mod": "module example.com/app\n",
    "internal/orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/app/internal/orders"',
  }, adapter);
  t.mock.method(adapter, "extract", () => { throw new Error("Unchanged sources must be reused"); });
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"]);
  await write("internal/go.mod", "module example.com/nested\n");
  const update = await index().updateFile("internal/go.mod");
  assert.equal(update.reparsedFiles, 0);
  assert.equal(update.reusedFiles, snapshot.files.length);
  assert.deepEqual(await incoming("internal/orders/create.go"), []);
  assert.deepEqual((await index().snapshot()).fragments, snapshot.fragments);
  await fs.unlink(path.join(root, "internal/go.mod"));
  await index().removeFile("internal/go.mod");
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"]);
  await write("internal/go.mod", "module example.com/nested\n");
  await index().rebuild();
  assert.deepEqual(await incoming("internal/orders/create.go"), []);
  await assert.rejects(index().updateFile("../go.mod"), /outside|escape/i);
});

test("a root manifest added to a legacy project is detected on the next reference query", async (t) => {
  const { incoming, write } = await project(t, {
    "internal/orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.net/external/internal/orders"',
  });
  assert.deepEqual(await incoming("internal/orders/create.go"), ["main.go"]);
  await write("go.mod", "module example.com/local\n");
  assert.deepEqual(await incoming("internal/orders/create.go"), []);
});

test("manifest parsing is lazy, shared by concurrent queries and stable for unchanged bytes", async (t) => {
  let parses = 0;
  class Counting extends GoKnowledgeAdapter {
    override readonly projectManifests = [{ ...GO_MODULE_MANIFEST, parse(text: string) { parses++; return GO_MODULE_MANIFEST.parse(text); } }];
  }
  const { incoming, index, write } = await project(t, {
    "go.mod": "module example.com/app\n",
    "orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/app/orders"',
  }, new Counting());
  await index().symbol("Create");
  await index().search("orders");
  assert.equal(parses, 0);
  assert.ok((await Promise.all(Array.from({ length: 12 }, () => incoming("orders/create.go")))).every((paths) => paths.join() === "main.go"));
  assert.equal(parses, 1);
  await incoming("orders/create.go");
  assert.equal(parses, 1);
  await write("go.mod", "module example.com/app\n");
  assert.deepEqual(await incoming("orders/create.go"), ["main.go"]);
  assert.equal(parses, 2);
});

test("invalid, oversized, directory and external-symlink manifests produce diagnostics, not guessed imports", async (t) => {
  const { root, incoming, index, write } = await project(t, {
    "go.mod": "module example.com/app\nmodule example.com/other\n",
    "orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/app/orders"',
  });
  const check = async (reason: string) => {
    assert.deepEqual(await incoming("orders/create.go"), []);
    assert.deepEqual(await index().projectStructureWarnings(), [{ path: "go.mod", reason }]);
  };
  await check("invalid_manifest");
  await write("go.mod", "x".repeat(MAX_PROJECT_MANIFEST_BYTES + 1));
  await check("size_limit");
  await fs.unlink(path.join(root, "go.mod"));
  await fs.mkdir(path.join(root, "go.mod"));
  await check("not_regular_file");
  await fs.rmdir(path.join(root, "go.mod"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "kr-outside-manifest-"));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, "go.mod"), "module example.com/app\n");
  await fs.symlink(path.join(external, "go.mod"), path.join(root, "go.mod"));
  await check("outside_repository");
  await fs.unlink(path.join(root, "go.mod"));
  await fs.symlink(path.join(root, "missing.mod"), path.join(root, "go.mod"));
  await check("unreadable_manifest");
  await fs.unlink(path.join(root, "go.mod"));
  await write("go.mod", "module example.com/app\n");
  assert.deepEqual(await incoming("orders/create.go"), ["main.go"]);
  assert.deepEqual(await index().projectStructureWarnings(), []);
});

test("manifest identity depends on project bytes and relative paths, not directory order or machine root", async (t) => {
  const files = { "go.mod": "module example.com/app\n", "a/create.go": "package a\nfunc Create() {}", "b/create.go": "package b\nfunc Create() {}" };
  const first = await project(t, files);
  const second = await project(t, files);
  const a = new ProjectStructureReader(first.root, ["a/create.go", "b/create.go"], first.registry);
  const b = new ProjectStructureReader(second.root, ["b/create.go", "a/create.go"], second.registry);
  assert.equal((await a.load()).identity, (await b.load()).identity);
  await assert.rejects(async () => new ProjectStructureReader(first.root, ["../outside.go"], first.registry).load(), /repository-relative/);
});

test("manifest retention shares the existing per-project admission limit without losing query results", async (t) => {
  class LargeManifest extends GoKnowledgeAdapter {
    override readonly projectManifests = [{ ...GO_MODULE_MANIFEST, parse(content: string) {
      return { ...(GO_MODULE_MANIFEST.parse(content) as object), extra: "x".repeat(9 * 1024 * 1024) };
    } }];
  }
  const files = {
    "go.mod": "module example.com/app\n",
    "orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/app/orders"',
  };
  const small = await project(t, files);
  const large = await project(t, files, new LargeManifest());
  assert.deepEqual(await small.incoming("orders/create.go"), ["main.go"]);
  assert.deepEqual(await large.incoming("orders/create.go"), ["main.go"]);
  assert.equal(getCodeQueryCacheDiagnostics(large.wikiRoot).cached, false);
  assert.equal(getCodeQueryCacheDiagnostics(small.wikiRoot).cached, true);
});

test("MCP references expose bounded manifest warnings alongside usable references", async (t) => {
  const files: Record<string, string> = {
    "go.mod": "module example.com/app\n",
    "orders/create.go": "package orders\nfunc Create() {}",
    "main.go": 'package main\nimport "example.com/app/orders"',
  };
  for (let i = 0; i < 15; i++) {
    files[`broken${i}/go.mod`] = "module\n";
    files[`broken${i}/main.go`] = "package main\nfunc main() {}";
  }
  const { root, wikiRoot } = await project(t, files);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
  await index.rebuild();
  const target = (await index.snapshot()).fragments.find((fragment) => fragment.path === "orders/create.go" && fragment.kind === "module")!;
  setWikiRoot(root);
  type Result = { isError?: boolean; structuredContent?: { references: unknown[]; manifestWarnings: unknown[]; manifestWarningCount: number }; content: Array<{ type: string; text?: string }> };
  let handler!: (args: Record<string, unknown>) => Promise<Result>;
  registerCodeEvidenceTools({ registerTool(_name: string, _config: unknown, callback: typeof handler) { handler = callback; } } as unknown as McpServer);
  const result = await handler({ action: "references", symbol_id: target.id });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent!.references.length > 0);
  assert.equal(result.structuredContent!.manifestWarningCount, 15);
  assert.equal(result.structuredContent!.manifestWarnings.length, 12);
  assert.match(result.content[0]!.text!, /Project manifest warning/);
});
