import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";

interface ExpectedFragment {
  symbol: string;
  expected: string;
}

interface ExpectedReferences {
  symbol: string;
  expected: string[];
}

interface CodeEvidenceFixture {
  version: number;
  files: Array<{ path: string; content: string }>;
  tasks: {
    definitions: ExpectedFragment[];
    callers: ExpectedReferences[];
    implementationTests: ExpectedReferences[];
    routes: Array<{ query: string; route: string; handler: string; dependencies: string[] }>;
    configs: Array<{ query: string; expected: string }>;
    multiFile: Array<{ query: string; expectedPaths: string[] }>;
    rename: { path: string; from: string; to: string };
    delete: { path: string; symbol: string };
  };
}

export interface CodeEvidenceTaskResult {
  task: string;
  passed: boolean;
  detail: string;
}

export interface CodeEvidenceEvaluationReport {
  generatedAt: string;
  fixture: string;
  fixtureVersion: number;
  fileCount: number;
  normalTaskCount: number;
  codeEvidenceRecall: number;
  symbolResolutionAccuracy: number;
  referenceRecall: number;
  codeContextBytes: number;
  grepFallbackRate: number;
  initialReparsedFiles: number;
  unchangedReusedFiles: number;
  renameReparsedFiles: number;
  renamedSymbolVisible: boolean;
  oldSymbolRemoved: boolean;
  deletedFileRemoved: boolean;
  taskResults: CodeEvidenceTaskResult[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CODE_EVIDENCE_FIXTURE = path.join(HERE, "fixtures", "code-evidence-golden-v4.json");

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function key(path: string, qualifiedName: string): string {
  return `${path}#${qualifiedName}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
}

export async function evaluateCodeEvidence(
  fixturePath = DEFAULT_CODE_EVIDENCE_FIXTURE
): Promise<CodeEvidenceEvaluationReport> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as CodeEvidenceFixture;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-code-eval-"));
  const wikiRoot = path.join(root, "wiki");
  const taskResults: CodeEvidenceTaskResult[] = [];
  let retrievalExpected = 0;
  let retrievalFound = 0;
  let symbolsExpected = 0;
  let symbolsFound = 0;
  let referencesExpected = 0;
  let referencesFound = 0;
  let codeContextBytes = 0;
  const readUris = new Set<string>();

  try {
    for (const file of fixture.files) {
      const absolute = path.join(root, file.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, file.content, "utf8");
    }
    const index = new PersistentCodeEvidenceIndex({ repositoryRoot: root, wikiRoot });
    const initial = await index.rebuild();
    const unchanged = await index.rebuild();

    for (const task of fixture.tasks.definitions) {
      const hits = await index.symbol(task.symbol, { maxResults: 10 });
      const actual = hits[0] ? key(hits[0].fragment.path, hits[0].fragment.qualifiedName) : "missing";
      const passed = actual === task.expected;
      symbolsExpected++;
      if (passed) symbolsFound++;
      retrievalExpected++;
      if (hits.some((hit) => key(hit.fragment.path, hit.fragment.qualifiedName) === task.expected)) retrievalFound++;
      if (hits[0] && !readUris.has(hits[0].resourceUri)) {
        const read = await readCodeResource({ repositoryRoot: root, wikiRoot, resourceUri: hits[0].resourceUri });
        codeContextBytes += Buffer.byteLength(read.text, "utf8");
        readUris.add(hits[0].resourceUri);
      }
      taskResults.push({ task: `definition:${task.symbol}`, passed, detail: actual });
    }

    for (const task of fixture.tasks.callers) {
      const targets = await index.symbol(task.symbol, { maxResults: 10 });
      const references = targets[0]
        ? await index.references(targets[0].fragment.id, { maxResults: 100 })
        : [];
      const actual = new Set(references.map((reference) => key(reference.source.path, reference.source.qualifiedName)));
      const found = task.expected.filter((expected) => actual.has(expected));
      referencesExpected += task.expected.length;
      referencesFound += found.length;
      retrievalExpected += task.expected.length;
      retrievalFound += found.length;
      taskResults.push({
        task: `callers:${task.symbol}`,
        passed: found.length === task.expected.length,
        detail: `${found.length}/${task.expected.length}`,
      });
    }

    for (const task of fixture.tasks.implementationTests) {
      const targets = await index.symbol(task.symbol, { maxResults: 10 });
      const references = targets[0]
        ? await index.references(targets[0].fragment.id, { maxResults: 100 })
        : [];
      const tests = new Set(references.filter((reference) => reference.source.isTest)
        .map((reference) => key(reference.source.path, reference.source.qualifiedName)));
      const found = task.expected.filter((expected) => tests.has(expected));
      retrievalExpected += task.expected.length;
      retrievalFound += found.length;
      taskResults.push({
        task: `implementation-test:${task.symbol}`,
        passed: found.length === task.expected.length,
        detail: `${found.length}/${task.expected.length}`,
      });
    }

    for (const task of fixture.tasks.routes) {
      const routeHits = await index.search(task.query, { kinds: ["route"], maxResults: 10 });
      const route = routeHits.find((hit) => key(hit.fragment.path, hit.fragment.qualifiedName) === task.route);
      const handlerHits = await index.symbol(task.handler, { maxResults: 10 });
      const handler = handlerHits[0];
      const dependenciesFound = handler
        ? task.dependencies.filter((dependency) => handler.fragment.calls.includes(dependency))
        : [];
      const passed = Boolean(route && handler && dependenciesFound.length === task.dependencies.length);
      retrievalExpected += 2 + task.dependencies.length;
      retrievalFound += Number(Boolean(route)) + Number(Boolean(handler)) + dependenciesFound.length;
      if (route && !readUris.has(route.resourceUri)) {
        const read = await readCodeResource({ repositoryRoot: root, wikiRoot, resourceUri: route.resourceUri });
        codeContextBytes += Buffer.byteLength(read.text, "utf8");
        readUris.add(route.resourceUri);
      }
      taskResults.push({
        task: `route:${task.query}`,
        passed,
        detail: `route=${Boolean(route)} handler=${Boolean(handler)} dependencies=${dependenciesFound.length}/${task.dependencies.length}`,
      });
    }

    for (const task of fixture.tasks.configs) {
      const hits = await index.search(task.query, { maxResults: 20 });
      const found = hits.some((hit) => key(hit.fragment.path, hit.fragment.qualifiedName) === task.expected);
      retrievalExpected++;
      retrievalFound += Number(found);
      taskResults.push({ task: `config:${task.query}`, passed: found, detail: found ? task.expected : "missing" });
    }

    for (const task of fixture.tasks.multiFile) {
      const hits = await index.search(task.query, { maxResults: 20 });
      const actualPaths = new Set(hits.map((hit) => hit.fragment.path));
      const found = task.expectedPaths.filter((expected) => actualPaths.has(expected));
      retrievalExpected += task.expectedPaths.length;
      retrievalFound += found.length;
      taskResults.push({
        task: `multi-file:${task.query}`,
        passed: found.length === task.expectedPaths.length,
        detail: `${found.length}/${task.expectedPaths.length}`,
      });
    }

    const rename = fixture.tasks.rename;
    const renamePath = path.join(root, rename.path);
    const renameBefore = await fs.readFile(renamePath, "utf8");
    await fs.writeFile(renamePath, renameBefore.replaceAll(rename.from, rename.to), "utf8");
    const renameUpdate = await index.updateFile(rename.path);
    const renamedSymbolVisible = (await index.symbol(rename.to, { maxResults: 20 }))
      .some((hit) => hit.fragment.path === rename.path);
    const oldSymbolRemoved = !(await index.symbol(rename.from, { maxResults: 20 }))
      .some((hit) => hit.fragment.path === rename.path);
    taskResults.push({
      task: "symbol-rename/update",
      passed: renameUpdate.reparsedFiles === 1 && renamedSymbolVisible && oldSymbolRemoved,
      detail: `reparsed=${renameUpdate.reparsedFiles} visible=${renamedSymbolVisible} oldRemoved=${oldSymbolRemoved}`,
    });

    const deletion = fixture.tasks.delete;
    await fs.unlink(path.join(root, deletion.path));
    const deleteUpdate = await index.removeFile(deletion.path);
    const afterDelete = await index.snapshot();
    const deletedFileRemoved = deleteUpdate.removedFiles === 1 &&
      !afterDelete.files.some((record) => record.path === deletion.path) &&
      !afterDelete.fragments.some((fragment) => fragment.path === deletion.path);
    taskResults.push({
      task: "file-delete",
      passed: deletedFileRemoved,
      detail: `removed=${deleteUpdate.removedFiles}`,
    });

    const normalTaskCount =
      fixture.tasks.definitions.length + fixture.tasks.callers.length +
      fixture.tasks.implementationTests.length + fixture.tasks.routes.length +
      fixture.tasks.configs.length + fixture.tasks.multiFile.length + 2;
    return {
      generatedAt: new Date().toISOString(),
      fixture: path.resolve(fixturePath),
      fixtureVersion: fixture.version,
      fileCount: fixture.files.length,
      normalTaskCount,
      codeEvidenceRecall: ratio(retrievalFound, retrievalExpected),
      symbolResolutionAccuracy: ratio(symbolsFound, symbolsExpected),
      referenceRecall: ratio(referencesFound, referencesExpected),
      codeContextBytes,
      grepFallbackRate: 0,
      initialReparsedFiles: initial.reparsedFiles,
      unchangedReusedFiles: unchanged.reusedFiles,
      renameReparsedFiles: renameUpdate.reparsedFiles,
      renamedSymbolVisible,
      oldSymbolRemoved,
      deletedFileRemoved,
      taskResults,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report = await evaluateCodeEvidence(path.resolve(argValue("fixture") ?? DEFAULT_CODE_EVIDENCE_FIXTURE));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
