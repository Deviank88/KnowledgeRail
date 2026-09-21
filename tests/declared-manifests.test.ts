import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { codeEvidenceIndexFile, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { parseManifestToml } from "../src/core/code-evidence/manifest-toml.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { literalGlob } from "../src/core/code-evidence/literal-glob.js";

async function project(t: TestContext, files: Record<string, string>) {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-declared-manifests-")), wikiRoot = join(root, "wiki");
  const write = async (name: string, body: string) => { await fs.mkdir(dirname(join(root, name)), { recursive: true }); await fs.writeFile(join(root, name), body); };
  for (const [name, body] of Object.entries(files)) await write(name, body);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot }); await index.rebuild();
  const snapshot = await index.snapshot();
  const incoming = async (name: string) => {
    const module = snapshot.fragments.find((f) => f.path === name && f.kind === "module" && f.qualifiedName === name)!;
    assert.ok(module, name);
    return [...new Set((await index.references(module.id, { maxResults: 100 })).filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
  };
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, wikiRoot, index, snapshot, incoming, write };
}

test("C# keeps nested namespaces and joins partial types only within one project", async (t) => {
  const p = await project(t, {
    "app/App.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
    "app/A.cs": "namespace Company {\nnamespace Ledger {\npublic partial class Entry {\npublic void Save() {}\n}\n}\nnamespace Reports {\npublic class Summary {}\n}\n}\nnamespace Separate {\npublic class Other {}\n}\n",
    "app/B.cs": "namespace Company.Ledger;\npublic partial class Entry {}\n",
    "app/Run.cs": "using E = Company.Ledger.Entry;\nusing Company.Reports;\nusing Separate;\npublic class Run {}\n",
    "other/Other.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
    "other/Duplicate.cs": "namespace Company.Ledger;\npublic partial class Duplicate {}\n",
    "app/Duplicate.cs": "namespace Company.Ledger;\npublic partial class Duplicate {}\n",
    "app/Bad.cs": "using D = Company.Ledger.Duplicate;\npublic class Bad {}\n",
  });
  assert.deepEqual(await p.incoming("app/B.cs"), ["app/Run.cs"]);
  assert.deepEqual(await p.incoming("app/A.cs"), ["app/Run.cs"]);
  assert.deepEqual(await p.incoming("app/Duplicate.cs"), []);
  assert.deepEqual(await p.incoming("other/Duplicate.cs"), []);
  assert.ok(p.snapshot.fragments.some((f) => f.qualifiedName === "Company.Reports.Summary"));
  assert.ok(p.snapshot.fragments.some((f) => f.qualifiedName === "Separate.Other"));
  assert.ok(p.snapshot.fragments.some((f) => f.qualifiedName === "Company.Ledger.Entry.Save"));
});

test("JVM declarations span source roots and languages while duplicate Gradle modules and overloads remain ambiguous", async (t) => {
  const p = await project(t, {
    "settings.gradle.kts": 'include("app", "core", "alternative")\n',
    "app/build.gradle.kts": 'dependencies { implementation(project(":core")) }\n',
    "core/src/main/java/Model.java": 'package demo;\npublic class Model {}\nclass Companion {}\n',
    "core/generated/kotlin/Adapter.kt": 'package demo\nclass Adapter {}\n',
    "core/src/main/java/Constants.java": 'package demo;\npublic class Constants {\npublic static final int LIMIT = 1;\npublic static void work() {}\npublic static void work(int x) {}\n}\n',
    "core/src/main/kotlin/Same.kt": 'package collision\nclass Same {}\nfun choose(x: Int) {}\n',
    "alternative/src/main/kotlin/Same.kt": 'package collision\nclass Same {}\nfun choose(x: String) {}\n',
    "app/src/main/java/Run.java": 'import demo.Adapter;\nimport demo.Companion;\nimport static demo.Constants.LIMIT;\nimport static demo.Constants.work;\nimport collision.Same;\n/*\nimport missing.Fake;\n*/\npublic class Run {}\n',
    "app/src/main/kotlin/Run.kt": 'import demo.Model\nimport collision.choose\nfun run() {}\n',
  });
  assert.deepEqual(await p.incoming("core/src/main/java/Model.java"), ["app/src/main/java/Run.java", "app/src/main/kotlin/Run.kt"]);
  assert.deepEqual(await p.incoming("core/generated/kotlin/Adapter.kt"), ["app/src/main/java/Run.java"]);
  assert.deepEqual(await p.incoming("core/src/main/java/Constants.java"), ["app/src/main/java/Run.java"]);
  for (const path of ["core/src/main/kotlin/Same.kt", "alternative/src/main/kotlin/Same.kt"]) assert.deepEqual(await p.incoming(path), []);
  const result = await p.index.referencesWithDiagnostics(p.snapshot.fragments[0]!.id);
  assert.deepEqual(result.importDiagnostics.unresolvedImports.map((issue) => [issue.matchedName, issue.status]).sort(), [["collision.Same", "ambiguous"], ["collision.choose", "ambiguous"]]);
});

