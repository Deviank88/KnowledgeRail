# Quality and efficiency comparison — 2.7.4

Local run: 2026-09-05, macOS arm64, Node 24.9.0. The baseline is commit
`aecee81` plus the local query-cache, phrase-cache, freshness and LRU changes
already present when this work began. A separate copy preserved that runtime.
Both sides use identical deterministic datasets and harness parameters. These
are local measurements, not cross-platform performance guarantees. No quality
threshold was lowered. Raw JSON files stay local under `benchmarks/results/`.

**Current validation status after the adapter and knowledge correction:** all
398 tests in 71 files pass, including the eight realistic import cases that
previously failed. TypeScript, repository hygiene, all 15 quality gates and the
installed npm/MCPB smoke checks pass. Six local knowledge
pages now contain 13 anchored code references; all pages were retrieved and all
cited resources opened successfully, with all anchors fresh. Historical review
failures and measurements remain below with their original scope. Passing
extraction gates alone does not establish working module-import resolution.

## Correctness and scope

Markdown fences now retain internal comments under the external heading, including
backticks, tildes, longer/shorter closing runs, up to three spaces, unclosed blocks
and passage size splits. Four-space/tab-indented lines remain code content.
The builder changes to `global-flat-v3-fenced-passages`; unchanged Markdown
rebuilds old persisted passages, then restores those corrected passages on restart.
Long-line fragmentation and CRLF offsets are unchanged and remain separate work.

Relative JS/TS import edges use importing-file paths, explicit extensions and
unambiguous runtime/source substitutions. Exact runtime files take precedence.
Directory index and case-sensitive path tests cover ambiguous siblings, same
basenames, packages and aliases. Unresolved imports produce no guessed edges.
Review found a real pre-release regression: the initial implementation removed
all import edges from non-JS/TS sources, including both `service.py` and its `run`
function importing `orders.py`. That removal was not a pre-existing limitation.
The final implementation moves resolution into optional adapter factories using
the existing path inventory and extracted declarations. Python resolves dotted
and relative names to a unique module or package, with `.pyi` fallback. Absolute
names use the repository root, importer directory and a source root established
by the importer's indexed package chain. This covers flat files, `src/` siblings
and regular packages under `src/`; arbitrary PYTHONPATH and dynamic imports remain
outside the contract. Conflicting bases and module/package candidates are tested.
Explicit JS/TS uppercase extensions resolve while path casing remains exact.

