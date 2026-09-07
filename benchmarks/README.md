# Benchmark and quality baseline

The v4 roadmap treats performance, retrieval quality, context efficiency and migration preservation as simultaneous constraints. A faster implementation is not considered an improvement if it loses relevant evidence or degrades downstream document/context quality.

## Retrieval quality

Run the domain-agnostic golden dataset:

```bash
npm run eval:retrieval
```

The evaluator reports, for each retrieval profile and query:

- `Recall@5`
- `Precision@5`
- `MRR`
- `NDCG@5`
- expected-passage heading match

The fixture lives in `benchmarks/fixtures/retrieval-golden.json` and intentionally covers more than one domain or lexical pattern: exact technical identifiers and API paths, current implementation state, architectural decisions, requirements, incidents, business rules and multilingual/Italian content.

Add scenarios when a new retrieval capability or failure mode is introduced. Do not remove hard cases or tune the fixture only to make a new algorithm look better.

The evaluator supports machine-readable output:

```bash
npm run eval:retrieval -- --json=benchmarks/results/retrieval.json
```

Retrieval-quality metrics are deterministic enough to become hard CI regression gates once the Foundation baseline has been captured. The baseline values must be measured from the accepted v3 implementation rather than invented in advance.

## Hybrid accuracy oracle

Run the bounded hybrid path against both lexical-only retrieval and the high-budget evaluation oracle:

```bash
npm run eval:hybrid
npm run eval:hybrid:gate
```

The v4 fixture contains 14 required failure modes, including graph-only siblings, controlled two- and three-hop evidence, a high-degree hub, contradictions, multi-source answers and deep relevant passages. The evaluator reports `CandidateRecall@K`, `EvidenceRecall@K`, `PassageRecall@K`, `MRR`, `NDCG@K`, `GraphOnlyRecoveryRate`, `MultiHopRecall`, `SourceCoverageRecall` and `LostRelevantByPruning` for lexical, bounded and oracle paths.

The gate pins the fixture IDs and maximum bounded budgets as well as the quality baseline. Critical evidence must have `LostRelevantByPruning == 0`; graph-only evidence must be absent from lexical recovery and present in bounded recovery. The oracle is evaluation-only and is not called by the normal runtime path.

## Recall-safe progressive widening

Run the deterministic W0-W3 controller evaluation and its CI gate:

```bash
npm run eval:widening
npm run eval:widening:gate
```

W0 uses the small local budget, W1 enlarges seeds and graph frontier, W2 adds entity-query candidates and the maximum bounded local traversal, and W3 is reserved for an explicitly configured source/code fallback. The normal golden set does not use W3. Coverage signals include query facets, named entities, source diversity, required artifact types, contradictions, passage evidence and truncated graph frontiers.

The gate pins both fixtures and both budgets. It requires final recall at least equal to Milestone A, sufficient displayed evidence, zero evidence lost after widening, a majority of easy cases at W0, automatic widening for the difficult cases, an explicit W2/depth-3 multi-hop probe, per-attempt token/evidence/visited-node budget compliance and no full-graph scan.

## Document-quality diagnostic

`npm run eval:quality` is intentionally a diagnostic evaluator rather than a hard regression gate. Its scores depend on editorial content and heuristic document review rather than a pinned, deterministic golden fixture, so treating the current output as a threshold would create a misleading gate. The deterministic section-evidence, document-contract, and editorial acceptance requirements are enforced instead by `eval:editorial:gate` and `eval:documents:gate`. Promote this evaluator only after adding a reviewed fixture, a stable metric definition, and an accepted baseline without lowering either existing gate.

## Source coverage compiler

Run the deterministic whole-source compiler evaluation and CI gate:

```bash
npm run eval:source-coverage
npm run eval:source-coverage:gate
```

The versioned fixture deterministically materializes a 159,480-character source whose only actionable fact starts at 99.94% of the source. The evaluator requires every character to belong to a bounded, content-addressed segment; rejects unknown coverage; blocks finalization while the terminal segment is unresolved; records explicit evidence/page references; and retrieves the fact later from the wiki index without reading the source or using a fallback.

The gate pins the fixture digest, source size, 4,096-character processing-unit budget, segment count and terminal segment ID. Its closure metrics are `sourceCoveragePercent=100`, `unresolvedSegmentCount=0`, `unrepresentedEvidenceCount=0`, all segments processed and every ignored filler segment carrying a reason.

## Evidence/Claim IR

Run the deterministic extraction-to-synthesis evaluation and CI gate:

```bash
npm run eval:evidence-ir
npm run eval:evidence-ir:gate
```

The versioned golden fixture exercises explicit and synthesized claims, exact duplicates and a contradiction across three canonical sources. Claims are durably recorded in `docs/evidence-ir/store.json` before wiki synthesis, with `sourceUri + segmentId` provenance, origin, confidence and lifecycle status. Linking records duplicates, contradictions and supersession without overwriting either side; synthesis marks non-explicit knowledge and can recreate the generated page byte-for-byte from the IR.