test("Ruby gemspec literal load paths are ordered, refreshed and isolated from relative requires", async (t) => {
  const p = await project(t, {
    "ledger.gemspec": "Gem::Specification.new do |s|\n  s.require_paths = ['odd', 'second']\nend\n",
    "odd/unit.rb": "module Unit\nend\n", "second/unit.rb": "module Unit\nend\n",
    "app/unit.rb": "module RelativeUnit\nend\n",
    "app/run.rb": "require 'unit'\nrequire_relative 'unit'\nrequire 'external_gem'\n",
  });
  assert.deepEqual(await p.incoming("odd/unit.rb"), ["app/run.rb"], JSON.stringify(await p.index.projectStructureWarnings()));
  assert.deepEqual(await p.incoming("second/unit.rb"), []);
  assert.deepEqual(await p.incoming("app/unit.rb"), ["app/run.rb"]);
  const bytes = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot));
  await p.write("ledger.gemspec", "Gem::Specification.new do |s|\ns.require_paths = %w[second]\nend\n");
  assert.deepEqual(await p.incoming("odd/unit.rb"), []);
  assert.deepEqual(await p.incoming("second/unit.rb"), ["app/run.rb"]);
  await p.write("ledger.gemspec", "Gem::Specification.new do |s|\ns.require_paths = compute_paths()\nend\n");
  assert.deepEqual(await p.incoming("second/unit.rb"), []);
  assert.deepEqual(await p.incoming("app/unit.rb"), ["app/run.rb"]);
  assert.ok((await p.index.projectStructureWarnings()).some((w) => w.reason === "dynamic_require_paths"));
  assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot)), bytes);
});

test("gemspec defaults require a declared specification; conditional and mutated paths stay unresolved", async (t) => {
  const p = await project(t, { "lib/unit.rb": "module Unit\nend\n", "run.rb": "require 'unit'\n" });
  assert.deepEqual(await p.incoming("lib/unit.rb"), []);
  await p.write("sample.gemspec", "Gem::Specification.new do |s|\ns.name = 'sample'\nend\n");
  assert.deepEqual(await p.incoming("lib/unit.rb"), ["run.rb"]);
  for (const body of ["if ENV['MODE']\ns.require_paths = ['lib']\nend", "s.require_paths = ['lib']\ns.require_paths.clear", "s.require_paths.push('lib')", "s.require_paths = ['lib' 'bad']"]) {
    await p.write("sample.gemspec", `Gem::Specification.new do |s|\n${body}\nend\n`);
    assert.deepEqual(await p.incoming("lib/unit.rb"), []);
  }
  await p.write("sample.gemspec", "Gem::Specification.new do |s|\ns.require_paths = [\n'lib', # literal\n]\nend\n");
  assert.deepEqual(await p.incoming("lib/unit.rb"), ["run.rb"]);
});

