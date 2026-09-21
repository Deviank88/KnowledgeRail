import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { PersistentCodeEvidenceIndex, codeEvidenceIndexFile, getCodeQueryCacheDiagnostics } from "../src/core/code-evidence/index.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { codeRequestLanguage } from "../src/core/code-evidence/request-telemetry.js";

async function project(t: TestContext, files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-declared-extensions-"));
  const write = async (name: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  };
  for (const [name, content] of Object.entries(files)) await write(name, content);
  const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot: path.join(root, "wiki") });
  await index.rebuild();
  const references = async (file: string) => {
    const target = (await index.snapshot()).fragments.find((fragment) => fragment.path === file && fragment.kind === "module")!;
    assert.ok(target, file);
    return index.referencesWithDiagnostics(target.id, { maxResults: 100 });
  };
  const incoming = async (file: string) => [...new Set((await references(file)).references.filter((hit) => hit.relation === "import").map((hit) => hit.source.path))].sort();
  t.after(async () => { clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, index, write, incoming, references };
}

test("platform imports do not consume the actionable sample; dynamic and verified unindexed imports have causes", async (t) => {
  const p = await project(t, {
    "main.js": 'import { LightningElement } from "lwc"; import "lightning/uiRecordApi"; import "@salesforce/user/Id"; import "./data.json"; const x = import(variable); require(dynamicName);',
    "data.json": "{}",
  });
  const { importDiagnostics: d } = await p.references("main.js");
  assert.equal(d.importResolutionCounts?.["typescript-javascript"]?.platform, 3);
  assert.equal(d.importResolutionCounts?.["typescript-javascript"]?.unresolved, 3);
  assert.deepEqual(d.unresolvedImports.map((issue) => issue.reason).sort(), ["not_indexed", "unsupported_syntax", "unsupported_syntax"]);
  assert.equal(d.unresolvedImportsTruncated, false);
});

test("Salesforce metadata imports use entity names and respect nested project boundaries", async (t) => {
  const p = await project(t, {
    "sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "custom" }, { path: "other" }] }),
    "custom/lwc/card/card.js": 'import "@salesforce/label/c.Caption"; import "@salesforce/resourceUrl/icon"; import "@salesforce/messageChannel/Updates__c"; import "c/duplicate"; import "c/nested";',
    "custom/labels/Custom.labels-meta.xml": '<CustomLabels><labels><fullName>Caption</fullName></labels><labels><fullName>Second</fullName></labels></CustomLabels>',
    "custom/staticresources/icon.resource-meta.xml": '<StaticResource><contentType>image/png</contentType></StaticResource>',
    "custom/messageChannels/Updates.messageChannel-meta.xml": '<LightningMessageChannel><masterLabel>Updates</masterLabel></LightningMessageChannel>',
    "custom/lwc/duplicate/duplicate.js": "export const value = 1;",
    "other/lwc/duplicate/duplicate.js": "export const value = 2;",
    "custom/nested/sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "pkg" }] }),
    "custom/nested/pkg/lwc/nested/nested.js": "export const value = 3;",
  });
  for (const file of ["custom/labels/Custom.labels-meta.xml", "custom/staticresources/icon.resource-meta.xml", "custom/messageChannels/Updates.messageChannel-meta.xml"]) {
    assert.deepEqual(await p.incoming(file), ["custom/lwc/card/card.js"]);
  }
  assert.deepEqual(await p.incoming("custom/nested/pkg/lwc/nested/nested.js"), []);
  const d = (await p.references("custom/lwc/card/card.js")).importDiagnostics;
  assert.ok(d.unresolvedImports.some((issue) => issue.specifier === "c/duplicate" && issue.status === "ambiguous" && issue.candidateCount === 2));
  assert.equal((await p.index.symbol("Second"))[0]?.fragment.kind, "constant");
});

