import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { multiLanguageCorpusSha256 } from "../benchmarks/multi-language-code-evidence-eval.js";
import {
  createDefaultKnowledgeAdapterRegistry,
  defaultParserVersionForPath,
  KnowledgeAdapterRegistry,
} from "../src/core/code-evidence/adapter-registry.js";
import { maskBraceLanguage } from "../src/core/code-evidence/brace-language-engine.js";
import { codeAnchorHash } from "../src/core/code-evidence/code-anchor.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { maskRubySource } from "../src/core/code-evidence/keyword-block-engine.js";
import {
  ApexKnowledgeAdapter,
  CppKnowledgeAdapter,
  JavaKnowledgeAdapter,
  KotlinKnowledgeAdapter,
} from "../src/core/code-evidence/language-adapters.js";
import { PythonKnowledgeAdapter } from "../src/core/code-evidence/python-adapter.js";
import { RubyKnowledgeAdapter } from "../src/core/code-evidence/ruby-adapter.js";
import { SalesforceMetadataKnowledgeAdapter } from "../src/core/code-evidence/sfmeta-adapter.js";
import { codeGrepFallbackDemand, recordCodeGrepFallback } from "../src/core/code-evidence/telemetry.js";
import { TypeScriptKnowledgeAdapter } from "../src/core/code-evidence/typescript-adapter.js";
import {
  CODE_EVIDENCE_INDEX_VERSION,
  CPP_ADAPTER_VERSION,
  JAVA_ADAPTER_VERSION,
  KOTLIN_ADAPTER_VERSION,
  PHP_ADAPTER_VERSION,
  PYTHON_ADAPTER_VERSION,
  RUBY_ADAPTER_VERSION,
  SFMETA_ADAPTER_VERSION,
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
    assert.equal(snapshot.adapters.length, 13);
    assert.equal(report.scannedFiles, 54);
    assert.equal(report.reparsedFiles, 54);
    assert.equal(snapshot.files.length, 54);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".h"))[0]?.parserVersion, CPP_ADAPTER_VERSION);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".php"))[0]?.parserVersion, PHP_ADAPTER_VERSION);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".kt"))[0]?.parserVersion, KOTLIN_ADAPTER_VERSION);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".object-meta.xml"))[0]?.parserVersion,
      SFMETA_ADAPTER_VERSION);
    assert.equal(snapshot.files.filter((file) => file.path.endsWith(".rb"))[0]?.parserVersion, RUBY_ADAPTER_VERSION);

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
      ["load_order", "python/order_service.py"],
      ["totalWithTax", "kotlin/OrderModels.kt"],
      ["Amount__c", "sfmeta/objects/Invoice__c/fields/Amount__c.field-meta.xml"],
      ["OrderService", "ruby/app/services/order_service.rb"],
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
      ["OrderService#place", "OrderService.place"],
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
    assert.equal(fragment("Order.totalWithTax")?.references.includes("Order"), true);
    assert.equal(snapshot.fragments.find((item) =>
      item.path === "ruby/app/models/order.rb" && item.qualifiedName === "Order"
    )?.references.includes("external_id"), true);
    assert.deepEqual(fragment("Invoice__c.Outstanding__c")?.references, ["Amount__c", "PaidAmount__c", "Status__c"]);
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

test("adapter claims are exclusive and language extensions resolve to one owner", () => {
  const registry = createDefaultKnowledgeAdapterRegistry();
  assert.equal(registry.resolve({ path: "include/orders.h" })?.parserVersion, CPP_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "scripts/orders.py" })?.parserVersion, PYTHON_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "stubs/orders.pyi" })?.parserVersion, PYTHON_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "lwc/component.js-meta.xml" })?.parserVersion,
    "typescript-javascript-deterministic-v2");
  assert.equal(registry.resolve({ path: "objects/Invoice__c.object-meta.xml" })?.parserVersion,
    SFMETA_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "objects/Invoice__c.validationRule-meta.xml" })?.parserVersion,
    SFMETA_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "generic/thing-meta.xml" }), undefined);
  assert.equal(registry.resolve({ path: "generic/thing.xml" }), undefined);
  assert.equal(registry.resolve({ path: "src/orders.kt" })?.parserVersion, KOTLIN_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "src/build.kts" })?.parserVersion, KOTLIN_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "lib/orders.rb" })?.parserVersion, RUBY_ADAPTER_VERSION);
  assert.equal(registry.resolve({ path: "tasks/orders.rake" })?.parserVersion, RUBY_ADAPTER_VERSION);
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