test("PHP uses declarations in each namespace and ignores fake imports and constants in HTML", async (t) => {
  const p = await project(t, {
    "definitions.php": '<p>namespace Fake; const WRONG = 1; use Bad\\Thing;</p>\n<?php namespace One {\nconst LIMIT = 2;\nfunction work() {}\nclass Item {}\n}\nnamespace Two {\nconst LIMIT = 3;\nfunction work() {}\n}\n?>\n<p>const OTHER = 4;</p>\n',
    "run.php": '<?php\nuse One\\{Item, function work, const LIMIT};\nuse const Two\\LIMIT as OTHER;\n',
    "wrong.php": '<?php\nuse function One\\LIMIT;\nuse const One\\Item;\nuse Fake\\WRONG;\n',
  });
  assert.deepEqual(await p.incoming("definitions.php"), ["run.php"]);
  const names = p.snapshot.fragments.filter((f) => f.kind === "constant").map((f) => f.qualifiedName).sort();
  assert.deepEqual(names, ["One\\LIMIT", "Two\\LIMIT"]);
  const selected = p.snapshot.fragments.find((f) => f.qualifiedName === "One\\LIMIT")!;
  assert.equal(selected.range.startLine, 3);
});

test("Composer classmap, files and PSR-0 preserve symbol kinds and literal exclusions", async (t) => {
  const p = await project(t, {
    "composer.json": JSON.stringify({ autoload: { classmap: ["odd/*"], "exclude-from-classmap": ["/odd/hidden/"], files: ["boot.php"], "psr-0": { "Legacy_": "old", "Vendor\\": "old" } } }),
    "odd/code/mixed.php": '<?php namespace Mapped;\nclass A {}\nclass B {}\n',
    "odd/hidden/Secret.php": '<?php namespace Mapped;\nclass Secret {}\n',
    "boot.php": '<?php namespace Mapped;\nconst LIMIT = 1;\nfunction work() {}\n',
    "notloaded.php": '<?php namespace Mapped;\nconst LIMIT = 2;\nfunction work() {}\n',
    "old/Legacy/Unit.php": '<?php\nclass Legacy_Unit {}\n',
    "old/Vendor/Legacy/Unit.php": '<?php namespace Vendor;\nclass Legacy_Unit {}\n',
    "run.php": '<?php\nuse Mapped\\{A, B, Secret};\nuse function Mapped\\work;\nuse const Mapped\\LIMIT;\nuse Legacy_Unit;\nuse Vendor\\Legacy_Unit;\n',
  });
  for (const path of ["odd/code/mixed.php", "boot.php", "old/Legacy/Unit.php", "old/Vendor/Legacy/Unit.php"]) assert.deepEqual(await p.incoming(path), ["run.php"], path);
  assert.deepEqual(await p.incoming("odd/hidden/Secret.php"), []);
  assert.deepEqual(await p.incoming("notloaded.php"), []);
  await p.write("composer.json", JSON.stringify({ autoload: { files: ["notloaded.php"] } }));
  assert.deepEqual(await p.incoming("boot.php"), []);
  assert.deepEqual(await p.incoming("notloaded.php"), ["run.php"]);
});

test("manifest glob matching preserves literal and slash semantics without exponential backtracking", () => {
  for (const [pattern, value, expected] of [
    ["pkg.*", "pkg.deep.unit", true], ["pkg.?", "pkg.é", true], ["pkg.?", "pkg.ab", false],
    ["pkg.+", "pkg.+", true], ["pkg.+", "pkg.x", false],
  ] as const) assert.equal(literalGlob(pattern, { questionMark: true })(value), expected);
  for (const [pattern, value, expected] of [
    ["odd/*/file.php", "odd/deep/file.php", true], ["odd/*/file.php", "odd/deep/more/file.php", false],
    ["odd/**/file.php", "odd/deep/more/file.php", true], ["odd/**tail", "odd/deep/moretail", true],
    ["odd/hidden", "odd/hidden/a.php", true], ["odd/hidden", "odd/hiddenish/a.php", false],
    ["odd/?", "odd/?/a.php", true], ["odd/?", "odd/a/a.php", false],
  ] as const) assert.equal(literalGlob(pattern, { pathPrefix: true })(value), expected);
  assert.equal(literalGlob(`${"*a".repeat(128)}b`)("a".repeat(512)), false);
  assert.equal(literalGlob(`${"**a".repeat(128)}b`, { pathPrefix: true })("a/".repeat(256)), false);
});