test("trigger headers are references, literal markup resolves Apex, and metadata-only updates refresh status", async (t) => {
  const p = await project(t, {
    "triggers/Audit.trigger": "trigger Audit on Invoice__c (before insert) { System.debug(Trigger.new); }",
    "objects/Invoice__c/Invoice__c.object-meta.xml": "<CustomObject><label>Invoice</label></CustomObject>",
    "classes/Controller.cls": "public class Controller {}",
    "classes/Controller.cls-meta.xml": "<ApexClass><status>Active</status></ApexClass>",
    "pages/View.page": '<apex:page controller="Controller" />',
    "pages/Dynamic.page": '<apex:page controller="{!controller}" />',
    "aura/View/View.cmp": '<aura:component controller="Controller" />',
  });
  const object = (await p.index.symbol("Invoice__c"))[0]!.fragment;
  const triggerRefs = (await p.index.references(object.id)).filter((hit) => hit.source.path.endsWith(".trigger"));
  assert.ok(triggerRefs.length); assert.ok(triggerRefs.every((hit) => hit.relation === "reference"));
  const markup = (await p.references("classes/Controller.cls")).references;
  assert.deepEqual([...new Set(markup.map((hit) => hit.source.path))].sort(), ["aura/View/View.cmp", "pages/View.page"]);
  assert.ok(markup.every((hit) => hit.relation === "reference"));
  await p.write("classes/Controller.cls-meta.xml", "<ApexClass><status>Inactive</status></ApexClass>");
  const report = await p.index.updateFile("classes/Controller.cls-meta.xml");
  assert.equal(report.reparsedFiles, 0);
  assert.equal((await p.index.symbol("Controller"))[0]!.fragment.deploymentStatus, "Inactive");
  await fs.rm(path.join(p.root, "classes/Controller.cls-meta.xml"));
  await p.index.removeFile("classes/Controller.cls-meta.xml");
  assert.equal((await p.index.symbol("Controller"))[0]!.fragment.deploymentStatus, undefined);
  assert.equal(codeRequestLanguage(["classes/Controller.cls-meta.xml"]), "unsupported");
  assert.equal(codeRequestLanguage(["labels/Custom.labels-meta.xml"]), "sfmeta");
});

for (const [backend, declaration] of [
  ["poetry", '[build-system]\nbuild-backend="poetry.core.masonry.api"\n[tool.poetry]\npackages=[{include="sample",from="odd"}]'],
  ["hatch", '[build-system]\nbuild-backend="hatchling.build"\n[tool.hatch.build.targets.wheel]\npackages=["odd/sample"]'],
  ["pdm", '[build-system]\nbuild-backend="pdm.backend"\n[tool.pdm.build]\npackage-dir="odd"\nincludes=["odd/sample"]'],
] as const) test(`${backend} resolves declared regular packages from arbitrary roots`, async (t) => {
  const p = await project(t, { "pyproject.toml": declaration, "odd/sample/__init__.py": "", "odd/sample/value.py": "VALUE = 1", "tests/run.py": "import sample.value" });
  assert.deepEqual(await p.incoming("odd/sample/value.py"), ["tests/run.py"]);
});

test("Flit defaults are declared; conflicting backend declarations retain a closed boundary", async (t) => {
  const p = await project(t, { "pyproject.toml": '[build-system]\nbuild-backend="flit_core.buildapi"\n[project]\nname="sample"',
    "src/sample/__init__.py": "", "src/sample/value.py": "VALUE = 1", "tests/run.py": "import sample.value" });
  assert.deepEqual(await p.incoming("src/sample/value.py"), ["tests/run.py"]);
  await p.write("pyproject.toml", '[tool.flit.module]\nname="sample"\n[tool.poetry]\npackages=[{include="sample",from="src"}]');
  assert.deepEqual(await p.incoming("src/sample/value.py"), []);
  assert.ok((await p.references("src/sample/value.py")).manifestWarnings.some((warning) => warning.reason === "conflicting_python_backends"));
  await p.write("src/sample/local.py", "from . import value");
  await p.index.updateFile("src/sample/local.py");
  assert.deepEqual(await p.incoming("src/sample/__init__.py"), ["src/sample/local.py"]);
});