The gate pins the fixture digest, claim IDs, output page paths, duplicate and contradiction counts. It requires 100% provenance, origin preservation and represented claims; zero linking errors and unsupported inferred facts; detected extraction, linking and synthesis fault probes; 100% evidence retention after an injected synthesis failure; 100% contradiction preservation and rebuild content match; closed source coverage; and unchanged canonical source hashes.

## Knowledge recovery / self-healing

Run the deterministic late-discovery writeback evaluation and its CI gate:

```bash
npm run eval:recovery
npm run eval:recovery:gate
```

The fixture records the same source fallback discovery twice and requires one deduplicated durable debt event with two occurrences. Recording debt must not write a wiki page, and premature resolution must fail. The accepted path then uses the existing Evidence IR linker/synthesis pipeline, verifies the exact claim provenance in the page, reconciles the source coverage ledger and closes the event.

The gate pins the fixture digest, claim/event IDs and output page. It requires `KnowledgeRecoveryPending` to move from one to zero, canonical sources to remain unchanged, provenance and coverage updates to be present, and cumulative `LateRecoveryRate` to decrease from `0.6667` to at most `0.3333` after subsequent evidence is served from represented knowledge.

## Code-evidence drift detection

The multi-language extraction corpus and its pinned gate run with:

```bash
npm run eval:code-evidence:languages
npm run eval:code-evidence:languages:gate
```

It hand-labels 199 symbols in 52 real-world-shaped source files totaling 1,429 source lines across Java, Kotlin, Apex, Salesforce metadata, C#, Go, Rust, PHP, C, C++, Python, and Ruby. The mixed-repository benchmark adds two LWC files, bringing that tree to 54 files and 1,446 lines. Baseline v4 separately pins both sets of file, line, and byte counts, the label count, the corpus digest, and generous upper bounds for Python, Kotlin, Ruby, and Salesforce-metadata extraction, then requires at least 0.95 precision and 0.90 recall per language. Optional labels also pin definitions, routes, imports, calls, configuration keys, and database references instead of measuring only symbol inventory. Adversarial masks cover text blocks, C# interpolations containing nested quoted expressions, raw/verbatim strings, Rust and Kotlin nested comments, Kotlin templates, PHP HTML interleaving and heredoc, C/C++ macro/raw-string cases, Python prefixes and f-strings, and Ruby heredocs, percent literals, regex/division ambiguity, and modifier forms. Kotlin function fixtures also pin balanced default-parameter calls and consecutive expression-body declarations. Bounded tests additionally scan deeply nested Kotlin templates, megabyte Kotlin raw strings and Ruby heredocs, and Python's 5,000 nested delimiters plus a 512 KB triple string. The mixed pass pins file reuse after an unchanged rebuild and adapter-specific upgrades.

The resulting in-corpus score is a regression signal over reviewed labels, not evidence that a deterministic heuristic extractor recognizes every construct found in the language ecosystem. New syntax families and production misses should extend this corpus before parser changes are accepted; thresholds must not be weakened to absorb them.

Run the deterministic drift scenarios and their CI gate:

```bash
npm run eval:drift
npm run eval:drift:gate
```

The pinned fixture covers unchanged ranges, trailing-whitespace-only edits, substantive content changes, deleted files, out-of-bounds ranges, and parser upgrades with identical content across every adapter, including Kotlin, Salesforce metadata, Ruby, and decorated Python anchors. The gate requires perfect verdict/reason accuracy, zero false positives, and zero silent misses without lowering any existing threshold. It also records full and path-scoped evaluation timings over 1,000 synthetic anchors; only deterministic workload sizes are gated because absolute timing on shared CI runners is noisy. The end-to-end single-file CLI parity fixture separately enforces a generous 300 ms ceiling. Line-count-changing reflows remain drift because the durable anchor cites fixed lines.

## Task-aware context compiler

Run the six-intent golden task suite and its CI gate:

```bash
npm run eval:task-context
npm run eval:task-context:gate
```

The suite covers `understand`, `implement`, `modify`, `debug`, `review` and `document` on the pinned hybrid-oracle corpus. It materializes every selected passage through the same resource reader an MCP client uses, then measures evidence recall against the golden oracle, parity with the bounded hybrid path, intent-category coverage, directional change-impact recall, unknown reporting, context tokens and bounded traversal work.

The gate pins both the task fixture and the underlying hybrid fixture. It requires 100% task evidence recall, bounded-hybrid parity, category coverage and change-impact recall; zero oracle/hybrid loss, fallback use and full-graph scans; all six intents; and a maximum 4,000-token heuristic structured context without raising the existing retrieval oracle thresholds.

## Semantic passage retrieval / ANN

Run the deterministic passage-index and fusion comparison:

```bash
npm run eval:semantic
npm run eval:semantic:gate
```

`semantic-retrieval-golden.json` pins the existing hybrid-oracle corpus and adds two paraphrase-only cases. The evaluator uses a deterministic concept-axis embedding provider solely to isolate index, ANN and RRF behavior from third-party model drift. It compares semantic-disabled and semantic-enabled retrieval query by query, including the complete hybrid oracle set.

The gate requires aggregate recall to improve, both semantic-only cases to recover, every existing oracle query to remain invariant, the exact-identifier rank not to degrade, and context tokens not to grow on queries with no measured recall gain. It also rejects ANN attempts whose candidate set becomes a full vector scan and pins provider/model/version plus the LSH configuration. Production model quality still needs a provider-specific evaluation before changing the configured model.

