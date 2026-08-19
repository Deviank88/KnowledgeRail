import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import {
  maskPythonSource,
  PythonKnowledgeAdapter,
} from "../src/core/code-evidence/python-adapter.js";

const FIXTURE_ROOT = path.resolve("tests/fixtures/code-evidence");
const PYTHON_ROOT = path.join(FIXTURE_ROOT, "python");

async function fixtureFragments(name: string) {
  const content = await fs.readFile(path.join(PYTHON_ROOT, name), "utf8");
  return new PythonKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: `python/${name}`,
    content,
  });
}

test("Python masking preserves offsets, UTF-8 width, and newlines across adversarial strings", () => {
  const content = [
    "a = r'fake_raw()'",
    "b = BR\"fake_bytes()\"",
    "c = f\"{lookup(\"fake_nested\", {\"brace\": 1})}\"",
    "d = rf'''caffè λ",
    "def fake_triple():",
    "    pass",
    "'''",
    "def visible():",
    "    return print('ok')",
    "",
  ].join("\n");
  const masked = maskPythonSource(content);
  assert.equal(masked.length, content.length);
  assert.equal(Buffer.byteLength(masked), Buffer.byteLength(content));
  assert.deepEqual(
    [...masked].flatMap((value, index) => value === "\n" ? [index] : []),
    [...content].flatMap((value, index) => value === "\n" ? [index] : [])
  );
  for (const hidden of ["fake_raw", "fake_bytes", "fake_nested", "fake_triple", "caffè"]) {
    assert.equal(masked.includes(hidden), false);
  }
  assert.equal(masked.includes("visible"), true);
  assert.equal(masked.includes("print"), true);
});

test("Python extraction pins indentation, decorators, nesting, docstrings, and masked f-string calls", async () => {
  const fragments = await fixtureFragments("order_service.py");
  assert.deepEqual(await fixtureFragments("order_service.py"), fragments);
  const fragment = (name: string) => fragments.find((item) => item.qualifiedName === name);
  assert.deepEqual(fragment("OrderService.place")?.range, { startLine: 21, endLine: 35 });
  assert.equal(fragment("OrderService.place")?.definition,
    "async def place( self, order_id: str, *, validate: bool = True, ) -> dict[str, str]:");
  assert.equal(fragment("OrderService.place")?.docComment, "Validate and persist one order.");
  assert.deepEqual(fragment("OrderService.place")?.routes, [
    { method: "POST", path: "/orders", handler: "OrderService.place" },
  ]);
  assert.equal(fragment("OrderService._validator.validate_order")?.kind, "function");
  assert.equal(fragment("OrderService.Metrics.increment")?.kind, "method");
  assert.deepEqual(fragment("load_order")?.databaseRefs, ["orders"]);
  assert.equal(fragment("build_label")?.calls.includes("lookup"), false);
  for (const hidden of ["fake_top_level", "class_factory"]) {
    assert.equal(fragments.some((item) => item.symbol === hidden || item.calls.includes(hidden)), false);
  }
  assert.equal(fragments.find((item) => item.kind === "module")?.docComment,
    "Order application service and HTTP entry points.");
});

test("Python route extraction covers Flask, Flask blueprints, and Django handler binding", async () => {
  const flask = await fixtureFragments("flask_app.py");
  assert.deepEqual(flask.find((item) => item.qualifiedName === "administer_orders")?.routes, [
    { method: "GET", path: "/admin/orders", handler: "administer_orders" },
    { method: "DELETE", path: "/admin/orders", handler: "administer_orders" },
  ]);
  assert.deepEqual(flask.find((item) => item.qualifiedName === "administer_orders")?.configKeys, ["ORDER_QUEUE"]);
  assert.deepEqual(flask.find((item) => item.qualifiedName === "create_blueprint_order")?.routes, [
    { method: "POST", path: "/blueprint/orders", handler: "create_blueprint_order" },
  ]);
  const django = (await fixtureFragments("urls.py")).filter((item) => item.kind === "route");
  assert.deepEqual(django.map((item) => item.routes[0]).sort((left, right) => left!.path.localeCompare(right!.path)), [
    { method: "ANY", path: "/^orders/(?P<order_id>[0-9]+)/$", handler: "views.order_detail" },
    { method: "ANY", path: "/orders/", handler: "views.list_orders" },
  ]);
  assert.deepEqual(django.map((item) => item.range).sort((left, right) => left.startLine - right.startLine), [
    { startLine: 7, endLine: 7 },
    { startLine: 8, endLine: 8 },
  ]);
});