test("local workspaces honor exports, import/require conditions, private aliases and package encapsulation", async (t) => {
  const p = await project(t, {
    "package.json": JSON.stringify({ workspaces: ["packages/*"], dependencies: { external: "1" }, imports: { "#local": "./local.ts" } }),
    "packages/lib/package.json": JSON.stringify({ name: "@app/lib", exports: { ".": { import: "./esm.js", require: "./cjs.js" }, "./feature/*": "./features/*.js" } }),
    "packages/lib/esm.ts": "export const value = 1;", "packages/lib/cjs.ts": "export const value = 2;",
    "packages/lib/features/a.ts": "export const feature = 1;", "packages/lib/private.ts": "export const secret = 1;",
    "local.ts": "export const local = 1;",
    "main.ts": 'import "@app/lib"; import "@app/lib/feature/a"; import "#local"; import "external/subpath"; import "@app/lib/private";',
    "legacy.cjs": 'require("@app/lib");',
  });
  assert.deepEqual(await p.incoming("packages/lib/esm.ts"), ["main.ts"]);
  assert.deepEqual(await p.incoming("packages/lib/cjs.ts"), ["legacy.cjs"]);
  assert.deepEqual(await p.incoming("packages/lib/features/a.ts"), ["main.ts"]);
  assert.deepEqual(await p.incoming("packages/lib/private.ts"), []);
  assert.deepEqual(await p.incoming("local.ts"), ["main.ts"]);
  const d = (await p.references("main.ts")).importDiagnostics;
  assert.equal(d.importResolutionCounts?.["typescript-javascript"]?.external_dependency, 1);
  assert.ok(!d.unresolvedImports.some((issue) => issue.specifier === "external/subpath"));
});

test("project references select owning configs and overlapping ownership remains ambiguous", async (t) => {
  const p = await project(t, {
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.test.json" }] }),
    "tsconfig.app.json": JSON.stringify({ include: ["app/**/*.ts"], compilerOptions: { paths: { "@value": ["./a.ts"] } } }),
    "tsconfig.test.json": JSON.stringify({ include: ["test/**/*.ts"], compilerOptions: { paths: { "@value": ["./b.ts"] } } }),
    "a.ts": "export const a = 1;", "b.ts": "export const b = 1;",
    "app/main.ts": 'import "@value";', "test/main.ts": 'import "@value";',
  });
  assert.deepEqual(await p.incoming("a.ts"), ["app/main.ts"]);
  assert.deepEqual(await p.incoming("b.ts"), ["test/main.ts"]);
  await p.write("tsconfig.test.json", JSON.stringify({ include: ["**/*.ts"], compilerOptions: { paths: { "@value": ["./b.ts"] } } }));
  assert.deepEqual(await p.incoming("a.ts"), []);
  assert.ok((await p.references("app/main.ts")).importDiagnostics.unresolvedImports.some((issue) => issue.status === "ambiguous"));
});

test("Rust path and one-level reexports resolve declarations while cfg alternatives remain ambiguous", async (t) => {
  const p = await project(t, {
    "Cargo.toml": '[package]\nname="sample"\n[dependencies]\nserde="1"\n',
    "src/lib.rs": '#[path = "storage.rs"]\npub mod data;\npub mod facade;\n#[cfg(unix)]\n#[path="unix.rs"]\nmod os;\n#[cfg(windows)]\n#[path="windows.rs"]\nmod os;',
    "src/storage.rs": "pub struct Record {}", "src/data.rs": "pub struct Wrong {}",
    "src/facade.rs": "pub use crate::data::Record;", "src/use.rs": "use crate::facade::Record;\nuse serde::Serialize;\nuse crate::os::Value;",
    "src/unix.rs": "pub struct Value {}", "src/windows.rs": "pub struct Value {}",
  });
  assert.ok((await p.incoming("src/storage.rs")).includes("src/use.rs"));
  assert.deepEqual(await p.incoming("src/data.rs"), []);
  assert.deepEqual(await p.incoming("src/unix.rs"), []);
  const d = (await p.references("src/use.rs")).importDiagnostics;
  assert.equal(d.importResolutionCounts?.rust?.external_dependency, 1);
  assert.ok(d.unresolvedImports.some((issue) => issue.status === "ambiguous" && issue.candidateCount === 2));
});

