/** Reviewed paths/relations are declared before extraction; the index never
 * supplies its own expected answers. Each adapter contributes real query targets. */
export interface EfficiencyCase {
  family: string;
  targetPath: string;
  symbol?: string;
  sourcePath: string;
  negativePath: string;
  relation: "import" | "call";
}
export interface EfficiencyFixture {
  files: Array<[string, string]>;
  cases: EfficiencyCase[];
  update: { path: string; contents: [string, string] };
}

export function multilingualEfficiencyFixture(scale: number, sparse: boolean): EfficiencyFixture {
  const files: Array<[string, string]> = [
    ["package.json", '{"name":"efficiency-fixture","private":true}'],
    ["go.mod", "module example.com/efficiency\n"],
    ["sfdx-project.json", '{"packageDirectories":[{"path":"packages"}]}'],
  ];
  const cases: EfficiencyCase[] = [];
  // Approximately 64 fragments per group. Report actual counts after extraction.
  for (let i = 0; i < Math.ceil(scale / 64); i++) {
    const group = sparse ? i : Math.floor(i / 50);
    function pair(family: string, extension: string, source: string, importer: string, options: {
      target?: string; caller?: string; symbol?: string; negative?: string;
    } = {}) {
      const directory = `packages/${family}/p${group}`;
      const targetPath = options.target ?? `${directory}/value${i}.${extension}`;
      const sourcePath = options.caller ?? `${directory}/use${i}.${extension}`;
      const negativePath = `${directory}/unrelated${i}.${extension}`;
      files.push([targetPath, source], [sourcePath, importer], [negativePath, options.negative ?? ""]);
      if (i === 0) cases.push({ family, targetPath, sourcePath, negativePath,
        ...(options.symbol ? { symbol: options.symbol } : {}), relation: options.symbol ? "call" : "import" });
    }
    pair("typescript-javascript", "ts", `export function tsValue${i}() { return ${i}; }`,
      `import { tsValue${i} } from './value${i}';\ntsValue${i}();`,
      { caller: `packages/typescript-javascript/p${group}/use${i}.js`, negative: "export const unrelated = 0;" });
    pair("java", "java", `package bench.java${i};\npublic class Value${i} {}`, `import bench.java${i}.Value${i};\npublic class Use${i} {}`,
      { negative: `import missing.java${i}.Value${i};\nclass Unrelated${i} {}` });
    pair("kotlin", "kt", `package bench.kotlin${i}\nclass Value${i} {}`, `import bench.kotlin${i}.Value${i}\nfun use${i}() {}`,
      { negative: `import missing.kotlin${i}.Value${i}\nfun unrelated${i}() {}` });
    pair("csharp", "cs", `namespace Bench.Cs${i};\npublic class Value${i} {}`, `using Bench.Cs${i};\npublic class Use${i} {}`,
      { negative: `using Missing.Cs${i};\nclass Unrelated${i} {}` });
    pair("go", "go", `package p${group}\nfunc Value${i}() {}`, `package main\nimport "example.com/efficiency/packages/go/p${group}"\nfunc main() {}`,
      { caller: `callers/go/use${i}.go`, negative: 'package unrelated\nimport "example.net/external"\n' });
    pair("rust", "rs", `pub fn rust_value${i}() {}`, `pub mod value${i};`,
      { target: `packages/rust/p${i}/value${i}.rs`, caller: `packages/rust/p${i}/lib.rs`, negative: "use external::missing;\n" });
    pair("php", "php", `<?php\nnamespace Bench\\Php${i};\nclass Value${i} {}`, `<?php\nuse Bench\\Php${i}\\Value${i};\nfunction use${i}() {}`,
      { negative: `<?php\nuse Missing\\Php${i}\\Value${i};` });
    pair("c", "c", `int c_value${i}(void) { return ${i}; }`, `int c_use${i}(void) { return c_value${i}(); }`,
      { symbol: `c_value${i}`, negative: `int c_unrelated${i}(void) { return 0; }` });
    pair("cpp", "hpp", `inline int cpp_value${i}() { return ${i}; }`, `#include "value${i}.hpp"\nint cpp_use${i}() { return cpp_value${i}(); }`,
      { caller: `packages/cpp/p${group}/use${i}.cpp`, negative: `#include "missing${i}.hpp"\n` });
    pair("python", "py", `def py_value${i}():\n    return ${i}\n`, `import value${i}\n`,
      { negative: `import missing${i}\n` });
    pair("ruby", "rb", `module RubyValue${i}\nend\n`, `require_relative 'value${i}'\n`,
      { negative: `require_relative 'missing${i}'\n` });
    pair("apex", "cls", `public class ApexValue${i} {\n public static void run() {}\n}`, `import run from '@salesforce/apex/ApexValue${i}.run';\nrun();`,
      { target: `packages/apex/p${group}/ApexValue${i}.cls`, caller: `packages/callers/apex/use${i}.js`, negative: `public class Unrelated${i} {}` });
    files.push([`packages/apex/p${group}/ApexValue${i}.cls-meta.xml`, "<ApexClass><status>Active</status></ApexClass>"]);
    pair("sfmeta", "field-meta.xml", '<CustomField><fullName>Amount__c</fullName><type>Number</type><label>Amount</label></CustomField>',
      `import amount from '@salesforce/schema/Efficiency${i}__c.Amount__c';`,
      { target: `packages/metadata/objects/Efficiency${i}__c/fields/Amount__c.field-meta.xml`, caller: `packages/callers/metadata/use${i}.js`,
        negative: '<CustomField><fullName>Unrelated__c</fullName><type>Text</type></CustomField>' });
  }
  return { files, cases, update: { path: "package.json", contents: [
    '{"name":"efficiency-fixture","private":true,"description":"revision A"}',
    '{"name":"efficiency-fixture","private":true,"description":"revision B"}',
  ] } };
}

/** Retains the original Salesforce-oriented workload for historical comparisons. */
export function salesforceEfficiencyFixture(scale: number, sparse: boolean): EfficiencyFixture {
  const files: Array<[string, string]> = [["sfdx-project.json", '{"packageDirectories":[{"path":"packages"}]}'],
    ["package.json", '{"dependencies":{"known-external":"1"}}']];
  for (let i = 0; i < Math.ceil(scale / 7); i++) {
    const directory = `packages/p${sparse ? i : Math.floor(i / 50)}`;
    files.push([`${directory}/Value${i}.cls`, `public class Value${i} {\n public static void run() {}\n public static void use() { Value0.run(); }\n}`],
      [`${directory}/Value${i}.cls-meta.xml`, "<ApexClass><status>Active</status></ApexClass>"],
      [`${directory}/use${i}.js`, `import run from '@salesforce/apex/Value0.run';\nimport './template${i}.html';\nrun();`],
      [`${directory}/template${i}.html`, "<template>fixture</template>"],
      [`${directory}/value${i}.py`, `def value${i}():\n    return ${i}\n`]);
  }
  return { files, cases: [{ family: "apex", targetPath: "packages/p0/Value0.cls", sourcePath: "packages/p0/use0.js",
    negativePath: "packages/p0/value0.py", relation: "import" }], update: {
    path: "packages/p0/Value0.cls-meta.xml", contents: [62, 63].map((version) =>
      `<ApexClass><apiVersion>${version}.0</apiVersion><status>Active</status></ApexClass>`) as [string, string],
  } };
}
