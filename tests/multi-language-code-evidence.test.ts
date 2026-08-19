import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createDefaultKnowledgeAdapterRegistry,
  defaultParserVersionForPath,
  KnowledgeAdapterRegistry,
} from "../src/core/code-evidence/adapter-registry.js";
import { maskBraceLanguage } from "../src/core/code-evidence/brace-language-engine.js";
import { codeAnchorHash } from "../src/core/code-evidence/code-anchor.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { CppKnowledgeAdapter, JavaKnowledgeAdapter } from "../src/core/code-evidence/language-adapters.js";
import { codeGrepFallbackDemand, recordCodeGrepFallback } from "../src/core/code-evidence/telemetry.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import {
  CODE_EVIDENCE_INDEX_VERSION,
  CPP_ADAPTER_VERSION,
  JAVA_ADAPTER_VERSION,
  PHP_ADAPTER_VERSION,
  type CodeAnchor,
  type KnowledgeAdapter,
} from "../src/core/code-evidence/types.js";
import { evaluateCodeAnchor } from "../src/core/drift-detection.js";

const FIXTURE_ROOT = path.resolve("tests/fixtures/code-evidence");

async function withTemporaryRoot(
  prefix: string,
  callback: (root: string, wikiRoot: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const wikiRoot = path.join(root, "wiki");
  try {
    await callback(root, wikiRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("the default registry indexes a mixed-language repository in one pass", async () => {
  await withTemporaryRoot("knowledge-rail-multilang-", async (root, wikiRoot) => {
    await fs.cp(FIXTURE_ROOT, root, { recursive: true });
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
    const report = await index.rebuild();
    const snapshot = await index.snapshot();
    assert.equal(snapshot.version, CODE_EVIDENCE_INDEX_VERSION);
    assert.equal(snapshot.adapters.length, 9);
    assert.equal(report.scannedFiles, 27);
    assert.equal(report.reparsedFiles, 27);
    assert.equal(snapshot.files.length, 27);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".h"))[0]?.parserVersion, CPP_ADAPTER_VERSION);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".php"))[0]?.parserVersion, PHP_ADAPTER_VERSION);

    const expected: Array<[string, string]> = [
      ["OrderController", "java/OrderController.java"],
      ["loadAccount", "apex/AccountService.cls"],
      ["AccountAudit", "apex/AccountAudit.trigger"],
      ["OrdersController", "csharp/OrdersController.cs"],
      ["Handle", "go/server.go"],
      ["handle", "rust/service.rs"],
      ["embedded_helper", "php/OrderController.php"],
      ["sum", "c/math.c"],
      ["add", "cpp/calculator.cpp"],
      ["OrderCard", "lwc/orderCard.js"],
    ];
    for (const [symbol, expectedPath] of expected) {
      assert.equal((await index.symbol(symbol, { maxResults: 20 })).some((hit) =>
        hit.fragment.path === expectedPath
      ), true, `${symbol} should resolve to ${expectedPath}`);
    }
    const qualifiedAliases: Array<[string, string]> = [
      ["OrderController.load", "com.acme.orders.OrderController#load"],
      ["OrderController # load", "com.acme.orders.OrderController#load"],
      ["Service.handle", "Service::handle"],
      ["math.Calculator.add", "math::Calculator::add"],
      ["App.Orders.OrderController.show", "App\\Orders\\OrderController::show"],
      ["OrderController->show", "App\\Orders\\OrderController::show"],
    ];
    for (const [query, qualifiedName] of qualifiedAliases) {
      assert.equal((await index.symbol(query, { maxResults: 20 })).some((hit) =>
        hit.fragment.qualifiedName === qualifiedName
      ), true, `${query} should resolve ${qualifiedName}`);
    }
    assert.equal((await index.symbol("UnrelatedService.load", { maxResults: 20 })).length, 0);
    await assert.rejects(index.symbol("::#\\->"), /must contain an identifier/);
    const fragment = (qualifiedName: string) => snapshot.fragments.find((item) =>
      item.qualifiedName === qualifiedName
    );
    assert.equal(fragment("com.acme.orders.OrderController#load")?.docComment?.includes("Load one order"), true);
    assert.equal(fragment("com.acme.orders.OrderController#load")?.imports.includes(
      "org.springframework.web.bind.annotation.GetMapping"
    ), true);
    assert.deepEqual(fragment("AccountService.loadAccount")?.databaseRefs, ["Account"]);
    assert.equal(fragment("trigger:AccountAudit:Account")?.routes.length, 2);
    assert.equal(fragment("Acme.Orders.OrdersController.Region")?.kind, "method");
    assert.equal(fragment("Server.Handle")?.imports.includes("github.com/go-chi/chi/v5"), true);
    assert.equal(fragment("Service::handle")?.calls.includes("persist"), true);
    assert.deepEqual(fragment("App\\Orders\\OrderController::show")?.configKeys, ["REGION", "orders.queue"]);
    assert.deepEqual(fragment("App\\Orders\\OrderController::show")?.databaseRefs, ["orders"]);
    assert.equal(fragment("App\\Orders\\OrderController")?.imports.includes("App\\Repository\\OrderRepository"), true);
    assert.equal(fragment("App\\Orders\\OrderController")?.imports.includes("TracksChanges"), false);
    assert.equal(fragment("sum")?.imports.includes("stddef.h"), true);
    assert.equal(fragment("math::Calculator::add")?.imports.includes("calculator.h"), true);
    for (const intentionallySkipped of [
      "fake_fn", "fake_generated", "fake_hidden", "declared_only", "bool", "fakeHtml", "fakeHeredoc",
    ]) {
      assert.equal((await index.symbol(intentionallySkipped)).length, 0);
    }
    const lwcClass = (await index.symbol("OrderCard"))[0]!;
    assert.equal(lwcClass.fragment.calls.includes("getRecord"), true);
    assert.equal(lwcClass.fragment.calls.includes("fakeAdapter"), false);
    assert.equal((await index.search("lightning__RecordPage", { maxResults: 20 })).some((hit) =>
      hit.fragment.path === "lwc/orderCard.js" && hit.fragment.configKeys.includes("lightning__RecordPage")
    ), true);
    assert.equal((await index.search("lightning__FakePage", { maxResults: 20 })).some((hit) =>
      hit.fragment.configKeys.includes("lightning__FakePage")
    ), false);

    const metadataPath = path.join(root, "lwc/orderCard.js-meta.xml");
    const metadata = await fs.readFile(metadataPath, "utf8");
    await fs.writeFile(metadataPath, metadata.replace("lightning__RecordPage", "lightning__HomePage"), "utf8");
    await index.updateFile("lwc/orderCard.js-meta.xml");
    assert.equal((await index.search("lightning__RecordPage", { maxResults: 20 })).some((hit) =>
      hit.fragment.path === "lwc/orderCard.js" && hit.fragment.configKeys.includes("lightning__RecordPage")
    ), false);
    assert.equal((await index.search("lightning__HomePage", { maxResults: 20 })).some((hit) =>
      hit.fragment.path === "lwc/orderCard.js" && hit.fragment.configKeys.includes("lightning__HomePage")
    ), true);
  });
});