test("Go workspace use and local replace resolve only declared module identities", async (t) => {
  const p = await project(t, {
    "go.work": "go 1.22\nuse (\n ./app\n ./library\n)\n",
    "app/go.mod": "module example.com/app\nrequire example.net/remote v1.0.0\nreplace example.net/remote => ../replacement\n",
    "app/main.go": 'package main\nimport "example.com/library"\nimport "example.net/remote"\nimport "example.com/hidden"',
    "library/go.mod": "module example.com/library\n", "library/lib.go": "package library\nfunc Run() {}",
    "replacement/go.mod": "module example.net/remote\n", "replacement/lib.go": "package remote\nfunc Run() {}",
    "hidden/go.mod": "module example.com/hidden\n", "hidden/lib.go": "package hidden\nfunc Run() {}",
  });
  assert.deepEqual(await p.incoming("library/lib.go"), ["app/main.go"]);
  assert.deepEqual(await p.incoming("replacement/lib.go"), ["app/main.go"]);
  assert.deepEqual(await p.incoming("hidden/lib.go"), []);
});

test("CMake keeps independent literal targets and blocks roots that can be shadowed", async (t) => {
  const p = await project(t, {
    "CMakeLists.txt": 'set(INC inc)\nadd_library(good main.cpp)\ntarget_include_directories(good PRIVATE ${INC})\nadd_library(other ${DYNAMIC_SOURCES})\nadd_subdirectory(child)',
    "main.cpp": '#include "value.hpp"', "inc/value.hpp": "struct Value {};",
    "child/CMakeLists.txt": 'add_library(child child.cpp)\ntarget_include_directories(child PRIVATE ${PROJECT_SOURCE_DIR}/inc)',
    "child/child.cpp": '#include "value.hpp"',
  });
  assert.deepEqual(await p.incoming("inc/value.hpp"), ["child/child.cpp", "main.cpp"]);
  await p.write("CMakeLists.txt", 'include_directories(inc)\ninclude_directories(${UNKNOWN})');
  assert.deepEqual(await p.incoming("inc/value.hpp"), []);
});

test("C# Compile Remove and Ruby path gems reuse declared membership and load paths", async (t) => {
  const p = await project(t, {
    "Directory.Build.props": '<Project><ItemGroup><Compile Remove="excluded/**/*.cs" /></ItemGroup></Project>',
    "main.cs": "using Demo;\nclass Main {}", "good.cs": "namespace Demo;\nclass Included {}", "excluded/gone.cs": "namespace Demo;\nclass Gone {}",
    "Gemfile": 'gem "local", path: "gems/local"',
    "gems/local/local.gemspec": "Gem::Specification.new do |s|\ns.require_paths = ['odd']\nend",
    "gems/local/odd/value.rb": "class Value\nend", "main.rb": "require 'value'",
  });
  assert.deepEqual(await p.incoming("excluded/gone.cs"), []);
  assert.deepEqual(await p.incoming("good.cs"), ["main.cs"]);
  assert.deepEqual(await p.incoming("gems/local/odd/value.rb"), ["main.rb"]);
});


test("dependency syntax failures do not discard independent declared roots", async (t) => {
  const p = await project(t, {
    "pyproject.toml": '[project]\ndependencies=42\n[tool.poetry]\npackages=[{include="sample",from="odd"}]',
    "odd/sample/__init__.py": "", "odd/sample/value.py": "VALUE = 1", "run.py": "import sample.value",
    "Cargo.toml": '[package]\nname="sample"\n[dependencies]\nbad=not_supported()',
    "src/lib.rs": "mod value;", "src/value.rs": "pub fn value() {}",
  });
  assert.deepEqual(await p.incoming("odd/sample/value.py"), ["run.py"]);
  assert.deepEqual(await p.incoming("src/value.rs"), ["src/lib.rs"]);
  const warnings = await p.index.projectStructureWarnings();
  assert.ok(warnings.some((entry) => entry.reason === "unsupported_python_dependencies"));
  assert.ok(warnings.some((entry) => entry.reason === "unsupported_cargo_dependencies"));
});

test("Rust attributes survive comments and cfg_attr never invents conventional targets", async (t) => {
  const p = await project(t, {
    "src/lib.rs": '#[path="actual.rs"]\n// kept comment\npub mod data;\n#[cfg_attr(unix, path="other.rs")]\nmod conditional;',
    "src/actual.rs": "pub struct Data {}", "src/data.rs": "pub struct Wrong {}",
    "src/conditional.rs": "pub struct Wrong {}", "src/other.rs": "pub struct Other {}",
  });
  assert.deepEqual(await p.incoming("src/actual.rs"), ["src/lib.rs"]);
  assert.deepEqual(await p.incoming("src/data.rs"), []);
  assert.deepEqual(await p.incoming("src/conditional.rs"), []);
  assert.ok((await p.index.importDiagnostics()).unresolvedImports.some((entry) => entry.reason === "unsupported_syntax"));
});

