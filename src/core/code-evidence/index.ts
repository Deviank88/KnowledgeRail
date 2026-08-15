import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import fg from "fast-glob";
import { atomicWriteText } from "../fs-service.js";
import { wikiMetaDir } from "../manifest-service.js";
import { safeResolveWithin } from "../paths.js";
import { tokenizeSearchText } from "../text-analysis.js";
import { readFileSafe } from "../utils.js";
import { TypeScriptKnowledgeAdapter } from "./typescript-adapter.js";
import {
  CODE_EVIDENCE_INDEX_VERSION,
  type CodeEvidenceFileRecord,
  type CodeEvidenceHit,
  type CodeEvidenceIndex,
  type CodeEvidenceSnapshot,
  type CodeEvidenceUpdateReport,
  type CodeReference,
  type CodeSearchOptions,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

const DEFAULT_MAX_RESULTS = 12;
const MAX_RESULTS = 100;
const MAX_CODE_FILE_BYTES = 2 * 1024 * 1024;
const INDEX_FILE_NAME = "code-evidence-index.json";
const CODE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const CODE_IGNORES = [
  ".git/**",
  ".agents/**",
  ".codex/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
  "wiki/.knowledge-rail/**",
];

const mutations = new Map<string, Promise<unknown>>();

async function withMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const normalized = nodePath.resolve(key);
  const previous = mutations.get(normalized) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  mutations.set(normalized, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutations.get(normalized) === tail) mutations.delete(normalized);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0") || nodePath.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid repository-relative code path: ${path}`);
  }
  return normalized;
}

function fingerprint(path: string, contentHash: string, parserVersion: string): string {
  return sha256(`${path}\0${contentHash}\0${parserVersion}`);
}

function emptySnapshot(parserVersion: string): CodeEvidenceSnapshot {
  return {
    version: CODE_EVIDENCE_INDEX_VERSION,
    parserVersion,
    generatedAt: new Date(0).toISOString(),
    files: [],
    fragments: [],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validFragment(value: unknown): value is KnowledgeFragment {
  if (!value || typeof value !== "object") return false;
  const fragment = value as Partial<KnowledgeFragment>;
  return typeof fragment.id === "string" &&
    typeof fragment.path === "string" &&
    typeof fragment.symbol === "string" &&
    typeof fragment.qualifiedName === "string" &&
    ["module", "class", "function", "method", "route", "test", "comment"].includes(fragment.kind ?? "") &&
    typeof fragment.definition === "string" &&
    Number.isInteger(fragment.range?.startLine) &&
    Number.isInteger(fragment.range?.endLine) &&
    (fragment.range?.startLine ?? 0) >= 1 &&
    (fragment.range?.endLine ?? 0) >= (fragment.range?.startLine ?? 1) &&
    isStringArray(fragment.imports) &&
    isStringArray(fragment.references) &&
    isStringArray(fragment.calls) &&
    Array.isArray(fragment.routes) && fragment.routes.every((route) =>
      route && typeof route.method === "string" && typeof route.path === "string" &&
      (route.handler === undefined || typeof route.handler === "string")
    ) &&
    isStringArray(fragment.configKeys) &&
    isStringArray(fragment.databaseRefs) &&
    typeof fragment.isTest === "boolean" &&
    (fragment.docComment === undefined || typeof fragment.docComment === "string");
}

function validateSnapshot(value: unknown): CodeEvidenceSnapshot {
  if (!value || typeof value !== "object") throw new Error("Code evidence index is not an object.");
  const snapshot = value as Partial<CodeEvidenceSnapshot>;
  if (
    snapshot.version !== CODE_EVIDENCE_INDEX_VERSION ||
    typeof snapshot.parserVersion !== "string" ||
    typeof snapshot.generatedAt !== "string" ||
    !Array.isArray(snapshot.files) ||
    !Array.isArray(snapshot.fragments) ||
    !snapshot.fragments.every(validFragment)
  ) {
    throw new Error("Code evidence index has an unsupported or invalid schema.");
  }
  const ids = new Set(snapshot.fragments.map((fragment) => fragment.id));
  if (ids.size !== snapshot.fragments.length) throw new Error("Code evidence index contains duplicate fragment ids.");
  for (const record of snapshot.files) {
    if (
      !record || typeof record !== "object" ||
      typeof record.path !== "string" ||
      typeof record.contentHash !== "string" ||
      typeof record.fingerprint !== "string" ||
      typeof record.parserVersion !== "string" ||
      !isStringArray(record.fragmentIds) ||
      record.fragmentIds.some((id) => !ids.has(id))
    ) {
      throw new Error("Code evidence index contains an invalid file record.");
    }
  }
  return snapshot as CodeEvidenceSnapshot;
}

export function codeEvidenceIndexFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), INDEX_FILE_NAME);
}