test("the golden corpus digest and byte metrics are invariant to checkout newlines", async () => {
  await withTemporaryRoot("knowledge-rail-newline-fixture-", async (root) => {
    const fixture = path.join(root, "fixture.cpp");
    await fs.writeFile(fixture, "int first() {\n  return 1;\n}\n", "utf8");
    const lf = await multiLanguageCorpusSha256(root);
    await fs.writeFile(fixture, "int first() {\r\n  return 1;\r\n}\r\n", "utf8");
    assert.equal(await multiLanguageCorpusSha256(root), lf);
  });
});

test("C/C++ signature matching remains bounded on repeated declaration-like tokens", { timeout: 1_000 }, async () => {
  const content = `${"A ".repeat(20_000)};\nint visible(void) {\n  return 1;\n}\n`;
  const fragments = await new CppKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "cpp/adversarial.cpp",
    content,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.symbol === "visible")?.range, {
    startLine: 2,
    endLine: 4,
  });
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

test("Kotlin masking preserves UTF-8 offsets across nested templates, raw strings, and nested comments", () => {
  const content = [
    "/* outer /* fun fakeComment() {} */ end */",
    "val label = \"caffè ${lookup(\"fakeTemplate() { }\")}\"",
    "val raw = \"\"\"λ fakeRaw() { ${ignored} }\"\"\"",
    "fun visibleAfterMasking() {}",
    "",
  ].join("\n");
  const masked = maskBraceLanguage(content, "kotlin");
  assert.equal(masked.length, content.length);
  assert.equal(Buffer.byteLength(masked), Buffer.byteLength(content));
  assert.deepEqual(
    [...masked].flatMap((value, index) => value === "\n" ? [index] : []),
    [...content].flatMap((value, index) => value === "\n" ? [index] : [])
  );
  for (const hidden of ["fakeComment", "fakeTemplate", "fakeRaw", "caffè", "λ"]) {
    assert.equal(masked.includes(hidden), false);
  }
  assert.equal(masked.includes("visibleAfterMasking"), true);
});

test("Kotlin masking stays bounded on deeply nested templates and a large raw string", { timeout: 2_000 }, async () => {
  let nested = "\"leaf\"";
  for (let depth = 0; depth < 128; depth++) nested = `\"\${lookup(${nested})}\"`;
  const content = [
    `val nested = ${nested}`,
    `val payload = \"\"\"${"x".repeat(1_000_000)}\"\"\"`,
    "fun visible() = 1",
    "",
  ].join("\n");
  const started = performance.now();
  const fragments = await new KotlinKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "kotlin/pathological.kt",
    content,
  });
  assert.equal(performance.now() - started < 1_900, true);
  assert.deepEqual(fragments.find((fragment) => fragment.symbol === "visible")?.range, {
    startLine: 3,
    endLine: 3,
  });
});

test("Ktor literal route scopes are joined while computed prefixes remain conservative", async () => {
  const content = [
    "import io.ktor.server.routing.routing",
    "fun configure() {",
    "  routing {",
    "    route(\"/api\") {",
    "      get(\"/orders\") { call.respondText(\"ok\") }",
    "    }",
    "    route(dynamicPrefix) {",
    "      get(\"/hidden\") { call.respondText(\"skip\") }",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  const fragments = await new KotlinKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "kotlin/scoped-routes.kt",
    content,
  });
  const routes = fragments.filter((fragment) => fragment.kind === "route");
  assert.deepEqual(routes.map((fragment) => fragment.routes[0]?.path), ["/api/orders"]);
  assert.equal(routes.some((fragment) => fragment.symbol.includes("hidden")), false);
});

test("consecutive Kotlin expression-body functions cannot consume one another", async () => {
  const content = [
    "package sample",
    "fun String.slugify(",
    "  separator: String = defaultSeparator(",
    "    \"-\",",
    "  ),",
    "): String = lowercase().replace(\" \", separator)",
    "fun standalone(x: Int) = x * 2",
    "",
  ].join("\n");
  const fragments = await new KotlinKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "kotlin/expression-bodies.kt",
    content,
  });
  assert.deepEqual(fragments.filter((fragment) => fragment.kind === "function").map((fragment) => ({
    qualifiedName: fragment.qualifiedName,
    range: fragment.range,
  })), [
    { qualifiedName: "String.slugify", range: { startLine: 2, endLine: 6 } },
    { qualifiedName: "sample.standalone", range: { startLine: 7, endLine: 7 } },
  ]);
});

