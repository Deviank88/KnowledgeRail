import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createDefaultKnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

test("real adapter imports resolve explicit extensions and JS/TS conventions without guessing packages or aliases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-imports-"));
  const files: Record<string, string> = {
    "lib/Module.ts": "export const value = 1;",
    "other/Module.ts": "export const value = 2;",
    "lib/Ambiguous.ts": "export const value = 1;",
    "lib/Ambiguous.tsx": "export const value = 2;",
    "lib/Exact.js": "export const value = 1;",
    "lib/Exact.ts": "export const value = 2;",
    "lib/Folder/index.ts": "export const value = 1;",
    "lib/Esm.mts": "export const value = 1;",
    "lib/Common.cts": "export const value = 1;",
    "lib/Component.tsx": "export const value = 1;",
    "lib/dotted.name.ts": "export const value = 1;",
    "lib/Upper.TS": "export const value = 1;",
    "src/explicit.ts": 'import "../lib/Module.ts";',
    "src/runtime.ts": 'import "../lib/Module.js";',
    "src/extensionless.ts": 'import { value as renamed } from "../lib/Module";',
    "src/require.cjs": 'const lib = require("../lib/Module.js");',
    "src/negative.ts": 'import "lib/Module.ts"; import "@alias/Module"; import "Module"; import "../lib/module.ts"; import "../lib/Module.json"; import "../../Module.ts";',
    "src/other.ts": 'import "../other/Module.ts";',
    "src/ambiguous.ts": 'import "../lib/Ambiguous"; import "../lib/Ambiguous.js";',
    "src/exact.ts": 'import "../lib/Exact.js";',
    "src/folder.ts": 'import "../lib/Folder";',
    "src/esm.mts": 'import "../lib/Esm.mjs";',
    "src/common.cts": 'import "../lib/Common.cjs";',
    "src/component.tsx": 'import "../lib/Component.jsx";',
    "src/dotted.ts": 'import "../lib/dotted.name.ts";',
    "src/upper.ts": 'import "../lib/Upper.TS";',
    "src/upper-negative.ts": 'import "../lib/Upper.ts"; import "../lib/upper.TS";',
  };
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: path.join(root, "wiki") });
    await index.rebuild();
    const snapshot = await index.snapshot();
    const incoming = async (name: string) => {
      const target = snapshot.fragments.find((fragment) => fragment.kind === "module" && fragment.path === name)!;
      assert.ok(target, `adapter emits module ${name}`);
      return [...new Set((await index.references(target.id, { maxResults: 100 })).filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
    };
    assert.deepEqual(await incoming("lib/Module.ts"), ["src/explicit.ts", "src/extensionless.ts", "src/require.cjs", "src/runtime.ts"]);
    assert.deepEqual(await incoming("other/Module.ts"), ["src/other.ts"]);
    assert.deepEqual(await incoming("lib/Ambiguous.ts"), []);
    assert.deepEqual(await incoming("lib/Ambiguous.tsx"), []);
    assert.deepEqual(await incoming("lib/Exact.js"), ["src/exact.ts"]);
    assert.deepEqual(await incoming("lib/Exact.ts"), []);
    assert.deepEqual(await incoming("lib/Upper.TS"), ["src/upper.ts"]);
    for (const [target, source] of [["Folder/index.ts", "folder.ts"], ["Esm.mts", "esm.mts"], ["Common.cts", "common.cts"], ["Component.tsx", "component.tsx"], ["dotted.name.ts", "dotted.ts"]]) {
      assert.deepEqual(await incoming(`lib/${target}`), [`src/${source}`]);
    }
  } finally {
    clearWorkspaceStates();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Python flat-layout imports retain both the importing module and function", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-python-imports-"));
  try {
    await fs.writeFile(path.join(root, "orders.py"), "def place_order():\n    return 1\n");
    await fs.writeFile(path.join(root, "service.py"), "from orders import place_order\n\ndef run():\n    return place_order()\n");
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: path.join(root, "wiki") });
    await index.rebuild();
    const target = (await index.snapshot()).fragments.find((fragment) => fragment.kind === "module" && fragment.path === "orders.py")!;
    assert.ok(target);
    const references = await index.references(target.id);
    assert.deepEqual(references.map((hit) => [hit.source.path, hit.source.kind, hit.relation]), [
      ["service.py", "module", "import"], ["service.py", "function", "import"],
    ]);
  } finally {
    clearWorkspaceStates();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Python src-layout imports resolve sibling modules, dotted packages and stubs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-python-src-"));
  const files: Record<string, string> = {
    "src/orders_cli.py": "def main():\n    return 1\n",
    "src/cli.py": "from orders_cli import main\n",
    "src/pkg/__init__.py": "value = 1\n",
    "src/pkg/orders.py": "value = 2\n",
    "src/package_user.py": "from pkg import value\nimport pkg.orders as orders\n",
    "src/stub_only.pyi": "value: int\n",
    "src/paired.py": "value = 1\n",
    "src/paired.pyi": "value: int\n",
    "src/stub_user.py": "from stub_only import value\nfrom paired import value\n",
    "root_user.py": "from orders_cli import main\n", // No arbitrary src/ inference from the root.
  };
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: path.join(root, "wiki") });
    await index.rebuild();
    const snapshot = await index.snapshot();
    const incoming = async (name: string) => {
      const target = snapshot.fragments.find((fragment) => fragment.path === name && fragment.kind === "module");
      assert.ok(target, `Python adapter emits module ${name}`);
      return (await index.references(target.id, { maxResults: 100 }))
        .filter((hit) => hit.relation === "import").map((hit) => hit.source.path);
    };
    assert.deepEqual(await incoming("src/orders_cli.py"), ["src/cli.py"]);
    assert.deepEqual(await incoming("src/pkg/__init__.py"), ["src/package_user.py"]);
    assert.deepEqual(await incoming("src/pkg/orders.py"), ["src/package_user.py"]);
    assert.deepEqual(await incoming("src/stub_only.pyi"), ["src/stub_user.py"]);
    assert.deepEqual(await incoming("src/paired.py"), ["src/stub_user.py"]);
    assert.deepEqual(await incoming("src/paired.pyi"), []);
  } finally {
    clearWorkspaceStates();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Python scripts resolve their own directory and reject relative imports without a package", async () => {
  const registry = createDefaultKnowledgeAdapterRegistry();
  const files: Record<string, string> = {
    "orders.py": "value = 1\n",
    "src/orders.py": "value = 2\n",
    "package.py": "value = 1\n",
    "src/package/__init__.py": "value = 2\n",
    "stub_only.py": "value = 1\n",
    "src/stub_only.pyi": "value: int\n",
    "src/ambiguous.py": "value = 1\n",
    "src/ambiguous/__init__.py": "value = 2\n",
    "src/absolute.py": "from orders import value\nfrom package import value\nfrom stub_only import value\nfrom ambiguous import value\n",
    "src/relative.py": "from .orders import value\n",
    "root_user.py": "from orders import value\n",
  };
  const fragments = (await Promise.all(Object.entries(files).map(([name, content]) =>
    registry.resolve({ path: name })!.extract({ repositoryRoot: "/fixture", path: name, content })
  ))).flat();
  const runtime = new CodeQueryRuntime({ version: 2, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments });
  for (const name of Object.keys(files).filter((name) => !name.endsWith("absolute.py") && !name.endsWith("relative.py") && name !== "root_user.py")) {
    const target = fragments.find((fragment) => fragment.path === name && fragment.kind === "module");
    assert.ok(target, `Python adapter emits module ${name}`);
    const expected = name === "orders.py" ? ["root_user.py"] :
      ["src/orders.py", "src/package/__init__.py", "src/stub_only.pyi"].includes(name) ? ["src/absolute.py"] : [];
    assert.deepEqual(runtime.references(target.id, {}, 100).filter((hit) => hit.relation === "import")
      .map((hit) => hit.source.path), expected, `unambiguous edges to ${name}`);
  }
});