## Editorial Intelligence

Run the pinned section-evidence and client-document gate:

```bash
npm run eval:editorial
npm run eval:editorial:gate
```

The evaluator keeps the functional and technical document-quality recall at the v3 baseline, then exercises a template-driven multi-hop section and a deliberately incomplete security section. Each section is compiled through the same task-aware hybrid/progressive-widening path used by `knowledge_context`, and only selected passage resources are materialized.

The gate pins the fixture digest and requires section evidence recall to improve from 50% to 100%, correct `GAP` reporting and evidence-plan resolution, 100% known-source coverage, no increase in claims without provenance, bounded context tokens, zero full-graph scans, zero fallback use and zero full-source grep attempts.

## Typed document contracts

Run the complete type-contract evaluation:

```bash
npm run eval:documents
npm run eval:documents:gate
```

The evaluator covers all eleven declared document types. Every non-custom type must have a template and specialist persona; a complete deterministic fixture must be export-ready, while the corresponding structurally incomplete fixture must be rejected. The gate requires 100% registry, template and persona coverage, 100% valid-document acceptance, 100% invalid-document rejection and 100% export-readiness accuracy.

## MCP tool surface and agent guidance

Run the agent-native surface evaluation through the real MCP transport:

```bash
npm run eval:tool-surface
npm run eval:tool-surface:gate
```

The evaluator requires exactly eight domain tools with no menu or historical aliases.
It separately measures the serialized `tools` array and the complete `tools/list`
result. Their matching pre-consolidation baselines are 19,926 and 26,080 UTF-8
bytes respectively; mixing those units is forbidden. The token proxy is the tools
array's reproducible `UTF-8 bytes / 3`. The versioned fixture is the only baseline
and threshold source. The evaluator also measures tool/action affordance over 31
realistic English and Italian requests, saved menu-routing round trips, and
server-side rejection of incomplete action arguments. It then executes five real
workflow traces covering initialization, canonical pages, atomic Evidence IR
orchestration, document planning/review and code-index maintenance. The same
transport compares `knowledge_context` full and default-compact responses and
requires identical evidence pointers and knowledge gaps.

This verifies that the advertised MCP protocol is mechanically followable without
profiles, menu state or hidden client configuration. The routing matcher uses a
small transparent normalization layer for stop words, plurals, and cross-language
concepts; it is a deterministic schema-quality regression signal, not proof of an
LLM's behavior. Provider-specific A/B remains required before attributing results
to a particular model.

## Code-evidence queries

```bash
npm run bench:code-query -- --scales=1000,10000 --iterations=30 --json=benchmarks/results/code-query.json
```

This benchmark writes deterministic synthetic snapshots with 1,000 and 10,000
fragments. It measures a cold symbol distribution, warm exact and partial symbol
lookups, incoming references, and text search. Every operation creates a new
index instance, matching the MCP tool lifecycle. Result digests must match across
before/after runs with identical parameters. Heap measurements run after garbage
collection and include workspace eviction. The benchmark isolates query costs;
it does not measure source parsing, resource reads or real-world extraction recall.

Query state belongs to one project's resolved wiki root. Each workspace has its
own 32 MiB estimated cache admission budget; activity in another project does not
consume that budget or invalidate its generation. Parsed snapshots and lazy
symbol/reference maps are covered by the estimate, which is not an exact V8 heap
limit. With N resident workspaces the sum of these independent admission budgets
is N × 32 MiB: the default workspace LRU cap of 32 permits 1,024 MiB of estimated
admissions in one process. `KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP` changes the number
of resident workspaces (a positive integer; invalid values use 32). This is neither
a memory reservation nor a global RAM cap. Oversized uncached snapshots, concurrent
loads, result copies, lexical/graph/semantic caches and runtime overhead add costs
outside that number. Separate processes add their memory usage at system level.
Report the admission estimate, measured V8 heap and process RSS separately.

There is no TTL or automatic idle expiry. A generation stays resident until an
internal snapshot write invalidates it, a later query observes an external change,
or the workspace is released/evicted (including automatic workspace LRU eviction).
An external edit without another query does not immediately release the cache.
LRU eviction releases disposable state for the least recently used workspace;
it does not transfer one project's admission allowance to another.

Oversized snapshots remain searchable without cache admission. Each query
checks inode/device, size, nanosecond modification/change timestamps and mode;
cache misses validate a snapshot between two matching metadata observations.
Explicit updates invalidate only the affected workspace. Public snapshot reads
and source-resource validation continue to read their authoritative files.

Exact symbol lookups skip partial matching only when enough eligible exact hits
already fill the requested result count. Otherwise partial matches still fill
the result set. Text search retains exhaustive substring scoring and uses bounded stable selection of the requested results. Compare
latency and memory alongside `eval:code-evidence:gate`,
`eval:code-evidence:languages:gate`, and `eval:drift:gate`.

## Scaling baseline

Quick local run:

```bash
npm run bench:scale
```

The default scales are 1k, 5k and 10k pages. For the full v4 baseline:

```bash
npm run bench:scale -- --scales=1000,5000,10000,50000,100000 --iterations=25 --json=benchmarks/results/v3-baseline.json
```

The benchmark grows one synthetic wiki incrementally and records:

- cold BM25 latency;
- forced-refresh BM25 latency;
- warm BM25 p50/p95/p99;
- one-page incremental update latency;
- graph build latency;
- graph query p50/p95/p99;
- warm graph load p50/p95/p99;
- section-context latency with and without graph;
- graph node/edge count;
- current graph-query global-scan lower bound (all graph nodes and edges are considered before the bounded result is produced);
- returned context characters and lexical-token proxy;
- process heap usage.

The lexical-token count is a stable project-local proxy for context size, not a model-specific tokenizer estimate. Model-token budgeting is introduced separately in the progressive-disclosure phase.

Large scale runs are intentionally not executed on every CI job. CI uses a small smoke dataset to guarantee that the benchmark itself remains executable.

### Performance gate policy

Do not hard-fail CI on absolute p95/p99 timings from shared GitHub-hosted runners: those values are noisy and can create false regressions. Performance-sensitive PRs must instead capture before/after JSON on the same machine, Node version, scale and iteration count. Structural complexity metrics (for example removal of the graph global scan) are evaluated alongside wall-clock latency.

## Comparing implementations

For any v4 retrieval/graph refactor, capture before/after JSON on the same machine and Node version. At minimum compare:

1. retrieval quality on the golden set;
2. p50/p95/p99 latency at increasing wiki sizes;
3. global vs local graph work and candidate/neighbor budgets;
4. number/size of evidence returned to the model;
5. write/update behavior;
6. migration compatibility tests;
7. document quality evaluation where the change affects context selection.

A change is not release-ready merely because it is faster. It must preserve or improve evidence quality and must not weaken migration/document guarantees.

## Test execution

`npm test` uses `scripts/run-tests.mjs`, which discovers test files explicitly rather than relying on shell glob expansion. Files run in isolated Node processes with bounded concurrency and a configurable per-file timeout. This makes execution consistent across Windows, Linux and macOS and prevents one leaked handle from indefinitely blocking the full suite.

`npm run eval:coverage` reports GAP precision and silent-miss for the pinned 25-case coverage fixture, including present and substring-only-missing single-word proper nouns. The same fixture is enforced by `eval:semantic:gate`, which requires lexical coverage to improve over the reproduced 2.0.5 exact-match path, semantic coverage to improve further, and both tiers to retain zero silent misses.

Useful environment variables:

```text
TEST_CONCURRENCY=4
TEST_FILE_TIMEOUT_MS=180000
```

## Legacy migration contract

Run the pinned v1/v2/v3 preservation suite:

```bash
npm run eval:migration
npm run eval:migration:gate
```

The evaluator materializes the same realistic knowledge, custom frontmatter, known source, unavailable source and request/decision/test chain in each legacy format. It proves that plan is read-only; every canonical byte and custom field is preserved; backups are complete; page/source counts and graph links remain invariant; retrieval and critical document context stay at 100% recall; known legacy sources remain `legacy_unverified`; unavailable sources are explicitly tracked; and no semantic enrichment is invented.

Each case is then rolled back and must recover its original format and canonical digest. Absolute migration latency is reported but not hard-gated on shared runners.

`tests/migration-compatibility.test.ts`, `tests/legacy-migration-v4.test.ts`, `tests/legacy-namespace-migration.test.ts`, and `tests/fs-manifest.test.ts` additionally cover automatic rollback after a failed backfill, corrupt ledgers, idempotent v4 repair, refusal to overwrite newer post-migration knowledge, the pre-rebrand `.llm-wiki` namespace, v1 manifest compatibility, coverage-ledger import, dual-namespace conflicts, unsafe or incomplete legacy metadata, and byte-identical manifest v2 output across CRLF/LF, Unicode NFD/NFC path, and filesystem timestamp variants.

Migration must preserve unknown/custom canonical fields and must not silently reinterpret old pages into new semantic classes such as `invariant` or `inference`.


## Local import references

Import extraction and incoming `import` relations are separate capabilities.
Adapters now own resolution through optional `createImportResolver(context)`;
the context exposes indexed module paths and declarations grouped by file.
Factories and their lookup maps are built only for adapters with actual imports,
once while building the generation's incoming map. Each source/specifier pair
is resolved once, even when its import inventory appears on several fragments.
Temporary lookup maps are released after construction. The runtime validates
returned paths against the inventory and deduplicates edges; call/reference/import
precedence, filters and ordering remain shared rules.