test("malformed Kotlin parameter lists stop at the next declaration in linear time", { timeout: 1_000 }, async () => {
  const malformed = Array.from({ length: 5_000 }, (_, index) => `fun broken${index}(`);
  const content = [...malformed, "fun visible() = 1", ""].join("\n");
  const fragments = await new KotlinKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "kotlin/malformed-functions.kt",
    content,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "visible")?.range, {
    startLine: 5_001,
    endLine: 5_001,
  });
  assert.equal(fragments.some((fragment) => fragment.symbol.startsWith("broken")), false);
});

test("malformed Kotlin type headers stay bounded on repeated indentation", { timeout: 1_000 }, async () => {
  const hostileIndentation = Array.from({ length: 10_000 }, () => "\t\t");
  const content = ["class Broken", ...hostileIndentation, "class Visible { }", ""].join("\n");
  const started = performance.now();
  const fragments = await new KotlinKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "kotlin/malformed-types.kt",
    content,
  });
  assert.equal(performance.now() - started < 900, true);
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "Broken")?.range, {
    startLine: 1,
    endLine: 1,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "Visible")?.range, {
    startLine: 10_002,
    endLine: 10_002,
  });
});

test("Ruby masking distinguishes regex literals from division and keeps modifier forms out of the block stack", async () => {
  const content = [
    "module Arithmetic",
    "  TEXT, SQL = <<~TEXT, <<-'SQL'",
    "    def fake_heredoc",
    "    end",
    "  TEXT",
    "    class FakeSql; end",
    "  SQL",
    "  WORDS = %w[class FakePercent end]",
    "  def normalized(total, count)",
    "    pattern = /order\\/end[0-9]+/i",
    "    ratio = total / count",
    "    return ratio if count.positive?",
    "    retry unless ratio.positive?",
    "  end",
    "end",
    "def visible_after_blocks = true",
    "",
  ].join("\n");
  const masked = maskRubySource(content);
  assert.equal(masked.length, content.length);
  assert.equal(Buffer.byteLength(masked), Buffer.byteLength(content));
  assert.equal(masked.includes("order"), false);
  assert.equal(masked.includes("total / count"), true);
  for (const hidden of ["fake_heredoc", "FakeSql", "FakePercent"]) assert.equal(masked.includes(hidden), false);

  const fragments = await new RubyKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "ruby/lib/arithmetic.rb",
    content,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "Arithmetic#normalized")?.range, {
    startLine: 9,
    endLine: 14,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "visible_after_blocks")?.range, {
    startLine: 16,
    endLine: 16,
  });
  assert.equal(fragments.some((fragment) => ["fake_heredoc", "FakeSql", "FakePercent"].includes(fragment.symbol)),
    false);
});

test("Ruby keyword scanning stays bounded on a megabyte heredoc", { timeout: 2_000 }, async () => {
  const content = `PAYLOAD = <<~DOC\n${"x".repeat(1_000_000)}\nDOC\ndef visible\n  true\nend\n`;
  const started = performance.now();
  const fragments = await new RubyKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "ruby/lib/pathological.rb",
    content,
  });
  assert.equal(performance.now() - started < 1_900, true);
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "visible")?.range, {
    startLine: 4,
    endLine: 6,
  });
});

test("Ruby append operators, singleton-class scopes, and expression-start blocks preserve method boundaries", async () => {
  const content = [
    "class Container",
    "  class << self",
    "    def build",
    "      new",
    "    end",
    "  end",
    "",
    "  def evaluate(queue, ready)",
    "    queue << ITEM",
    "    value = if ready",
    "      1",
    "    else",
    "      0",
    "    end",
    "    value",
    "  end",
    "end",
    "",
    "def visible_after_container = true",
    "",
  ].join("\n");
  const fragments = await new RubyKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "ruby/lib/container.rb",
    content,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "Container.build")?.range, {
    startLine: 3,
    endLine: 5,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "Container#evaluate")?.range, {
    startLine: 8,
    endLine: 16,
  });
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "visible_after_container")?.range, {
    startLine: 19,
    endLine: 19,
  });
});

test("Ruby evidence heuristics ignore comments, quoted heredoc markers, strings, and regex bodies", async () => {
  const content = [
    "# require \"fake/comment\"",
    "marker = \"<<~FAKE\"",
    "example = \"ENV['FAKE_KEY'] self.table_name = 'fake_table'\"",
    "pattern = /create_table :fake_regex/",
    "items << ORDER",
    "def visible",
    "  true",
    "end",
    "",
  ].join("\n");
  const fragments = await new RubyKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "ruby/lib/evidence_masking.rb",
    content,
  });
  const module = fragments.find((fragment) => fragment.kind === "module")!;
  assert.deepEqual(module.imports, []);
  assert.deepEqual(module.configKeys, []);
  assert.deepEqual(module.databaseRefs, []);
  assert.deepEqual(fragments.find((fragment) => fragment.qualifiedName === "visible")?.range, {
    startLine: 6,
    endLine: 8,
  });
});

