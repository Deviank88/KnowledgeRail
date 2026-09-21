import { createDefaultKnowledgeAdapterRegistry, type KnowledgeAdapterRegistry } from "./adapter-registry.js";
import { createLegacyImportResolver } from "./import-resolution/paths.js";
import { ImportResolutionCollector } from "./import-resolution/diagnostics.js";
import { ProjectStructureReader } from "./project-structure.js";
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
  declaredReferences: Map<string, number[]>;
  importDiagnostics: CodeImportDiagnostics;
  importCounts: Record<string, CodeImportResolutionCounts>;
  diagnosticBytes: number;
  estimatedBytes: number;
}

function addReferences(index: Map<string, number[]>, values: readonly string[], ordinal: number): void {
  for (const value of new Set(values)) {
    const entries = index.get(value);
    if (entries) entries.push(ordinal);
    else index.set(value, [ordinal]);
  }
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
}

export class CodeQueryRuntime {
  readonly snapshot: CodeEvidenceSnapshot;
  private symbols?: { entries: SymbolEntry[]; exact: Map<string, SymbolEntry[]> };
  private incoming?: ReferenceIndex;
  private structureReader?: ProjectStructureReader;
  private structure?: ProjectStructure;
  private unindexedPaths?: Promise<ReadonlySet<string>>;
  private verifiedUnindexedPaths: ReadonlySet<string> = new Set();
  private metadataEstimatedBytes = 0;
  private metadataReady?: Promise<void>;
  private metadataWarnings: ProjectStructure["warnings"] = [];

  constructor(snapshot: CodeEvidenceSnapshot, readonly registry: KnowledgeAdapterRegistry = DEFAULT_QUERY_ADAPTERS,
    private readonly generationCache: CodeGenerationCache = { estimatedBytes: 0 }) {
    this.snapshot = { ...snapshot, fragments: enrichLwcBundles(snapshot.fragments) };
  }

  /** Sidecars follow source freshness: explicit update/remove/rebuild publishes a
   * new generation. Warm symbol/search queries perform no sidecar filesystem IO. */
  async refreshSourceMetadata(repositoryRoot: string): Promise<void> {
    const adapters = this.registry.registrations.map(({ adapter }) => adapter).filter((adapter) => adapter.enrichSourceMetadata);
    if (!adapters.length) return;
    this.metadataReady ??= (async () => {
      const cache = this.generationCache;
      if (!cache.structure && !cache.pending) cache.pending = (async () => {
        const reader = new ProjectStructureReader(repositoryRoot,
          new Set(this.snapshot.fragments.map((fragment) => fragment.path)), this.registry, true);
        const metadata = await reader.load();
        const estimate = metadata.manifests.size || metadata.warnings.length
          ? Buffer.byteLength(JSON.stringify([...metadata.manifests])) * 4 + metadata.manifests.size * 128 + Buffer.byteLength(JSON.stringify(metadata.warnings)) * 4 : 0;
        if (estimate <= 1024 * 1024) { cache.structure = metadata; cache.estimatedBytes = estimate; }
        return metadata;
      })().finally(() => { cache.pending = undefined; });
      const metadata = cache.structure ?? await cache.pending!;
      this.metadataEstimatedBytes = cache.estimatedBytes;
      this.metadataWarnings = metadata.warnings;
      if (!metadata.manifests.size) return;
      for (const adapter of adapters) this.snapshot.fragments = adapter.enrichSourceMetadata!(this.snapshot.fragments, metadata);
      this.symbols = undefined;
      this.incoming = undefined;
    })().catch((error) => { this.metadataReady = undefined; throw error; });
    await this.metadataReady;
  }