export async function readCodeEvidenceSnapshot(
  wikiRoot: string,
  parserVersion: string
): Promise<CodeEvidenceSnapshot> {
  const raw = await readFileSafe(codeEvidenceIndexFile(wikiRoot));
  if (raw === null) return emptySnapshot(parserVersion);
  try {
    return validateSnapshot(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    throw new Error(`Cannot read code evidence index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeSnapshot(wikiRoot: string, snapshot: CodeEvidenceSnapshot): Promise<void> {
  await atomicWriteText(codeEvidenceIndexFile(wikiRoot), `${JSON.stringify(snapshot, null, 2)}\n`);
}

async function readCodeSource(repositoryRoot: string, path: string): Promise<{ source: CodeSource; contentHash: string }> {
  const normalized = normalizedRelativePath(path);
  const lexicalTarget = safeResolveWithin(repositoryRoot, normalized);
  const [rootReal, targetReal] = await Promise.all([
    fs.realpath(repositoryRoot),
    fs.realpath(lexicalTarget),
  ]);
  const relativeReal = nodePath.relative(rootReal, targetReal);
  if (relativeReal === "" || relativeReal.startsWith("..") || nodePath.isAbsolute(relativeReal)) {
    throw new Error(`Code path resolves outside the repository root: ${path}`);
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) throw new Error(`Code path is not a regular file: ${path}`);
  if (stat.size > MAX_CODE_FILE_BYTES) {
    throw new Error(`Code file exceeds ${MAX_CODE_FILE_BYTES} bytes: ${path}`);
  }
  const content = await fs.readFile(targetReal, "utf8");
  return {
    source: { repositoryRoot: rootReal, path: normalized, content },
    contentHash: sha256(content),
  };
}

function report(params: {
  scannedFiles: number;
  reusedFiles: number;
  reparsedFiles: number;
  removedFiles: number;
  snapshot: CodeEvidenceSnapshot;
}): CodeEvidenceUpdateReport {
  return {
    scannedFiles: params.scannedFiles,
    reusedFiles: params.reusedFiles,
    reparsedFiles: params.reparsedFiles,
    removedFiles: params.removedFiles,
    fragmentCount: params.snapshot.fragments.length,
  };
}

function clampResults(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new Error(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  return value;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function fieldIncludes(values: readonly string[], term: string): boolean {
  return values.some((value) => normalized(value).includes(term));
}

function scoreFragment(fragment: KnowledgeFragment, query: string, terms: readonly string[]): {
  score: number;
  matchedTerms: string[];
} {
  const queryNormalized = normalized(query).trim();
  const symbol = normalized(fragment.symbol);
  const qualifiedName = normalized(fragment.qualifiedName);
  const path = normalized(fragment.path);
  const definition = normalized(fragment.definition);
  const docComment = normalized(fragment.docComment ?? "");
  const routeText = fragment.routes.map((route) => `${route.method} ${route.path} ${route.handler ?? ""}`.toLowerCase());
  let score = symbol === queryNormalized || qualifiedName === queryNormalized ? 120 : 0;
  if (symbol.includes(queryNormalized) || qualifiedName.includes(queryNormalized)) score += 32;
  if (path.includes(queryNormalized)) score += 16;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    let termScore = 0;
    if (symbol === term || qualifiedName === term) termScore += 18;
    else if (symbol.includes(term) || qualifiedName.includes(term)) termScore += 12;
    if (path.includes(term)) termScore += 6;
    if (definition.includes(term)) termScore += 6;
    if (fieldIncludes(fragment.calls, term)) termScore += 9;
    if (fieldIncludes(fragment.references, term)) termScore += 5;
    if (fieldIncludes(fragment.imports, term)) termScore += 5;
    if (fieldIncludes(fragment.configKeys, term)) termScore += 12;
    if (fieldIncludes(fragment.databaseRefs, term)) termScore += 10;
    if (routeText.some((value) => value.includes(term))) termScore += 12;
    if (docComment.includes(term)) termScore += 4;
    if (termScore > 0) {
      score += termScore;
      matchedTerms.push(term);
    }
  }
  if (terms.length > 0) score += (matchedTerms.length / terms.length) * 20;
  if (fragment.kind === "module") score *= 0.72;
  return { score, matchedTerms };
}

function pathAllowed(path: string, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`));
}

export function codeResourceUri(fragment: KnowledgeFragment): string {
  const encodedPath = fragment.path.split("/").map(encodeURIComponent).join("/");
  return `code://repo/${encodedPath}#${encodeURIComponent(fragment.id)}`;
}

export class PersistentCodeEvidenceIndex implements CodeEvidenceIndex {
  readonly repositoryRoot: string;
  readonly wikiRoot: string;
  readonly adapter: KnowledgeAdapter;

  constructor(params: { repositoryRoot: string; wikiRoot: string; adapter?: KnowledgeAdapter }) {
    this.repositoryRoot = nodePath.resolve(params.repositoryRoot);
    this.wikiRoot = nodePath.resolve(params.wikiRoot);
    this.adapter = params.adapter ?? new TypeScriptKnowledgeAdapter();
  }

  async snapshot(): Promise<CodeEvidenceSnapshot> {
    return readCodeEvidenceSnapshot(this.wikiRoot, this.adapter.parserVersion);
  }

  private async querySnapshot(): Promise<CodeEvidenceSnapshot> {
    const snapshot = await this.snapshot();
    if (snapshot.files.length > 0 && snapshot.parserVersion !== this.adapter.parserVersion) {
      throw new Error(
        `Code evidence parser version changed from ${snapshot.parserVersion} to ${this.adapter.parserVersion}; rebuild the index.`
      );
    }
    return snapshot;
  }

  async rebuild(): Promise<CodeEvidenceUpdateReport> {
    return withMutationLock(codeEvidenceIndexFile(this.wikiRoot), async () => {
      const before = await this.snapshot();
      const paths = (await fg(CODE_GLOB, {
        cwd: this.repositoryRoot,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: CODE_IGNORES,
      })).map(normalizedRelativePath).sort();
      const oldFiles = new Map(before.files.map((record) => [record.path, record]));
      const oldFragments = new Map(before.fragments.map((fragment) => [fragment.id, fragment]));
      const files: CodeEvidenceFileRecord[] = [];
      const fragments: KnowledgeFragment[] = [];
      let reusedFiles = 0;
      let reparsedFiles = 0;

      for (const path of paths) {
        const { source, contentHash } = await readCodeSource(this.repositoryRoot, path);
        if (!this.adapter.supports(source)) continue;
        const nextFingerprint = fingerprint(path, contentHash, this.adapter.parserVersion);
        const previous = oldFiles.get(path);
        if (previous?.fingerprint === nextFingerprint && previous.parserVersion === this.adapter.parserVersion) {
          const reused = previous.fragmentIds.map((id) => oldFragments.get(id));
          if (reused.every((fragment): fragment is KnowledgeFragment => fragment !== undefined)) {
            reusedFiles++;
            files.push(previous);
            fragments.push(...reused);
            continue;
          }
        }
        const extracted = await this.adapter.extract(source);
        reparsedFiles++;
        files.push({
          path,
          contentHash,
          fingerprint: nextFingerprint,
          parserVersion: this.adapter.parserVersion,
          fragmentIds: extracted.map((fragment) => fragment.id),
        });
        fragments.push(...extracted);
      }

      const snapshot: CodeEvidenceSnapshot = {
        version: CODE_EVIDENCE_INDEX_VERSION,
        parserVersion: this.adapter.parserVersion,
        generatedAt: new Date().toISOString(),
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
        fragments: fragments.sort((left, right) =>
          left.path.localeCompare(right.path) || left.range.startLine - right.range.startLine || left.id.localeCompare(right.id)
        ),
      };
      await writeSnapshot(this.wikiRoot, snapshot);
      return report({
        scannedFiles: paths.length,
        reusedFiles,
        reparsedFiles,
        removedFiles: before.files.filter((record) => !paths.includes(record.path)).length,
        snapshot,
      });
    });
  }

  async updateFile(path: string): Promise<CodeEvidenceUpdateReport> {
    return withMutationLock(codeEvidenceIndexFile(this.wikiRoot), async () => {
      const normalizedPath = normalizedRelativePath(path);
      const before = await this.snapshot();
      if (before.files.length > 0 && before.parserVersion !== this.adapter.parserVersion) {
        throw new Error("Code evidence parser version changed; rebuild the complete index before updating one file.");
      }
      const { source, contentHash } = await readCodeSource(this.repositoryRoot, normalizedPath);
      if (!this.adapter.supports(source)) throw new Error(`No code evidence adapter supports: ${normalizedPath}`);
      const nextFingerprint = fingerprint(normalizedPath, contentHash, this.adapter.parserVersion);
      const previous = before.files.find((record) => record.path === normalizedPath);
      if (previous?.fingerprint === nextFingerprint && previous.parserVersion === this.adapter.parserVersion) {
        return report({ scannedFiles: 1, reusedFiles: 1, reparsedFiles: 0, removedFiles: 0, snapshot: before });
      }
      const extracted = await this.adapter.extract(source);
      const files = before.files.filter((record) => record.path !== normalizedPath);
      files.push({
        path: normalizedPath,
        contentHash,
        fingerprint: nextFingerprint,
        parserVersion: this.adapter.parserVersion,
        fragmentIds: extracted.map((fragment) => fragment.id),
      });
      const snapshot: CodeEvidenceSnapshot = {
        version: CODE_EVIDENCE_INDEX_VERSION,
        parserVersion: this.adapter.parserVersion,
        generatedAt: new Date().toISOString(),
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
        fragments: [
          ...before.fragments.filter((fragment) => fragment.path !== normalizedPath),
          ...extracted,
        ].sort((left, right) =>
          left.path.localeCompare(right.path) || left.range.startLine - right.range.startLine || left.id.localeCompare(right.id)
        ),
      };
      await writeSnapshot(this.wikiRoot, snapshot);
      return report({ scannedFiles: 1, reusedFiles: 0, reparsedFiles: 1, removedFiles: 0, snapshot });
    });
  }

  async removeFile(path: string): Promise<CodeEvidenceUpdateReport> {
    return withMutationLock(codeEvidenceIndexFile(this.wikiRoot), async () => {
      const normalizedPath = normalizedRelativePath(path);
      safeResolveWithin(this.repositoryRoot, normalizedPath);
      const before = await this.snapshot();
      const existed = before.files.some((record) => record.path === normalizedPath);
      if (!existed) {
        return report({ scannedFiles: 0, reusedFiles: before.files.length, reparsedFiles: 0, removedFiles: 0, snapshot: before });
      }
      const snapshot: CodeEvidenceSnapshot = {
        ...before,
        generatedAt: new Date().toISOString(),
        files: before.files.filter((record) => record.path !== normalizedPath),
        fragments: before.fragments.filter((fragment) => fragment.path !== normalizedPath),
      };
      await writeSnapshot(this.wikiRoot, snapshot);
      return report({ scannedFiles: 0, reusedFiles: snapshot.files.length, reparsedFiles: 0, removedFiles: 1, snapshot });
    });
  }

  async search(query: string, options: CodeSearchOptions = {}): Promise<CodeEvidenceHit[]> {
    if (!query.trim()) throw new Error("Code evidence query must not be empty.");
    const maxResults = clampResults(options.maxResults);
    const kindFilter = options.kinds ? new Set(options.kinds) : null;
    const terms = tokenizeSearchText(query);
    const snapshot = await this.querySnapshot();
    return snapshot.fragments
      .filter((fragment) => !kindFilter || kindFilter.has(fragment.kind))
      .filter((fragment) => pathAllowed(fragment.path, options.paths))
      .map((fragment) => ({ fragment, ...scoreFragment(fragment, query, terms) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score ||
        left.fragment.path.localeCompare(right.fragment.path) ||
        left.fragment.range.startLine - right.fragment.range.startLine)
      .slice(0, maxResults)
      .map((hit) => ({ ...hit, resourceUri: codeResourceUri(hit.fragment) }));
  }

  async symbol(name: string, options: CodeSearchOptions = {}): Promise<CodeEvidenceHit[]> {
    if (!name.trim()) throw new Error("Symbol name must not be empty.");
    const maxResults = clampResults(options.maxResults);
    const sought = normalized(name).trim();
    const kindFilter = options.kinds ? new Set(options.kinds) : null;
    const snapshot = await this.querySnapshot();
    return snapshot.fragments
      .filter((fragment) => fragment.kind !== "module" && fragment.kind !== "comment")
      .filter((fragment) => !kindFilter || kindFilter.has(fragment.kind))
      .filter((fragment) => pathAllowed(fragment.path, options.paths))
      .map((fragment) => {
        const symbol = normalized(fragment.symbol);
        const qualified = normalized(fragment.qualifiedName);
        const score = symbol === sought || qualified === sought ? 200
          : qualified.endsWith(`.${sought}`) ? 160
          : symbol.includes(sought) || qualified.includes(sought) ? 80
          : 0;
        return { fragment, score, matchedTerms: score > 0 ? [sought] : [] };
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.fragment.path.localeCompare(right.fragment.path))
      .slice(0, maxResults)
      .map((hit) => ({ ...hit, resourceUri: codeResourceUri(hit.fragment) }));
  }

  async references(symbolId: string, options: CodeSearchOptions = {}): Promise<CodeReference[]> {
    if (!symbolId.trim()) throw new Error("symbolId must not be empty.");
    const maxResults = clampResults(options.maxResults);
    const snapshot = await this.querySnapshot();
    const target = snapshot.fragments.find((fragment) => fragment.id === symbolId);
    if (!target) throw new Error(`Unknown code evidence symbol id: ${symbolId}`);
    const targetNames = new Set([
      normalized(target.symbol),
      normalized(target.qualifiedName),
      normalized(target.qualifiedName.split(".").at(-1)!),
    ]);
    const moduleStem = target.path.split("/").at(-1)!.replace(/\.[^.]+$/, "").toLowerCase();
    const references: CodeReference[] = [];
    for (const source of snapshot.fragments) {
      if (source.id === target.id || !pathAllowed(source.path, options.paths)) continue;
      const calls = source.calls.map(normalized);
      const refs = source.references.map(normalized);
      let relation: CodeReference["relation"] | null = calls.some((value) =>
        targetNames.has(value) || targetNames.has(value.split(".").at(-1)!)
      ) ? "call" : null;
      if (!relation && refs.some((value) => targetNames.has(value))) relation = "reference";
      if (!relation && target.kind === "module" && source.imports.some((value) =>
        value.toLowerCase().split("/").at(-1) === moduleStem
      )) relation = "import";
      if (relation) references.push({ source, target, relation, resourceUri: codeResourceUri(source) });
    }
    const relationRank = { call: 0, reference: 1, import: 2 } as const;
    return references
      .sort((left, right) => relationRank[left.relation] - relationRank[right.relation] ||
        Number(right.source.isTest) - Number(left.source.isTest) ||
        left.source.path.localeCompare(right.source.path) ||
        left.source.range.startLine - right.source.range.startLine)
      .slice(0, maxResults);
  }
}