test("adapter claims are exclusive and headers resolve to the C++ superset", () => {
  const registry = createDefaultKnowledgeAdapterRegistry();
  assert.equal(registry.resolve({ path: "include/orders.h" })?.parserVersion, CPP_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "scripts/orders.py" }), undefined);
  assert.equal(registry.resolve({ path: "templates/orders.blade.php" }), undefined);
  assert.throws(() => new KnowledgeAdapterRegistry([
    { adapter: new TypeScriptKnowledgeAdapter(), extensionClaims: [".ts"] },
    { adapter: new JavaKnowledgeAdapter(), extensionClaims: [".ts"] },
  ]), /claimed by both/);
  const php = createDefaultKnowledgeAdapterRegistry().resolve({ path: "fixture.php" })!;
  const broadPhp: KnowledgeAdapter = {
    parserVersion: "broad-php-test-v1",
    supports: ({ path: candidate }) => candidate.endsWith(".php"),
    extract: async () => [],
  };
  const blade: KnowledgeAdapter = {
    parserVersion: "blade-test-v1",
    supports: ({ path: candidate }) => candidate.endsWith(".blade.php"),
    extract: async () => [],
  };
  assert.throws(() => new KnowledgeAdapterRegistry([
    { adapter: broadPhp, extensionClaims: [".php"] },
    { adapter: blade, extensionClaims: [".blade.php"] },
  ]), /overlap/);
  assert.doesNotThrow(() => new KnowledgeAdapterRegistry([
    { adapter: php, extensionClaims: [".php"] },
    { adapter: blade, extensionClaims: [".blade.php"] },
  ]));
});

test("C++ access labels do not shift inline method ranges", async () => {
  const content = [
    "class Inventory {",
    "public:",
    "  int available() const {",
    "    return 3;",
    "  }",
    "};",
    "",
  ].join("\n");
  const fragments = await new CppKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "cpp/inventory.hpp",
    content,
  });
  const method = fragments.find((fragment) => fragment.qualifiedName === "Inventory::available");
  assert.deepEqual(method?.range, { startLine: 3, endLine: 5 });
  assert.equal(method?.definition, "int available() const {");
});

test("C# interpolation expressions may contain nested quoted strings without desynchronizing masking", () => {
  const content = [
    "var label = $\"{Lookup(\"priority\")}:{order.Id}\";",
    "var nested = $\"{Format($\"{Lookup(\"region\")}\")}\";",
    "void VisibleAfterInterpolation() {}",
    "",
  ].join("\n");
  const masked = maskBraceLanguage(content, "csharp");
  assert.equal(masked.length, content.length);
  assert.equal(masked.split("\n").length, content.split("\n").length);
  assert.equal(masked.includes("priority"), false);
  assert.equal(masked.includes("region"), false);
  assert.equal(masked.includes("VisibleAfterInterpolation"), true);
});