  /** Only reference consumers pay for manifest freshness checks. */
  async refreshProjectStructure(repositoryRoot: string): Promise<void> {
    this.unindexedPaths ??= probeUnindexedImports(repositoryRoot, this.snapshot.fragments,
      new Set(this.snapshot.fragments.map((fragment) => fragment.path)));
    this.verifiedUnindexedPaths = await this.unindexedPaths;
    if (!this.registry.registrations.some(({ adapter }) => adapter.projectManifests?.length)) return;
    if (!this.structureReader || this.structureReader.repositoryRoot !== repositoryRoot) {
      this.structureReader = this.generationCache.projectReader?.repositoryRoot === repositoryRoot
        ? this.generationCache.projectReader : new ProjectStructureReader(repositoryRoot,
          new Set(this.snapshot.fragments.map((fragment) => fragment.path)), this.registry);
      this.structure = undefined;
      this.incoming = undefined;
    }
    const structure = await this.structureReader.load();
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

  projectStructureEstimatedBytes(): number {
    return (this.structureReader?.estimatedBytes ?? 0) + this.metadataEstimatedBytes + (this.incoming?.estimatedBytes ?? 0);
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
      const modulePaths = new Set(this.snapshot.fragments.filter((fragment) => fragment.kind === "module").map((fragment) => fragment.path));
      const diagnostics = new ImportResolutionCollector(modulePaths);
      const incoming: ReferenceIndex = { byId: new Map(), calls: new Map(), references: new Map(), imports: new Map(),
        declaredReferences: new Map(),
        importDiagnostics: diagnostics.result(), importCounts: diagnostics.byLanguage, diagnosticBytes: 0, estimatedBytes: 0 };
      const fragmentsByPath = new Map<string, KnowledgeFragment[]>();
      for (const fragment of this.snapshot.fragments) {
        const siblings = fragmentsByPath.get(fragment.path);
        if (siblings) siblings.push(fragment);
        else fragmentsByPath.set(fragment.path, [fragment]);
      }
      const issues: CodeImportIssue[] = [];
      const context = { paths: modulePaths, fragmentsByPath, structure: this.structure,
        reportIssue: (issue: CodeImportIssue) => issues.push(issue) };
      const classify = createImportClassifier(context);
      const resolvers = new Map<KnowledgeAdapter | undefined, CodeImportResolver>();
      const referenceResolvers = new Map<KnowledgeAdapter, CodeImportResolver>();
      let legacy: CodeImportResolver | undefined;
      // Adapters attach the same import inventory to several fragments per file.
      // Memoize resolution only while constructing this generation's incoming map.
      const resolvedBySource = new Map<string, { resolve: CodeImportResolver; language: string; imports: Map<string, readonly string[]> }>();
      this.snapshot.fragments.forEach((fragment, ordinal) => {
        incoming.byId.set(fragment.id, ordinal);
        addReferences(incoming.calls, fragment.calls.flatMap((call) => {
          const value = normalizedCodeText(call);
          return [value, value.split(".").at(-1)!];
        }), ordinal);
        const declaredNames = new Set(fragment.declaredReferences?.filter((name) => name.startsWith("schema:")).map((name) => normalizedCodeText(name.slice(7))));
        addReferences(incoming.references, [...fragment.references.map(normalizedCodeText).filter((name) => !declaredNames.has(name)),
          ...fragment.databaseRefs.map(normalizedCodeText)], ordinal);
        if (fragment.declaredReferences?.length) {
          const adapter = this.registry.resolve({ path: fragment.path });
          if (adapter?.createReferenceResolver) {
            let resolve = referenceResolvers.get(adapter);
            if (!resolve) {
              resolve = adapter.createReferenceResolver({ ...context, reportIssue: undefined });
              referenceResolvers.set(adapter, resolve);
            }
            addReferences(incoming.declaredReferences,
              fragment.declaredReferences.flatMap((name) => [...resolve!(fragment.path, name)]).filter((path) => modulePaths.has(path)), ordinal);
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
        const imports: string[] = [];
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
          imports.push(...targets);
        }
        addReferences(incoming.imports, imports, ordinal);
      });
      incoming.importDiagnostics = diagnostics.result();
      incoming.diagnosticBytes = 2 * JSON.stringify([incoming.importDiagnostics, incoming.importCounts]).length + 2048;
      // Conservative string/map/array allowance. Postings contain ordinals, not
      // fragment objects, so retaining them cannot retain an oversized snapshot.
      incoming.estimatedBytes = incoming.diagnosticBytes;
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
    const importedPaths = new Set<string>();
    for (const [path, sources] of incoming.imports) if (sources.includes(ordinal)) importedPaths.add(path);
    if (importedPaths.size) for (const fragment of this.snapshot.fragments) {
      if (fragment.kind === "module" && fragment.qualifiedName === fragment.path && importedPaths.has(fragment.path)) add(fragment, "import", "outgoing");
    }
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
      for (const name of [normalizedCodeText(target.symbol), normalizedCodeText(target.qualifiedName),
        ...(target.kind === "module" && target.qualifiedName === target.path ? [] : [normalizedCodeText(target.qualifiedName.split(".").at(-1)!)]),
        ...target.databaseRefs.map(normalizedCodeText)]) {
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
