import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createDefaultKnowledgeAdapterRegistry, KnowledgeAdapterRegistry } from "../src/core/code-evidence/adapter-registry.js";
import { CodeQueryRuntime } from "../src/core/code-evidence/query-runtime.js";
import { codeEvidenceIndexFile, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import type { CodeImportContext } from "../src/core/code-evidence/types.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";

async function project(files: Record<string, string>) {
  const registry = createDefaultKnowledgeAdapterRegistry();
  const fragments = (await Promise.all(Object.entries(files).map(([path, content]) =>
    registry.resolve({ path })!.extract({ repositoryRoot: "/fixture", path, content })
  ))).flat();
  const runtime = new CodeQueryRuntime({ version: 2, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments }, registry);
  return {
    runtime,
    incoming(targetPath: string) {
      const target = fragments.find((fragment) => fragment.path === targetPath && fragment.kind === "module" && fragment.qualifiedName === targetPath);
      assert.ok(target, targetPath);
      return [...new Set(runtime.references(target.id, {}, 100).filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
    },
  };
}

test("declared Java names reject duplicate types and unrelated stems, preserving static and wildcard imports", async () => {
  const fixture = await project({
    "one/Orders.java": "package com.acme;\npublic class Orders {\n public static void place() {}\n}",
    "two/Orders.java": "package other;\npublic class Orders {}",
    "one/Extra.java": "package com.acme;\npublic class Extra {}",
    "dup1/Duplicate.java": "package com.acme;\npublic class Duplicate {}",
    "dup2/Duplicate.java": "package com.acme;\npublic class Duplicate {}",
    "Static.java": "import static com.acme.Orders.place;\npublic class Static {}",
    "Group.java": "import com.acme.*;\npublic class Group {}",
    "Negative.java": "import com.acme.Duplicate;\nimport missing.Orders;\nimport com.acme.orders;\npublic class Negative {}",
  });
  assert.deepEqual(fixture.incoming("one/Orders.java"), ["Group.java", "Static.java"]);
  assert.deepEqual(fixture.incoming("one/Extra.java"), ["Group.java"]);
  assert.deepEqual(fixture.incoming("two/Orders.java"), []);
  assert.deepEqual(fixture.incoming("dup1/Duplicate.java"), ["Group.java"]);
  assert.deepEqual(fixture.incoming("dup2/Duplicate.java"), ["Group.java"]);
});

test("Kotlin imports use declarations regardless of filename and retain aliases and top-level functions", async () => {
  const fixture = await project({
    "domain/Misc.kt": "package com.acme\nclass Orders {}\nfun place() {}",
    "app/Service.kt": "import com.acme.Orders as Invoice\nimport com.acme.place\nfun run() {}",
    "other/Orders.kt": "package other\nclass Orders {}",
  });
  assert.deepEqual(fixture.incoming("domain/Misc.kt"), ["app/Service.kt"]);
  assert.deepEqual(fixture.incoming("other/Orders.kt"), []);
});

test("C# namespace imports collect contributing files while duplicate type aliases remain unresolved", async () => {
  const fixture = await project({
    "domain/One.cs": "namespace Acme.Orders;\npublic class One {}",
    "domain/Two.cs": "namespace Acme.Orders;\npublic class Two {}",
    "nested/Three.cs": "namespace Acme.Orders.Nested;\npublic class Three {}",
    "dup1/Type.cs": "namespace Other;\npublic class Type {}",
    "dup2/Type.cs": "namespace Other;\npublic class Type {}",
    "Consumer.cs": "using Acme.Orders;\nusing Alias = Other.Type;\npublic class Consumer {}",
  });
  for (const target of ["domain/One.cs", "domain/Two.cs"]) assert.deepEqual(fixture.incoming(target), ["Consumer.cs"]);
  for (const target of ["nested/Three.cs", "dup1/Type.cs", "dup2/Type.cs"]) assert.deepEqual(fixture.incoming(target), []);
});

test("PHP grouped imports and aliases resolve declared classes and functions without filename assumptions", async () => {
  const fixture = await project({
    "domain/Misc.php": "<?php\nnamespace App\\Orders;\nclass Order {}\nfunction place() {}",
    "domain/More.php": "<?php\nnamespace App\\Orders;\nclass Invoice {}",
    "Consumer.php": "<?php\nuse App\\Orders\\{Order as Purchase, Invoice};\nuse function App\\Orders\\place;\nfunction run() {}",
    "wrong/Order.php": "<?php\nnamespace Other;\nclass Order {}",
  });
  assert.deepEqual(fixture.incoming("domain/Misc.php"), ["Consumer.php"]);
  assert.deepEqual(fixture.incoming("domain/More.php"), ["Consumer.php"]);
  assert.deepEqual(fixture.incoming("wrong/Order.php"), []);
});

test("C/C++ imports reference literal headers, reject ambiguity and do not manufacture implementation edges", async () => {
  const fixture = await project({
    "src/orders.h": "int place(void);",
    "src/orders.c": "int place(void) { return 1; }",
    "other/orders.h": "int place(void);",
    "src/service.c": '#include "orders.h"\nint run(void) { return place(); }',
    "ambiguous.h": "int value();",
    "src/ambiguous.h": "int value();",
    "src/negative.cpp": '#include "ambiguous.h"\n#include "../../../orders.h"\n#include "Orders.h"\nint run() { return 1; }',
  });
  assert.deepEqual(fixture.incoming("src/orders.h"), ["src/service.c"]);
  for (const target of ["src/orders.c", "other/orders.h", "ambiguous.h", "src/ambiguous.h"]) assert.deepEqual(fixture.incoming(target), []);
});

test("Go package imports include every implementation file and reject conflicting source roots", async () => {
  const fixture = await project({
    "internal/orders/create.go": "package orders\nfunc Create() {}",
    "internal/orders/cancel.go": "package orders\nfunc Cancel() {}",
    "internal/orders/orders_test.go": "package orders\nfunc TestCreate() {}",
    "cmd/main.go": 'package main\nimport "example.com/app/internal/orders"\nfunc main() {}',
    "negative/main.go": 'package main\nimport "example.net/external/orders"\nfunc main() {}',
    "a/internal/ambiguous/one.go": "package ambiguous\nfunc One() {}",
    "b/internal/ambiguous/two.go": "package ambiguous\nfunc Two() {}",
    "conflict/main.go": 'package main\nimport "example.com/app/internal/ambiguous"\nfunc main() {}',
  });
  for (const target of ["internal/orders/create.go", "internal/orders/cancel.go"]) assert.deepEqual(fixture.incoming(target), ["cmd/main.go"]);
  for (const target of ["internal/orders/orders_test.go", "a/internal/ambiguous/one.go", "b/internal/ambiguous/two.go"]) assert.deepEqual(fixture.incoming(target), []);
});

test("Rust resolves crate, self, super, groups and inline modules within their crate", async () => {
  const fixture = await project({
    "src/lib.rs": "pub mod orders;\npub mod feature;\npub mod inline {\n pub fn item() {}\n}\n",
    "src/orders.rs": "pub fn place() {}",
    "src/feature/mod.rs": "use super::orders::place;\npub mod nested;",
    "src/feature/nested.rs": "use crate::{orders::place, inline::item};\nuse self::child::*;\npub mod child;",
    "src/feature/nested/child.rs": "pub fn value() {}",
    "other/src/lib.rs": "use crate::orders::place;\npub mod orders;",
    "other/src/orders/mod.rs": "pub fn place() {}",
    "src/negative.rs": "use super::super::orders::place;\nuse external::orders::place;",
  });
  assert.deepEqual(fixture.incoming("src/orders.rs"), ["src/feature/mod.rs", "src/feature/nested.rs"]);
  assert.deepEqual(fixture.incoming("src/lib.rs"), ["src/feature/nested.rs"]);
  assert.deepEqual(fixture.incoming("src/feature/nested/child.rs"), ["src/feature/nested.rs"]);
  assert.deepEqual(fixture.incoming("other/src/orders/mod.rs"), ["other/src/lib.rs"]);
});

test("Rust file/mod ambiguity and excessively nested use groups remain unresolved", async () => {
  const fixture = await project({
    "src/lib.rs": `use crate::orders::place;\nuse crate::${"{".repeat(40)}orders::place${"}".repeat(40)};`,
    "src/orders.rs": "pub fn place() {}",
    "src/orders/mod.rs": "pub fn place() {}",
  });
  assert.deepEqual(fixture.incoming("src/orders.rs"), []);
  assert.deepEqual(fixture.incoming("src/orders/mod.rs"), []);
});

test("Python regular-package boundaries supply the src root without global basename aliases", async () => {
  const fixture = await project({
    "src/app/__init__.py": "value = 1",
    "src/app/orders.py": "def place():\n return 1",
    "src/app/nested/__init__.py": "value = 1",
    "src/app/nested/service.py": "from app.orders import place\nfrom ..orders import place",
    "root.py": "from app.orders import place",
    "src/app/escape.py": "from ..app.orders import place",
  });
  assert.deepEqual(fixture.incoming("src/app/orders.py"), ["src/app/nested/service.py"]);
});

test("LWC imports resolve Apex methods, schema declarations and local component bundles", async () => {
  const fixture = await project({
    "force-app/main/default/classes/Orders.cls": "public class Orders {\n @AuraEnabled\n public static void load() {}\n}",
    "force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml": '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Amount__c</fullName><type>Number</type><label>Amount</label></CustomField>',
    "force-app/main/default/lwc/orderCard/orderCard.js": 'import load from "@salesforce/apex/Orders.load";\nimport amount from "@salesforce/schema/Invoice__c.Amount__c";\nimport child from "c/orderChild";\nexport class Card {}',
    "force-app/main/default/lwc/orderChild/orderChild.js": "export class Child {}",
    "negative.js": 'import load from "@salesforce/apex/Orders.missing";\nimport field from "@salesforce/schema/Invoice__c.Missing__c";',
  });
  for (const target of ["force-app/main/default/classes/Orders.cls", "force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml", "force-app/main/default/lwc/orderChild/orderChild.js"]) {
    assert.deepEqual(fixture.incoming(target), ["force-app/main/default/lwc/orderCard/orderCard.js"]);
  }
});

test("custom adapter resolvers are lazy, deduplicate targets and cannot link outside the inventory", async () => {
  let builds = 0, resolutions = 0;
  class Custom extends TypeScriptKnowledgeAdapter {
    override readonly createImportResolver = (_context: CodeImportContext) => {
      builds++;
      return () => { resolutions++; return ["target.ts", "target.ts", "outside.ts"]; };
    };
  }
  const adapter = new Custom();
  const fragments = [
    ...await adapter.extract({ repositoryRoot: "/fixture", path: "target.ts", content: "export const value = 1;" }),
    ...await adapter.extract({ repositoryRoot: "/fixture", path: "user.ts", content: 'import "anything";\nexport function run() {}' }),
  ];
  const registry = new KnowledgeAdapterRegistry([adapter]);
  const runtime = new CodeQueryRuntime({ version: 2, adapters: registry.roster(), generatedAt: "fixture", files: [], fragments }, registry);
  assert.equal(builds, 0);
  const target = fragments.find((fragment) => fragment.path === "target.ts" && fragment.kind === "module")!;
  assert.equal(runtime.references(target.id, {}, 100).length, 2);
  assert.equal(runtime.references(target.id, {}, 100).length, 2);
  assert.deepEqual({ builds, resolutions }, { builds: 1, resolutions: 1 });
});

test("same-roster custom resolvers do not share cached rules or rewrite persisted snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-import-registry-"));
  const wikiRoot = path.join(root, "wiki");
  try {
    await fs.writeFile(path.join(root, "target.ts"), "export const value = 1;");
    await fs.writeFile(path.join(root, "user.ts"), 'import "./target.ts";');
    const original = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, adapter: new TypeScriptKnowledgeAdapter() });
    await original.rebuild();
    const target = (await original.snapshot()).fragments.find((fragment) => fragment.path === "target.ts" && fragment.kind === "module")!;
    const before = await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8");
    assert.equal((await original.references(target.id)).length, 1);
    class NoImports extends TypeScriptKnowledgeAdapter {
      override readonly createImportResolver = () => () => [];
      override async extract(): Promise<never> { throw new Error("queries must not re-extract persisted files"); }
    }
    const other = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, adapter: new NoImports() });
    assert.deepEqual(await other.references(target.id), []);
    assert.equal((await original.references(target.id)).length, 1);
    assert.equal(await fs.readFile(codeEvidenceIndexFile(wikiRoot), "utf8"), before);
  } finally {
    clearWorkspaceStates();
    await fs.rm(root, { recursive: true, force: true });
  }
});