test("Composer PSR-0 prefixes cannot suppress a supported PSR-4 mapping", async (t) => {
  const p = await project(t, {
    "composer.json": JSON.stringify({ autoload: { "psr-4": { "Vendor\\": "src" }, "psr-0": { "Vendor\\Specific\\": "old" } } }),
    "src/Specific/Unit.php": '<?php namespace Vendor\\Specific;\nclass Unit {}\n',
    "run.php": '<?php\nuse Vendor\\Specific\\Unit;\n',
  });
  assert.deepEqual(await p.incoming("src/Specific/Unit.php"), ["run.php"]);
});

test("variable-name manifests retain ambiguity, deletion, recreation and nested update boundaries", async (t) => {
  const p = await project(t, { "nested/lib/unit.rb": "module Unit\nend\n", "nested/run.rb": "require 'unit'\n" });
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), []);
  const manifest = "Gem::Specification.new do |s|\ns.require_paths = ['lib']\nend\n";
  await p.write("nested/one.gemspec", manifest);
  await p.index.updateFile("nested/one.gemspec");
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), ["nested/run.rb"]);
  await p.write("nested/two.gemspec", manifest);
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), [], "multiple declarations cannot choose an arbitrary gem owner");
  await fs.unlink(join(p.root, "nested/two.gemspec"));
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), ["nested/run.rb"]);
  await fs.unlink(join(p.root, "nested/one.gemspec"));
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), []);
  await p.write("nested/one.gemspec", manifest);
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), ["nested/run.rb"]);
  const outside = await fs.mkdtemp(join(tmpdir(), "kr-outside-gemspec-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(join(outside, "one.gemspec"), manifest);
  await fs.unlink(join(p.root, "nested/one.gemspec"));
  await fs.symlink(join(outside, "one.gemspec"), join(p.root, "nested/one.gemspec"));
  assert.deepEqual(await p.incoming("nested/lib/unit.rb"), []);
  assert.ok((await p.index.projectStructureWarnings()).some((warning) => warning.path === "nested/one.gemspec" && warning.reason === "outside_repository"));
});

test("C/C++ compile commands preserve ordered roots, multiple configurations and source-relative includes", async (t) => {
  const p = await project(t, {
    "compile_commands.json": JSON.stringify([
      { directory: ".", file: "src/one.cpp", arguments: ["c++", "-Isecond", "-iquote", "first", "-c", "src/one.cpp"] },
      { directory: ".", file: "src/two.cpp", command: 'c++ -I "second" -c src/two.cpp' },
      { directory: ".", file: "src/multi.cpp", arguments: ["c++", "-Ifirst"] },
      { directory: ".", file: "src/multi.cpp", arguments: ["c++", "-Isecond"] },
    ]),
    "src/one.cpp": '#include "unit.h"\n#include "local.h"\n',
    "src/two.cpp": '#include "unit.h"\n#include <local.h>\n',
    "src/multi.cpp": '#include "unit.h"\n',
    "first/unit.h": "int first();\n", "second/unit.h": "int second();\n", "src/local.h": "int local();\n",
  });
  assert.deepEqual(await p.incoming("first/unit.h"), ["src/one.cpp"]);
  assert.deepEqual(await p.incoming("second/unit.h"), ["src/two.cpp"], JSON.stringify(await p.index.referencesWithDiagnostics(p.snapshot.fragments.find((f) => f.path === "second/unit.h" && f.kind === "module")!.id)));
  assert.deepEqual(await p.incoming("src/local.h"), ["src/one.cpp"]);
  await p.write("compile_commands.json", JSON.stringify([{ directory: p.root, file: join(p.root, "src/one.cpp"), arguments: ["c++", "-I", join(p.root, "second")] }]));
  assert.deepEqual(await p.incoming("second/unit.h"), ["src/one.cpp"]);
  assert.deepEqual(await p.incoming("first/unit.h"), []);
});