test("Python test conventions and .pyi declarations remain distinct", async () => {
  const tests = await fixtureFragments("test_order_service.py");
  assert.equal(tests.find((item) => item.qualifiedName === "test_places_order")?.kind, "test");
  assert.equal(tests.find((item) => item.qualifiedName === "OrderServiceTests.test_loads_order")?.isTest, true);
  assert.equal(tests.find((item) => item.qualifiedName === "repository")?.isTest, true);

  const stubs = await fixtureFragments("contracts.pyi");
  assert.equal(stubs.every((item) => item.isTest === false), true);
  assert.deepEqual(stubs.find((item) => item.qualifiedName === "OrderRepository.load")?.range, {
    startLine: 11,
    endLine: 11,
  });
  assert.equal(stubs.some((item) => item.kind === "route"), false);
});

test("Python indentation uses tab stops and ignores dedented source text inside triple strings", async () => {
  const fragments = await fixtureFragments("strings_and_indentation.py");
  assert.deepEqual(fragments.find((item) => item.qualifiedName === "TabIndented.calculate")?.range, {
    startLine: 13,
    endLine: 20,
  });
  assert.deepEqual(fragments.find((item) => item.qualifiedName === "SpaceIndented.visible")?.range, {
    startLine: 25,
    endLine: 34,
  });
  assert.equal(fragments.find((item) => item.qualifiedName === "SpaceIndented.visible")?.docComment,
    "Fallback documentation for the visible method.");
  assert.equal(fragments.find((item) => item.qualifiedName === "testimonial_view")?.kind, "function");
  assert.equal(fragments.find((item) => item.qualifiedName === "testimonial_view")?.isTest, false);
  assert.equal(fragments.find((item) => item.qualifiedName === "inline_documented")?.docComment,
    "Inline one-line documentation.");
  for (const hidden of ["fake_raw", "FakeBytes", "fake_adjacent", "fake_from_triple", "FakeFromTriple"]) {
    assert.equal(fragments.some((item) => item.symbol === hidden), false);
  }
});

test("Python logical lines retain relative imports, exports, config, and database evidence", async () => {
  const content = [
    "from ..orders import (",
    "    handler as bound_handler,",
    "    Order,",
    ")",
    "",
    "AUDIT = Table(\"audit_log\", metadata)",
    "REGION = os.environ[\"ORDER_REGION\"]",
    "__all__ = [\"joined\"]",
    "",
    "def joined(value: str, \\",
    "           suffix: str) -> str:",
    "    \"\"\"Join two values",
    "    without exposing indentation.\"\"\"",
    "    return bound_handler(value, suffix, settings.DEFAULT_TENANT)",
    "",
  ].join("\n");
  const fragments = await new PythonKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "python/logical_lines.py",
    content,
  });
  const module = fragments.find((item) => item.kind === "module")!;
  const joined = fragments.find((item) => item.qualifiedName === "joined")!;
  assert.deepEqual(module.imports, ["..orders"]);
  for (const reference of ["bound_handler", "Order", "joined"]) assert.equal(module.references.includes(reference), true);
  assert.deepEqual(module.configKeys, ["DEFAULT_TENANT", "ORDER_REGION"]);
  assert.deepEqual(module.databaseRefs, ["audit_log"]);
  assert.equal(joined.definition, "def joined(value: str, suffix: str) -> str:");
  assert.equal(joined.docComment, "Join two values without exposing indentation.");
  assert.equal(joined.calls.includes("bound_handler"), true);
  assert.deepEqual(joined.configKeys, ["DEFAULT_TENANT"]);
});

test("Python prose in docstrings does not become configuration or database evidence", async () => {
  const content = [
    "def documented():",
    "    \"\"\"Call os.getenv(\"FAKE_KEY\"), read settings.FAKE_SETTING,",
    "    then SELECT value FROM fake_docs in this example.\"\"\"",
    "    return settings.REAL_SETTING",
    "",
  ].join("\n");
  const fragments = await new PythonKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "python/documented.py",
    content,
  });
  const documented = fragments.find((item) => item.qualifiedName === "documented")!;
  assert.deepEqual(documented.configKeys, ["REAL_SETTING"]);
  assert.deepEqual(documented.databaseRefs, []);
});

test("Python scanning stays bounded on deep continuations and large triple strings", { timeout: 2_000 }, async () => {
  const depth = 5_000;
  const content = [
    `VALUE = ${"(".repeat(depth)}1${")".repeat(depth)}`,
    `TEXT = \"\"\"${"x".repeat(512_000)}\"\"\"`,
    "def visible():",
    "    return VALUE",
    "",
  ].join("\n");
  const fragments = await new PythonKnowledgeAdapter().extract({
    repositoryRoot: FIXTURE_ROOT,
    path: "python/pathological.py",
    content,
  });
  assert.deepEqual(fragments.find((item) => item.qualifiedName === "visible")?.range, {
    startLine: 3,
    endLine: 4,
  });
});