test("Ruby modules are retained as named fragments outside the golden evaluator's generic module filter", async () => {
  const content = "module Billing\n  module Orders\n  end\nend\n";
  const fragments = await new RubyKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "ruby/lib/billing.rb",
    content,
  });
  assert.deepEqual(fragments.filter((fragment) => fragment.qualifiedName !== fragment.path).map((fragment) =>
    [fragment.kind, fragment.qualifiedName, fragment.range]
  ), [
    ["module", "Billing", { startLine: 1, endLine: 4 }],
    ["module", "Billing::Orders", { startLine: 2, endLine: 3 }],
  ]);
});

test("Salesforce metadata degrades malformed XML and cross-links Apex database evidence", async () => {
  const malformed = "<CustomObject><label>Broken\n";
  const malformedFragments = await new SalesforceMetadataKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "sfmeta/objects/Broken__c/Broken__c.object-meta.xml",
    content: malformed,
  });
  assert.equal(malformedFragments.length, 1);
  assert.equal(malformedFragments[0]?.kind, "module");
  const mismatchedFragments = await new SalesforceMetadataKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "sfmeta/objects/Broken__c/Broken__c.object-meta.xml",
    content: "<CustomObject><label>Broken</description></CustomObject>\n",
  });
  assert.equal(mismatchedFragments.length, 1);
  assert.equal(mismatchedFragments[0]?.kind, "module");

  await withTemporaryRoot("knowledge-rail-sfmeta-links-", async (root, wikiRoot) => {
    await fs.mkdir(path.join(root, "force-app/main/default/objects/Invoice__c/fields"), { recursive: true });
    await fs.mkdir(path.join(root, "force-app/main/default/triggers"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, "force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml"), [
        "<CustomObject>",
        "  <label>Invoice</label>",
        "</CustomObject>",
        "",
      ].join("\n"), "utf8"),
      fs.writeFile(path.join(root, "force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml"), [
        "<CustomField>",
        "  <label>Amount</label>",
        "  <type>Currency</type>",
        "</CustomField>",
        "",
      ].join("\n"), "utf8"),
      fs.writeFile(path.join(root, "force-app/main/default/triggers/InvoiceAudit.trigger"), [
        "trigger InvoiceAudit on Invoice__c (before insert) {",
        "  List<Invoice__c> invoices = [SELECT Amount__c FROM Invoice__c];",
        "}",
        "",
      ].join("\n"), "utf8"),
    ]);
    const registry = new KnowledgeAdapterRegistry([
      new ApexKnowledgeAdapter(),
      new SalesforceMetadataKnowledgeAdapter(),
    ]);
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, registry });
    await index.rebuild();
    for (const symbol of ["Invoice__c", "Invoice__c.Amount__c"]) {
      const target = (await index.symbol(symbol, { maxResults: 20 })).find((hit) =>
        hit.fragment.path.endsWith("-meta.xml") && hit.fragment.qualifiedName === symbol
      )?.fragment;
      assert.ok(target, `${symbol} metadata should be indexed`);
      assert.equal((await index.references(target.id, { maxResults: 20 })).some((reference) =>
        reference.source.qualifiedName === "trigger:InvoiceAudit:Invoice__c"
      ), true, `${symbol} should be connected to the Apex trigger`);
    }
  });
});