test("CMake literal targets ignore comments and strings, retain local includes and expose competing headers", async (t) => {
  const p = await project(t, {
    "CMakeLists.txt": 'project(Example)\n#[=[\ninclude_directories(fake)\n]=]\nset(doc "include_directories(fake)")\nadd_library(core src/core.cpp)\ntarget_include_directories(core PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include")\nadd_executable(other src/other.cpp)\n',
    "src/core.cpp": '#include "unit.h"\n#include "local.h"\n', "src/other.cpp": '#include "unit.h"\n',
    "include/unit.h": "int unit();\n", "fake/unit.h": "int fake();\n", "src/local.h": "int local();\n",
  });
  assert.deepEqual(await p.incoming("include/unit.h"), ["src/core.cpp"]);
  assert.deepEqual(await p.incoming("fake/unit.h"), []);
  await p.write("CMakeLists.txt", 'include_directories(include fake)\n');
  assert.deepEqual(await p.incoming("include/unit.h"), []);
  assert.deepEqual(await p.incoming("fake/unit.h"), []);
  await p.write("CMakeLists.txt", 'if(A AND (B OR C))\ninclude_directories(include)\nendif()\n');
  assert.deepEqual(await p.incoming("include/unit.h"), []);
  assert.deepEqual(await p.incoming("src/local.h"), ["src/core.cpp"]);
  assert.ok((await p.index.projectStructureWarnings()).some((w) => w.reason === "conditional_cmake_declaration"));
});

test("TOML preserves quoted keys, inline tables, comments, multiline arrays and literal strings; malformed declarations fail", () => {
  const parsed = parseManifestToml('[project]\nname = "ledger"\ndescription = """line one\nline two"""\n[tool.setuptools]\npackage-dir = {"" = \'odd#path\'} # trailing\npy-modules = [\n"orders", # module\n]\n[[bin]]\nname="cli"\npath="entry.rs"\n');
  assert.equal((parsed.project as { description: string }).description, "line one\nline two");
  assert.equal((((parsed.tool as Record<string, unknown>).setuptools as Record<string, unknown>)["package-dir"] as Record<string, string>)[""], "odd#path");
  for (const content of ['[x]\na=1\na=2', '[x]\n[x]', 'a = ["x"', 'a = {x="y",}', 'a="\\q"', '[x]\na = execute()', 'a=' + '['.repeat(40) + '0' + ']'.repeat(40)]) {
    assert.throws(() => parseManifestToml(content), /TOML/);
  }
});

test("TOML projection skips unrelated values and fake headers but validates selected declarations", () => {
  const fields = [["tool", "setuptools", "package-dir"]];
  const content = 'released=2026-09-06\n[tool.ruff]\ninvalid option = execute()\ntext="""\n[tool.setuptools]\npackage-dir={""="fake"}\n"""\n[tool.setuptools]\npackage-dir={""="real"}\n';
  const parsed = parseManifestToml(content, fields);
  assert.equal(((parsed.tool as any).setuptools["package-dir"])[""], "real");
  assert.equal((parsed.tool as any).ruff, undefined);
  const quoted = parseManifestToml('[tool.ruff]\ntext="""quote at the end""""\n[tool.setuptools]\npackage-dir={""="real"}', fields);
  assert.equal(((quoted.tool as any).setuptools["package-dir"])[""], "real");
  const inline = parseManifestToml('tool={ruff={date=2026-09-06, text="[tool.setuptools]"},setuptools={package-dir={""="real"}}}', fields);
  assert.equal(((inline.tool as any).setuptools["package-dir"])[""], "real");
  const dotted = parseManifestToml('tool.setuptools.package-dir.""="real"\ntool.ruff.date=2026-09-06', fields);
  assert.equal(((dotted.tool as any).setuptools["package-dir"])[""], "real");
  assert.throws(() => parseManifestToml('[tool.setuptools]\npackage-dir=2026-09-06', fields), /TOML/);
  assert.throws(() => parseManifestToml('[tool.ruff]\ntext="""unclosed\n[tool.setuptools]\npackage-dir={}', fields), /TOML/);
});