test("Go duplicate replacements stay ambiguous and replacement targets are not workspace members", async (t) => {
  const p = await project(t, {
    "go.work": "use ./app\nreplace example.net/alias => ./replacement\n",
    "app/go.mod": "module example.com/app\nreplace example.net/duplicate => ../a\nreplace example.net/duplicate => ../b",
    "app/main.go": 'package main\nimport "example.net/duplicate"\nimport "example.net/original"',
    "replacement/go.mod": "module example.net/original", "replacement/lib.go": "package original\nfunc Value() {}",
    "a/go.mod": "module example.net/a", "a/lib.go": "package a\nfunc Value() {}",
    "b/go.mod": "module example.net/b", "b/lib.go": "package b\nfunc Value() {}",
  });
  for (const file of ["replacement/lib.go", "a/lib.go", "b/lib.go"]) assert.deepEqual(await p.incoming(file), []);
  assert.ok((await p.index.importDiagnostics()).unresolvedImports.some((entry) => entry.status === "ambiguous"));
});

test("JVM reactor boundaries isolate independent builds and preserve duplicate-module ambiguity", async (t) => {
  const p = await project(t, {
    "pom.xml": "<project><modules><module>app</module><module>lib</module></modules></project>",
    "app/pom.xml": "<project />", "lib/pom.xml": "<project />",
    "app/Main.java": "import shared.Value;\npublic class Main {}",
    "lib/Value.java": "package shared;\npublic class Value {}",
    "independent/pom.xml": "<project />", "independent/Value.java": "package shared;\npublic class Value {}",
  });
  assert.deepEqual(await p.incoming("lib/Value.java"), ["app/Main.java"]);
  assert.deepEqual(await p.incoming("independent/Value.java"), []);
  await p.write("pom.xml", "<project><modules><module>app</module><module>lib</module><module>independent</module></modules></project>");
  assert.deepEqual(await p.incoming("lib/Value.java"), []);
  assert.ok((await p.index.importDiagnostics()).unresolvedImports.some((entry) => entry.status === "ambiguous"));
});

test("pnpm literal membership excludes negated packages", async (t) => {
  const p = await project(t, {
    "pnpm-workspace.yaml": "packages:\n  - 'modules/*'\n  - '!modules/private'\n",
    "main.ts": 'import "public"; import "private";',
    "modules/public/package.json": '{"name":"public","exports":"./entry.ts"}',
    "modules/public/entry.ts": "export const value = 1;",
    "modules/private/package.json": '{"name":"private","exports":"./entry.ts"}',
    "modules/private/entry.ts": "export const value = 2;",
  });
  assert.deepEqual(await p.incoming("modules/public/entry.ts"), ["main.ts"]);
  assert.deepEqual(await p.incoming("modules/private/entry.ts"), []);
});

test("oversized snapshots retain bounded sidecar metadata until explicit generation invalidation", async (t) => {
  const p = await project(t, {
    "Controller.cls": "public class Controller {}",
    "Controller.cls-meta.xml": "<ApexClass><status>Active</status></ApexClass>",
  });
  const snapshot = await p.index.snapshot();
  snapshot.fragments[0]!.docComment = "x".repeat(9 * 1024 * 1024);
  await fs.writeFile(codeEvidenceIndexFile(path.join(p.root, "wiki")), JSON.stringify(snapshot));
  assert.equal((await p.index.symbol("Controller"))[0]!.fragment.deploymentStatus, "Active");
  const cache = getCodeQueryCacheDiagnostics(path.join(p.root, "wiki"));
  assert.equal(cache.cached, false);
  assert.ok(cache.estimatedBytes > 0 && cache.estimatedBytes <= 1024 * 1024);
  await fs.rm(path.join(p.root, "Controller.cls-meta.xml"));
  assert.equal((await p.index.symbol("Controller"))[0]!.fragment.deploymentStatus, "Active", "sidecars follow explicit generations, including uncached snapshots");
  await p.index.removeFile("Controller.cls-meta.xml");
  assert.equal((await p.index.symbol("Controller"))[0]!.fragment.deploymentStatus, undefined);
});

