import { createDefaultKnowledgeAdapterRegistry, type KnowledgeAdapterRegistry } from "./adapter-registry.js";
import { createLegacyImportResolver } from "./import-resolution/paths.js";
import { ImportResolutionCollector } from "./import-resolution/diagnostics.js";
import { ProjectStructureReader } from "./project-structure.js";
import { persistedSourceMetadata } from "./source-metadata.js";
import { createImportClassifier, probeUnindexedImports } from "./import-resolution/classification.js";
import { localPath } from "./import-resolution/paths.js";
import { posix } from "node:path";
import { TopResults } from "../top-results.js";
import type {
  CodeEvidenceHit, CodeEvidenceSnapshot, CodeReference, CodeSearchOptions, KnowledgeFragment,
  CodeImportResolver, KnowledgeAdapter, ProjectStructure,
  CodeImportDiagnostics, CodeImportResolutionCounts, CodeImportIssue,
  RelatedCodeEvidence,
} from "./types.js";

export const DEFAULT_QUERY_ADAPTERS = createDefaultKnowledgeAdapterRegistry();

export function normalizedCodeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function normalizedQualifiedSymbol(value: string): string {
  return normalizedCodeText(value).trim()
    .replace(/\s*(?:->|::|#|\\)\s*/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
}

export function codePathAllowed(path: string, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function enrichLwcBundles(fragments: readonly KnowledgeFragment[]): KnowledgeFragment[] {
  const targetsByJavaScriptPath = new Map<string, string[]>();
  for (const fragment of fragments) {
    if (!fragment.path.toLowerCase().endsWith(".js-meta.xml") || fragment.configKeys.length === 0) continue;
    const javaScriptPath = fragment.path.slice(0, -"-meta.xml".length);
    targetsByJavaScriptPath.set(javaScriptPath, uniqueSorted([
      ...(targetsByJavaScriptPath.get(javaScriptPath) ?? []), ...fragment.configKeys,
    ]));
  }
  return fragments.map((fragment) => {
    const targets = targetsByJavaScriptPath.get(fragment.path);
    return targets ? { ...fragment, configKeys: uniqueSorted([...fragment.configKeys, ...targets]) } : fragment;
  });
}

interface SymbolEntry {
  fragment: KnowledgeFragment;
  symbol: string;
  qualified: string;
  ordinal: number;
}

interface ReferenceIndex {
  byId: Map<string, number>;
  calls: Map<string, number[]>;
  references: Map<string, number[]>;
  imports: Map<string, number[]>;
  outgoingImports: Map<number, number[]>;
  declaredReferences: Map<string, number[]>;
  importDiagnostics: CodeImportDiagnostics;
  importCounts: Record<string, CodeImportResolutionCounts>;
  diagnosticBytes: number;
  estimatedBytes: number;
}

function addReference(index: Map<string, number[]>, value: string, ordinal: number): void {
  const entries = index.get(value);
  // Construction visits fragments in ordinal order. A repeated name for this
  // fragment is already the last posting, so no temporary Set is necessary.
  if (entries) { if (entries[entries.length - 1] !== ordinal) entries.push(ordinal); }
  else index.set(value, [ordinal]);
}

function addReferences(index: Map<string, number[]>, values: readonly string[], ordinal: number): void {
  for (const value of values) addReference(index, value, ordinal);
}

/** Generation-bound metadata and ordinal postings may survive a snapshot too
 * large for admission, within sub-budgets of the existing project cache. */
export interface CodeGenerationCache {
  structure?: ProjectStructure;
  pending?: Promise<ProjectStructure>;
  estimatedBytes: number;
  projectReader?: ProjectStructureReader;
  projectEstimatedBytes?: number;
  incoming?: { identity?: string; index: ReferenceIndex };
  incomingEstimatedBytes?: number;
  unindexedPaths?: ReadonlySet<string>;
  unindexedPending?: Promise<ReadonlySet<string>>;
  unindexedEstimatedBytes?: number;
}

export class CodeQueryRuntime {
  readonly snapshot: CodeEvidenceSnapshot;
  private symbols?: { entries: SymbolEntry[]; exact: Map<string, SymbolEntry[]> };
  private incoming?: ReferenceIndex;
  private structureReader?: ProjectStructureReader;
  private structure?: ProjectStructure;
  private paths?: ReadonlySet<string>;
  private pathsEstimatedBytes = 0;
  private unindexedPaths?: Promise<ReadonlySet<string>>;
  private verifiedUnindexedPaths: ReadonlySet<string> = new Set();
  private metadataEstimatedBytes = 0;
  private metadataReady?: Promise<void>;
  private metadataWarnings: ProjectStructure["warnings"] = [];

  constructor(snapshot: CodeEvidenceSnapshot, readonly registry: KnowledgeAdapterRegistry = DEFAULT_QUERY_ADAPTERS,
    private readonly generationCache: CodeGenerationCache = { estimatedBytes: 0 }) {
    this.snapshot = { ...snapshot, fragments: enrichLwcBundles(snapshot.fragments) };
  }

  private sourcePaths(): ReadonlySet<string> {
    if (!this.paths) {
      const paths = new Set<string>();
      for (const fragment of this.snapshot.fragments) paths.add(fragment.path);
      this.paths = paths;
      this.pathsEstimatedBytes = [...this.paths].reduce((bytes, path) => bytes + 128 + path.length * 4, 128);
    }
    return this.paths;
  }

  /** Sidecars follow source freshness: explicit update/remove/rebuild publishes a
   * new generation. Warm symbol/search queries perform no sidecar filesystem IO. */
  async refreshSourceMetadata(repositoryRoot: string): Promise<void> {
    const adapters = this.registry.registrations.map(({ adapter }) => adapter).filter((adapter) => adapter.enrichSourceMetadata);
    if (!adapters.length) return;
    this.metadataReady ??= (async () => {
      const persisted = persistedSourceMetadata(this.snapshot, this.registry);
      if (persisted) {
        this.metadataWarnings = persisted.warnings;
        for (const adapter of adapters) this.snapshot.fragments = adapter.enrichSourceMetadata!(this.snapshot.fragments, persisted);
        this.symbols = undefined;
        this.incoming = undefined;
        return;
      }
      const cache = this.generationCache;
      if (!cache.structure && !cache.pending) cache.pending = (async () => {
        const reader = new ProjectStructureReader(repositoryRoot,
          this.sourcePaths(), this.registry, true);
        const metadata = await reader.load();
        const estimate = metadata.manifests.size || metadata.warnings.length
          ? Buffer.byteLength(JSON.stringify([...metadata.manifests])) * 4 + metadata.manifests.size * 128 + Buffer.byteLength(JSON.stringify(metadata.warnings)) * 4 : 0;
        if (estimate <= 1024 * 1024) { cache.structure = metadata; cache.estimatedBytes = estimate; }
        return metadata;
      })().finally(() => { cache.pending = undefined; });
      const metadata = cache.structure ?? await cache.pending!;
      this.metadataEstimatedBytes = cache.estimatedBytes;
      this.metadataWarnings = metadata.warnings;
      for (const adapter of adapters) this.snapshot.fragments = adapter.enrichSourceMetadata!(this.snapshot.fragments, metadata);
      this.symbols = undefined;
      this.incoming = undefined;
    })().catch((error) => { this.metadataReady = undefined; throw error; });
    await this.metadataReady;
  }

  /** Only reference consumers pay for manifest freshness checks. */
  async refreshProjectStructure(repositoryRoot: string): Promise<void> {
    const cache = this.generationCache;
    this.unindexedPaths ??= (async () => {
      if (cache.unindexedPaths) return cache.unindexedPaths;
      cache.unindexedPending ??= probeUnindexedImports(repositoryRoot, this.snapshot.fragments, this.sourcePaths())
        .then((paths) => {
          const estimate = [...paths].reduce((bytes, path) => bytes + 128 + path.length * 4, 128);
          if (estimate <= 1024 * 1024) { cache.unindexedPaths = paths; cache.unindexedEstimatedBytes = estimate; }
          return paths;
        }).finally(() => { cache.unindexedPending = undefined; });
      return cache.unindexedPending;
    })().catch((error) => { this.unindexedPaths = undefined; throw error; });
    if (!this.registry.registrations.some(({ adapter }) => adapter.projectManifests?.length)) {
      this.verifiedUnindexedPaths = await this.unindexedPaths;
      return;
    }
    if (!this.structureReader || this.structureReader.repositoryRoot !== repositoryRoot) {
      this.structureReader = this.generationCache.projectReader?.repositoryRoot === repositoryRoot
        ? this.generationCache.projectReader : new ProjectStructureReader(repositoryRoot,
          this.sourcePaths(), this.registry);
      // Publish before awaiting load so concurrent runtimes join the reader's
      // pending refresh. Admission is checked once the bounded read completes.
      this.generationCache.projectReader = this.structureReader;
      this.structure = undefined;
      this.incoming = undefined;
    }
    // These confined reads are independent. Drain both before propagating an
    // error so retries cannot race unfinished preparation from a failed request.
    const [probes, manifests] = await Promise.allSettled([this.unindexedPaths, this.structureReader.load()]);
    if (probes.status === "rejected" || manifests.status === "rejected") {
      if (this.generationCache.projectReader === this.structureReader) {
        this.generationCache.projectReader = undefined;
        this.generationCache.projectEstimatedBytes = 0;
      }
      throw probes.status === "rejected" ? probes.reason : (manifests as PromiseRejectedResult).reason;
    }
    this.verifiedUnindexedPaths = probes.value;
    const structure = manifests.value;
    if (this.structureReader.estimatedBytes + this.generationCache.estimatedBytes <= 1024 * 1024) {
      this.generationCache.projectReader = this.structureReader;
      this.generationCache.projectEstimatedBytes = this.structureReader.estimatedBytes;
    } else {
      this.generationCache.projectReader = undefined; this.generationCache.projectEstimatedBytes = 0;
    }
    if (this.structure?.identity !== structure.identity) {
      this.structure = structure;
      this.incoming = undefined;
    }
    if (this.generationCache.incoming?.identity !== structure.identity) {
      this.generationCache.incoming = undefined; this.generationCache.incomingEstimatedBytes = 0;
    }
  }

  projectStructureWarnings(): ProjectStructure["warnings"] {
    return [...(this.structure?.warnings ?? []), ...this.metadataWarnings];
  }

  declaredComponents(paths: readonly string[]): Array<{ path: string; manifest: string }> {
    const components: Array<{ path: string; manifest: string }> = [];
    for (const [manifestPath, manifest] of this.structure?.manifests ?? []) {
      if (manifest.warning || !/^(?:package\.json|go\.mod|Cargo\.toml|tsconfig[^/]*\.json|pom\.xml|[^/]+\.csproj)$/.test(posix.basename(manifestPath))) continue;
      const directory = posix.dirname(manifestPath);
      if (paths.some((p) => directory === "." || p.startsWith(directory + "/"))) components.push({ path: directory, manifest: manifestPath });
    }
    return components.sort((a, b) => a.path.localeCompare(b.path) || a.manifest.localeCompare(b.manifest)).slice(0, 12);
  }

  projectStructureEstimatedBytes(): number {
    return (this.structureReader?.estimatedBytes ?? 0) + this.metadataEstimatedBytes + (this.incoming?.estimatedBytes ?? 0) +
      (this.generationCache.unindexedEstimatedBytes ?? 0) +
      this.pathsEstimatedBytes;
  }

  /** Internal outcome counts are generation inventory, never request/fallback rates. */
  importResolutionDiagnostics(): { diagnostics: CodeImportDiagnostics; byLanguage: Record<string, CodeImportResolutionCounts> } {
    const incoming = this.referenceIndex();
    return { diagnostics: incoming.importDiagnostics, byLanguage: incoming.importCounts };
  }

  private symbolIndex(): NonNullable<CodeQueryRuntime["symbols"]> {
    if (!this.symbols) {
      const entries: SymbolEntry[] = [];
      const exact = new Map<string, SymbolEntry[]>();
      this.snapshot.fragments.forEach((fragment, ordinal) => {
        if (fragment.kind === "module" || fragment.kind === "comment") return;
        const entry = { fragment, ordinal, symbol: normalizedQualifiedSymbol(fragment.symbol), qualified: normalizedQualifiedSymbol(fragment.qualifiedName) };
        entries.push(entry);
        for (const key of new Set([entry.symbol, entry.qualified])) {
          const matches = exact.get(key);
          if (matches) matches.push(entry);
          else exact.set(key, [entry]);
        }
      });
      this.symbols = { entries, exact };
    }
    return this.symbols;
  }

  symbol(sought: string, options: CodeSearchOptions, maxResults: number): Omit<CodeEvidenceHit, "resourceUri">[] {
    const symbols = this.symbolIndex();
    const allowed = (entry: SymbolEntry): boolean =>
      (!options.kinds || options.kinds.includes(entry.fragment.kind)) && codePathAllowed(entry.fragment.path, options.paths);
    const hits = (symbols.exact.get(sought) ?? []).filter(allowed).map((entry) => ({ entry, score: 200 }));
    // Partial matches still fill the result budget. Skip their scan only when
    // enough eligible exact matches already outrank every possible partial hit.
    if (hits.length < maxResults) {
      for (const entry of symbols.entries) {
        if (entry.symbol === sought || entry.qualified === sought || !allowed(entry)) continue;
        const score = entry.qualified.endsWith(`.${sought}`) ? 160
          : entry.symbol.includes(sought) || entry.qualified.includes(sought) ? 80 : 0;
        if (score > 0) hits.push({ entry, score });
      }
    }
    return hits.sort((left, right) => right.score - left.score ||
      left.entry.fragment.path.localeCompare(right.entry.fragment.path) || left.entry.ordinal - right.entry.ordinal)
      .slice(0, maxResults)
      .map(({ entry, score }) => ({ fragment: entry.fragment, score, matchedTerms: [sought] }));
  }

  private referenceIndex(): ReferenceIndex {
    if (!this.incoming && this.generationCache.incoming?.identity === this.structure?.identity) this.incoming = this.generationCache.incoming?.index;
    if (!this.incoming) {
      const modulePaths = new Set<string>();
      const fragmentsByPath = new Map<string, KnowledgeFragment[]>();
      for (const fragment of this.snapshot.fragments) {
        if (fragment.kind === "module") modulePaths.add(fragment.path);
        const siblings = fragmentsByPath.get(fragment.path);
        if (siblings) siblings.push(fragment);
        else fragmentsByPath.set(fragment.path, [fragment]);
      }
      const diagnostics = new ImportResolutionCollector(modulePaths);
      const incoming: ReferenceIndex = { byId: new Map(), calls: new Map(), references: new Map(), imports: new Map(),
        outgoingImports: new Map(),
        declaredReferences: new Map(),
        importDiagnostics: diagnostics.result(), importCounts: diagnostics.byLanguage, diagnosticBytes: 0, estimatedBytes: 0 };
      const issues: CodeImportIssue[] = [];
      const context = { paths: modulePaths, fragmentsByPath, structure: this.structure,
        reportIssue: (issue: CodeImportIssue) => issues.push(issue) };
      const classify = createImportClassifier(context);
      const resolvers = new Map<KnowledgeAdapter | undefined, CodeImportResolver>();
      const referenceResolvers = new Map<KnowledgeAdapter, CodeImportResolver>();
      let legacy: CodeImportResolver | undefined;
      // Inventories repeat the same identifiers across enclosing fragments.
      // Normalize once while building the postings; this map is not retained.
      const normalized = new Map<string, string>();
      const normalize = (value: string): string => {
        let result = normalized.get(value);
        if (result === undefined) { result = normalizedCodeText(value); normalized.set(value, result); }
        return result;
      };
      // Adapters attach the same import inventory to several fragments per file.
      // Memoize resolution only while constructing this generation's incoming map.
      const resolvedBySource = new Map<string, { resolve: CodeImportResolver; language: string; imports: Map<string, readonly string[]> }>();
      const declaredBySource = new Map<string, { resolve: CodeImportResolver; targets: Map<string, readonly string[]> }>();
      this.snapshot.fragments.forEach((fragment, ordinal) => {
        incoming.byId.set(fragment.id, ordinal);
        for (const call of fragment.calls) {
          const value = normalize(call);
          addReference(incoming.calls, value, ordinal);
          const dot = value.lastIndexOf(".");
          if (dot >= 0) addReference(incoming.calls, value.slice(dot + 1), ordinal);
        }
        const declaredNames = fragment.declaredReferences?.length
          ? new Set(fragment.declaredReferences.filter((name) => name.startsWith("schema:")).map((name) => normalize(name.slice(7)))) : undefined;
        for (const reference of fragment.references) {
          const name = normalize(reference);
          if (!declaredNames?.has(name)) addReference(incoming.references, name, ordinal);
        }
        for (const name of fragment.databaseRefs) addReference(incoming.references, normalize(name), ordinal);
        if (fragment.declaredReferences?.length) {
          let declared = declaredBySource.get(fragment.path);
          if (!declared) {
            const adapter = this.registry.resolve({ path: fragment.path });
            if (adapter?.createReferenceResolver) {
              let resolve = referenceResolvers.get(adapter);
              if (!resolve) {
                resolve = adapter.createReferenceResolver({ ...context, reportIssue: undefined });
                referenceResolvers.set(adapter, resolve);
              }
              declared = { resolve, targets: new Map() };
              declaredBySource.set(fragment.path, declared);
            }
          }
          if (declared) for (const name of fragment.declaredReferences) {
            let targets = declared.targets.get(name);
            if (!targets) {
              targets = [...declared.resolve(fragment.path, name)].filter((path) => modulePaths.has(path));
              declared.targets.set(name, targets);
            }
            addReferences(incoming.declaredReferences, targets, ordinal);
          }
        }
        if (fragment.kind === "module" && fragment.qualifiedName === fragment.path) {
          for (const specifier of fragment.unsupportedImports ?? []) {
            const language = this.registry.resolve({ path: fragment.path })?.parserVersion.split("-deterministic-")[0] ?? "legacy";
            diagnostics.begin(fragment.path, specifier, language);
            diagnostics.report({ status: "unresolved", reason: "unsupported_syntax", matchedName: specifier });
            diagnostics.finish(0);
          }
        }
        if (fragment.imports.length === 0) return;
        let resolved = resolvedBySource.get(fragment.path);
        if (!resolved) {
          const adapter = this.registry.resolve({ path: fragment.path });
          let resolve = resolvers.get(adapter);
          if (!resolve) {
            resolve = adapter?.createImportResolver?.(context) ?? (legacy ??= createLegacyImportResolver(context));
            resolvers.set(adapter, resolve);
          }
          resolved = { resolve, language: adapter?.parserVersion.split("-deterministic-")[0] ?? "legacy", imports: new Map() };
          resolvedBySource.set(fragment.path, resolved);
        }
        for (const specifier of fragment.imports) {
          let targets = resolved.imports.get(specifier);
          if (!targets) {
            diagnostics.begin(fragment.path, specifier, resolved.language);
            issues.length = 0;
            targets = [...new Set(resolved.resolve(fragment.path, specifier))].filter((path) => modulePaths.has(path));
            const disposition = !targets.length && !issues.some((issue) => issue.status === "ambiguous")
              ? classify(fragment.path, specifier, resolved.language) : undefined;
            if (!disposition) {
              const local = /^\.{1,2}\//u.test(specifier) ? localPath(posix.dirname(fragment.path), specifier) : undefined;
              const notIndexed = local !== undefined && this.verifiedUnindexedPaths.has(local);
              if (!targets.length && !issues.length && notIndexed) issues.push({ status: "unresolved", matchedName: specifier });
              for (const issue of issues) diagnostics.report(notIndexed && issue.status === "unresolved"
                ? { ...issue, reason: "not_indexed" } : issue);
            }
            diagnostics.finish(targets.length, disposition);
            resolved.imports.set(specifier, targets);
          }
          addReferences(incoming.imports, targets, ordinal);
        }
      });
      incoming.importDiagnostics = diagnostics.result();
      incoming.diagnosticBytes = 2 * JSON.stringify([incoming.importDiagnostics, incoming.importCounts]).length + 2048;
      // Conservative string/map/array allowance. Postings contain ordinals, not
      // fragment objects, so retaining them cannot retain an oversized snapshot.
      const moduleOrdinals = new Map(this.snapshot.fragments.flatMap((fragment, ordinal) =>
        fragment.kind === "module" && fragment.qualifiedName === fragment.path ? [[fragment.path, ordinal] as const] : []));
      for (const [targetPath, sources] of incoming.imports) {
        const target = moduleOrdinals.get(targetPath);
        if (target === undefined) continue;
        for (const source of sources) {
          const targets = incoming.outgoingImports.get(source);
          if (targets) targets.push(target);
          else incoming.outgoingImports.set(source, [target]);
        }
      }
      incoming.estimatedBytes = incoming.diagnosticBytes;
      for (const ordinals of incoming.outgoingImports.values()) incoming.estimatedBytes += 160 + ordinals.length * 16;
      for (const [key] of incoming.byId) incoming.estimatedBytes += 128 + key.length * 4;
      for (const index of [incoming.calls, incoming.references, incoming.imports, incoming.declaredReferences]) {
        for (const [key, ordinals] of index) incoming.estimatedBytes += 160 + key.length * 4 + ordinals.length * 16;
      }
      if (incoming.estimatedBytes <= 16 * 1024 * 1024) {
        this.generationCache.incoming = { identity: this.structure?.identity, index: incoming };
        this.generationCache.incomingEstimatedBytes = incoming.estimatedBytes;
      }
      this.incoming = incoming;
    }
    return this.incoming;
  }

  references(symbolId: string, options: CodeSearchOptions, maxResults: number): Omit<CodeReference, "resourceUri">[] {
    const targetOrdinal = this.referenceIndex().byId.get(symbolId);
    if (targetOrdinal === undefined) throw new Error(`Unknown code evidence symbol id: ${symbolId}`);
    const target = this.snapshot.fragments[targetOrdinal]!;
    return this.referencesTo([target], options, maxResults);
  }

  /** One hop, no new retained graph. Call names must identify one definition;
   * candidates retain the same explicit lexical status as references. */
  relatedEvidence(symbolId: string, maxResults: number): Array<Omit<RelatedCodeEvidence, "resourceUri"> & { fragment: KnowledgeFragment }> {
    const incoming = this.referenceIndex();
    const ordinal = incoming.byId.get(symbolId);
    if (ordinal === undefined) throw new Error(`Unknown code evidence symbol id: ${symbolId}`);
    const target = this.snapshot.fragments[ordinal]!;
    const exactSymbols = this.symbolIndex().exact;
    const result = new Map<string, Omit<RelatedCodeEvidence, "resourceUri"> & { fragment: KnowledgeFragment }>();
    const add = (fragment: KnowledgeFragment, relation: "call" | "import", direction: "incoming" | "outgoing") => {
      if (fragment.id === target.id || result.has(fragment.id)) return;
      if (direction === "incoming" && fragment.path === target.path &&
          fragment.range.startLine <= target.range.startLine && fragment.range.endLine >= target.range.endLine) return;
      result.set(fragment.id, { fragment, relation, direction, basis: relation === "call" ? "lexical_call" : "resolved_import" });
    };
    const names = new Set([target.symbol, target.qualifiedName].map(normalizedCodeText));
    for (const name of names) {
      const sought = normalizedQualifiedSymbol(name);
      const definitions = exactSymbols.get(sought) ?? [];
      if (definitions.length !== 1 || definitions[0]!.fragment.id !== target.id) continue;
      for (const source of incoming.calls.get(name) ?? []) add(this.snapshot.fragments[source]!, "call", "incoming");
    }
    // A symbol claim can navigate the module that imports its containing file.
    for (const source of incoming.imports.get(target.path) ?? []) {
      const fragment = this.snapshot.fragments[source]!;
      if (fragment.kind === "module" && fragment.qualifiedName === fragment.path) add(fragment, "import", "incoming");
    }
    for (const call of target.calls) {
      const name = normalizedQualifiedSymbol(call);
      const matches = exactSymbols.get(name) ?? [];
      if (matches.length === 1) add(matches[0]!.fragment, "call", "outgoing");
    }
    for (const source of incoming.outgoingImports.get(ordinal) ?? []) add(this.snapshot.fragments[source]!, "import", "outgoing");
    const best = new TopResults<NonNullable<ReturnType<typeof result.get>>>(maxResults, (a, b) =>
      (a.relation === "call" ? 0 : 1) - (b.relation === "call" ? 0 : 1) ||
      a.fragment.path.localeCompare(b.fragment.path) || a.fragment.range.startLine - b.fragment.range.startLine ||
      a.fragment.id.localeCompare(b.fragment.id));
    for (const candidate of result.values()) best.add(candidate);
    return best.sorted();
  }

  /** Batch targets share postings, deduplication and bounded ordering. Used for
   * whole-file impact without querying every declaration independently. */
  referencesTo(targets: readonly KnowledgeFragment[], options: CodeSearchOptions, maxResults: number): Omit<CodeReference, "resourceUri">[] {
    const incoming = this.referenceIndex();
    const targetByName = new Map<string, KnowledgeFragment>();
    const modules = new Map<string, KnowledgeFragment>();
    const singleTarget = targets.length === 1 ? incoming.byId.get(targets[0]!.id) : undefined;
    const targetOrdinals = targets.length > 1 ? new Set(targets.map((target) => incoming.byId.get(target.id))) : undefined;
    for (const target of targets) {
      const fileModule = target.kind === "module" && target.qualifiedName === target.path;
      for (const name of [normalizedCodeText(target.symbol), normalizedCodeText(target.qualifiedName),
        ...(fileModule ? [] : [normalizedCodeText(target.qualifiedName.split(".").at(-1)!)]),
        // Database names consumed inside a source file do not identify that file.
        // Entity fragments keep their database aliases and all source-side usage
        // remains indexed; only physical file modules exclude those target aliases.
        ...(fileModule ? [] : target.databaseRefs.map(normalizedCodeText))]) {
        if (!targetByName.has(name)) targetByName.set(name, target);
      }
      if (target.kind === "module" && !modules.has(target.path)) modules.set(target.path, target);
    }
    const seen = new Set<number>();
    const relationRank = { call: 0, reference: 1, import: 2 } as const;
    const best = new TopResults<{ ordinal: number; relation: CodeReference["relation"]; source: KnowledgeFragment; target: KnowledgeFragment }>(
      maxResults, (left, right) => relationRank[left.relation] - relationRank[right.relation] ||
        Number(right.source.isTest) - Number(left.source.isTest) || left.source.path.localeCompare(right.source.path) ||
        left.source.range.startLine - right.source.range.startLine || left.ordinal - right.ordinal
    );
    const collect = (index: Map<string, number[]>, names: ReadonlyMap<string, KnowledgeFragment>, relation: CodeReference["relation"]): void => {
      for (const [name, target] of names) for (const ordinal of index.get(name) ?? []) {
        if (ordinal === singleTarget || seen.has(ordinal) || targetOrdinals?.has(ordinal)) continue;
        const source = this.snapshot.fragments[ordinal]!;
        if (!codePathAllowed(source.path, options.paths)) continue;
        // Enclosing inventories include child declarations. Keep actual sibling
        // method callers, not the containing module/class as a caller of itself.
        if ((source.kind === "module" || source.kind === "class") && source.path === target.path &&
            source.range.startLine <= target.range.startLine && source.range.endLine >= target.range.endLine) continue;
        seen.add(ordinal);
        best.add({ ordinal, relation, source, target });
      }
    };
    collect(incoming.calls, targetByName, "call");
    collect(incoming.references, targetByName, "reference");
    collect(incoming.declaredReferences, new Map(targets.map((target) => [target.path, target])), "reference");
    collect(incoming.imports, modules, "import");
    return best.sorted()
      .map(({ source, target, relation }) => ({ source, target, relation }));
  }
}