Java, Kotlin, C# and PHP use qualified declarations; C/C++ includes resolve actual
headers; Go imports resolve directory members independently of filenames; Rust
handles the tested crate/self/super, grouped and inline-module forms. Salesforce
LWC virtual imports resolve Apex methods, schema metadata and local components.
Namespace/package groups may intentionally name multiple files, while competing
single targets remain unresolved. Ruby and adapters without a hook retain the
legacy fallback. Calls/reference precedence and filters remain unchanged. No
snapshot schema or extraction-version bump is required by the import refactor.
A separate TypeScript function-range correction advances that adapter to v3,
as described below; existing files owned by it are reparsed on refresh.
See the [import contract](README.md#local-import-references) for static-resolution
limits; these rules do not claim compiler or build-tool equivalence.

New regressions fail on the preserved runtime: Markdown mis-segmentation and old
checkpoint reuse; explicit imports missing while unrelated packages link; four
reads after deletion; and a denied snapshot read triggering a derived rebuild.
The final implementation stops on absence, preserves busy-writer fallback and
propagates filesystem errors.

## Updates and retained memory

10,000 pages, 30 edit/remove/reinsert cycles, 20 unique vocabulary tokens per page.
The edit result measures the targeted API including persistence. Removal also
rebuilds the corpus revision ledger, which remains a corpus-sized cost.

| Measurement | Before | After |
| --- | ---: | ---: |
| Edit p50, ms | 8.259 | 4.917 |
| Edit p95, ms | 12.483 | 6.038 |
| Removal p50, ms | 33.057 | 33.248 |
| Removal p95, ms | 34.850 | 34.997 |
| Heap after GC, MiB | 146.34 | 145.26 |
| RSS after GC, MiB | 1204.81 | 1002.03 |

`removeCheckpointRecord` re-derives terms using the same builder as insertion,
touching only the affected postings. No persistent inverse map is added. The
separate `bench:page-terms` workload compares this choice against a direct
vocabulary scan and a page-to-terms map at 1k/10k/50k pages; its timings are
lookup-only microbenchmarks, not end-to-end deletion latency.


| Pages | Vocabulary | Scan p50, ms | Derive p50, ms | Inverse p50, ms | Extra inverse heap, MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 22,004 | 0.1513 | 0.0135 | 0.0017 | 1.38 |
| 10,000 | 220,004 | 1.6165 | 0.0106 | 0.0014 | 14.36 |
| 50,000 | 1,100,004 | 9.6863 | 0.0102 | 0.0012 | 72.44 |

At 10k pages the inverse map saves only about 0.009 ms versus derivation but
adds 14.36 MiB after GC; at 50k it adds 72.44 MiB. Derivation was retained.

## Reconciliation

The metadata phase uses the actual confined path resolver and file stat calls.
Ten samples per scale/mode; ordered result retention is included. The reported
extra heap is sampled peak minus post-GC starting heap, not process RSS. This
phase benchmark excludes Markdown parsing, postings rebuild and persistence.

| Pages | Unbounded p50, ms | 64 workers p50, ms | Unbounded extra heap, MiB | 64 workers extra heap, MiB |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 2.067 | 1.861 | 3.25 | 1.60 |
| 10,000 | 170.700 | 140.623 | 282.29 | 51.58 |
| 100,000 | 1734.652 | 1439.066 | 1060.63 | 57.56 |

8/16/32/64 workers were compared. 64 had the best measured latency at both large
scales, with similar bounded heap. A small project showed no material penalty.
Errors stop scheduling and drain active workers; complete reconciliation publishes
only after verification succeeds. Regression tests cover changes, deletion, errors
and notifications arriving during verification.


The complete read-only reconciliation was also measured at 1k/10k/100k pages,
including canonical parsing on cold load and ten forced warm verification scans.
The implementations ran in separate processes against identical deterministic
Markdown so one runtime's previous heap/RSS could not inflate the next reading.
Persistence was disabled. Reported peaks include the initial cold generation.

| Pages | Before cold, ms | After cold, ms | Before warm p50, ms | After warm p50, ms | Before peak heap, MiB | After peak heap, MiB | Before peak RSS, MiB | After peak RSS, MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 152.47 | 177.41 | 18.37 | 18.07 | 40.82 | 30.06 | 177.53 | 134.83 |
| 10,000 | 1440.60 | 1334.06 | 215.66 | 160.17 | 319.48 | 131.24 | 629.89 | 333.95 |
| 100,000 | 13789.57 | 13649.68 | 1989.37 | 1578.88 | 1419.61 | 1205.76 | 2561.44 | 1555.98 |

No record count or reuse assertion failed. Full cold indexing still allocates
records, postings and a candidate generation, so bounding metadata work does not
cap total heap/RSS. The dedicated soak is the source for release/lifetime
conclusions; the initial same-process comparison is retained as exploratory data.

## Code queries

These are two distinct development rounds. The earlier query-cache round already
brought the exact-symbol lookup from roughly 14 ms to 0.1 ms; that cache is part
of this report's baseline. The present optimization round leaves symbol timings
essentially flat and improves multi-term text search from 16.9 to 15.6 ms. Do not
attribute the earlier symbol speedup to this round or generalize the text-query
gain to all code operations. The timing tables below describe the initial
measured implementation; the import regression was corrected subsequently.

100 cold symbol samples and 100 samples per warm operation at each scale. Every
call constructs a new public index instance, matching the MCP query lifecycle.
The expanded workload includes exact, substring, absent, broad and filtered text.
Its synthetic JS/TS-shaped fragments did not cover non-JS imports: matching
performance digests were insufficient to detect the reviewed regression.
Realistic actual-adapter tests subsequently exposed additional missing import
capabilities; the final correction passes those expanded cases.

| 10,000 fragments, warm p50 ms | Before | After |
| --- | ---: | ---: |
| symbolTop1 | 0.045 | 0.047 |
| symbolDefault | 0.695 | 0.728 |
| references | 2.108 | 2.053 |
| search | 16.915 | 15.581 |
| searchExact | 8.315 | 7.647 |
| searchSubstring | 8.905 | 7.944 |
| searchMissing | 7.708 | 7.010 |
| searchBroad | 8.732 | 7.804 |
| searchFiltered | 0.879 | 0.779 |

The full result digests match at both scales. A separate 1,600-comparison test
matches exact text/symbol result objects, including Unicode normalization,
substring queries, kinds, paths, limits and ties. Corrected import edges are
evaluated separately because old behavior is intentionally changed.

| Cold / memory at 10,000 fragments | Before | After |
| --- | ---: | ---: |
| Cold symbol p50Ms | 17.350 | 17.294 |
| Cold symbol p95Ms | 18.359 | 17.804 |
| Cold symbol p99Ms | 18.782 | 18.515 |
| Warm heap after GC, MiB | 28.60 | 28.62 |
| Released heap after GC, MiB | 13.91 | 13.98 |

The phase profile attributes about 15.09 ms to scoring a multi-term query at
10,000 fragments, 0.31 ms to filtering, 0.40 ms to full sorting and 0.05 ms to
copying 12 returned results. Scoring remains exhaustive to preserve every
substring match. A bounded stable selection and one filtered loop reduce
temporary allocations without an additional text index or retained query cache.

## Lexical selection

100 queries per combination of balanced/precision/coverage profile and phrase
reranking on/off, at 1k and 10k pages. Queries include phrases, identifiers,
broad matches and absence, with result limits 1/12/50. Digests include scores,
ordering, headings and excerpts and match for both corpus sizes.

| 10,000 pages, p50 ms | Before | After |
| --- | ---: | ---: |
| balanced, phrase=False | 4.758 | 3.288 |
| balanced, phrase=True | 4.773 | 3.335 |
| precision, phrase=False | 4.762 | 3.268 |
| precision, phrase=True | 4.756 | 3.249 |
| coverage, phrase=False | 4.694 | 3.184 |
| coverage, phrase=True | 4.710 | 3.255 |

The baseline spends approximately 0.83–0.84 ms sorting per balanced query.
A deterministic selection-only comparison at 10k candidates measured 1.23 ms
for full sorting versus 0.16 ms for a 100-item heap. IDF-only and bounded-selection
variants were measured separately. The retained implementation hoists IDF and
keeps the entire pre-existing phrase pool, including stable ties, before reranking.

## Project precision

The versioned fixture contains 20 locally authored questions: 8 development and
12 evaluation cases. They concern this repository; they are not production logs.
Four adversarial pages are synthetic. Source anchors validate the project-derived
claims. Both splits and every case outcome are reported without rule tuning.
Twelve evaluation cases are an internal regression signal with high sampling
uncertainty, not a publishable estimate of production precision or GAP quality.

| Evaluation split metric | Result |
| --- | ---: |
| cases | 12 |
| foundRecall | 1 |
| shownRecall | 0.9231 |
| shownPrecision | 0.5000 |
| gapPrecision | 0.6000 |
| correctGaps | 3 |
| falseGaps | 2 |
| silentMisses | 0 |
| passageErrors | 0 |

Found recall is 100%; displayed recall is 92.31% and displayed precision 50%.
Two false GAPs persist, alongside three correct GAPs and no silent misses. The
one missing displayed evidence is retained in the candidate pool and explicitly
reported under the tight display budget. These limits are not hidden by recall.
The Markdown passage defect moves from one error to zero. In the actual-adapter
mini-corpus, import precision/recall move from 0/0 (an unrelated package link) to
1/1 for the expected explicit/runtime imports. Dynamic `importlib.import_module`
targets remain unrecovered and are labeled as an adapter limitation.

## Stability and release checks

The final soak completed all 10,000 operations without a coherence assertion
failure. Its predeclared minimum duration was five minutes; actual elapsed time
was 19.12 minutes. Elapsed time includes pacing and idle periods;
operation latencies below are timed separately. There were 100 samples per mutation
or cold-restart scenario, 4,000 symbol reads, 3,000 text queries and 2,000 reference
queries. Tail estimates for the 100-sample scenarios remain coarse.

| Operation | Samples | p50, ms | p95, ms | p99, ms |
| --- | ---: | ---: | ---: | ---: |
| restart | 100 | 0.641 | 3.976 | 5.887 |
| internalWrite | 100 | 17.040 | 33.685 | 129.406 |
| atomicReplacement | 100 | 1.060 | 4.912 | 7.203 |
| deleteRecreate | 100 | 1.042 | 5.119 | 6.336 |
| corruptCode | 100 | 28.816 | 51.906 | 112.970 |
| oversized | 100 | 26.636 | 39.131 | 140.004 |
| removeSource | 100 | 31.349 | 35.667 | 62.895 |
| wikiWrite | 100 | 20.202 | 23.151 | 57.074 |
| corruptRetrieval | 100 | 27.994 | 31.693 | 108.523 |
| lazyMaps | 100 | 1.049 | 1.249 | 5.573 |
| symbol | 4000 | 0.045 | 0.823 | 1.761 |
| search | 3000 | 0.237 | 1.736 | 2.690 |
| references | 2000 | 0.051 | 0.928 | 1.842 |

Post-GC heap started at 10.53 MiB and ended after release at
11.01 MiB. Release checkpoints from operation 3,000 onward remained between
10.95 and 11.13 MiB, including retained measurement arrays and runtime warmup.
Sampled peak heap was 186.95 MiB; sampled peak process RSS was
409.62 MiB, versus OS-reported process peak RSS
410.12 MiB. RSS is an allocator/process measure and need not return to its
initial value after GC or workspace release.

The first harness occasionally retained its own oversized JSON fixture across
later awaits (roughly 9 MiB extra). Moving each operation into a completed async
frame removed that measurement artifact; a 2,000-operation probe and the complete
rerun show stable released heap. Both original and corrected raw runs are retained
locally. No production cache workaround was added to change these readings.

Internal invalidation and release reset admission diagnostics; oversized snapshots
remain searchable without admission; the idle checks retain the existing cache,
as expected without TTL. Independent same-name project isolation is also covered
by the automated tests. This workload does not justify adding configurable
per-project quota or idle expiry: those would add cache misses and lifecycle
complexity without a demonstrated persistent-retention benefit here. Reassess with
real workloads if more idle projects or larger uncached snapshots cause pressure.

Local release validation after the first import correction passed: 381 tests in 70 files, TypeScript, repository
hygiene, all 15 existing quality gates, the warm-start gate (about 2.98× p50 resume
speedup), npm installed-package smoke and desktop MCPB smoke. Release metadata
including the desktop manifest is aligned to 2.7.4. Cross-platform CI and registry
publication were not run in this local session.

Reproduction commands and workload details are in [the benchmark guide](README.md#quality-and-efficiency-workloads-274).


## Verification after the import review

The flat Python reproduction failed on the previous working tree (zero import
edges) and now returns both the importing module and `run` function. Nine tests
using the real Java, Kotlin, C#, Go, Rust, PHP, C, C++ and Ruby adapters failed on
the previous built 2.7.4 runtime and passed with the compatibility index restored.
Their synthetic bare specifiers tested the old matcher, not representative
language imports; the realistic-import review below supersedes that coverage claim.
Python package/relative cases also check ambiguity, aliases, stub precedence,
path filters, test priority and isolation between homonymous projects.

The targeted code-query rerun uses the same 1k/10k synthetic snapshots and 100
samples as the earlier run: both complete result digests remain identical.
At 10k fragments, warm reference p50 is 1.90 ms and warm heap after GC is 28.64 MiB;
these are observations on the same machine, not a claim of another speedup.
The separate 1,600 text/symbol comparisons also remain identical. Raw results are
`274-code-import-fix.json` and `274-project-precision-import-fix.json`; the fixed
12-case evaluation split has unchanged outcomes. The code-specific fixture now
records and hashes the static Python import reproduction separately.

The first query after the lexical builder upgrade and its roughly 14-second
100k-page rebuild are documented in `SELF_HOSTING.md`. Subsequent processes avoid
that rebuild only when the replacement checkpoint has been persisted. Benchmark
scripts are grouped with the other `bench:*` entries. No existing quality gate
was weakened or broad performance claim substituted for capability regressions.

### Python src-layout follow-up

The first Python correction still searched absolute names only at the snapshot
root. The reproduction with `src/cli.py` containing `from orders_cli import main`
and its sibling `src/orders_cli.py` returned zero import edges, losing the edge
available in 2.7.3. It now returns exactly the importing `src/cli.py` module.
The resolver checks the root and the importer directory, deduplicates a shared
base and requires one candidate across both. Relative imports keep their package
base; no additional search roots or project-wide basename fallback are inferred.

Two new tests cover sibling modules, dotted packages, stub fallback and conflicts
between the two bases, including module/package and implementation/stub conflicts.
Both failed before the fix and pass afterward. The existing JS/TS fixture also
failed for an explicit `.TS` import before correction; uppercase extension
recognition now passes while mismatched path casing still produces no edge.
After this follow-up, `npm run verify` passes 383 tests in 70 files, TypeScript
and repository hygiene; all 15 quality gates and release metadata checks pass.
The npm installed-package smoke and regenerated 2.7.4 desktop MCPB smoke pass too.
The timing results above remain historical measurements from the earlier runs;
this follow-up adds correctness coverage and makes no new performance claim.

### Realistic import coverage review (before adapter correction)

The replacement fixtures extracted all nine realistic specifiers successfully,
but seven yielded zero module import edges: Java/Kotlin package-qualified names,
C# namespace imports, Rust `crate::orders::place`, PHP namespace-qualified names,
and C/C++ header includes with extensions. Go's `orders.go` and Ruby's `orders.rb`
fixtures each yielded two edges, for the importing module and function. These
counts reproduced the supplied review table.
They describe these fixtures, not a population-wide success rate by language.

An additional Go fixture changed `internal/orders/orders.go` to
`internal/orders/create.go`, preserving package, content and import: it yielded
zero edges. Go and Ruby then retained only partial stem-based behavior.
JS/TS and Python were the only adapters with dedicated module-import resolution.
The other adapters still extract imports and symbols; absence of an import edge
does not mean their entire code-evidence support is unavailable.

The ten realistic capability tests replaced the nine synthetic parity tests.
They required incoming edges and left eight failures visible in the normal test
suite. No missing capability is marked skipped/TODO or accepted as a zero-edge
success. README and changelog disclosed these pre-existing limitations.
That review changed tests and documentation before the resolver implementation.

Validation with `CONTINUE_ON_FAILURE=1 npm run verify` ran all 70 test files:
376 tests pass and eight import capability tests fail, with no skipped or TODO
tests. TypeScript and repository hygiene pass. The 15 existing quality gates
still pass when run separately, confirming that their acceptance checks do not
cover these missing import edges. Release metadata and whitespace checks pass;
the expanded test suite did not pass and the milestone was reopened at that point.

### Adapter resolution and linked knowledge

The final correction passes all ten realistic capability cases. Twelve additional
adapter-contract tests cover qualified and grouped declarations, aliases,
ambiguity, headers without invented implementation twins, Go package files,
Rust relative/inline/grouped forms and crate isolation, Python package source
roots, Salesforce LWC imports, lazy factories and invalid-path rejection.
Persisted snapshot bytes remain unchanged when querying with different adapter
registries, and registry identity prevents reuse of another registry's rules.

The runtime retains one incoming-import map per generation. Each adapter factory
is created lazily and uses existing fragments, without reparsing files; temporary
lookup structures are not added to the persisted snapshot. Repeated source and
specifier pairs share resolution work during map construction. Explicit groups
are a necessary extension to a globally unique-target algorithm: a C# namespace
or Go package can legitimately contribute several files.

Salesforce checks include Apex symbols, metadata database/reference relations,
malformed metadata, selective parser refresh and drift, plus LWC imports of Apex
methods, schema objects/fields and local components. The focused existing run
passed 33 tests; the new LWC contract case and the full suite also pass. These are
local source/metadata fixtures, not validation against a live Salesforce org.

Knowledge synthesis now renders a direct `code://repo/...#symbol-...` link and
captured line range beside a claim only when a matching code anchor was captured.
Non-code and unresolved claims receive no fabricated links. A regression test
retrieves the synthesized page through task context, opens its code resource,
checks the fragment and verifies stable resynthesis. Existing drift validation
continues to detect changed or unresolvable anchors.

`npm run dogfood:import-knowledge` also exercises this flow on this repository:
six local implementation pages, 13 anchored claims, 13 successfully opened code
resources and 13 fresh anchors, with no suspected drift or unresolved anchors.
Each page was retrieved within a 2,000-token task-context budget. The script uses
the record/link/synthesis and mutation-finalization services used by the tools;
unrelated pages are preserved. The result is local at
`benchmarks/results/274-import-knowledge.json`. This proves the navigable
knowledge-to-code path for these examples, not a general retrieval speedup.
See the [workflow guide](../docs/guides/code-evidence-retrieval.md).

A separate final comparison preserved the build immediately before the adapter
correction, then ran the same code-query harness with 100 iterations per operation
at 1k and 10k fragments. Result digests match at both scales; another 1,600
text/symbol comparisons match exactly. The synthetic benchmark deliberately does
not establish correctness or cold import-map costs for every language.

| Final adapter comparison | Before | After |
| --- | ---: | ---: |
| 1,000 fragments, warm references p50 ms | 0.249708 | 0.249708 |
| 10,000 fragments, warm references p50 ms | 1.890625 | 1.891084 |
| 10,000 fragments, warm heap after GC MiB | 28.376 | 28.643 |

Raw files are `274-before-adapter-resolvers.json` and
`274-after-adapter-resolvers.json` under `benchmarks/results/`. Warm reference
latency is essentially unchanged; this correction improves supported evidence
coverage and direct navigation, without claiming a new query-speed gain. These
timings precede the final TypeScript range correction and do not measure its
extraction cost.

### Function bodies behind knowledge links

Inspecting the actual cited resources uncovered an existing TypeScript extraction
defect: a parameter destructuring brace or inline object type could be mistaken
for the function body. Several links therefore opened a signature without the
implementation supporting the claim. This was corrected in the adapter by
balancing parameters and return-type delimiters before locating the body.

A new regression reads four real indexed resources with destructured parameters,
inline parameter and return types, a multiline signature/default callback and a
generic callback constraint. Each must include its own implementation statements
and exclude the adjacent function. The test fails on the preserved pre-correction
build with `fromContext must include its implementation` and passes now. The
project knowledge script also requires implementation statements in every cited
function resource; successful URI lookup alone is insufficient evidence.

`typescript-javascript-deterministic-v3` invalidates old extraction records for
that adapter on refresh, including LWC metadata companions; other adapters keep
their versions and the snapshot schema remains v2. Existing anchors are not
silently rewritten: drift checks report parser changes and recapture is explicit.
This selective refresh is separate from the Markdown builder's one-time lexical
rebuild and from the import refactor's compatibility with persisted snapshots.

Final tool-surface validation retains all 31 routing examples with no failures
and stays within the original catalog byte/token budgets. The public workflow
guide is explicitly allowed and required in the npm packaging smoke; local wiki
pages, normalized sources and raw benchmark results remain outside the package.