| Importing language | Supported project-local evidence | Selection |
| --- | --- | --- |
| JS/TS | Relative files, runtime/source substitutions, directory indexes, declared `paths`/`baseUrl` and one local config inheritance level | Exact pattern, then longest prefix; exact runtime file first, otherwise one candidate |
| Python | Dotted modules, relative imports, packages, `.pyi` fallback, importer siblings and regular-package source roots | One candidate across eligible roots |
| Java/Kotlin | Shared qualified declarations, static owner imports, aliases, package/type wildcards | Unique file for a name; explicit wildcard groups may span files |
| C# | Qualified types, nested namespaces and compatible partial declarations within a csproj boundary | Unique type or compatible partial group; namespace imports can span files |
| PHP | Declared classes/functions/constants, mixed groups, aliases, PSR-4/PSR-0/classmap/files | Unique file per declared name and symbol kind |
| Go | `go.mod` module identity plus relative package directory; legacy suffix matching only without discovered Go manifests | Non-test implementation files within the importing module's boundary |
| Rust | `crate`, `self`, `super`, use groups, `.rs`/`mod.rs` and indexed inline modules | One file per resolved module; source crate confines lookup |
| C/C++ | Quoted paths from importer directory, declared compile_commands include paths or literal CMake targets | One indexed header; competing configurations ambiguous, angle includes unresolved |
| LWC | `@salesforce/apex/Class.method`, indexed `@salesforce/schema/Object.Field`, `c/component` | One indexed declaration or conventional local bundle |
| Ruby | require_relative and ordered literal gemspec require_paths | First supported declared load path; external gems and dynamic paths unresolved |
| Custom adapters without a resolver | Original lowercase import-tail to file-stem comparison | One candidate; collisions are reported as ambiguous |

Resolvers keep their array-returning contract. An optional synchronous
`CodeImportContext.reportIssue` callback reports failed singular lookups or members
of a group. Custom resolver arrays remain trusted groups. The shared runtime counts
each source/specifier once, prioritizes ambiguity over other failures and records
`partial` when valid group members remain. Counts by adapter language family are
internal generation inventories, not request counts or fallback rates.

`knowledge_code references` exposes at most twelve `unresolvedImports` with four
candidate paths each. Ambiguities sort before unresolved examples. The diagnostic
scope is the whole indexed snapshot, independent of target and path filters;
truncation is explicit, including strings abbreviated to 256 UTF-16 code units.
Samples have a separate bounded selection and participate in existing cache
admission. No per-query repository scan or new persistent cache is introduced.
See the [usage guide](../docs/guides/code-evidence-retrieval.md) for interpretation.

Run the dedicated source/manifest oracle with:

```bash
npm run eval:imports:gate
node --import tsx benchmarks/import-resolution-eval.ts --gate --json=benchmarks/results/import-resolution.json
```

The versioned fixture covers 30 development/evaluation cases across JS/TS, Python, Java, Kotlin,
C#, PHP, Go, Rust, C/C++, Ruby and LWC/Apex. It requires exact file-level import
edges and diagnostic outcomes, including missing/extra negatives and valid members
of partial groups; queries must not rewrite snapshots. Existing gates retain their
thresholds. These are hand-authored examples,
not a broad measurement of language understanding or arbitrary repository layouts.

The report includes edge precision/recall by source language and an offline fallback
oracle: a reference request needs fallback when its labeled import edges are missing
or extra. This is distinct from observed public-request telemetry. Compare the same
fixture with `--runtime=/path/to/preserved/runtime`; historical user rates cannot be
reconstructed when a denominator was never recorded.

`npm run eval:functional-routing:gate` adds 29 scenarios over three domain stories,
Italian/English queries, two source layouts and document/code-only projects. It
checks displayed incoming evidence, claim provenance, stale/ambiguous/anchorless
negatives, token disclosure and explicit acceptance of related-code proposals.
Recorded aliases drive the lexical run. `eval:project-precision` includes this corpus
alongside its unchanged original questions. The full suite now contains 18 gates.

`npm run eval:public-manifests:gate` verifies unmodified manifest bytes from six public
projects, pinned by Git commit, source URL and SHA-256. `public-project-manifests.json`
contains the source bytes; `public-project-imports.json` provides controlled source
overlays and independent expected edges/negatives. Three cases are development and
three evaluation. Django, Symfony Console, ripgrep, Rack, chi and Flask cover actual
manifest grammar, including unrelated sections and an unsupported Flit layout. These
are not whole-project imports or private-user observations; source overlays are synthetic.

With an embedding provider configured, run the same functional and semantic probes live:

```bash
node --import tsx benchmarks/functional-routing-eval.ts --live --json=benchmarks/results/functional-live.json
node --import tsx benchmarks/semantic-retrieval-eval.ts --live --json=benchmarks/results/semantic-live.json
```

Live runs retain the fixture oracle and production ANN settings. The optional
`KNOWLEDGE_RAIL_EMBEDDING_QUERY_PREFIX` affects queries only and participates in
provider identity. Ollama qwen3-embedding:0.6b results, including the failed paraphrase
probes, are reported in [knowledge-routing-2.8.0.md](knowledge-routing-2.8.0.md).
The deterministic semantic quality gate retains its own pinned provider and settings.

### Workspace specific page retention

```bash
node --import tsx benchmarks/workspace-selection-eval.ts --json=benchmarks/results/280-workspace-selection.json
```

The twelve questions in `fixtures/workspace-specific-pages.json` identify expected
pages and supporting active-claim text in the real KnowledgeRail wiki. The probe
freezes all canonical page bytes, including history, and records their SHA-256.
It compares the current runtime with an isolated copy that bypasses exactly the
dominance-selection call; fusion, coverage, source text and budgets stay unchanged.
It verifies identical scored candidate pools. Three profiles and two budgets yield
72 runs of the same twelve questions, not 72 independent questions. Runs use fixed
W0 and explicit lexical mode to isolate selection; there is no production flag or
change to the workspace pages.

