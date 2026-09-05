import { createDefaultKnowledgeAdapterRegistry, type KnowledgeAdapterRegistry } from "./adapter-registry.js";
import { createLegacyImportResolver } from "./import-resolution/paths.js";
import { ImportResolutionCollector } from "./import-resolution/diagnostics.js";
import { ProjectStructureReader } from "./project-structure.js";
import { TopResults } from "../top-results.js";
import type {
  CodeEvidenceHit, CodeEvidenceSnapshot, CodeReference, CodeSearchOptions, KnowledgeFragment,
  CodeImportResolver, KnowledgeAdapter, ProjectStructure,
  CodeImportDiagnostics, CodeImportResolutionCounts,
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
  importDiagnostics: CodeImportDiagnostics;
  importCounts: Record<string, CodeImportResolutionCounts>;
  diagnosticBytes: number;
}

function addReferences(index: Map<string, number[]>, values: readonly string[], ordinal: number): void {
  for (const value of new Set(values)) {
    const entries = index.get(value);
    if (entries) entries.push(ordinal);
    else index.set(value, [ordinal]);
  }
}

/** Disposable query structures for one validated snapshot generation. */
export class CodeQueryRuntime {
  readonly snapshot: CodeEvidenceSnapshot;
  private symbols?: { entries: SymbolEntry[]; exact: Map<string, SymbolEntry[]> };
  private incoming?: ReferenceIndex;
  private structureReader?: ProjectStructureReader;
  private structure?: ProjectStructure;

  constructor(snapshot: CodeEvidenceSnapshot, readonly registry: KnowledgeAdapterRegistry = DEFAULT_QUERY_ADAPTERS) {
    this.snapshot = { ...snapshot, fragments: enrichLwcBundles(snapshot.fragments) };
  }

  /** Only reference consumers pay for manifest freshness checks. */
  async refreshProjectStructure(repositoryRoot: string): Promise<void> {
    if (!this.registry.registrations.some(({ adapter }) => adapter.projectManifests?.length)) return;
    if (!this.structureReader || this.structureReader.repositoryRoot !== repositoryRoot) {
      this.structureReader = new ProjectStructureReader(repositoryRoot,
        new Set(this.snapshot.fragments.map((fragment) => fragment.path)), this.registry);
      this.structure = undefined;
      this.incoming = undefined;
    }
    const structure = await this.structureReader.load();
    if (this.structure?.identity !== structure.identity) {
      this.structure = structure;
      this.incoming = undefined;
    }
  }

  projectStructureWarnings(): ProjectStructure["warnings"] {
    return this.structure?.warnings ?? [];
  }

  projectStructureEstimatedBytes(): number {
    return (this.structureReader?.estimatedBytes ?? 0) + (this.incoming?.diagnosticBytes ?? 0);
  }

  /** Internal outcome counts are generation inventory, never request/fallback rates. */
  importResolutionDiagnostics(): { diagnostics: CodeImportDiagnostics; byLanguage: Record<string, CodeImportResolutionCounts> } {
    const incoming = this.referenceIndex();
    return { diagnostics: incoming.importDiagnostics, byLanguage: incoming.importCounts };
  }

  symbol(sought: string, options: CodeSearchOptions, maxResults: number): Omit<CodeEvidenceHit, "resourceUri">[] {
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
    const allowed = (entry: SymbolEntry): boolean =>
      (!options.kinds || options.kinds.includes(entry.fragment.kind)) && codePathAllowed(entry.fragment.path, options.paths);
    const hits = (this.symbols.exact.get(sought) ?? []).filter(allowed).map((entry) => ({ entry, score: 200 }));
    // Partial matches still fill the result budget. Skip their scan only when
    // enough eligible exact matches already outrank every possible partial hit.
    if (hits.length < maxResults) {
      for (const entry of this.symbols.entries) {
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
    if (!this.incoming) {
      const modulePaths = new Set(this.snapshot.fragments.filter((fragment) => fragment.kind === "module").map((fragment) => fragment.path));
      const diagnostics = new ImportResolutionCollector(modulePaths);
      const incoming: ReferenceIndex = { byId: new Map(), calls: new Map(), references: new Map(), imports: new Map(),
        importDiagnostics: diagnostics.result(), importCounts: diagnostics.byLanguage, diagnosticBytes: 0 };
      const fragmentsByPath = new Map<string, KnowledgeFragment[]>();
      for (const fragment of this.snapshot.fragments) {
        const siblings = fragmentsByPath.get(fragment.path);
        if (siblings) siblings.push(fragment);
        else fragmentsByPath.set(fragment.path, [fragment]);
      }
      const context = { paths: modulePaths, fragmentsByPath, structure: this.structure, reportIssue: diagnostics.report };
      const resolvers = new Map<KnowledgeAdapter | undefined, CodeImportResolver>();
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
        addReferences(incoming.references, [...fragment.references, ...fragment.databaseRefs].map(normalizedCodeText), ordinal);
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
            targets = [...new Set(resolved.resolve(fragment.path, specifier))].filter((path) => modulePaths.has(path));
            diagnostics.finish(targets.length);
            resolved.imports.set(specifier, targets);
          }
          imports.push(...targets);
        }
        addReferences(incoming.imports, imports, ordinal);
      });
      incoming.importDiagnostics = diagnostics.result();
      incoming.diagnosticBytes = 2 * JSON.stringify([incoming.importDiagnostics, incoming.importCounts]).length + 2048;
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
        normalizedCodeText(target.qualifiedName.split(".").at(-1)!), ...target.databaseRefs.map(normalizedCodeText)]) {
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
        seen.add(ordinal);
        best.add({ ordinal, relation, source, target });
      }
    };
    collect(incoming.calls, targetByName, "call");
    collect(incoming.references, targetByName, "reference");
    collect(incoming.imports, modules, "import");
    return best.sorted()
      .map(({ source, target, relation }) => ({ source, target, relation }));
  }
}
