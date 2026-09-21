# Declared reference extensions — 2.8.x implementation

Measured 2026-09-22, macOS arm64, Node v24.9.0. Working-tree implementation;
package/release version remains 2.8.0. No tag or publication is implied.
Comparison runtime: preserved source at `34d1684`, before these changes.

## Scope and implementation

T1–T6 are implemented within the literal declaration contracts in the
[guide](../docs/guides/code-evidence-retrieval.md). The changes add:

- Salesforce project boundaries, platform classification, label/resource/channel
  imports, trigger object references, literal Visualforce/Aura controllers and
  Apex deployment status. The previous trigger header could appear as a lexical
  call; it is now a declared reference, with independent SOQL evidence preserved.
- Poetry/Hatch/Flit/PDM layouts normalized into the existing Python name index.
- Inventory causes and language counters separate from request/fallback telemetry.
- Rust path/cfg declarations, one-level re-exports and bounded Cargo workspace globs.
- JS/TS ownership, local package exports/imports and npm/yarn/pnpm workspaces,
  including different import/require entry points in the same source.
- Literal CMake, Go workspace/replacement, JVM boundary, C# exclusion and Ruby path-gem
  declarations. Unsupported declarations retain explicit limits and diagnostics.

Shared components handle manifest traversal, bounded wildcard discovery, XML and
TOML projection, membership matching and diagnostics. No dependency was added.
Snapshot v2 remains additive; extraction versions advance only for JS/TS (v6),
Apex (v2), Rust (v2) and Salesforce metadata (v2). Rebuild refreshes affected adapters;
historical anchors keep their original parser versions.

The real-repository probe exposed repeated work when a full snapshot exceeds cache
admission. Compact metadata/manifest-reader state now has a 1 MiB sub-budget and
ordinal reference postings a 16 MiB sub-budget. Both share the existing 32 MiB
project ceiling. Postings retain no fragment objects. Snapshot/registry changes
invalidate them; known manifest edits rebuild the affected graph. Regressions cover
reuse and invalidation even when the full snapshot is not cached.

## Validation

- Full verification: 501 tests across 79 files; type checks and repository hygiene.
- All 18 quality gates; 44 import cases, nine pinned public manifests, and 38
  functional-routing cases including Salesforce in two package layouts.
- 1,600 unchanged text/symbol comparisons against the preserved runtime; identical
  query-result digests at 1,000 and 10,000 fragments.
- Build and project-precision evaluation pass. The latter reports evaluation shown
  recall 0.9231, shown precision 0.75 and zero silent misses/passage errors; it is not
  a claim of perfect retrieval.
- Knowledge refresh: six pages, 25 current code anchors verified fresh and 25 code
  resources materialized. Historical claims and drift remain preserved; this does
  not certify every historical anchor as fresh.
- Runtime audit exits successfully at the existing high-severity threshold. One
  moderate advisory group remains in the unchanged transitive `hono` dependency.
  No dependency update is bundled into this milestone.

The prior Rust oracle now includes real `mod` edges; Cargo simple globs no longer
expect an unsupported warning; the Flask public overlay now reaches its Flit package
from external tests. Parser-version expectations change with the extractor versions.
The unrelated-Python-tool test continues to verify ignored grammar using tool tables
outside the newly supported backends; dedicated tests verify backend conflicts and
malformed dependency declarations. No acceptance threshold was lowered.

## Timings and memory

Runs below are sequential local observations, not cross-machine guarantees. Query
microbenchmarks use 30 iterations; context uses 40 paired iterations. Context keeps
the existing p50 ceiling and additionally gates paired p95 overhead at 5 ms.

| Measurement | Before | After |
| --- | ---: | ---: |
| 1k fragments, warm references p50 / p95 | 0.220 / 0.387 ms | 0.263 / 0.453 ms |
| 10k fragments, warm references p50 / p95 | 0.741 / 0.865 ms | 0.832 / 1.057 ms |
| 10k fragments, cold symbol p50 / p95 | 16.431 / 17.125 ms | 16.997 / 19.355 ms |
| 10k query-bench process peak heap | 97.48 MB | 101.98 MB |

These microbenchmarks show a small added cost, not a universal speedup. Process
heap includes fixtures and transient allocations; it is not the cache admission
estimate. Query-result digests are unchanged.

| Context workload | Paired overhead p50 | Paired overhead p95 |
| --- | ---: | ---: |
| 1k fragments, 1 root | 0.598 ms | 0.805 ms |
| 1k fragments, 3 roots | 1.044 ms | 1.368 ms |
| 10k fragments, 1 root | 0.916 ms | 1.243 ms |
| 10k fragments, 3 roots | 1.549 ms | 1.908 ms |

Manifest-rich benchmarks also run dense and sparse directory layouts, separately
from snapshot parsing. At the larger sparse layout (5,001 source files; actual
fragment counts vary by adapter):

| Language | Cold discovery + first references | Warm p95 incl. freshness |
| --- | ---: | ---: |
| Go | 153.67 ms | 0.16 ms |
| JS/TS | 257.86 ms | 1.31 ms |
| C/C++ | 150.49 ms | 0.16 ms |
| C# | 187.56 ms | 0.23 ms |
| Ruby | 178.93 ms | 0.23 ms |
| Python | 123.23 ms | 0.16 ms |
| Rust | 65.11 ms | 0.15 ms |
| Salesforce | 76.80 ms | 0.19 ms |

## Authorized real-repository observation