The report separates target-page retention, display-budget omissions and dominance
removals. Other pages are not labeled irrelevant, so this is not a precision score.
On the measured six-page workspace all expected pages already rank first. This
check cannot establish safety when an overview outranks a specific page, and does
not establish answer correctness, selected-passage freshness or general stability.
Broader examples with overview/detail hierarchies remain needed. The probe is an
exploratory check, not a new gate or a replacement for the existing held-out corpus.

The deterministic regression in `tests/hybrid-retrieval.test.ts` separately exercises
an overview ranked first and a specific page ranked second across all three profiles.
It checks equal signals, a strict subset of the same/different type, the half-query
boundary, low-coverage dominance and signals missing from the entire pool. Selection
protects candidates covering at least half of all query facets/entities; ordinary
result and token budgets still apply. See the measured precision tradeoff in the
[follow-up report](knowledge-routing-2.8.0.md#review-follow-up--overviewdetail-coverage-guard).

Measure generation construction and bounded diagnostic disclosure separately:

```bash
node --expose-gc --import tsx benchmarks/import-diagnostics-bench.ts --json=benchmarks/results/import-diagnostics.json
# Compare with a preserved incoming working tree:
node --expose-gc --import tsx benchmarks/import-diagnostics-bench.ts --runtime=/path/to/baseline --json=benchmarks/results/import-diagnostics-before.json
```

The benchmark uses actual TS adapter output at 1k/10k fragments with one local and
one unresolved external import per source. Extraction, manifest discovery and disk
loading are outside the measured incoming-map construction. It separately reports
warm reference selection, diagnostic cloning, retained heap and sample admission
estimate. Compare result digests before interpreting timing differences.

JS/TS supports `.js` → `.ts`/`.tsx`, `.jsx` → `.tsx`, `.mjs` → `.mts`, and
`.cjs` → `.cts`. An exact existing runtime file wins before substitution.
Extensionless imports may match a file or directory index; multiple alternatives
stay unresolved. The nearest `tsconfig.json` or `jsconfig.json` provides declared
aliases; `tsconfig.json` wins when both occur in the same directory. JSONC comments,
trailing commas, exact mappings, one wildcard with a suffix and ordered target
fallback are supported. Ambiguous targets stop fallback; equally specific wildcard
patterns also stay unresolved. `rootDir` never supplies an implicit import root.
One relative `extends` path is read with an optional `.json` suffix; relative options
keep their declaring config's origin and child `paths` replaces the parent map.
These supported rules follow the [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths)
and [config inheritance](https://www.typescriptlang.org/tsconfig/extends.html).
This is a bounded structural resolver: it does not emulate every `moduleResolution`
mode, project references, include/exclude ownership, package exports or bundler
settings. Npm packages and undeclared aliases are not inferred. Remote, array,
cyclic and deeper inheritance fail with manifest diagnostics; relative imports
remain usable when the config is invalid.

Python searches declared setuptools roots or a script's directory, so `src/cli.py` can import its
sibling `src/orders_cli.py`. A chain of indexed `__init__.py`/`.pyi` packages
also identifies the importer's package source root: with `src/app/__init__.py`,
`src/app/service.py` can import `app.orders` from `src/app/orders.py`.
This does not expose `orders_cli` globally to root-level scripts. A shared base
is checked once; different candidates remain unresolved. Relative imports stay
within the known package chain; no regular package means relative imports are
unresolved. `.pyi` is only a fallback for its corresponding
`.py`. Additional `sys.path` roots, namespace-package root inference and dynamic
imports remain outside this contract. `from pkg import child` links the recorded
specifier `pkg`; it does not guess that `child` is a submodule.

Java/Kotlin/PHP names come from extracted declarations, not a filename or an
assumed `src/main/java` root. Duplicate qualified declarations stay unresolved
for a direct name lookup. C# namespace imports and explicit Java/Kotlin wildcard
imports intentionally identify groups, not a single arbitrarily chosen class.
They describe the import scope, not proof that every declaration is used.
Overload/type-system/accessibility analysis is not added; imported Java static members
identify their owning class. C# partial declarations must agree in kind/arity and
project boundary. Full Gradle/MSBuild evaluation remains outside the contract.

Go indexes directory groups rather than file stems. With `module example.com/app`
in a `go.mod`, both `internal/orders/create.go` and `internal/orders/cancel.go`
can be reached from `example.com/app/internal/orders`, independent of the module's
directory in the repository. An external import with the same directory suffix
does not match. Nested `go.mod` files establish separate boundaries; other local
modules are not inferred as dependencies. `_test.go` files are excluded. These
identities follow the [Go module/package model](https://go.dev/ref/mod#modules-packages-and-versions).
`go.work`, `replace`, vendor and build-tag selection remain outside this resolver.
Without discovered Go manifests, the previous suffix heuristic remains available
for compatibility, including its possible false positives; `legacy_suffix_heuristic`
diagnostics distinguish its unverified candidates from declared resolution.

Adapters optionally declare `projectManifests` parsers. The shared reader discovers
manifests along indexed file ancestors once per code generation, reads at most
256 KiB per file with 16 concurrent operations, and retains compact parsed values.
The optional `references` hook supplies up to 32 direct local dependencies per
manifest, parsed with the same spec. Only one level is followed. Current dependencies
are rechecked, including missing files; edited references discover new targets and
prune old ones. No executable config or recursive dependency graph is evaluated.
Known manifest edits (including equal-sized edits with restored mtime), deletion,
recreation and root-manifest creation are detected on reference queries. To discover
a newly added nested manifest, rebuild or call `knowledge_code action="update"`
with its repository-relative path. `update` and `remove` publish a derived generation
without extracting source files. This avoids rescanning every directory per query.
Malformed, oversized and unsafe manifests produce at most 12 `manifestWarnings`
in the MCP reference response, with `manifestWarningCount` for the total. They do
not trigger fallback to a guessed module identity. Parser data shares the existing
32 MiB estimated admission budget; oversized generations remain queryable without
retention. Source snapshot schema remains v2; Ruby/C/C++ syntax provenance and the
TS inventory fix advance their extraction versions independently of manifest parsing.

Run `npm run bench:project-structure -- --iterations=30` for Go discovery,
known-manifest freshness, retained/released heap and incoming-map costs at roughly
1k/10k fragments. It compares 50 files per directory with one file per directory.
It excludes source extraction and persisted-snapshot loading; it does not measure
the separate `knowledge_context` code-impact path. Regression coverage is in
`tests/project-structure.test.ts`. Add `--language=javascript` for declared aliases
with a shared local base config using the same benchmark and lifecycle. Additional
coverage is in `tests/javascript-project-structure.test.ts`, including comparisons
with the dev dependency TypeScript compiler for unambiguous supported mappings.
Use `--language=csharp`, `--language=ruby` or `--language=cpp` for variable-name
project manifests, ordered gem load paths or compilation database include paths.
Reports show the actual extracted fragment count: the C++ prototype fixture yields
one file module per header rather than the two fragments of the other fixtures.

For the actual task compiler, run `npm run bench:code-context -- --gate`.
It uses real TS extraction output in persisted 1k/10k-fragment snapshots and measures
the complete `compileTaskContext` call, with 40 paired warm samples against the same
document-only request. The 2,000-token case requests one source root; the 4,000-token
case requests three. Both must actually disclose code relations and stay within the
manifest's heuristic budget. `--gate` requires the paired p50 overhead to remain at
most 5 ms; it is a separate performance gate, not a change to the 15 quality gates.
Pass `--baseline=/path/to/preserved/runtime` to check document-only context parity.
Cold snapshot loading, retained heap, admitted cache size, root/relation counts and
display tokens are reported separately. Fixture extraction is outside the interval;
source bodies are not materialized by context. The small wiki and empty evidence IR
do not model a large history; actual-project measurements are recorded separately
in `knowledge-routing-2.8.0.md`. This estimate covers the task-context manifest,
not provider tokenization or every byte of the MCP envelope.

`tests/code-task-context.test.ts` covers source roots, callers/importers, active claim
roots, related wiki metadata, manifest refresh, full/compact MCP links, root/relation
limits, token fitting, read-only failures and preservation of scope during widening.
Related wiki metadata does not silently satisfy documentary coverage. Fixed expansion
limits set `widenable: false`; larger context budgets are suggested only for display
omissions that can actually benefit from them.

Python setuptools, Composer PSR-4 and Cargo target/workspace manifests use the same
reader. `tests/declared-manifests.test.ts` covers literal declarations, invalid forms,
refresh, isolation and excluded namespaces. See the [bounded language contract](../docs/guides/code-evidence-retrieval.md)
for supported TOML/INI/JSON forms and deferred build-tool features.

Rust uses declared Cargo roots or indexed file/module conventions within the source crate. `.rs` and
`mod.rs` collisions remain unresolved; `super` cannot escape the crate.
Use-tree expansion is bounded to 65,536 characters, depth 32 and 1,024 visited
nodes. Arbitrary `#[path]`, conditional compilation, re-export chains and
edition-dependent/external bare paths are not inferred. C/C++ quoted includes use
the including directory and declared compile_commands/literal CMake include paths;
angle headers and dynamic build configuration remain unresolved. Ruby resolves literal
`require_relative` and ordered gemspec load paths, while dynamic runtime paths remain
unsupported. Optional module `importStatements` preserve syntax without
changing raw import arrays. Header references never imply an implementation twin.

`npm run bench:code-telemetry` isolates the cost of the bounded, atomic OS-buffered
request counters from index/context latency. `npm run report:code-requests -- /path/to/wiki`
prints the same query-free aggregate exposed by admin status. Recent request IDs are
retained for correlation; no new permanent in-memory cache is added.

Apex and Salesforce metadata do not emit Java-style imports. Their existing
symbol/database reference matching still links metadata and Apex. LWC virtual
imports now use actual indexed Apex methods and object/field declarations;
standard platform modules or missing metadata do not receive fabricated edges.

Validation: `tests/code-import-resolution.test.ts` contains ten realistic cases
across the nine non-JS/Python languages, including Go's different-filename case.
Eight cases failed before this correction; all ten now resolve their expected
importing fragments. `tests/import-adapter-contract.test.ts` separately covers
ambiguity, aliases, groups, negative paths, namespace/package cardinality,
Salesforce imports, lazy construction, custom registries and unchanged persisted
snapshots. These cases establish supported behavior, not a language-wide success
rate. The earlier bare-specifier parity probes did not establish that coverage.

Knowledge pages now expose a direct code resource when an Evidence IR claim has
a verified code anchor. See [the retrieval workflow](../docs/guides/code-evidence-retrieval.md)
and run `npm run dogfood:import-knowledge` to populate and verify this repository's
local wiki. The source notes, pages and result JSON remain local generated data.

## Quality and efficiency workloads (2.7.4)

The [local comparison report](quality-efficiency-2.7.4.md) records the measured
tradeoffs, scope and remaining limits. To reproduce the workloads:

```bash
npm run bench:update -- --pages=10000 --iterations=30 --vocabulary=20 --json=benchmarks/results/update.json
npm run bench:page-terms
npm run bench:reconcile -- --scales=100,10000,100000 --iterations=10
npm run bench:reconcile:full -- --runtimes=/path/to/preserved/baseline,.
npm run bench:code-query -- --scales=1000,10000 --iterations=100 --json=benchmarks/results/code-query.json
npm run bench:code-profile
npm run bench:code-parity -- --baseline=/path/to/preserved/baseline
npm run bench:lexical-selection -- --iterations=100 --json=benchmarks/results/lexical.json
npm run eval:project-precision
npm run bench:stability -- --operations=10000 --duration-ms=300000
```

Preserve the pre-change working tree, including local optimizations, and use the
same benchmark harness and parameters in both copies. `bench:lexical-selection`
also accepts `--runtime=/path/to/preserved/baseline`. Its optional phase callback
measures scoring (including heap selection) separately from final sorting.
`bench:code-profile` isolates filtering, scoring, full sorting and result copies;
`bench:code-parity` compares exact result objects including scores and stable ties.

`bench:reconcile` measures the filesystem metadata phase with the actual confined
path resolver and stat calls. It compares unbounded, 8, 16, 32 and 64 concurrent
checks; the runtime uses 64. Memory includes the ordered results array and a
5 ms sampler; sampling can miss short peaks. The worker pool stops scheduling on
failure and drains started work before propagating the first error. Full
reconciliation publishes only after verification succeeds. `bench:reconcile:full`
adds cold indexing and forced warm reconciliation; multiple `--runtimes` run in
separate processes to keep heap/RSS comparisons independent.

`bench:update` reports edit and removal latency plus sampled heap/RSS, with an
optional per-page vocabulary expansion. `bench:page-terms` compares a direct
vocabulary scan, term derivation and an inverse map; it also reports the inverse
map's additional heap after GC. Term removal now scales with the page's terms;
whole-page deletion still rebuilds the corpus revision ledger.

The versioned project-precision fixture contains locally authored questions about
KnowledgeRail, not production user logs. Development and evaluation cases stay
separate, synthetic adversarial pages are identified, and source anchors validate
project evidence. `eval:project-precision -- --runtime=/path/to/preserved/baseline`
repeats the fixed fixture on a preserved runtime. The evaluator reports found recall, displayed recall/precision,
correct/false GAPs and silent misses, plus real-adapter import precision and the
observed dynamic-Python-import limit. It does not tune ranking or lower existing
gates to fit these cases.

The stability plan is printed before execution: one project, 100 source files,
100 wiki pages, 10,000 operations over at least five minutes. Each 100-operation
cycle includes 40 symbol reads, 30 text queries, 20 reference reads and one of
each of ten mutation/recovery scenarios. Every 1,000 operations it checks a
2-second idle interval, post-GC heap and workspace release. The report separates
admission estimates, post-GC heap, sampled heap/RSS peaks and OS process peak RSS.
It exercises admitted and oversized snapshots and fully built lazy maps; this
bounded local run is not a long-duration production guarantee.


The review follow-up covers manifest field projection (including unrelated TOML
dates/tool sections), Cargo member warnings without losing package roots, counter
archive/recovery across concurrent processes, and one-refresh related-evidence
batches. Python backend limits and compact schema hints are explicit in the guide.
The corresponding regressions are in `declared-manifests.test.ts`,
`code-request-telemetry.test.ts` and `related-code-evidence.test.ts`.

```bash
node --expose-gc --import tsx benchmarks/related-code-evidence-bench.ts --runtime=/path/to/preserved/runtime
node --expose-gc --import tsx benchmarks/related-code-evidence-bench.ts
```

This benchmark compares eight sequential proposal queries with one batch using
identical target IDs, snapshots and manifests. It asserts proposal content/counts,
reports result digests and counts manifest refreshes. Timings exclude claim writes
and resource materialization. `warmHeapBytes` is whole-process heap including loaded
modules; it does not isolate batch allocations or prove a memory reduction when
comparing dynamically imported runtimes. See the sixth tranche in
`knowledge-routing-2.8.0.md` for the final measurements.