test("enclosing Apex declarations are not callers of their own methods", async (t) => {
  const p = await project(t, {
    "Service.cls": "public class Service {\n public static void run() {}\n public static void caller() { run(); }\n}",
    "entry.js": 'import run from "@salesforce/apex/Service.run";\nexport function start() { run(); }',
  });
  const method = (await p.index.symbol("Service.run"))[0]!.fragment;
  const references = await p.index.references(method.id, { maxResults: 100 });
  assert.ok(!references.some((entry) => entry.source.kind === "class" && entry.source.path === "Service.cls"));
  assert.ok(references.some((entry) => entry.source.qualifiedName === "Service.caller"));
  assert.ok(references.some((entry) => entry.source.path === "entry.js"));
});

test("Gradle includes join only declared nested module boundaries", async (t) => {
  const p = await project(t, {
    "settings.gradle": 'include ":lib"',
    "lib/settings.gradle": "rootProject.name = 'lib'",
    "app/Main.java": "import shared.Value;\npublic class Main {}",
    "lib/Value.java": "package shared;\npublic class Value {}",
    "independent/settings.gradle": "rootProject.name = 'independent'",
    "independent/Value.java": "package shared;\npublic class Value {}",
  });
  assert.deepEqual(await p.incoming("lib/Value.java"), ["app/Main.java"]);
  assert.deepEqual(await p.incoming("independent/Value.java"), []);
  await p.write("settings.gradle", 'include ":lib", ":independent"');
  assert.deepEqual(await p.incoming("lib/Value.java"), []);
  assert.ok((await p.index.importDiagnostics()).unresolvedImports.some((entry) => entry.status === "ambiguous"));
});

test("oversized snapshots reuse bounded postings and invalidate them on manifest edits", async (t) => {
  const p = await project(t, {
    "tsconfig.json": '{"compilerOptions":{"paths":{"@value":["./a.ts"]}}}',
    "main.ts": 'import "@value";', "a.ts": "export const a = 1;", "b.ts": "export const b = 2;",
    "padding.ts": "export const padding = 1;",
  });
  const snapshot = await p.index.snapshot();
  snapshot.fragments.find((entry) => entry.path === "padding.ts")!.docComment = "x".repeat(9 * 1024 * 1024);
  await fs.writeFile(codeEvidenceIndexFile(path.join(p.root, "wiki")), JSON.stringify(snapshot));
  const adapter = p.index.registry.resolve({ path: "main.ts" })!;
  const original = adapter.createImportResolver!;
  let builds = 0;
  adapter.createImportResolver = (context) => { builds++; return original.call(adapter, context); };
  t.after(() => { adapter.createImportResolver = original; });
  assert.deepEqual(await p.incoming("a.ts"), ["main.ts"]);
  assert.deepEqual(await p.incoming("a.ts"), ["main.ts"]);
  assert.equal(builds, 1);
  const cache = getCodeQueryCacheDiagnostics(path.join(p.root, "wiki"));
  assert.equal(cache.cached, false);
  assert.ok(cache.estimatedBytes > 0 && cache.estimatedBytes <= cache.maxEstimatedBytes);
  await p.write("tsconfig.json", '{"compilerOptions":{"paths":{"@value":["./b.ts"]}}}');
  assert.deepEqual(await p.incoming("a.ts"), []);
  assert.deepEqual(await p.incoming("b.ts"), ["main.ts"]);
  assert.equal(builds, 2);
});

test("import and require in one source preserve both declared conditional entry points", async (t) => {
  const p = await project(t, {
    "package.json": '{"name":"local","exports":{"import":"./esm.ts","require":"./cjs.ts"}}',
    "main.ts": 'import "local"; require("local");',
    "esm.ts": "export const value = 1;", "cjs.ts": "export const value = 2;",
  });
  assert.deepEqual(await p.incoming("esm.ts"), ["main.ts"]);
  assert.deepEqual(await p.incoming("cjs.ts"), ["main.ts"]);
  assert.deepEqual((await p.index.importDiagnostics()).unresolvedImports, []);
});