test("Python ignores unrelated tool grammar and retains package boundaries for unsupported build backends", async (t) => {
  const p = await project(t, {
    "pyproject.toml": '[project]\nreleased=2026-09-06\n[tool.ruff]\nfuture=execute()\n[tool.setuptools]\npackage-dir={""="odd"}\npy-modules=["unit"]\n',
    "odd/unit.py": "value=1\n", "tests/test_unit.py": "import unit\nimport pkg.mod\n",
    "pkg/__init__.py": "value=1\n", "pkg/mod.py": "value=2\n", "pkg/run.py": "import pkg.mod\n",
  });
  assert.deepEqual(await p.incoming("odd/unit.py"), ["tests/test_unit.py"]);
  assert.deepEqual(await p.index.projectStructureWarnings(), []);
  const bytes = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot));
  for (const backend of ["custom_builder", "unrelated_tool"]) {
    await p.write("pyproject.toml", `[project]\nreleased=2026-09-06\n[tool.${backend}]\npackages=["pkg"]\n`);
    assert.deepEqual(await p.incoming("pkg/mod.py"), ["pkg/run.py"], backend);
    assert.deepEqual(await p.incoming("odd/unit.py"), [], "tests outside a package need supported declared roots");
    assert.deepEqual(await p.index.projectStructureWarnings(), []);
  }
  await p.write("pyproject.toml", '[tool.setuptools]\npackage-dir={""=2026-09-06}\n');
  assert.deepEqual(await p.incoming("pkg/mod.py"), []);
  assert.ok((await p.index.projectStructureWarnings()).some((w) => w.reason === "invalid_manifest"));
  assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot)), bytes);
});

test("Cargo workspace member problems warn without discarding valid root-package targets", async (t) => {
  const declaration = '[package]\nname="root"\nrelease-date=2026-09-06\n[lib]\npath="odd/entry.rs"\n';
  const p = await project(t, {
    "Cargo.toml": declaration + '[workspace]\nmembers=["crates/*", "member"]\n',
    "odd/entry.rs": "mod unit;\nuse crate::unit::run;", "odd/unit.rs": "pub fn run() {}",
    "member/Cargo.toml": '[package]\nname="member"\n', "member/src/lib.rs": "mod unit;\nuse crate::unit::run;", "member/src/unit.rs": "pub fn run() {}",
  });
  const bytes = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot));
  assert.deepEqual(await p.incoming("odd/unit.rs"), ["odd/entry.rs"]);
  assert.deepEqual(await p.incoming("member/src/unit.rs"), ["member/src/lib.rs"]);
  assert.ok(!(await p.index.projectStructureWarnings()).some((w) => w.reason === "unsupported_cargo_workspace_glob"));
  await p.write("Cargo.toml", declaration + '[workspace]\nmembers=42\n');
  assert.deepEqual(await p.incoming("odd/unit.rs"), ["odd/entry.rs"]);
  assert.ok((await p.index.projectStructureWarnings()).some((w) => w.reason === "invalid_cargo_workspace_members"));
  await p.write("Cargo.toml", '[package]\nname="root"\n[lib]\npath=2026-09-06\n');
  assert.deepEqual(await p.incoming("odd/unit.rs"), []);
  assert.ok((await p.index.projectStructureWarnings()).some((w) => w.reason === "invalid_manifest"));
  assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot)), bytes);
});