test("default parser resolution reuses the memoized registry across anchor-sized workloads", () => {
  for (let index = 0; index < 1_000; index++) {
    assert.equal(defaultParserVersionForPath(`src/order-${index}.cpp`), CPP_ADAPTER_VERSION);
  }
});

test("changing one adapter version reparses only files claimed by that adapter", async () => {
  await withTemporaryRoot("knowledge-rail-adapter-isolation-", async (root, wikiRoot) => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, "src/service.ts"), "export function stableTs() { return 1; }\n", "utf8"),
      fs.writeFile(path.join(root, "src/Service.java"), "class Service { int value() { return 1; } }\n", "utf8"),
    ]);
    const initialRegistry = new KnowledgeAdapterRegistry([
      new TypeScriptKnowledgeAdapter(),
      new JavaKnowledgeAdapter(),
    ]);
    const initialIndex = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, registry: initialRegistry });
    await initialIndex.rebuild();
    const before = await initialIndex.snapshot();
    const java = new JavaKnowledgeAdapter();
    const javaV2: KnowledgeAdapter & { extensionClaims: readonly string[] } = {
      parserVersion: "java-deterministic-v2",
      extensionClaims: java.extensionClaims,
      supports: (source) => java.supports(source),
      extract: (source) => java.extract(source),
    };
    const changedIndex = new PersistentCodeEvidenceIndex({
      repositoryRoot: root,
      wikiRoot,
      registry: new KnowledgeAdapterRegistry([new TypeScriptKnowledgeAdapter(), javaV2]),
    });
    const update = await changedIndex.rebuild();
    const after = await changedIndex.snapshot();
    assert.deepEqual(
      { reused: update.reusedFiles, reparsed: update.reparsedFiles },
      { reused: 1, reparsed: 1 }
    );
    assert.deepEqual(
      after.files.find((file) => file.path.endsWith("service.ts")),
      before.files.find((file) => file.path.endsWith("service.ts"))
    );
    assert.deepEqual(
      after.fragments.filter((fragment) => fragment.path.endsWith("service.ts")),
      before.fragments.filter((fragment) => fragment.path.endsWith("service.ts"))
    );
    assert.equal(after.files.find((file) => file.path.endsWith("Service.java"))?.parserVersion, "java-deterministic-v2");
  });
});

test("a v1 snapshot is discarded once and rebuilt as snapshot v2", async () => {
  await withTemporaryRoot("knowledge-rail-snapshot-v1-", async (root, wikiRoot) => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(wikiRoot, ".knowledge-rail"), { recursive: true });
    await fs.writeFile(path.join(root, "src/service.ts"), "export function migrated() {}\n", "utf8");
    await fs.writeFile(path.join(wikiRoot, ".knowledge-rail/code-evidence-index.json"), JSON.stringify({
      version: 1,
      parserVersion: "typescript-javascript-deterministic-v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      files: [],
      fragments: [],
    }), "utf8");
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
    const report = await index.rebuild();
    assert.equal(report.reparsedFiles, 1);
    assert.equal((await index.snapshot()).version, 2);
  });
});

test("drift parser resolution and fallback demand are language-aware", async () => {
  const content = "class Service {}\n";
  const anchor: CodeAnchor = {
    path: "src/Service.java",
    startLine: 1,
    endLine: 1,
    rangeHash: codeAnchorHash(content, 1, 1),
    parserVersion: JAVA_ADAPTER_VERSION,
    capturedAt: "2026-08-19T00:00:00.000Z",
  };
  assert.deepEqual(evaluateCodeAnchor({ anchor, content }), {
    verdict: "fresh",
    observedRangeHash: anchor.rangeHash,
  });
  assert.equal(evaluateCodeAnchor({ anchor, content, parserVersion: "java-deterministic-v2" }).reason, "parser_version_changed");

  await withTemporaryRoot("knowledge-rail-fallback-demand-", async (_root, wikiRoot) => {
    await assert.rejects(recordCodeGrepFallback({
      wikiRoot,
      query: "invalid fallback",
      reason: "result paths exceed reported hits",
      resultCount: 0,
      resultPaths: ["src/Unexpected.php"],
    }), /cannot exceed resultCount/);
    await recordCodeGrepFallback({
      wikiRoot,
      query: "legacy handler",
      reason: "unsupported code required raw lookup",
      resultCount: 4,
      resultPaths: ["force/One.cls", "force/Two.cls", "src/Legacy.java"],
      timestamp: "2026-08-19T00:00:00.000Z",
    });
    assert.deepEqual(await codeGrepFallbackDemand(wikiRoot), {
      totalEvents: 1,
      totalResults: 4,
      categorizedResults: 3,
      uncategorizedResults: 1,
      byExtension: { ".cls": 2, ".java": 1 },
    });
  });
});