test("Python dotted and relative imports resolve one module or package without basename guesses", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-python-packages-"));
  const files: Record<string, string> = {
    "pyproject.toml": '[tool.setuptools]\npackage-dir={""="."}\n',
    "orders.py": "def root_order():\n    return 1\n",
    "pkg/__init__.py": "package_value = 1\n",
    "pkg/orders.py": "def place_order():\n    return 2\n",
    "pkg/nested/__init__.py": "nested_value = 1\n",
    "pkg/nested/service.py": "from ..orders import place_order\ndef run():\n    return place_order()\n",
    "pkg/sibling.py": "from .orders import place_order as send\ndef run():\n    return send()\n",
    "pkg/package_user.py": "from . import package_value\n",
    "dotted.py": "import pkg.orders as invoice_module\n",
    "package_user.py": "from pkg import package_value\n",
    "ambiguous.py": "value = 1\n",
    "ambiguous/__init__.py": "value = 2\n",
    "ambiguous_user.py": "from ambiguous import value\n",
    "nested_only/external.py": "value = 1\n",
    "negative.py": "from external import value\nfrom missing.orders import absent\nfrom Pkg.orders import absent\n",
    "pkg/escape.py": "from ..orders import root_order\n",
    "relative_at_root.py": "from .orders import root_order\n",
    "stub_only.pyi": "def stub(): ...\n",
    "stub_user.py": "from stub_only import stub\n",
    "paired.py": "value = 1\n",
    "paired.pyi": "value: int\n",
    "paired_user.py": "from paired import value\n",
    "tests/test_orders.py": "from orders import root_order\ndef test_run():\n    return root_order()\n",
    "root_user.py": "from orders import root_order\n",
  };
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: path.join(root, "wiki") });
    await index.rebuild();
    const snapshot = await index.snapshot();
    const targetId = (name: string) => {
      const target = snapshot.fragments.find((fragment) => fragment.path === name && fragment.kind === "module");
      assert.ok(target, `Python adapter emits module ${name}`);
      return target.id;
    };
    const incoming = async (name: string) => [...new Set((await index.references(targetId(name), { maxResults: 100 }))
      .filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
    assert.deepEqual(await incoming("pkg/orders.py"), ["dotted.py", "pkg/nested/service.py", "pkg/sibling.py"]);
    assert.deepEqual(await incoming("pkg/__init__.py"), ["package_user.py", "pkg/package_user.py"]);
    assert.deepEqual(await incoming("orders.py"), ["root_user.py", "tests/test_orders.py"]);
    for (const name of ["ambiguous.py", "ambiguous/__init__.py", "nested_only/external.py", "paired.pyi"]) {
      assert.deepEqual(await incoming(name), [], `no guessed edge to ${name}`);
    }
    assert.deepEqual(await incoming("stub_only.pyi"), ["stub_user.py"]);
    assert.deepEqual(await incoming("paired.py"), ["paired_user.py"]);
    assert.equal((await index.references(targetId("orders.py"), { maxResults: 1 }))[0]?.source.path, "tests/test_orders.py");
    assert.deepEqual((await index.references(targetId("orders.py"), { paths: ["root_user.py"] })).map((hit) => hit.source.path), ["root_user.py"]);

    // The same module names in a second project must build a separate inventory.
    const otherRoot = path.join(root, "other-project");
    await fs.mkdir(otherRoot);
    await fs.writeFile(path.join(otherRoot, "orders.py"), "def root_order():\n    return 9\n");
    await fs.writeFile(path.join(otherRoot, "other_user.py"), "from orders import root_order\n");
    const other = new PersistentCodeEvidenceIndex({ repositoryRoot: otherRoot, wikiRoot: path.join(otherRoot, "wiki") });
    await other.rebuild();
    const otherTarget = (await other.snapshot()).fragments.find((fragment) => fragment.path === "orders.py" && fragment.kind === "module")!;
    assert.deepEqual((await other.references(otherTarget.id)).map((hit) => hit.source.path), ["other_user.py"]);
    assert.deepEqual(await incoming("orders.py"), ["root_user.py", "tests/test_orders.py"]);
  } finally {
    clearWorkspaceStates();
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("file module references do not use consumed database names as aliases for the file", async () => {
  const registry = createDefaultKnowledgeAdapterRegistry();
  for (const [targetPath, targetContent, sourcePath, sourceContent, negativePath, negativeContent] of [
    ["reader.ts", 'export function read() { throw new Error("update the index"); }\nexport const query = "SELECT id FROM orders";',
      "caller.ts", 'import { read } from "./reader.js";\nexport function run(the: string) { read(); return the; }',
      "unrelated.ts", 'export const query = "SELECT id FROM orders";\nexport const the = 1;'],
    ["reader.py", 'def read():\n    return "SELECT id FROM orders"\n',
      "caller.py", 'from reader import read\n\ndef run():\n    return read()\n',
      "unrelated.py", 'query = "SELECT id FROM orders"\n'],
  ]) {
    const fragments = [];
    for (const [path, content] of [[targetPath!, targetContent!], [sourcePath!, sourceContent!], [negativePath!, negativeContent!]]) {
      fragments.push(...await registry.resolve({ path: path! })!.extract({ repositoryRoot: "/fixture", path: path!, content: content! }));
    }
    const target = fragments.find((f) => f.path === targetPath && f.kind === "module")!;
    assert.ok(target.databaseRefs.includes("orders"), "database usage remains available as evidence");
    const runtime = new CodeQueryRuntime({ version: 2, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments });
    const incoming = runtime.references(target.id, {}, 100);
    assert.ok(incoming.some((r) => r.source.path === sourcePath && r.source.kind === "module" && r.relation === "import"));
    assert.ok(!incoming.some((r) => r.source.path === negativePath), "sharing a database does not reference the other file");
    assert.ok(!incoming.some((r) => r.source.path === targetPath), "a file's own database usage is not an incoming file reference");
    assert.deepEqual(runtime.referencesTo([target], {}, 100), incoming, "single and batched queries share the corrected interpretation");
  }
});

// These are capability expectations, not parity with the old stem heuristic.
// Missing import edges must fail visibly even when extraction itself succeeds.
for (const [language, targetPath, targetSource, sourcePath, importingSource, specifier] of [
  ["Java", "src/main/java/com/acme/orders/Orders.java",
    "package com.acme.orders;\npublic class Orders {}",
    "src/main/java/com/acme/service/Service.java",
    "package com.acme.service;\nimport com.acme.orders.Orders;\npublic class Service {\n  public void run() {}\n}",
    "com.acme.orders.Orders"],
  ["Kotlin", "src/main/kotlin/com/acme/orders/OrderTypes.kt",
    "package com.acme.orders\nclass Orders {}",
    "src/main/kotlin/com/acme/service/Service.kt",
    "package com.acme.service\nimport com.acme.orders.Orders\nfun run() {}",
    "com.acme.orders.Orders"],
  ["C#", "Orders/OrderService.cs",
    "namespace Acme.Orders;\npublic class OrderService {}",
    "Service.cs", "using Acme.Orders;\npublic class Service {\n  public void Run() {}\n}",
    "Acme.Orders"],
  ["Go", "internal/orders/orders.go", "package orders\nfunc Place() {}",
    "cmd/service/main.go", 'package main\nimport "example.com/app/internal/orders"\nfunc main() { orders.Place() }',
    "example.com/app/internal/orders"],
  ["Go with a different filename in the same package", "internal/orders/create.go", "package orders\nfunc Place() {}",
    "cmd/service/main.go", 'package main\nimport "example.com/app/internal/orders"\nfunc main() { orders.Place() }',
    "example.com/app/internal/orders"],
  ["Rust", "src/orders.rs", "pub fn place() {}",
    "src/lib.rs", "pub mod orders;\nuse crate::orders::place;\npub fn run() { place(); }",
    "crate::orders::place"],
  ["PHP", "src/Orders/Orders.php", "<?php\nnamespace App\\Orders;\nclass Orders {}",
    "src/Service.php", "<?php\nnamespace App;\nuse App\\Orders\\Orders;\nfunction run() {}",
    "App\\Orders\\Orders"],
  ["C", "src/orders.h", "int place(void);",
    "src/service.c", '#include "orders.h"\nint run(void) { return place(); }',
    "orders.h"],
  ["C++", "src/orders.hpp", "int place();",
    "src/service.cpp", '#include "orders.hpp"\nint run() { return place(); }',
    "orders.hpp"],
  ["Ruby", "lib/orders.rb", "def place\n  1\nend",
    "lib/service.rb", 'require_relative "orders"\ndef run\n  place\nend',
    "orders"],
] as const) {
  test(`${language} resolves realistic extracted imports to the target module`, async () => {
    const registry = createDefaultKnowledgeAdapterRegistry();
    // C headers are intentionally owned by the C++ superset adapter.
    const targetAdapter = registry.resolve({ path: targetPath })!;
    const sourceAdapter = registry.resolve({ path: sourcePath })!;
    const fragments = [
      ...await targetAdapter.extract({ repositoryRoot: "/fixture", path: targetPath, content: targetSource }),
      ...await sourceAdapter.extract({ repositoryRoot: "/fixture", path: sourcePath, content: importingSource }),
    ];
    const target = fragments.find((fragment) => fragment.path === targetPath && fragment.kind === "module")!;
    assert.ok(target, "the real adapter must emit the target module");
    const source = fragments.find((fragment) => fragment.path === sourcePath && fragment.kind === "module")!;
    assert.ok(source, "the real adapter must emit the importing module");
    assert.deepEqual(source.imports, language === "Rust" ? [specifier, "self::orders"] : [specifier], "specifier extraction includes declared Rust modules independently of use statements");
    const expectedSources = fragments.filter((fragment) => fragment.path === sourcePath && fragment.imports.includes(specifier));
    const runtime = new CodeQueryRuntime({ version: 2, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments });
    assert.deepEqual(
      runtime.references(target.id, {}, 100).filter((hit) => hit.relation === "import").map((hit) => hit.source.id),
      expectedSources.map((fragment) => fragment.id),
      `${specifier} must link the importing fragments to ${targetPath}`
    );
    assert.deepEqual(runtime.references(target.id, { paths: ["other"] }, 100), []);
  });
}