test("default parser resolution reuses the memoized registry across anchor-sized workloads", () => {
  for (let index = 0; index < 1_000; index++) {
    assert.equal(defaultParserVersionForPath(`src/order-${index}.cpp`), CPP_ADAPTER_VERSION);
    assert.equal(defaultParserVersionForPath(`src/order-${index}.py`), PYTHON_ADAPTER_VERSION);
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

test("a Python parser upgrade reparses only .py and .pyi files", async () => {
  await withTemporaryRoot("knowledge-rail-python-adapter-isolation-", async (root, wikiRoot) => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, "src/service.ts"), "export function stableTs() { return 1; }\n", "utf8"),
      fs.writeFile(path.join(root, "src/service.py"), "def python_service():\n    return 1\n", "utf8"),
      fs.writeFile(path.join(root, "src/service.pyi"), "def typed_service() -> int: ...\n", "utf8"),
    ]);
    const initialRegistry = new KnowledgeAdapterRegistry([
      new TypeScriptKnowledgeAdapter(),
      new PythonKnowledgeAdapter(),
    ]);
    const initialIndex = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot, registry: initialRegistry });
    await initialIndex.rebuild();
    const before = await initialIndex.snapshot();
    const python = new PythonKnowledgeAdapter();
    const pythonV2: KnowledgeAdapter & { extensionClaims: readonly string[] } = {
      parserVersion: "python-deterministic-v2",
      extensionClaims: python.extensionClaims,
      supports: (source) => python.supports(source),
      extract: (source) => python.extract(source),
    };
    const changedIndex = new PersistentCodeEvidenceIndex({
      repositoryRoot: root,
      wikiRoot,
      registry: new KnowledgeAdapterRegistry([new TypeScriptKnowledgeAdapter(), pythonV2]),
    });
    const update = await changedIndex.rebuild();
    const after = await changedIndex.snapshot();
    assert.deepEqual(
      { reused: update.reusedFiles, reparsed: update.reparsedFiles },
      { reused: 1, reparsed: 2 }
    );
    assert.deepEqual(
      after.files.find((file) => file.path.endsWith("service.ts")),
      before.files.find((file) => file.path.endsWith("service.ts"))
    );
    assert.deepEqual(
      after.fragments.filter((fragment) => fragment.path.endsWith("service.ts")),
      before.fragments.filter((fragment) => fragment.path.endsWith("service.ts"))
    );
    assert.equal(after.files.filter((file) => /\.pyi?$/u.test(file.path)).every((file) =>
      file.parserVersion === "python-deterministic-v2"
    ), true);
  });
});

test("Kotlin, Salesforce metadata, and Ruby parser upgrades remain file-selective", async () => {
  const factories = [
    () => new TypeScriptKnowledgeAdapter(),
    () => new KotlinKnowledgeAdapter(),
    () => new SalesforceMetadataKnowledgeAdapter(),
    () => new RubyKnowledgeAdapter(),
  ];
  const paths = ["service.ts", "service.kt", "Invoice__c.object-meta.xml", "service.rb"];
  const contents = [
    "export function stableTs() { return 1; }\n",
    "fun stableKotlin() = 1\n",
    "<CustomObject><label>Invoice</label></CustomObject>\n",
    "def stable_ruby = 1\n",
  ];
  for (const changedAdapterIndex of [1, 2, 3]) {
    await withTemporaryRoot(`knowledge-rail-new-adapter-${changedAdapterIndex}-`, async (root, wikiRoot) => {
      await Promise.all(paths.map((relative, index) =>
        fs.writeFile(path.join(root, relative), contents[index]!, "utf8")
      ));
      const initialAdapters: KnowledgeAdapter[] = factories.map((factory) => factory());
      const initialIndex = new PersistentCodeEvidenceIndex({
        repositoryRoot: root,
        wikiRoot,
        registry: new KnowledgeAdapterRegistry(initialAdapters),
      });
      await initialIndex.rebuild();
      const before = await initialIndex.snapshot();
      const adapters: KnowledgeAdapter[] = factories.map((factory) => factory());
      const changed = adapters[changedAdapterIndex]!;
      assert.equal("extensionClaims" in changed && Array.isArray(changed.extensionClaims), true);
      const upgraded: KnowledgeAdapter & { extensionClaims: readonly string[] } = {
        parserVersion: `${changed.parserVersion}-upgrade-test`,
        extensionClaims: [...(changed as KnowledgeAdapter & { extensionClaims: readonly string[] }).extensionClaims],
        supports: (source) => changed.supports(source),
        extract: (source) => changed.extract(source),
      };
      adapters[changedAdapterIndex] = upgraded;
      const changedIndex = new PersistentCodeEvidenceIndex({
        repositoryRoot: root,
        wikiRoot,
        registry: new KnowledgeAdapterRegistry(adapters),
      });
      const update = await changedIndex.rebuild();
      const after = await changedIndex.snapshot();
      assert.deepEqual({ reused: update.reusedFiles, reparsed: update.reparsedFiles }, { reused: 3, reparsed: 1 });
      for (const [fileIndex, relative] of paths.entries()) {
        const actual = after.files.find((file) => file.path === relative);
        if (fileIndex === changedAdapterIndex) {
          assert.equal(actual?.parserVersion, upgraded.parserVersion);
        } else {
          assert.deepEqual(actual, before.files.find((file) => file.path === relative));
        }
      }
    });
  }
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