A local Salesforce repository was read in full; both runtimes wrote indexes only
to temporary directories. No private source, business vocabulary, source paths or
wiki pages are included in this report or the committed fixtures. The oracle was
fixed from literal declarations before retrieval: five Apex imports, five resource
imports, two message-channel imports and five trigger object references.

| Measurement | Before | After |
| --- | ---: | ---: |
| Indexed source files | 1,438 | 1,478 |
| Fragments | 8,238 | 8,289 |
| Selected positive edge checks | 5 / 17 | 17 / 17 |
| Warm references on shared targets, p50 | 85.553 ms | 36.614 ms |
| Warm references on shared targets, p95 | 103.282 ms | 40.061 ms |
| First reference query | 97.541 ms | 152.058 ms |
| Retained derived-cache estimate | 0 | 11,570,992 bytes |

The warm comparison uses the same ten targets (50 samples per runtime). Seven
newly indexed metadata targets are additional recall checks, not substitutes in
that timing comparison. Both full snapshots exceed admission; the improvement
comes from bounded reuse of derived state. Cold cost increases with the additional
metadata and relation construction. This is selected positive-edge recall, not
whole-repository precision or an observed user fallback rate.

The first-reference row above is one sample per runtime, with the filesystem
already exercised by rebuild and snapshot reads. It is not a process-start or
cold-disk percentile. A follow-up profile repeated the same first target in 16
alternating trials per runtime, clearing application workspace state before every
trial. The first two trials per runtime were excluded from the medians below to
reduce JIT transients; the OS file cache remained warm. Instrumentation measured
elapsed time around runtime preparation, source metadata, project structure and
reference-index construction; it did not change production code.

| Application-cold phase, median of 14 trials | Before | After |
| --- | ---: | ---: |
| Snapshot loading, validation and runtime preparation | 30.570 ms | 31.646 ms |
| Source companion metadata and enrichment | 0 | 17.067 ms |
| Project manifest discovery and unindexed-import probes | 5.226 ms | 18.424 ms |
| Reference index construction | 47.966 ms | 61.521 ms |
| Complete first reference query | 84.048 ms | 129.897 ms |
| Complete first reference query, p95 | 88.512 ms | 133.666 ms |

Phase medians need not add up to the total median. Snapshot bytes grew only from
12,944,710 to 13,058,955 (0.9%); additional eager generation preparation dominates
the cold regression, approximately 55% in this repeated profile. The compact
derived cache avoids repeating much of this work on subsequent queries, but its
initial construction remains on the first reference request after invalidation or
process restart. These measurements establish the optimization target; they do
not claim that the cold regression has been fixed.

The new JS/TS inventory contains 228 resolved specifiers, 227 platform specifiers,
eight declared external dependencies and 94 unresolved (four unsupported dynamic
expressions). Python has nine resolved and 95 unresolved. These counts are per
source/specifier; unresolved includes forms outside the declaration contract.
The source workspace has no recorded served-request population, so no real fallback
rate can be inferred. A second authorized checkout had no usable source corpus.

## T7/T8 and readiness for 2.9.0

One authentic overview/detail wiki was frozen byte-for-byte and tested with 20
analyst-authored questions and expected excerpts fixed before retrieval. Across
120 runs (three profiles, two budgets), 64 expected-page appearances were retained
before and after; zero expected pages were removed by dominance or newly lost.
86 runs had the expected page below first rank, and dominance operated in 102 runs.
The self-wiki probe independently retains 72/72 expected appearances over twelve
questions. Other returned pages are not automatically labeled irrelevant.

T7 remains **under observation**: one authentic hierarchical workspace and generated
review questions do not satisfy twenty real questions across three such workspaces.
T8 remains **partially observed**: the whole source inventory was exercised with
seventeen literal edge checks, but there is no complete anonymized user corpus with
answer oracles and no historical fallback population. Pure live semantic paraphrases
await the durable index/provider work in 2.9.0 M0/M2. No semantic-quality claim is made.

T3's cause inventory and the existing R6 request denominator are available for 2.9.0
signals. M0 can proceed independently; M1/M9 should not treat offline edge recall
or unresolved inventory as a measured user fallback rate.

## Reproduction

```bash
npm run verify
npm run eval:gates
npm run build
npm run audit:runtime
node --import tsx benchmarks/code-query-parity.ts --baseline=/path/to/preserved/runtime
node --expose-gc --import tsx benchmarks/code-query-bench.ts --scales=1000,10000 --iterations=30
node --expose-gc --import tsx benchmarks/code-context-bench.ts --baseline=/path/to/preserved/runtime --gate
node --expose-gc --import tsx benchmarks/project-structure-bench.ts --language=salesforce
node --expose-gc --import tsx benchmarks/real-code-references-eval.ts --repository=/path/to/project --oracle=/path/to/reviewed-edges.json --baseline=/path/to/preserved/runtime
node --import tsx benchmarks/workspace-selection-eval.ts --wiki=/path/to/wiki --fixture=/path/to/reviewed-pages.json
npm run dogfood:import-knowledge
```

Private oracle bytes stay local. The real edge-oracle SHA-256 was
`3fd70b7b8c7fe580d920f6a6728544a47de4d3d23185864400e27332e2e4f7ac`.
Public manifests retain their immutable Git URLs and SHA-256 in the checked-in
corpus. Hatch's implicit layout remains an explicit negative control; synthetic
positive fixtures cover its declared packages/sources contract.
