# Knowledge routing review — 2.8.0 tranches

The first six tranches below are historical evidence. The seventh completes the
implemented language extensions, precision fixes, public-manifest corpus and live
Ollama evaluation. Current verification: **470 tests in 78 files, 18 quality gates**,
production build, zero runtime audit vulnerabilities and **1,600 identical query
comparisons**. No action or quality threshold was removed to meet timing targets.
The complete milestone remains open for the explicit language and real-project
coverage backlog; passing integration does not claim universal language/semantic accuracy.

Local verification, 2026-09-05/07 (Europe/Rome), macOS arm64, Node 24.9.0.
This report covers 2.8.0 work developed on the existing 2.7.4 working tree. That tree already
contained adapter factories, import fixes, query caches and anchored wiki links.
Those earlier improvements are not attributed to this tranche. The complete
pre-change runtime was preserved at `/tmp/knowledgerail-review-baseline.Puhnr3`;
Git HEAD alone does not reproduce this baseline.

## What the project can establish — first-tranche findings

Functional language must first map to recorded project concepts and evidence.
Module resolution then helps verify and navigate the relevant code. Resolving
imports alone does not make a request such as “cancel an order” map to its
requirements, implementation and tests. Knowledge authored by a model must retain
those connections explicitly; later sessions cannot assume that model's entire
prior context. A document-only project must remain useful without code adapters.

The existing wiki → anchored claim → code resource path works for the six project
pages checked here. Automatic code impact through `knowledge_context` is still
missing: `changed_paths` accepts wiki Markdown paths, and the compiler uses wiki
edges. Caller/reference matches remain lexical candidates, not compiler-proven
execution relationships. Explicit import ambiguity, additional manifest formats
and a request-count denominator for fallback rates remain open.

## Adversarial layout checks

The local probe uses actual adapters and persisted indexes with project manifests.
These are seven concrete capability examples, not a population-wide quality score.

| Case | Before | After |
| --- | --- | --- |
| Java package under an arbitrary source directory | Correct | Correct |
| Kotlin class declared in an unrelated filename/directory | Correct | Correct |
| Go external import with the same directory suffix as a local package | False local edge | No false edge with `go.mod` |
| TypeScript alias declared in `tsconfig.json` | Missing edge | Still missing |
| Python module declared through `package-dir` | Missing edge | Still missing |
| Ruby `require_relative` with an unrelated same-stem file | False edge | Still present |
| C++ angle include with a same-stem local header | False edge | Still present |

The source-path context probe still rejects `src/orders.ts` as a wiki changed path.
Raw fixtures and observations are `results/280-layout-before.json` and
`results/280-layout-after.json`. The local executable is
`milestones/280-layout-probe.mts`; it accepts a runtime root as its optional first
argument and creates/removes its own temporary projects.

## Implemented changes

- Adapters can declare bounded manifest parsers through `projectManifests`.
  The common reader discovers ancestor manifests once per code generation, reads
  at most 256 KiB per file with 16 concurrent operations, confines content reads
  to the repository and retains compact parsed values. Only Go currently declares
  a manifest parser. Existing adapters and custom factories remain compatible.
