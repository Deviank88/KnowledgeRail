import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeQueryRuntime, normalizedQualifiedSymbol } from "../src/core/code-evidence/query-runtime.js";
import type { KnowledgeFragment } from "../src/core/code-evidence/types.js";

function fragment(id: string, overrides: Partial<KnowledgeFragment> = {}): KnowledgeFragment {
  return {
    id, symbol: id, qualifiedName: id, path: "src/same.ts", kind: "method", definition: id,
    range: { startLine: 1, endLine: 2 }, imports: [], references: [], calls: [], routes: [],
    configKeys: [], databaseRefs: [], isTest: false, ...overrides,
  };
}

function runtime(fragments: KnowledgeFragment[]): CodeQueryRuntime {
  return new CodeQueryRuntime({ version: 2, adapters: [], generatedAt: "fixture", files: [], fragments });
}

test("symbol lookup preserves partial matches, filters, normalized separators and stable ties", () => {
  const index = runtime([
    fragment("first", { symbol: "Order", qualifiedName: "Order", range: { startLine: 80, endLine: 81 } }),
    fragment("second", { symbol: "Order", qualifiedName: "Order" }),
    fragment("suffix", { symbol: "create", qualifiedName: "Namespace::Order" }),
    fragment("partial", { symbol: "SpecialOrder", qualifiedName: "SpecialOrder", kind: "function" }),
    fragment("hidden", { symbol: "Order", qualifiedName: "Order", path: "other/hidden.ts" }),
    fragment("module", { symbol: "Order", qualifiedName: "Order", kind: "module" }),
  ]);
  const search = (max: number) => index.symbol("order", { paths: ["src/"] }, max);
  assert.deepEqual(search(1).map((hit) => hit.fragment.id), ["first"]);
  assert.deepEqual(search(4).map((hit) => [hit.fragment.id, hit.score]), [
    ["first", 200], ["second", 200], ["suffix", 160], ["partial", 80],
  ]);
  assert.deepEqual(index.symbol("order", { kinds: ["function"] }, 1).map((hit) => hit.fragment.id), ["partial"]);
  for (const name of ["Namespace.Order", "Namespace::Order", "Namespace#Order", "Namespace\\Order", "Namespace->Order"]) {
    assert.equal(index.symbol(normalizedQualifiedSymbol(name), {}, 1)[0]?.fragment.id, "suffix");
  }
  assert.deepEqual(index.symbol("missing", {}, 100), []);
});

test("incoming reference indexes preserve relation priority, filters and original ordering", () => {
  const index = runtime([
    fragment("target", { symbol: "Target", qualifiedName: "Target", kind: "module", path: "lib/Module.ts", databaseRefs: ["orders"] }),
    fragment("reference", { references: ["Target"], imports: ["./Module"] }),
    fragment("caller-first", { calls: ["Ns.Target", "Target"], references: ["Target"] }),
    fragment("caller-second", { calls: ["Ｔａｒｇｅｔ"] }),
    fragment("test-caller", { calls: ["Target"], path: "tests/use.ts", isTest: true }),
    fragment("database", { databaseRefs: ["orders"] }),
    fragment("import", { imports: ["../lib/Module"] }),
    fragment("import-with-extension", { imports: ["../lib/Module.ts"] }),
  ]);
  assert.deepEqual(index.references("target", {}, 100).map((hit) => [hit.source.id, hit.relation]), [
    ["test-caller", "call"], ["caller-first", "call"], ["caller-second", "call"],
    ["reference", "reference"], ["database", "reference"], ["import", "import"], ["import-with-extension", "import"],
  ]);
  assert.deepEqual(index.references("target", { paths: ["src"] }, 2).map((hit) => hit.source.id), ["caller-first", "caller-second"]);
  assert.throws(() => index.references("missing", {}, 10), /Unknown code evidence symbol/);
});

test("bounded incoming selection matches a full ordering with duplicate relations, filters and ties", () => {
  const target = fragment("target", { symbol: "Target", qualifiedName: "Target", kind: "module", path: "lib/Module.ts" });
  const sources = Array.from({ length: 1_000 }, (_, i) => fragment(`source-${i}`, {
    path: `src/File${i % 17}.ts`,
    calls: i % 3 === 0 ? ["Ns.Target", "Target"] : [],
    references: i % 5 === 0 ? ["Target"] : [],
    imports: ["../lib/Module.ts"],
    isTest: i % 7 === 0,
    range: { startLine: i % 11 + 1, endLine: i % 11 + 2 },
  }));
  const index = runtime([target, ...sources]);
  for (const paths of [undefined, [], ["src"], ["src/File1.ts"], ["missing"]]) {
    const expected = sources.map((source, ordinal) => ({
      source, ordinal, relation: source.calls.length ? "call" : source.references.length ? "reference" : "import",
    })).filter(({ source }) => !paths?.length || paths.some((prefix) => source.path === prefix || source.path.startsWith(`${prefix}/`)))
      .sort((left, right) => ["call", "reference", "import"].indexOf(left.relation) - ["call", "reference", "import"].indexOf(right.relation) ||
        Number(right.source.isTest) - Number(left.source.isTest) || left.source.path.localeCompare(right.source.path) ||
        left.source.range.startLine - right.source.range.startLine || left.ordinal - right.ordinal)
      .map(({ source, relation }) => ({ source, target, relation }));
    for (const limit of [1, 2, 12, 100, 2_000]) assert.deepEqual(index.references(target.id, { paths }, limit), expected.slice(0, limit));
  }
});
