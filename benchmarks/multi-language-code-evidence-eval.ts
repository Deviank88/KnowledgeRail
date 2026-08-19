import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { canonicalFixtureText } from "./fixture-integrity.js";
import { maskBraceLanguage, type BraceLanguage } from "../src/core/code-evidence/brace-language-engine.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import {
  ApexKnowledgeAdapter,
  CKnowledgeAdapter,
  CppKnowledgeAdapter,
  CSharpKnowledgeAdapter,
  GoKnowledgeAdapter,
  JavaKnowledgeAdapter,
  PhpKnowledgeAdapter,
  RustKnowledgeAdapter,
} from "../src/core/code-evidence/language-adapters.js";
import type { CodeFragmentKind, KnowledgeAdapter } from "../src/core/code-evidence/types.js";

interface ExpectedSymbol {
  path: string;
  kind: CodeFragmentKind;
  symbol: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  docComment: boolean;
}

interface LanguageFixture {
  language: string;
  knownGaps: string[];
  symbols: ExpectedSymbol[];
}

export interface LanguageExtractionResult {
  language: string;
  expectedSymbols: number;
  extractedSymbols: number;
  truePositives: number;
  precision: number;
  recall: number;
  falsePositiveKeys: string[];
  missingKeys: string[];
  knownGaps: string[];
}

export interface MaskingResult {
  language: BraceLanguage;
  lengthPreserved: boolean;
  newlinesPreserved: boolean;
  hiddenTokenMasked: boolean;
  visibleTokenPreserved: boolean;
  passed: boolean;
}

export interface MultiLanguageCodeEvidenceReport {
  generatedAt: string;
  fixtureRoot: string;
  corpusSha256: string;
  languageResults: LanguageExtractionResult[];
  maskingResults: MaskingResult[];
  sourceFileCount: number;
  sourceLineCount: number;
  sourceByteCount: number;
  labeledSourceFileCount: number;
  labeledSourceLineCount: number;
  labeledSourceByteCount: number;
  expectedSymbolCount: number;
  initialReparsedFiles: number;
  unchangedReusedFiles: number;
  initialBuildMs: number;
  unchangedBuildMs: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MULTI_LANGUAGE_FIXTURE_ROOT = path.resolve(HERE, "../tests/fixtures/code-evidence");

const ADAPTERS: Record<string, KnowledgeAdapter> = {
  apex: new ApexKnowledgeAdapter(),
  c: new CKnowledgeAdapter(),
  cpp: new CppKnowledgeAdapter(),
  csharp: new CSharpKnowledgeAdapter(),
  go: new GoKnowledgeAdapter(),
  java: new JavaKnowledgeAdapter(),
  php: new PhpKnowledgeAdapter(),
  rust: new RustKnowledgeAdapter(),
};

const MASKING_CASES: Array<{
  language: BraceLanguage;
  content: string;
  hidden: string;
  visible: string;
}> = [
  { language: "java", content: "String x = \"\"\"\nescaped \\\"\"\" fakeMethod() { }\n\"\"\";\nvoid visible() {}\n", hidden: "fakeMethod", visible: "visible" },
  { language: "apex", content: "Account a = [SELECT FakeCall() FROM Account];\nvoid visible() {}\n", hidden: "FakeCall", visible: "visible" },
  { language: "csharp", content: "var x = @\"fakeMethod() { \"\"q\"\" }\";\nvar y = $\"{Lookup(\"fakeMethod()\")}\";\nvar z = $\"\"\"fakeMethod() { }\"\"\";\nvoid Visible() {}\n", hidden: "fakeMethod", visible: "Visible" },
  { language: "go", content: "var x = `fakeMethod() { }`\nfunc visible() {}\n", hidden: "fakeMethod", visible: "visible" },
  { language: "rust", content: "/* outer /* fake_fn() {} */ end */\nlet x = r##\"fake_raw() {}\"##;\nfn visible<'a>(x: &'a str) {}\n", hidden: "fake_raw", visible: "'a" },
  { language: "php", content: "<script>function fakeHtml() {}</script>\n<?php\n$x = <<<'NOW'\nfakeHeredoc() {}\nNOW;\n$y = <<<TXT\nfakeHeredoc() {}\nTXT;\nfunction visible() {}\n?>\n", hidden: "fakeHeredoc", visible: "visible" },
  { language: "c", content: "#define FAKE(name) \\\n  int fake_hidden(void) { return 0; }\nint visible(void) {}\n", hidden: "fake_hidden", visible: "visible" },
  { language: "cpp", content: "auto x = R\"tag(fake_method() { })tag\";\nint visible() {}\n", hidden: "fake_method", visible: "visible" },
];

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
}