- Go uses the module path declared in the nearest `go.mod` and package directory,
  respecting nested module boundaries. External suffix matches are rejected in
  declared projects. Unreadable/invalid manifests block guessed resolution and
  return at most 12 MCP warnings plus a total count. Manifest-free projects retain
  the legacy suffix heuristic. `go.work`, `replace`, vendor and build tags remain
  outside the contract. The basic module/package mapping follows the
  [Go module reference](https://go.dev/ref/mod#modules-packages-and-versions).
- Known manifest edits, deletion/recreation and root-manifest creation are checked
  on reference queries. New nested manifests require index rebuild or targeted
  `update`/`remove` for the manifest path. These mutations publish a new derived
  generation and reuse source fragments. Queries themselves do not rewrite the
  snapshot. Parsed manifest retention shares the existing per-project 32 MiB
  admission estimate; oversized generations still serve results without retention.
- Incoming reference selection reuses `TopResults`. It visits matching postings
  and retains only the best candidate records for ordering, plus a deduplication
  set. Relation precedence, path filtering, test preference and stable ties are
  preserved. This does not claim O(k) total query memory: deduplication still
  depends on the number of matching fragments.
- A real project check exposed TypeScript masking of backticks/quotes inside a
  regex as string delimiters, hiding the newly edited Go resolver function. The
  extractor now masks expression-position regexes and preserves UTF-16 offsets,
  while keeping division visible. A resource-read regression failed before the
  fix and now verifies complete, separate function bodies. Adapter v4 triggers
  selective re-extraction; other adapter versions and snapshot schema v2 are
  unchanged. This is not a complete JS lexer: ambiguous statement-position regexes
  and nested Unicode-set syntax still require dedicated coverage.

## Performance and memory

Same machine, deterministic synthetic code-query fixture, 100 cold symbol samples
and 100 samples per warm operation at 1k/10k fragments. The public index is created
anew for each operation, matching the MCP lifecycle. Result digests match at both
scales, including all nine benchmark operations.

| Incoming references | Before p50 ms | After p50 ms | Before p95 ms | After p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 1,000 fragments | 0.2407 | 0.1184 | 0.3369 | 0.1934 |
| 10,000 fragments | 1.9135 | 0.5631 | 2.4149 | 0.6914 |

The 10k reference p50 improves by about 71% on this workload. Warm post-GC heap is
28.650 → 28.730 MiB; released heap is 14.012 → 14.101 MiB. Retained memory is
essentially unchanged, not reduced. These numbers do not measure every language
or claim that general text search improved. Raw reports:
`results/280-review-before.json`, `results/280-review-after.json`.

The dedicated Go benchmark includes manifest discovery, freshness and incoming
maps. Source extraction and persisted-snapshot loading are excluded. At 10,002
fragments and 5,001 files:

| Go structure workload | 102 directories | 5,002 directories |
| --- | ---: | ---: |
| Initial discovery + incoming map, ms (one sample) | 16.05 | 65.90 |
| Warm query including known-manifest checks, p50 ms (30 samples) | 0.093 | 0.082 |
| Warm p95 ms | 0.147 | 0.137 |
| Retained heap increment, MiB | 2.60 | 3.03 |

The retained increment includes incoming indexes and runtime objects, not only
manifest data. The initial implementation probed every possible nested manifest
on every query: 42.83 ms p50 for 5,002 directories even after bounded I/O. It was
replaced with generation-based discovery and known-manifest checks. This is an
explicit freshness policy change, not a like-for-like 500× algorithmic speedup:
discovering a newly created nested manifest now requires `update`/rebuild.
Cold discovery remains proportional to the indexed directory inventory.
Reports: `results/280-structure-initial.json`, `280-structure-bounded.json`,
`280-structure-final.json`. These are targeted measurements, not a long-duration
memory soak or proof of the pending context-impact budget.

The existing context-disclosure benchmark (500 wiki pages, 15 iterations) retains
identical payload sizes and outcomes: eight evidence items and zero gaps. Manifest
construction p50 is 4.036 → 3.909 ms; this small variation is not attributed to the
code changes. That benchmark does not call the task compiler's future code-impact
path. Reports: `results/280-context-before.json`, `280-context-after.json`.

## Quality and actual project knowledge

Baseline: 398 tests in 71 files. Final: **410 tests in 72 files**, TypeScript checks,
repository hygiene, all **15 existing quality gates** and production build pass.
No acceptance threshold was lowered. The parser-upgrade unit test now requests a
version distinct from the fixture's actual version, preserving the same expected
drift verdict and reason.

The 1,600 text/symbol comparisons remain identical. The parity harness gives each
runtime its own adapter roster metadata while keeping fragment bytes identical,
so intentional parser-version migration does not masquerade as a query difference.
Reference ordering additionally has a full-sort oracle covering 1,000 overlapping
call/reference/import candidates, ties, paths and result limits.

The project-precision evaluation initially could not run because its source pointer
still named the previously removed `module-resolution.ts` and `RUNTIME_SUBSTITUTIONS`.
Only that pointer/anchor was repaired. Questions, document bodies, expected answers
and budgets are unchanged; all per-case results match the preserved runtime.
The 12 evaluation questions still have found recall **100%**, shown recall **92.3%**,
shown precision **50%**, and **two false GAPs**. This remains a small local regression
corpus, not evidence of production-level precision. Raw before/after reports are
`results/280-project-precision-before.json` and `280-project-precision.json`.

The project maintenance flow was exercised first on a copy of the actual source,
wiki and evidence store, then on the workspace. Six implementation pages are
retrieved; all 13 current claim links open and all 13 current anchors are fresh.
The script now explicitly supersedes its own older source revisions and verifies
links per current claim, preserving unrelated pages and historical evidence.
The resulting source has 13 active and 13 superseded claims; three old anchors
still show drift. They are reported, not silently recaptured or declared fresh.
See `results/280-import-knowledge.json`.

At the end of the first tranche, one lifecycle gap remained: drift aggregation by page included
superseded claims, so a historical anchor can mark a page containing fresh current
claims stale. The second tranche below fixes this R0 issue. Automatic semantic routing,
import ambiguity and code impact are also still incomplete. This tranche does
not certify the entire 2.8.0 milestone or universal language/layout support.

## Reproduction

```sh
npm run verify
npm run eval:gates
npm run build
npm run bench:code-parity -- --baseline=/path/to/preserved/runtime
npm run bench:code-query -- --scales=1000,10000 --iterations=100
npm run bench:project-structure -- --iterations=30
npm run eval:project-precision
npm run bench:context
npm run dogfood:import-knowledge
```

The last command updates the six local knowledge pages and owned source claims.
In a sandbox that disallows the `tsx` CLI's local IPC socket, the equivalent
`node --import tsx benchmarks/context-disclosure-bench.ts` needs no CLI socket.
Gateway tests require permission to bind loopback. Publication, tags, release
version changes and cross-platform CI were not part of this tranche.

## Second tranche — declared JS/TS configuration and current claim status

Continuation on 2026-09-06 (Europe/Rome). The complete incoming runtime was
preserved at `/tmp/knowledgerail-280-next-baseline.N1zUbx`; measurements below
compare against that first-tranche runtime, not against Git HEAD.

`staleClaimsByPage` now reconciles drift with current claim status. Superseded
anchors remain in the audit ledger, including their verdict and page associations,
but do not alone make a current page stale. This works even when supersession
happens after the last drift check. Active, ambiguous and contradicted claims
continue to propagate drift. The integration test follows source edit → new anchored
claim → explicit supersession → synthesis → task context, then edits the current
implementation again and checks that drift still propagates.

The common project reader now accepts an optional direct-reference hook: at most
32 local dependencies per manifest and one inheritance level, using the same
confined, 256 KiB/file reader and per-workspace admission budget. Changed references
discover new targets and prune obsolete ones; missing declared bases are rechecked.
The reader remains language independent. JS/TS handles its own option inheritance,
alias compilation and config boundaries. No runtime dependency or source snapshot
schema change was added.

JS/TS supports JSONC comments/trailing commas, `paths`, `baseUrl`, exact-pattern and
longest-prefix selection, one wildcard with a suffix, and ordered target fallback.
An ambiguous target stops fallback rather than selecting a later definite edge;
equally specific wildcard patterns also remain unresolved. Local `extends` keeps
relative option origins, and child `paths` replaces the whole inherited map.
Tests compare selected unambiguous outcomes with the existing dev dependency
TypeScript compiler, following the [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths)
and [config inheritance](https://www.typescriptlang.org/tsconfig/extends.html).
Runtime parsing uses the new reusable `parseManifestJson` function.

The closest config defines the supported boundary (`tsconfig` wins over `jsconfig`
in the same directory). `rootDir` does not create aliases and is not retained or
used for import routing. Config include/exclude ownership, project references,
package exports, bundler settings, remote/multiple/deeper inheritance and complete
compiler-mode behavior remain outside this contract. Missing, invalid and unsafe
bases produce bounded diagnostics; relative imports remain available. Adding a new
nested config still requires targeted `update` or rebuild. R3 import ambiguity and
R4 automatic code impact in task context remained open at the end of this tranche;
the third tranche below implements the bounded context expansion.

### Measurements and regression evidence

The same project-structure benchmark now accepts `--language=javascript`; it uses
actual adapters, arbitrary package directories, a root config and a shared local
base config. Source extraction and persisted snapshot loading are excluded from
the measured interval. Each row below has 50 warm samples; retained heap is a local
V8 measurement after GC, including the runtime's derived reference structures.

| JS/TS fragments | Files per directory | Cold discovery + incoming map | Warm p50 including freshness | Warm p95 | Retained heap |
| --- | --- | --- | --- | --- | --- |
| 1,002 | 50 | 5.431 ms | 0.215 ms | 0.358 ms | 0.516 MiB |
| 1,002 | 1 | 17.215 ms | 0.154 ms | 0.204 ms | 0.245 MiB |
| 10,002 | 50 | 21.001 ms | 0.151 ms | 0.264 ms | 2.489 MiB |
| 10,002 | 1 | 111.539 ms | 0.149 ms | 0.212 ms | 2.465 MiB |

This is a new capability with an explicit freshness cost, not a speedup against
the previous unresolved-alias behavior. Cold discovery depends on directory count;
warm checks depend on retained manifests and current declared dependencies.

For unchanged Go work at 10,002 fragments, p50 is 0.086 → 0.086 ms with 50 files
per directory and 0.079 → 0.085 ms with one file per directory. Cold measurements
are 16.122 → 16.537 ms and 66.704 → 66.073 ms respectively. Retained heap remains
2.584 MiB and 3.015 → 3.019 MiB. Result digests are identical at both scales and
layouts; these small timing variations are not claimed as an optimization.
Raw results: `results/280-next-structure-go-before.json`,
`280-next-structure-go-after.json`, `280-next-structure-javascript.json`.

The current-status drift fix reads and validates the evidence store only when the
ledger has linked non-fresh entries. It retains no new permanent cache. On the same
actual project ledger/store (28,396 / 88,998 bytes), a read-only 100-sample probe
changes p50 from 0.232 to 1.290 ms (p95 0.378 → 1.671 ms) and correctly changes
three stale pages to zero. This roughly 1 ms cost buys current-status correctness;
it is not whole-task latency or a large-history scalability result. Empty/fresh
ledger requests avoid the evidence-store read. Reports:
`results/280-next-drift-status-before.json`, `280-next-drift-status-after.json`.

Verification passes **418 tests in 73 files**, repository hygiene, TypeScript checks,
all **15 unchanged quality gates** and production build. All **1,600 text/symbol
comparisons** remain identical. The original declared-alias layout probe now finds
its expected target; the Python package-dir miss and Ruby/C++ false edges remain
explicit in `results/280-next-layout.json`. The small project-precision corpus has
identical per-case outcomes: 12 evaluation questions, 92.3% shown recall, 50% shown
precision and two false GAPs. No thresholds or fixture expectations were relaxed.

The maintenance script was exercised on a copy, then the workspace. Six pages are
retrieved with **16 current anchors fresh and 16 code resources opened**. Each
retrieved page is also checked not to be stale. The owned source now contains
16 active and 26 superseded claims; five historical anchors still show drift and
remain auditable. Report: `results/280-next-import-knowledge.json`.

At the end of the second tranche, the next priorities were explicit import
outcomes (R3), code roots/impact in task context (R4), Python declared package roots
and a realistic import-quality gate. R4 is implemented below. Use the per-tranche
table in the local milestone for current status.

## Third tranche — code impact in task context

Continuation on 2026-09-06 (Europe/Rome). The incoming runtime was preserved at
`/tmp/knowledgerail-280-context-baseline.zwzJMV`. Comparisons use that complete
second-tranche runtime, including incoming working-tree changes.

`knowledge_context` now accepts repository-relative source files in `changed_paths`
and recognizes explicit supported file paths in the task text. For impact intents,
selected wiki pages can also supply code roots through active, anchored claims.
A new integration case starts with the functional request “Modificare il limite
degli storni commerciali”, without a code symbol, and reaches `applyCredit`, its
callers and a related wiki page through the recorded project knowledge. This
demonstrates the functional-request → wiki → claim → code route on a controlled
fixture; it does not establish universal language or arbitrary-layout coverage.

The full and compact responses expose optional `codeRoots`, `codeRelations`,
`codeWikiPages`, `codeSnapshot`, warnings and truncation status under `changeImpact`.
Returned code resources are also MCP resource links. Related wiki pages are
candidates derived from active claims and known graph pages; they do not silently
enter the verified documentary evidence buckets or increase coverage scores.
Superseded, ambiguous, contradicted and known-stale claims do not seed code roots.
An empty result is not evidence that a component is unused.

The expansion reads the existing code snapshot. Missing, corrupt, incompatible or
foreign symlink indexes produce a GAP without an implicit rebuild, repair or disk
write. Source bodies are materialized separately when the model opens relevant
resources. `codeSnapshot` identifies the indexed generation, not live source
freshness. Queries still refresh the supported manifest metadata through the
existing shared project structure.

### Work and memory bounds

- At most three roots, twelve incoming candidates per root and six related wiki
  pages. Small lookaheads detect omitted roots, relations and pages. There is no
  recursive traversal or persisted call graph.
- File roots combine module imports and declaration callers in one shared
  `referencesTo` selection. Existing single-symbol queries use the same selector,
  preserving ordering, relation precedence, path filters and test preference.
  Numeric ordinal exclusion preserves the single-target fast path. Deduplication
  memory still depends on matching fragments; this is not an O(k)-memory claim.
- Page/claim association is now one shared helper. Drift and impact reuse one lazy
  evidence-store read per task, with no additional permanent cache. Tasks without
  code paths or eligible anchored pages return through the existing document-only
  path. Derived code structures retain the shared 32 MiB admission estimate.
- Code candidates fit within the existing task-manifest token estimate through
  bounded prefix selection, using binary search instead of serializing every
  possible tail. Removing roots also removes their relations and page links.
  Tight budgets can leave roots with no displayed incoming candidates. Existing
  mandatory metadata can still exceed very small budgets and reports that fact.
- Widening preserves the original query, source paths and page types. Fixed
  expansion caps use `widenable: false`, avoiding a suggested retry that cannot
  increase those caps. The token estimate covers the task manifest, not the whole
  MCP envelope or a provider tokenizer.

No runtime dependency, persisted code schema or task-context version was changed.

### Context performance

`benchmarks/code-context-bench.ts` measures the actual `compileTaskContext` with
persisted snapshots containing real TypeScript adapter output. Fixture extraction
is outside the timed interval. Each row has forty paired warm samples against the
same document-only task, plus a cold context load. The 2,000-token scenario requests
one root; the 4,000-token scenario requests three. Both assert that incoming
candidates are actually disclosed, that the budget fits and that document-only
output is identical to the preserved baseline.

| Fragments | Token budget | Cold context | Document p50 | With code p50 | Paired overhead p50 / p95 | Displayed roots / relations | Manifest tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2,000 | 10.501 ms | 0.413 ms | 0.949 ms | 0.551 / 0.683 ms | 1 / 1 | 1,960 |
| 1,000 | 4,000 | 7.353 ms | 0.342 ms | 1.262 ms | 0.897 / 1.029 ms | 3 / 27 | 3,986 |
| 10,000 | 2,000 | 55.913 ms | 0.359 ms | 1.277 ms | 0.907 / 1.468 ms | 1 / 1 | 1,961 |
| 10,000 | 4,000 | 44.529 ms | 0.336 ms | 1.889 ms | 1.533 / 2.174 ms | 3 / 26 | 3,932 |

All rows pass the separate 5 ms paired-p50 overhead gate. This is an empirical
acceptance check on these fixtures, not a runtime deadline or a latency guarantee
for every repository. The fixture has a small wiki and empty evidence store;
large claim histories, many manifests and generations exceeding cache admission
need separate measurements. Post-GC retained heap is 2.060 / 1.241 MiB at 1k and
10.612 / 10.522 MiB at 10k. This includes loaded code/query structures and context
state, not solely expansion allocations. The 10k admission estimate is 24,908,192
bytes of the existing 33,554,432-byte limit. Report:
`results/280-context-impact.json`.

On the actual KnowledgeRail wiki/store, twenty warm paired samples compare the
previous document context with the new source-impact context for
`src/context/code-impact.ts`. Selected wiki paths remain identical. Document p50
is 11.892 ms; code context p50 is 13.015 ms. Paired additional p50/p95 is
**1.203 / 1.865 ms**, with three roots, 26 relations and 5,335 estimated tokens
within a 6,000-token budget. Report: `results/280-context-actual-project.json`;
read-only local probe: `milestones/280-context-project-probe.mts`.

Existing code-query result digests remain identical at 1k and 10k fragments.
Incoming-reference p50 changes from 0.209 to 0.197 ms at 1k and from 0.686 to
0.701 ms at 10k (fifty samples). These small variations are not a speedup claim.
Reports: `results/280-context-code-query-before.json` and
`results/280-context-code-query-after.json`.

### Verification and current project knowledge

All **427 tests in 74 files**, TypeScript checks, repository hygiene, **15 unchanged
quality gates** and production build pass. Nine new integration tests cover
functional claim routing, path handling, manifest refresh, read-only error cases,
source-resource materialization, active claim filtering, caps, token fitting,
full/compact links and public-tool follow-up scope. The tool-surface gate caught
an added schema description that grew the catalog and degraded two routing cases.
Removing that duplicate description restored the previous 13,492-byte catalog and
100% fixture routing accuracy; the new usage guidance remains in server
instructions and the code-evidence guide. No thresholds were relaxed.

All **1,600 text/symbol comparisons** remain identical
(`results/280-context-query-parity.json`). The twelve-question project-precision
corpus has the same per-case outcomes: 92.3% shown recall, 50% shown precision and
two false GAPs. The original layout probe now accepts source paths; the Python
package-dir miss and Ruby/C++ false edges remain open. Reports:
`results/280-context-project-precision.json`, `results/280-context-layout.json`.

The maintenance script was exercised on a copy, then on this workspace. Six wiki
pages have **18 current anchors fresh**, with 18 ordinary code resources opened.
An additional real context check opens all **29 disclosed impact resources**:
three roots and 26 relations, with one related wiki-page candidate and 5,335 tokens.
The owned source has 18 active and 42 superseded claims. Ten historical anchors
remain drifted and auditable without making the current pages stale. Reports:
`results/280-context-import-knowledge.json` and its log.

At the end of the third tranche, R4 was implemented within these bounds. R3
explicit ambiguity diagnostics, Python
declared package roots, the known Ruby/C++ false edges, a broader functional/import
quality corpus, R5 related-claim proposals and R6 fallback denominators remain
open. Local success does not certify unseen languages, layouts or regressions
outside the tested corpus. No release or publication was performed.

## Fourth tranche — explicit import resolution diagnostics

Continuation on 2026-09-06 (Europe/Rome). The complete incoming runtime was
preserved at `/tmp/knowledgerail-280-resolution-baseline.AIAodB`; comparisons use
that third-tranche working tree rather than Git HEAD.

`knowledge_code references` now exposes bounded `unresolvedImports`: source path,
specifier, matched name, ambiguous/unresolved status, reason and candidate paths.
The existing reference hit shape is unchanged. The sample covers the indexed
snapshot, explicitly labeled `unresolvedImportsScope: "indexed_snapshot"`; it is
not attributed to the queried target or filtered by its path prefixes. An import
can be unresolved because it is external, unsupported or missing from the index.
It does not automatically indicate an indexing GAP or require a rebuild.

Adapter resolvers keep their array-returning contract. The optional synchronous
`CodeImportContext.reportIssue` callback reports failed lookups; shared
`uniqueImport` handling distinguishes a singular name with several candidates from
an explicit multi-file namespace, package or wildcard group. Custom resolver arrays
remain trusted groups, preserving their existing behavior. In partially resolved
PHP/Rust groups, valid members remain edges while failed members get diagnostics.
The legacy basename fallback now reports collisions rather than linking all
same-stem files. Single-candidate legacy guesses retain their previous limitations.

Generation-local counts classify each unique source/specifier once as resolved,
ambiguous or unresolved. Ambiguity takes precedence within a partial group;
`partial` separately counts groups retaining valid members. Counts by adapter
language family stay internal and do not claim request or fallback rates. They
describe the extracted import inventory, not complete source-language semantics.

The incoming map keeps only twelve diagnostic examples, prioritizing ambiguity,
with four candidate paths each. Text beyond 256 UTF-16 code units is abbreviated
and marked; truncation also covers omitted examples/candidates. Bounded selection
reuses `TopResults`; no complete issue ledger or second graph survives generation
construction. Retained examples and counts participate in the existing workspace
admission estimate. The simple reference API shares query selection while avoiding
copies of diagnostics it does not return. Manifest changes invalidate edges,
examples and counts together, without source extraction or snapshot writes.

Task context carries one compact warning when the snapshot contains incomplete
import resolution, preserving full/compact parity and token fitting. The warning
does not manufacture a missing-index GAP. Runtime dependencies, persisted schema,
adapter extraction versions and the public tool catalog are unchanged.

### Import oracle and compatibility

The new `eval:imports:gate` joins all fifteen existing quality gates without changing
their thresholds. Thirteen hand-authored source/manifest cases cover JS/TS, Python,
Java, Kotlin, C#, PHP, Go, Rust, C/C++, Ruby and LWC/Apex. The oracle requires exactly
**14 file-level import edges and 17 problematic lookup outcomes**, with no missing
or extra edges/diagnostics, and verifies unchanged snapshot bytes after queries.
It covers declared groups, aliases, equally specific patterns, ordered fallback,
duplicate names, package collisions and valid siblings in partial groups.

On the preserved runtime, the same fixture produces two unwanted Ruby legacy
edges and exposes none of the seventeen diagnostic outcomes. Current results
remove those two edges while preserving all fourteen expected edges. These are
small capability examples, not a population-wide language-quality score. Reports:
`results/280-resolution-import-before.json`, `results/280-resolution-import-gate.json`.
The versioned fixture's SHA-256 is recorded in each report.

Six new integration tests cover once-per-specifier counts, partial groups, late
ambiguity prioritization, bounded text/candidates, stable ordering, custom adapters,
manifest refresh, cache admission, detached diagnostic results, MCP response shape
and task-context warning semantics. **433 tests in 75 files**, TypeScript checks,
repository hygiene, all **16 quality gates** and production build pass. The final
targeted recheck after the ordering adjustment also passes thirty tests.

All **1,600 text/symbol comparisons** remain identical
(`results/280-resolution-query-parity.json`). Standard code-query result digests
match at 1k/10k fragments, including references. At 10k, public reference p50 changes
from 0.745 to 0.692 ms and warm heap from 28.880 to 28.943 MiB. These small timing
variations are not attributed as a general search optimization. Reports:
`results/280-resolution-code-query-before.json`, `results/280-resolution-code-query-after.json`.

### Construction, warm queries and retained memory

`import-diagnostics-bench.ts` uses actual TS extraction output with one local and
one unresolved external import per importing file. Extraction, manifest discovery
and snapshot IO are excluded from the measured incoming-map construction. Forty
samples measure initial construction, warm reference selection and diagnostic
cloning separately; returned reference digests match the preserved runtime.

| Fragments | Incoming map p50 before → after | Warm references p50 before → after | Diagnostic clone p50 | Retained heap before → after | Diagnostic admission estimate |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 1.066 → 1.251 ms | 0.075 → 0.058 ms | 0.009 ms | 204,480 → 214,216 bytes | 6,560 bytes |
| 10,000 | 10.185 → 11.733 ms | 0.559 → 0.563 ms | 0.009 ms | 1,280,736 → 1,287,584 bytes | 6,618 bytes |

At 10k the new capability costs about **1.55 ms at construction and 6.7 KiB of
retained heap** in this workload. The retained sample remains twelve issues at
both scales; this does not imply constant total query memory. The incoming map and
existing deduplication remain proportional to the indexed/matching data. Reports:
`results/280-resolution-diagnostics-before.json`, `results/280-resolution-diagnostics-after.json`.

The existing full task-context performance gate also passes, with identical
document-only output versus the preserved runtime. At 10k fragments, warm paired
code-expansion overhead is 0.901 ms for one root/2,000 tokens and 1.484 ms for three
roots/4,000 tokens, below the existing 5 ms threshold. This fixture contains valid
imports and an empty evidence store; the diagnostic-heavy benchmark above measures
the new collection cost. Report: `results/280-resolution-context-impact.json`.

### Current project evidence and remaining work

A read-only probe on this project's existing snapshot (336 files, 3,155 fragments)
compares forty paired `referencesWithDiagnostics` calls against the preserved
runtime. Hits remain identical. Previous/current p50 is 0.216 / 0.228 ms; paired
additional p50/p95 is 0.004 / 0.057 ms. The shared cache remains admitted at
29,370,144 of 33,554,432 estimated bytes. Report:
`results/280-resolution-actual-project.json`; probe:
`milestones/280-resolution-project-probe.mts`.

The actual inventory exposes a Ruby fixture's same-stem collision across languages.
It also includes external imports and import-looking fixture/template strings
extracted lexically from TS files. These observations are reasons to improve
extraction and resolution coverage; the inventory's unresolved counts must not be
presented as a source-coverage or language-failure rate.

Knowledge maintenance succeeded on a copy and then this workspace: six wiki pages,
**19 current anchors fresh and 19 ordinary code resources opened**. A source-impact
context opens all **35 disclosed resources** (three roots, 32 relations), with one
related wiki-page candidate and 5,971 estimated tokens within 6,000. The owned
source has 19 active and 60 superseded claims. Forty-two historical anchors now
show drift after the resolver edits; they remain auditable without making current
pages stale. Report: `results/280-resolution-import-knowledge.json` and its log.

The twelve-question project-precision corpus retains the same per-case results:
92.3% shown recall, 50% shown precision and two false GAPs. Report:
`results/280-resolution-project-precision.json`.

R3 is implemented within this contract. Python declared package roots, Ruby
`require_relative` path semantics, C/C++ quote/angle distinction, extraction of
import-like fixture text, a broader functional/language corpus, R5 related-claim
proposals and R6 fallback denominators remain open. Existing lexical call/reference
candidates are not compiler-proven execution edges. No release was published.


## Fifth tranche — common work and reproduced precision defects

Continuation on 2026-09-06 (Europe/Rome), Node 24.9.0, macOS arm64. The incoming
working tree was clean at `24e783c`, package version 2.7.4, with 433 passing tests.
The complete incoming runtime is preserved at
`/var/folders/02/jd8r0gn93697nww15ln701lc0000gn/T/knowledgerail-280-pending-baseline.5MPJJy`.
This tranche closes the requested common work and known defects within the
contracts below. No dependency, release version or publication was changed.

### Declarations, precision and compatibility

Python setuptools declarations now supply physical roots and logical package
names from `pyproject.toml` or `setup.cfg`: package-dir, explicit packages/modules,
and supported literal find roots/include/exclude patterns. Named directory mappings
preserve relative imports. Metadata-only pyproject files do not shadow setup.cfg.
Without a declared layout, only the script directory or a verified regular-package
root supplies absolute imports; relative imports require a real package chain.
A repository-root guess or a directory without package initializers is insufficient.
Runtime `.py` modules keep precedence over their `.pyi` stubs. The supported mapping
forms follow the [setuptools package discovery documentation](https://setuptools.pypa.io/en/stable/userguide/package_discovery.html).
Implicit namespaces, dynamic configuration and backend execution remain excluded.

Composer PSR-4 and autoload-dev declarations check class namespace/path
correspondence, support string/array directories and retain nested-project boundaries.
Metadata-only Composer files preserve declaration-based resolution within their
project. Classmap/files/PSR-0 and constants are not implemented by this reader.
The mappings follow the [Composer schema](https://getcomposer.org/doc/04-schema.md#autoload).
Cargo declares custom library/binary target roots and one level of literal workspace
members; workspace membership does not invent cross-crate dependency edges.
Existing crate/self/super, groups and inline-module resolution is preserved.
Wildcard members, cfg/path attributes, dependency resolution and re-exports remain
outside this subset. References: [Cargo targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html)
and [workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html).

Both Python and Cargo reuse the bounded TOML reader; all formats reuse the existing
confined project-structure reader, freshness checks, dependency depth, warnings
and per-workspace admission. TOML supports tables, array tables, quoted/dotted keys,
strings, arrays and inline tables, with 16,384 nodes and depth 32. Unsupported or
malformed syntax yields diagnostics, without running build tools or adding a parser
dependency. These fixtures are hand-authored from documented forms, not anonymized
production repositories or proof of full build-tool grammar coverage.

Ruby require_relative uses its literal path from the importer, including explicit
`.rb`; unrelated same-stem files and ordinary require without a modeled load path
remain unresolved. C/C++ quoted includes use the including directory, while angle
includes stay unresolved without compiler include-path support. No implementation
twin or repository-root candidate is invented. This quote-directory behavior follows
[GCC's include search rules](https://gcc.gnu.org/onlinedocs/cpp/Search-Path.html).

Raw fragment import arrays and snapshot v2 remain compatible. Optional syntax
provenance on file modules distinguishes require/require_relative and quote/angle,
including mixed partially resolved forms. Existing language golden bytes and scores
were preserved. Parser versions advance selectively: TS/JS v5, Ruby v2, C/C++ v3.
TS extraction ignores import-looking comments, strings and templates while retaining
actual side-effect imports, require calls, quoted binding names and long import
clauses. Regression tests include a clause over 65,536 characters. Existing source
features were not capped or dropped to make extraction faster.

### Functional knowledge and related evidence

The new functional-routing gate has **29 scenarios**: three recorded domain stories,
two layouts with unrelated source names, twelve impact queries split between
Italian development and English evaluation questions, fifteen unreliable-claim
variants, and document-only/code-only projects. Aliases are authored in evidence;
queries do not name source paths or symbols. Twelve impact queries achieve **100%
shown precision and recall** on this controlled corpus. Unsupported conceptual
knowledge in a code-only project produces an explicit GAP. Stale, anchorless,
superseded, ambiguous and contradicted claims do not become trusted code roots.

A newly recorded or reused active anchored claim can propose at most eight direct
call/import neighbors with relation, direction, basis and code URI. Lookup reuses
the existing exact-symbol and incoming indexes, with bounded ranking through
TopResults and no second retained graph. Calls qualify only when the name identifies
one definition, and are explicitly lexical candidates. Outgoing import materialization
uses one fragment pass rather than a scan for every target. Enclosing file modules
are no longer shown as callers of their own declarations.

Proposals do not write claims, relations or pages. Each of six project/layout
variants materializes its two useful proposals, verifies that the store still has
one claim, then explicitly records one additional accepted claim. The store reaches
two claims only after that action. Missing index metadata does not undo the original
claim. The ordinary authoring workflow exposes these candidates as structured data
and resource links. Caps apply across the complete record response, with truncation
and warnings exposed.

This evaluation is lexical with recorded domain aliases. Optional live semantic
provider accuracy is **not measured**; existing deterministic semantic integration
tests and gates still pass. The original twelve evaluation questions retain their
previous outcomes: **92.3% shown recall, 50% shown precision and two false GAPs**.
Their questions, source content and expected results were not weakened to improve
the new report. Artifacts: `results/280-completion-functional.json` and
`results/280-completion-project-precision.json`.

### Import and fallback evaluation

The import oracle now contains **23 cases**, thirteen development and ten evaluation,
requiring exactly **23 file import edges and 27 problematic outcomes**. Every
positive edge and negative/ambiguous outcome passes. The previous golden expectations
for Python repository-root ambiguity and C include-root ambiguity were corrected to
the documented semantics, with explicit positive and negative regression cases.
This is a semantic bug fix, separate from unchanged query-ranking parity.

The same fixture hash runs against both preserved and current runtimes. Its offline
fallback oracle asks for the incoming imports of every indexed file module and
requires fallback for missing or extra expected file edges. Across **79 requests**,
ten needed fallback before and zero after:

| Language family | Requests | Before fallback requests | After |
| --- | ---: | ---: | ---: |
| JS/TS | 12 | 1 | 0 |
| Python | 11 | 2 | 0 |
| PHP | 10 | 2 | 0 |
| Rust | 9 | 2 | 0 |
| C/C++ fixture (CPP adapter) | 8 | 2 | 0 |
| Ruby | 6 | 1 | 0 |
| Java/Kotlin/C#/Go/Apex combined | 23 | 0 | 0 |

Artifacts: `results/280-completion-import-before.json` and
`results/280-completion-import-gate.json`. This is an offline oracle comparison,
not observed historical user fallback telemetry or a population-wide failure rate.

R6 now counts successful public search/symbol/reference responses, including empty
ones, with per-workspace request IDs. Errors, resource reads and internal context
operations do not inflate the denominator. Reference language comes from its target;
search/symbol language comes from explicit file scopes or returned hits, with mixed
and unknown buckets when necessary. A correlated record_fallback increments one
request once and records a normalized reason. Unlinked, foreign or expired IDs stay
separate. A missing recorded fallback is not proof that the user never used one.

Admin status and `report:code-requests` expose aggregates. The new bounded counter
file retains at most 512 recent IDs and 256 KiB, with no query text, source path,
body, symbol or stable content hash. The legacy fallback journal remains unchanged
and has its preexisting content contract. Counters start with this instrumentation;
old fallback events cannot reconstruct a historical served-request denominator.
Cross-process lock tests verify exact counts from three independent writers.

### Cost, memory and preserved functionality

The final code-query workload uses the same thirty samples and 1k/10k fragment
fixtures as the preserved baseline. Digests remain identical for all nine operations,
and all **1,600 text/symbol parity comparisons** match separately.

| Fragments | References p50 before → after | References p95 before → after | Warm heap before → after |
| --- | ---: | ---: | ---: |
| 1,000 | 0.210 → 0.214 ms | 0.353 → 0.380 ms | 11.137 → 11.283 MiB |
| 10,000 | 0.659 → 0.719 ms | 0.901 → 0.877 ms | 28.926 → 29.077 MiB |

These timings do not establish a general search speedup. The measured warm heap
increase is about 0.15 MiB. Public MCP request counters are additional work and are
measured separately, rather than omitted from the stated cost of the new feature.
Artifacts: `results/280-completion-code-query-before.json`,
`results/280-completion-code-query-after.json`, `results/280-completion-query-parity.json`.

The unchanged 500-page/15-iteration context-disclosure workload retains the same
payloads: eight evidence entries, no GAP, 1,781 manifest tokens and 1,950 tokens with
selected materialization. Manifest p50 is 4.168 → 3.645 ms; selected materialization
0.634 → 0.535 ms. These small-run variations are not attributed to an optimization.
Reports: `results/280-completion-context-before.json` and
`results/280-completion-context-after.json`.

The actual code-context benchmark also passes its unchanged 5 ms paired-p50 gate
and checks document-only output parity against the preserved runtime:

| Fragments / token budget | Added p50 / p95 | Displayed roots / relations | Manifest tokens | Retained heap |
| --- | ---: | ---: | ---: | ---: |
| 1,000 / 2,000 | 0.568 / 0.721 ms | 1 / 1 | 1,960 | 2,190,656 bytes |
| 1,000 / 4,000 | 0.945 / 1.132 ms | 3 / 27 | 3,986 | 1,320,960 bytes |
| 10,000 / 2,000 | 0.944 / 1.565 ms | 1 / 1 | 1,961 | 11,133,024 bytes |
| 10,000 / 4,000 | 1.571 / 1.967 ms | 3 / 26 | 3,932 | 11,091,672 bytes |

The 10k admission estimate is **24,910,620 / 33,554,432 bytes**; the limit was not
raised. Retained heap includes loaded code/context state, not only expansion
allocations. Reports: `results/280-completion-context-impact.json` and the existing
Go/JS structure rechecks `results/280-completion-structure-go.json` and
`results/280-completion-structure-javascript.json`.

An initial durable counter implementation added **14.561 ms p50 per served response**.
The final counters reuse atomic writes and process locks with explicit OS buffering:
**0.584 ms p50 / 0.886 ms p95** per response, **0.571 ms p50** per fallback and
**0.113 ms p50** for status (fifty samples, 5,115-byte counter file). Canonical
knowledge writes retain fsync by default. No counter samples, languages, reasons,
correlation or concurrency guarantees were removed to achieve this reduction;
only the new diagnostic counters omit the power-loss durability barrier. They
persist across ordinary process restarts, while sudden power loss can lose recent
counts. The window/size limits are unchanged and there is no retained telemetry
cache. Reports: `results/280-completion-telemetry.json` (initial implementation) and
`results/280-completion-telemetry-buffered.json` (final).

### Final verification and current project knowledge

All **447 tests in 78 files**, TypeScript checks, repository hygiene, **17 quality
gates**, production build and npm runtime audit pass; the audit reports zero
vulnerabilities. The original sixteen gates retain their thresholds and the new
functional-routing gate adds a separate contract. No language golden hash or
threshold was changed to mask a regression. Existing raw imports, registry/custom
adapter behavior, query ordering, resource links, evidence history, context token
budgets and durability defaults are preserved. Corrected false edges have their
own explicit semantic regressions.

The maintenance script ran successfully on an isolated copy and then this
workspace. Six current wiki pages have **24 fresh anchors**, with all 24 ordinary
code resources opened. The real impact context opens another **34 resources**:
three roots and 31 relations, one related wiki page, within **5,933 / 6,000 tokens**.
Fifty-two historical anchors still report drift and remain auditable; none causes
a current page to be falsely marked stale. Report:
`results/280-completion-import-knowledge.json`.

Remaining work is explicit: wider realistic/anonymized language corpora, live
semantic-provider evaluation, Java/Kotlin build ownership and overloads, C# partial
and nested types, PHP constants/classmap, compiler include paths, Ruby gemspec load
paths, fuller Rust build semantics and TS project/package/bundler ownership. These
were not silently marked complete by the common-work closure.


## Sixth tranche — review follow-up, 2026-09-06

The five-tranche working tree (447 tests) was preserved at
`/var/folders/02/jd8r0gn93697nww15ln701lc0000gn/T/knowledgerail-280-review-baseline.ypfndchk`.
This is the comparison baseline, including all previously implemented features.
The review identified two operational defects, one repeated-refresh cost and
several documentation/schema omissions. All seven items are addressed below.

| Review item | Resolution and evidence |
| --- | --- |
| Unrelated TOML disables Python/Cargo | The shared TOML reader projects selected declaration fields and skips unrelated values without allocating their contents. Tests cover dates, unrelated malformed tool options, inline/dotted keys, multiline strings and fake table headers. Selected invalid roots still fail closed. |
| Cargo workspace glob discards root package | Package targets and workspace members are parsed independently. Globs, invalid members and reference-count limits emit nonfatal notices through the shared reader; valid package roots and supported literal members survive. |
| Corrupt telemetry cannot recover | The next counter mutation archives the original bytes under the existing workspace/process lock and starts a new counting period. Status exposes the archive and startedAt; old request IDs become unlinked. Tests cover empty/truncated/inconsistent files, concurrent writers and foreign symlinks. |
| Python backend coverage unclear | Guide, changelog, milestone and project knowledge explicitly state that layout declarations support setuptools only. Poetry/Hatch/Flit/PDM projects retain package-boundary/script resolution but can miss absolute imports from external tests/scripts. Tests pin both retained edges and documented unresolved cases. These backends have not been added. |
| Changelog lost existing limits | Restored Go's suffix heuristic without go.mod, the incomplete unresolved-cause taxonomy and the fact that rootDir is not import identity. |
| Compact action description and free-text reasons | The guide explains compact routing hints and links the complete enum/action reference. fallback_reason now lists no_match, ambiguous, unresolved_import and unsupported_extension in the schema, with other as the free-text fallback. All actions and parameters remain available. |
| Refresh once per claim | The index instance was already shared; structure freshness was repeated. A bounded batch now loads one snapshot and refreshes manifests once, deduplicates repeated target IDs and preserves individual failures and the overall eight-candidate cap. |

Projection is deliberately not a general TOML validator. Lexically ambiguous input,
such as an unterminated multiline string/container or malformed table header, can
still prevent trustworthy declaration discovery and fail the manifest. Merely
seeing text resembling a table header inside a value never creates a root. The
string-boundary cases follow the [TOML 1.0 specification](https://toml.io/en/v1.0.0#string).
Cargo member globs are valid Cargo syntax but remain unexpanded by this resolver;
they now receive an explicit notice while independent package targets survive.
See [Cargo workspace members](https://doc.rust-lang.org/cargo/reference/workspaces.html#the-members-and-exclude-fields).
No compiler/build tool is executed and the existing size, node, depth, reference
and workspace-admission bounds remain in force.

Telemetry recovery is limited to corrupt content. It does not reset newer formats,
IO errors, non-regular files or foreign symlinks. Read-only status reports corruption
without moving files; a subsequent counting operation performs recovery. Original
files are kept as `code-request-counts.corrupt-<timestamp>-<id>.json` for inspection.
The active file remains bounded to 256 KiB and 512 correlation IDs; retained archives
are separate and are not silently deleted. The new period is explicit, so rates
cannot combine a new denominator with old linked fallback events. Ordinary atomic
OS-buffered writes and canonical knowledge durability defaults are preserved.

### Reproductions and verification

Six new regressions exercise projection, Python backend boundaries, Cargo member
isolation, telemetry recovery, confinement and the proposal batch. On the preserved
runtime, the five behavior/API regressions fail and the confinement guard already
passes. On the final runtime all six pass. Existing tests retain future-version
protection and failure-preserves-claim behavior through the batch API. The current
complete suite passes **453 tests in 78 files**, all **17 quality gates**, TypeScript
checks, repository hygiene and production build. Text/symbol parity remains **1,600
identical comparisons** (`results/280-review-fixes-query-parity.json`).

The public catalog contains **13,496 bytes / 4,499 estimated tokens**, below the
unchanged 13,500/4,500 limits, with **31/31 routing cases correct**. Savings come from
shorter wording/spacing in descriptions; no action, parameter or validation was
removed. `docs/reference/tool-actions.md` was regenerated from the schemas.

### Performance

`related-code-evidence-bench.ts` queries eight distinct IDs on the same persisted
fixture, with real manifest freshness IO and forty warm samples. The preserved
runtime performs the original sequential calls; the current runtime uses one batch.

| Fragments | Refreshes before → after | Batch p50 before → after | Batch p95 before → after |
| --- | ---: | ---: | ---: |
| 1,000 | 8 → 1 | 1.344 → 0.210 ms | 1.512 → 0.356 ms |
| 10,000 | 8 → 1 | 1.284 → 0.202 ms | 1.428 → 0.275 ms |

Returned proposal digests are identical at both sizes. These are proposal-query
costs, not total ingestion latency: source/anchor updates, claim persistence and
resource materialization are excluded. The measured reduction does not depend on
omitting candidates or returning stale manifest metadata. Reports:
`results/280-review-fixes-related-before.json` and `results/280-review-fixes-related-after.json`.
Whole-process heap includes dynamically loaded modules and does not isolate the
cost of this batch; no memory reduction is claimed from those samples.

The healthy-counter workload retains the same 5,115-byte file and bounds. Fifty
samples measure served-response p50 **0.541 → 0.545 ms**, fallback **0.554 → 0.540 ms**,
and read-only status **0.105 → 0.106 ms**. These variations do not indicate a material
healthy-path regression or a speedup. Archive IO is exceptional and is verified by
recovery/concurrency tests, not included in these healthy timings. Reports:
`results/280-review-fixes-telemetry-before.json` and `results/280-review-fixes-telemetry-after.json`.

The unchanged context gate also passes. At 10k fragments paired code-expansion p50
is **0.937 / 1.428 ms** for one/three roots, below 5 ms. Document-only results remain
identical to the preserved runtime. Cache admission remains
**24,910,620 / 33,554,432 bytes**. Report: `results/280-review-fixes-context-impact.json`.

Knowledge maintenance passed on the isolated copy and then the workspace: six pages,
**24 current fresh anchors and 24 direct resources opened**. The real impact context
opens another **28 resources** (three roots, 25 relations), within **5,394 / 6,000
estimated tokens**. Sixty-one historical anchors remain drifted and auditable without
making current pages stale. Report: `results/280-review-fixes-import-knowledge.json`.
The original language-extension backlog, optional live semantic evaluation and two
historical false GAPs remain open; none was claimed fixed by this review follow-up.

## Seventh tranche — extensions, precision and live evaluation, 2026-09-07

### Implemented behavior and preserved contracts

JVM declarations now span Java/Kotlin sources, static imports identify the owning
class and duplicate/overloaded names in competing Gradle layouts remain ambiguous.
Shared namespace scopes handle nested/file-scoped C# and separate PHP namespaces.
C# partial declarations must agree in kind/arity and project boundary; competing
projects are not merged. PHP adds indexed constants, mixed grouped imports and
Composer PSR-0/classmap/files/exclusions alongside existing PSR-4 behavior.

Ruby reads literal ordered gemspec require_paths, including RubyGems' declared
default; dynamic conditions/mutations do not supply guessed roots. C/C++ reads
ordered compilation-database options and bounded literal CMake directory/target
declarations. Local quoted includes and require_relative remain usable when the
independent manifest cannot resolve other imports. Competing C/C++ configurations
remain ambiguous. Go's no-manifest suffix fallback stays available, with explicit
legacy_suffix_heuristic diagnostics rather than silent declared provenance.

The shared reader discovers bounded *.gemspec/*.csproj names at indexed ancestors,
retains confinement/freshness checks and invalidates known manifest changes without
source extraction or snapshot writes. New nested declarations need update/rebuild.
Python and Composer compile literal glob filters once with a shared matcher that
avoids exponential regex backtracking. Namespace parsing shares one brace-scope
scan. No external parser, build execution, dependency or second persistent graph
was added. Java/Kotlin/C#/PHP extraction advances to v2; snapshot v2 stays compatible.

These are bounded declaration contracts, grounded in the
[Composer autoload specification](https://getcomposer.org/doc/04-schema.md#autoload),
[RubyGems require_paths](https://guides.rubygems.org/specification-reference/#require_paths),
[Clang compilation databases](https://clang.llvm.org/docs/JSONCompilationDatabase.html),
[CMake target include directories](https://cmake.org/cmake/help/latest/command/target_include_directories.html)
and [C# partial declarations](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/partial-classes-and-methods).
They do not evaluate Gradle/MSBuild, dynamic gemspecs, compiler macros/system headers,
transitive CMake configuration or installed dependencies. Databases in arbitrary
build directories are not discovered unless exposed at indexed ancestors/root.

### Precision and corpus evidence

Complete delimited identifiers now contribute full coverage aliases even beyond
three segments; a prefix alone still fails. Inferred artifact requirements accept
a relevant selected heading, while explicit page-type requirements remain strict.
Display selection removes a lower-ranked lexical candidate only when a same-type
candidate covers a strict superset of its query signals. Full coverage candidates,
semantic/graph evidence, request traceability, source diversity, contradictions and
explicit artifact-chain widening are retained. This is a ranking heuristic, not
proof that an omitted page contains no useful information.

The unchanged original project-precision corpus reports:

| Evaluation metric | Preserved runtime | Final runtime |
| --- | ---: | ---: |
| Full-pool recall | 100% | 100% |
| Displayed recall | 92.31% (12/13) | 92.31% (12/13) |
| Displayed precision | 50% | 75% |
| False GAPs | 2 | 0 |
| Silent misses / passage errors | 0 / 0 | 0 / 0 |

Development displayed precision is 46.67% → 77.78%, with 100% recall. Questions,
bodies, oracles, thresholds and budgets were not changed. Reports:
`results/280-close-precision-before.json` and `results/280-close-precision-final.json`.

The import fixture now has 30 cases (17 development/13 evaluation), 36 expected
edges and 34 diagnostic outcomes, all matched. Its 114 oracle reference requests
require zero fallbacks; this is not observed user behavior. The public-manifest gate
adds six exact manifests pinned by commit, URL and SHA-256: Django, Symfony Console,
ripgrep, Rack, chi and Flask. Three development/three evaluation overlays supply
seven edges and five expected diagnostics. Source overlays are controlled fixtures,
not the real projects' complete source trees. The Flask case preserves the explicit
unsupported-Flit boundary; it does not establish Flit layout support. Reports:
`results/280-close-final-imports.json` and `results/280-close-final-public-manifests.json`.

### Ollama qwen3-embedding:0.6b

Live evaluation uses the user's local Ollama endpoint, 1024-dimensional embeddings,
unchanged questions and production LSH/ANN defaults. Optional queryPrefix affects
queries only and participates in provider identity; no user configuration was
persisted. The prefix follows the
[official Qwen example](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B):
`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `.

Both runs preserve the fourteen existing semantic-oracle queries and exact-identifier
rank, but recover **0/2 paraphrase-only probes**: aggregate recall remains 87.5%.
No ANN attempt scans all vectors. The instruction reduces maximum ANN candidate
ratio from 52.83% to 39.62% and no-benefit token growth from six queries to one
(+2 estimated tokens). It does not establish a semantic recall improvement.
Final semantic p50 is 71.728 ms without instruction and 70.631 ms with it, including
the local provider; these are one-pass corpus measurements, not steady-state SLA estimates.

The live functional corpus passes all 29 scenarios and all twelve impact queries
have 100% displayed precision/recall. Those stories contain recorded IT/EN aliases;
passing them does not contradict the two missing paraphrase probes. Reports:
`results/280-close-final-semantic-live.json`,
`results/280-close-final-semantic-live-instruct.json` and
`results/280-close-final-functional-live.json`.

### Performance and feature preservation

Before/after runs use the preserved sixth-tranche runtime on the same machine,
sequentially, with the same fixtures and thirty samples. Text/symbol parity is
**1,600/1,600** and code-query result digests are identical at 1k/10k fragments.
At 10k, reference p50 is 0.786 → 0.748 ms, general search 14.759 → 14.924 ms and
default symbol lookup 0.641 → 0.618 ms. Warm whole-process heap is 29.110 → 29.223 MiB.
These small variations do not establish a general query speedup. Reports:
`results/280-close-query-before.json`, `results/280-close-query-after.json` and
`results/280-close-query-parity.json`.

The first selector implementation regressed the 500-page document-context benchmark
from 82.590 to 135.051 ms p50. CPU profiling identified repeated alias/token work.
Query-specific streaming alias matching and reuse of matched signals within each
attempt reduce the final p50 to **72.608 ms** (p95 95.945 → 84.872 ms). The same
benchmark retains eight evidence entries, zero GAPs and identical payload sizes;
manifest-plus-materialized evidence stays at 5,847 bytes / 1,950 estimated tokens.
No body, resource, graph expansion or quality check was removed for this result.
Only query signal sets live until the attempt ends; no new retained workspace cache.
Reports: `results/280-close-disclosure-before.json`, `...-after.json`, `...-final.json`.

The actual code-context compiler retains document parity and passes the unchanged
5 ms paired-overhead gate. At 10k, p50 overhead is **0.859 / 1.543 ms** for one/three
roots, with cache admission **24,910,620 / 33,554,432 bytes**. Retained measured heap
is about 11.1 MB, separate from the conservative admission estimate. Token budgets,
three roots/twelve incoming candidates/six related pages remain unchanged.
Report: `results/280-close-final-context.json`.

Existing Go/JS manifest benchmark digests remain identical. At 5,001 files, Go warm
freshness+lookup p50 is 0.086 → 0.102 ms (dense) and 0.086 → 0.088 ms (sparse);
JS is 0.166 → 0.167 ms and 0.165 → 0.172 ms. New format costs are measured with the
same harness, including discovery IO rather than only lookup:

| Format, 5,001 files | Fragments | Cold dense / sparse | Warm freshness p50 dense / sparse | Retained heap dense / sparse |
| --- | ---: | ---: | ---: | ---: |
| C# csproj | 10,002 | 16.231 / 132.386 ms | 0.157 / 0.165 ms | 1.26 / 1.88 MB |
| Ruby gemspec | 10,001 | 14.463 / 117.693 ms | 0.169 / 0.168 ms | 1.22 / 1.18 MB |
| C++ compilation DB | 5,001 | 18.967 / 149.146 ms | 0.106 / 0.105 ms | 1.23 / 1.29 MB |

Dense means fifty files/directory, sparse one. The C++ prototype fixture extracts
one module per header, so it is not labeled a 10k-fragment run. Cold source extraction
and snapshot loading are excluded. Sparse discovery cost remains visible; source
updates discover new nested boundaries, while warm queries avoid repeated whole-tree
discovery. Reports: `results/280-close-structure-*.json`.

### Verification, knowledge and remaining scope

All **470 tests in 78 files**, TypeScript checks, repository checks, **18 quality gates**
and production build pass. Runtime npm audit reports **zero vulnerabilities**.
Catalog size is **13,497 bytes / 4,499 estimated tokens**, below unchanged caps,
with all **31 routing cases** correct. No action, validation, original oracle or
quality threshold was removed. Tests that simulate a future Java parser version now
use a value distinct from the new current v2; original migration assertions remain.

Knowledge maintenance passed on the isolated copy, then on this workspace. Six pages
contain **25 current fresh anchors and 25 opened direct resources**. The real impact
context opens another **33 resources** (three roots/thirty relations), within
**5,941 / 6,000 estimated tokens**. Eighty-one historical anchors still show drift;
their audit history is retained and does not mark superseded-only pages stale.
Report: `results/280-close-import-knowledge.json`.

The milestone's remaining boxes are explicit: wider real-user projects/oracles,
Python Poetry/Hatch/Flit/PDM layouts, Rust cfg/path attributes/re-exports, JS/TS
ownership/project references/package resolution and the complete unresolved-cause
taxonomy. Installed dependencies/build execution remain excluded. Live model quality
has been measured with a negative paraphrase result, not certified. This tranche is
complete; the entire backlog is not silently marked closed. No release/tag/publication
or package-version change was performed.

### Review follow-up — shared batch target bound

`RELATED_EVIDENCE_MAX_TARGETS` now supplies both claim selection/truncation and the
defensive batch admission check. The limit stays eight and is distinct from the
candidate count. TypeScript checks, the three existing related-evidence tests,
production build and current knowledge-anchor refresh pass. This is a constant
extraction with unchanged selection behavior; no new timing claim or broader
suite rerun is attributed to it.

### Review follow-up — workspace specificity and explicit costs

The exploratory `workspace-selection-eval.ts` freezes the six existing wiki pages
byte-for-byte, including their claim history, and records page SHA-256 values. Twelve
questions name expected specific pages and supporting active-claim text before
retrieval. An isolated copy of the current runtime bypasses only the dominance call;
the probe asserts identical complete scored pools and retains the same budgets.
Fixed W0 and explicit lexical mode isolate the selection stage. Three profiles and
two budgets repeat those twelve questions for 72 runs; they are not 72 independent
queries, nor a new held-out quality corpus.

All expected pages remain displayed **72/72 before and after**, with no expected
target removed by dominance. The selector removes some candidates in every run.
However, **every expected page already ranks first**. Consequently this check does
not test the risk of a higher-ranked overview suppressing a more specific page.
The workspace has thematic implementation pages rather than a separately authored
overview/detail hierarchy. The rule remains under observation; this result cannot
establish general stability, answer correctness or freshness of the selected passage.
Other pages have not been labeled irrelevant, so no precision score is inferred.
Report: `results/280-workspace-selection.json`; questions:
`fixtures/workspace-specific-pages.json`. Neither workspace pages nor runtime
selection policy are changed by the probe.

The guide, changelog and current project knowledge now explicitly describe CMake's
file-wide failure scope: one unsupported relevant declaration clears all roots and
targets from that file, including independent literal declarations. Local quoted
includes remain available. Conditional/generated build setups should expect missing
CMake-derived imports; the corpus does not measure a real-project coverage percentage.
README and the query-prefix guide explain that changing the prefix invalidates
semantic identity and triggers full document re-embedding at next synchronization,
even when document embedding inputs are identical.

The unused retrievalEvidenceSignals wrapper is removed; the shared request-local
factory remains. A C/C++ comment explains that the inner break keeps one match per
configuration while the outer loop preserves ambiguity across configurations.
No ranking rule, budget or threshold changed. TypeScript checks, **38 targeted tests**
and production build pass; the review's global suite/gate results are not presented
as a fresh rerun. Current knowledge has **25 fresh anchors**, 25 opened direct resources
and 33 impact resources within **5,949/6,000 tokens**; 83 historical drift entries
remain auditable. Report: `results/280-review-observations-knowledge.json`.

### Review follow-up — overview/detail coverage guard

The reported omission is reproduced by a small deterministic wiki: an overview
ranks first and a specific same-type page ranks second with five of six query
signals, yet the old selector hides it with four result slots available. Selection
now protects candidates covering **at least half of all query facets and entities**.
The denominator comes from the same request-local matcher already shared with
coverage, including signals missing from every retrieved page. It adds one count
per attempt and one comparison per candidate, with no new source scan or cache.
Strict dominance still removes low-coverage lexical candidates; existing semantic,
graph, traceability and explicit coverage exceptions remain. Normal result/token
budgets still apply and GAP assessment retains the entire candidate pool.

`tests/hybrid-retrieval.test.ts` checks the following six scenarios in precision,
balanced and coverage profiles, semantic disabled, fixed W0 and four result slots.
Each run asserts the overview/specific pool order and actual matched signal counts.

| Overview signals | Specific signals | Types | Specific shown after guard |
| --- | --- | --- | --- |
| 6/6 | 6/6 | Same | Yes |
| 6/6 | 5/6 | Same | Yes |
| 6/6 | 5/6 | Different | Yes |
| 6/6 | 3/6 | Same | Yes |
| 6/6 | 2/6 | Same | No, dominated |
| 4/6 | 2/6 | Same | No, absent query signals still count |

A coverage regression also checks technical-entity components, duplicate facets,
queries without signals and reuse of matched sets. The original project-precision fixture,
questions, labels, budgets and thresholds are unchanged (SHA-256
`0826c3e4de63e0427c7da8662908f74ce0b8ddfe6937679a693d9b68612281b0`).

| Split / metric | Before guard | After guard |
| --- | ---: | ---: |
| Evaluation shown precision | 75% | 75% |
| Evaluation shown recall | 12/13 (92.31%) | 12/13 (92.31%) |
| Development shown precision | 77.78% | 70% |
| Development shown recall | 100% | 100% |
| False GAPs / silent misses / passage errors, both splits | 0 / 0 / 0 | 0 / 0 / 0 |

The development cost is one additional unlabelled-as-relevant `cache` result on
`dev-lru` ("Workspace LRU eviction order"). It is retained by the general protection;
the threshold was not tuned to remove it. Both splits still improve on the original
pre-selection precision, 50% evaluation and 46.67% development. Report:
`results/280-dominance-precision.json`.

A sequential before/after disclosure benchmark uses a frozen pre-guard runtime,
500 pages and 30 iterations per runtime, with identical output payloads: eight
evidences, zero GAPs and 5,847 bytes / 1,950 estimated tokens for manifest plus
selected evidence. Editorial latency p50 is **70.701 → 70.220 ms**, p95
**81.782 → 80.844 ms**. This run shows no regression, not an established speedup.
Reports: `results/280-dominance-disclosure-before.json` and `...-after.json`.

Repository checks, TypeScript checks, **478 tests in 78 files**, all **18 quality
gates** and the production build pass. No functionality, evaluation oracle, quality
threshold or budget was removed. Verification metadata and runtime hashes are in
`results/280-dominance-verification.json`.

Knowledge maintenance verifies **25 current fresh anchors**, 25 direct code resources
and 33 impact resources within **5,976/6,000 tokens**; 85 historical drift entries
remain auditable. The workspace A/B probe was rerun after that refresh: expected
pages remain shown **72/72**, identical scored pools, no target removed by dominance.
Targets still rank first, so that probe adds no overview/detail evidence. Reports:
`results/280-dominance-knowledge.json` and `results/280-dominance-workspace-selection.json`.

The reproduced five-of-six omission is closed. General stability remains unclaimed:
useful pages below the half-query threshold can still be dominated, and a synthetic
hierarchy is not real-project answer-quality validation. Those broader observations
remain explicit in the milestone.