test("Python declared module roots refresh without source extraction or snapshot writes", async (t) => {
  const p = await project(t, {
    "pyproject.toml": '[project]\nname="example"\n[tool.setuptools]\npackage-dir={""="odd/application"}\npy-modules=["orders"]\n',
    "odd/application/orders.py": "def place():\n return 1\n", "odd/application/hidden.py": "value=1\n", "elsewhere/orders.py": "value=2\n",
    "cli.py": "from orders import place\nimport hidden\n", "nested/pyproject.toml": '[tool.setuptools]\npy-modules=[]\n', "nested/use.py": "import orders\n",
  });
  const bytes = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot));
  assert.deepEqual(await p.incoming("odd/application/orders.py"), ["cli.py"]);
  assert.deepEqual(await p.incoming("odd/application/hidden.py"), []);
  await p.write("pyproject.toml", '[tool.setuptools]\npackage-dir={""="elsewhere"}\npy-modules=["orders"]\n');
  assert.deepEqual(await p.incoming("odd/application/orders.py"), []);
  assert.deepEqual(await p.incoming("elsewhere/orders.py"), ["cli.py"]);
  await p.write("pyproject.toml", '[tool.setuptools]\npackage-dir={""="../outside"}\n');
  assert.deepEqual(await p.incoming("elsewhere/orders.py"), []);
  assert.ok((await p.index.projectStructureWarnings()).some((w) => w.reason === "invalid_manifest"));
  assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot)), bytes);
});

test("Python setup.cfg named packages and child overrides preserve logical relative imports", async (t) => {
  const p = await project(t, {
    "pyproject.toml": '[build-system]\nrequires=["setuptools"]\n',
    "setup.cfg": '[metadata]\nname=example\n[options]\npackages=\n billing\n billing.rules\npackage_dir=\n billing=unusual\n billing.rules=policies\n',
    "unusual/__init__.py": "value=0\n", "unusual/run.py": "from .rules import value\n", "policies/__init__.py": "value=1\n",
    "policies/check.py": "from .. import value\n", "cli.py": "import billing.rules.check\n", "decoy/rules/check.py": "value=9\n",
  });
  assert.deepEqual(await p.incoming("policies/__init__.py"), ["unusual/run.py"]);
  assert.deepEqual(await p.incoming("unusual/__init__.py"), ["policies/check.py"]);
  assert.deepEqual(await p.incoming("policies/check.py"), ["cli.py"]);
  assert.deepEqual(await p.incoming("decoy/rules/check.py"), []);
});

test("Python discovery uses declared roots and package boundaries, not implicit namespaces or excluded packages", async (t) => {
  const p = await project(t, {
    "pyproject.toml": '[tool.setuptools.packages.find]\nwhere=["custom"]\ninclude=["bill*"]\nexclude=["billing.tests*"]\nnamespaces=false\n',
    "custom/billing/__init__.py": "value=0\n", "custom/billing/order.py": "value=1\n", "custom/billing/tests/__init__.py": "value=2\n",
    "custom/bill_ns/unit.py": "value=3\n", "app.py": "import billing.order\nimport billing.tests\nimport bill_ns.unit\n",
  });
  assert.deepEqual(await p.incoming("custom/billing/order.py"), ["app.py"]);
  assert.deepEqual(await p.incoming("custom/billing/tests/__init__.py"), []);
  assert.deepEqual(await p.incoming("custom/bill_ns/unit.py"), []);
});

test("Composer validates PSR-4 classes, dev mappings and project ownership; edits invalidate without rebuilding", async (t) => {
  const p = await project(t, {
    "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "strange/" } }, "autoload-dev": { "psr-4": { "Spec\\": ["tests/"] } } }),
    "strange/Orders.php": "<?php\nnamespace App;\nclass Orders {}", "wrong/Orders.php": "<?php\nnamespace App;\nclass Orders {}",
    "tests/Helper.php": "<?php\nnamespace Spec;\nclass Helper {}", "index.php": "<?php\nuse App\\Orders;\nuse Spec\\Helper;",
    "vendor/component/composer.json": '{"autoload":{"psr-4":{"App\\\\":"src/"}}}', "vendor/component/src/Orders.php": "<?php\nnamespace App;\nclass Orders {}",
  });
  assert.deepEqual(await p.incoming("strange/Orders.php"), ["index.php"]);
  assert.deepEqual(await p.incoming("wrong/Orders.php"), []);
  assert.deepEqual(await p.incoming("tests/Helper.php"), ["index.php"]);
  const bytes = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot));
  await p.write("composer.json", '{"autoload":{"psr-4":{"App\\\\":"wrong/"}}}');
  assert.deepEqual(await p.incoming("strange/Orders.php"), []);
  assert.deepEqual(await p.incoming("wrong/Orders.php"), ["index.php"]);
  assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot)), bytes);
  await p.write("composer.json", '{"name":"example/project"}');
  assert.deepEqual(await p.incoming("tests/Helper.php"), ["index.php"]);
  assert.deepEqual(await p.incoming("wrong/Orders.php"), []); // Duplicate declarations remain ambiguous.
});