function symbolKey(symbol: ExpectedSymbol): string {
  return [
    symbol.path,
    symbol.kind,
    symbol.symbol,
    symbol.qualifiedName,
    symbol.startLine,
    symbol.endLine,
    symbol.isTest,
    symbol.docComment,
  ].join("\0");
}

async function filesBelow(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) results.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  await visit(root);
  return results.sort();
}

export async function multiLanguageCorpusSha256(fixtureRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of await filesBelow(fixtureRoot)) {
    const content = canonicalFixtureText(await fs.readFile(path.join(fixtureRoot, relative), "utf8"));
    hash.update(relative).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

async function evaluateLanguage(fixtureRoot: string, language: string): Promise<LanguageExtractionResult> {
  const directory = path.join(fixtureRoot, language);
  const fixture = JSON.parse(await fs.readFile(path.join(directory, "expected.json"), "utf8")) as LanguageFixture;
  if (fixture.language !== language || !Array.isArray(fixture.knownGaps) || !Array.isArray(fixture.symbols)) {
    throw new Error(`Invalid ${language} code-evidence fixture.`);
  }
  const actual: ExpectedSymbol[] = [];
  for (const name of (await fs.readdir(directory)).filter((value) => value !== "expected.json").sort()) {
    const absolute = path.join(directory, name);
    if (!(await fs.stat(absolute)).isFile()) continue;
    const relative = `${language}/${name}`;
    const content = await fs.readFile(absolute, "utf8");
    const fragments = await ADAPTERS[language]!.extract({ repositoryRoot: fixtureRoot, path: relative, content });
    for (const fragment of fragments) {
      if (fragment.kind === "module" || fragment.kind === "comment") continue;
      actual.push({
        path: fragment.path,
        kind: fragment.kind,
        symbol: fragment.symbol,
        qualifiedName: fragment.qualifiedName,
        startLine: fragment.range.startLine,
        endLine: fragment.range.endLine,
        isTest: fragment.isTest,
        docComment: fragment.docComment !== undefined,
      });
    }
  }
  const expectedKeys = new Set(fixture.symbols.map(symbolKey));
  const actualKeys = new Set(actual.map(symbolKey));
  const truePositives = [...actualKeys].filter((key) => expectedKeys.has(key)).length;
  return {
    language,
    expectedSymbols: expectedKeys.size,
    extractedSymbols: actualKeys.size,
    truePositives,
    precision: ratio(truePositives, actualKeys.size),
    recall: ratio(truePositives, expectedKeys.size),
    falsePositiveKeys: [...actualKeys].filter((key) => !expectedKeys.has(key)).sort(),
    missingKeys: [...expectedKeys].filter((key) => !actualKeys.has(key)).sort(),
    knownGaps: fixture.knownGaps,
  };
}

function evaluateMasking(): MaskingResult[] {
  return MASKING_CASES.map((fixture) => {
    const masked = maskBraceLanguage(fixture.content, fixture.language);
    const lengthPreserved = masked.length === fixture.content.length;
    const newlinesPreserved = [...masked].filter((value) => value === "\n").length ===
      [...fixture.content].filter((value) => value === "\n").length;
    const hiddenTokenMasked = !masked.includes(fixture.hidden);
    const visibleTokenPreserved = masked.includes(fixture.visible);
    return {
      language: fixture.language,
      lengthPreserved,
      newlinesPreserved,
      hiddenTokenMasked,
      visibleTokenPreserved,
      passed: lengthPreserved && newlinesPreserved && hiddenTokenMasked && visibleTokenPreserved,
    };
  });
}

export async function evaluateMultiLanguageCodeEvidence(
  fixtureRoot = DEFAULT_MULTI_LANGUAGE_FIXTURE_ROOT
): Promise<MultiLanguageCodeEvidenceReport> {
  const resolvedRoot = path.resolve(fixtureRoot);
  const languageResults = await Promise.all(Object.keys(ADAPTERS).sort().map((language) =>
    evaluateLanguage(resolvedRoot, language)
  ));
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-multilang-eval-"));
  const wikiRoot = path.join(temporaryRoot, "wiki");
  try {
    for (const relative of await filesBelow(resolvedRoot)) {
      if (relative.endsWith("expected.json")) continue;
      const target = path.join(temporaryRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(resolvedRoot, relative), target);
    }
    const sourceFiles = (await filesBelow(resolvedRoot)).filter((value) => !value.endsWith("expected.json"));
    const sourceContents = await Promise.all(sourceFiles.map(async (relative) =>
      canonicalFixtureText(await fs.readFile(path.join(resolvedRoot, relative), "utf8"))
    ));
    const sourceFileCount = sourceFiles.length;
    const sourceLineCount = sourceContents.reduce((total, content) =>
      total + (content.length === 0 ? 0 : content.split(/\r?\n/u).length - (content.endsWith("\n") ? 1 : 0)), 0
    );
    const sourceByteCount = sourceContents.reduce((total, content) => total + Buffer.byteLength(content), 0);
    const labeledSourceContents = sourceContents.filter((_content, index) =>
      ADAPTERS[sourceFiles[index]!.split("/")[0]!] !== undefined
    );
    const labeledSourceFileCount = labeledSourceContents.length;
    const labeledSourceLineCount = labeledSourceContents.reduce((total, content) =>
      total + (content.length === 0 ? 0 : content.split(/\r?\n/u).length - (content.endsWith("\n") ? 1 : 0)), 0
    );
    const labeledSourceByteCount = labeledSourceContents.reduce((total, content) =>
      total + Buffer.byteLength(content), 0
    );
    const expectedSymbolCount = languageResults.reduce((total, result) => total + result.expectedSymbols, 0);
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: temporaryRoot, wikiRoot });
    const initialStarted = performance.now();
    const initial = await index.rebuild();
    const initialBuildMs = performance.now() - initialStarted;
    const unchangedStarted = performance.now();
    const unchanged = await index.rebuild();
    const unchangedBuildMs = performance.now() - unchangedStarted;
    return {
      generatedAt: new Date().toISOString(),
      fixtureRoot: resolvedRoot,
      corpusSha256: await multiLanguageCorpusSha256(resolvedRoot),
      languageResults,
      maskingResults: evaluateMasking(),
      sourceFileCount,
      sourceLineCount,
      sourceByteCount,
      labeledSourceFileCount,
      labeledSourceLineCount,
      labeledSourceByteCount,
      expectedSymbolCount,
      initialReparsedFiles: initial.reparsedFiles,
      unchangedReusedFiles: unchanged.reusedFiles,
      initialBuildMs: Number(initialBuildMs.toFixed(3)),
      unchangedBuildMs: Number(unchangedBuildMs.toFixed(3)),
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report = await evaluateMultiLanguageCodeEvidence(process.argv[2] ?? DEFAULT_MULTI_LANGUAGE_FIXTURE_ROOT);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