test("Cargo custom roots, explicit workspace members and manifest changes retain crate boundaries", async (t) => {
  const p = await project(t, {
    "Cargo.toml": '[workspace]\nmembers=["component"]\n',
    "component/Cargo.toml": '[package]\nname="billing-core"\nversion="0.1.0"\n[lib]\npath="odd/entry.rs"\n',
    "component/odd/entry.rs": "mod orders;\nuse crate::orders::place;\npub fn run() {}", "component/odd/orders.rs": "pub fn place() {}",
    "component/else/orders.rs": "pub fn place() {}", "other/Cargo.toml": '[package]\nname="other"\n',
    "other/src/lib.rs": "use billing_core::orders::place;\nuse crate::orders::place;", "other/src/orders.rs": "pub fn place() {}",
  });
  assert.deepEqual(await p.incoming("component/odd/orders.rs"), ["component/odd/entry.rs"]);
  assert.deepEqual(await p.incoming("other/src/orders.rs"), ["other/src/lib.rs"]);
  assert.deepEqual(await p.incoming("component/else/orders.rs"), []);
  const bytes = await fs.readFile(codeEvidenceIndexFile(p.wikiRoot));
  await p.write("component/Cargo.toml", '[package]\nname="billing-core"\n[lib]\npath="else/missing.rs"\n');
  assert.deepEqual(await p.incoming("component/odd/orders.rs"), []);
  assert.deepEqual(await fs.readFile(codeEvidenceIndexFile(p.wikiRoot)), bytes);
});

test("Ruby relative paths and C quoted includes never attach unrelated, system or implementation twins", async (t) => {
  const p = await project(t, {
    "odd/orders.rb": "def place\n 1\nend", "foreign/orders.rb": "def other\n 2\nend", "odd/main.rb": "require_relative 'orders.rb'\nrequire 'external'\n",
    "odd/missing.rb": "require_relative '../absent/orders'\n", "orders.h": "int root();", "odd/orders.h": "int place();", "odd/orders.cpp": "int place() { return 1; }",
    "odd/main.cpp": '#include "orders.h"\n#include <orders.h>\n/*\n#include "../orders.h"\n*/\nint main() {}', "entry.cpp": '#include "odd/orders.h"\n',
  });
  assert.deepEqual(await p.incoming("odd/orders.rb"), ["odd/main.rb"]);
  assert.deepEqual(await p.incoming("foreign/orders.rb"), []);
  assert.deepEqual(await p.incoming("orders.h"), []);
  assert.deepEqual(await p.incoming("odd/orders.h"), ["entry.cpp", "odd/main.cpp"]);
  assert.deepEqual(await p.incoming("odd/orders.cpp"), []);
});

test("TS extraction excludes comments, templates and strings without swallowing subsequent genuine imports", async (t) => {
  const p = await project(t, {
    "unit.ts": "export const value=1;", "decoy.ts": "export const value=2;",
    "main.ts": '// import "./decoy"\nconst text = `import {fake} from "./decoy"; require("./decoy")`;\nconst example = \'import "./decoy"\';\nimport {value} from "./unit";\n',
    "bindings.ts": 'import { "export-name" as renamed /* from "./decoy" */ } from "./unit";\n',
    "large.ts": `import { ${Array.from({ length: 10000 }, (_, i) => `value${i}`).join(", ")} } from "./unit";`,
  });
  assert.deepEqual(await p.incoming("unit.ts"), ["bindings.ts", "large.ts", "main.ts"]);
  assert.deepEqual(await p.incoming("decoy.ts"), []);
});
