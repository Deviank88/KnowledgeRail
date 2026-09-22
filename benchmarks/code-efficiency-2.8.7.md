# Code efficiency — 2.8.7 first implementation tranche

> Historical intermediate measurements. The [release validation](release-readiness-2.8.7.md) records the final 64 MiB/five-workspace policy, acceptance checks and scope. Statements about production defaults below describe their measurement checkpoint.

Measured 2026-09-22, macOS arm64, Node v24.9.0.
The milestone remains open. Package version stays 2.8.0; no release or tag.

Scope correction: the measurements below are historical Salesforce-oriented
workloads. The synthetic tree contains JS/Python files, but its query target is
Apex; this does not establish efficiency across languages. The benchmark now
defaults to active targets and positive/negative controls in all 13 adapter
families. Use `--profile=salesforce` for the historical fixture. Project knowledge
also includes requirements, decisions, incidents and documents without code links.
See the [multilingual and documentary follow-up](code-efficiency-multilingual-2.8.7.md)
for subsequent measurements, functional corrections and memory experiments.

## Implementation and scope

- Concurrent requests share an in-flight validated snapshot even when it exceeds
  permanent admission. Different registries retain their own generation state.
- Unindexed-import probes, including empty results, survive snapshot eviction
  within a 1 MiB sub-budget of the existing 32 MiB project ceiling. Errors allow
  retry; explicit generations and workspace eviction invalidate the state.
- Salesforce import/reference resolvers share prepared names and package ownership,
  without sharing diagnostic callbacks or retaining source fragments in postings.
- Manifest candidate discovery visits each ancestor once per shared specification.
  Conflicting custom parsers preserve their previous selection order. Filesystem
  confinement, missing boundaries and known-manifest refresh behavior are unchanged.
- Explicit index writes persist versioned companion projections in snapshot v2.
  Apex status restores after restart without sidecar reads. Metadata-only changes
  preserve source fragment IDs/fingerprints/anchor hashes. Invalid XML, removal and
  absent status clear status; older/incompatible projections use read-only fallback.
  Metadata preparation still checks the generation's companions on explicit writes.

No public payload was compressed and no retrieval or acceptance threshold was lowered.
E1/E2 are implemented; E0 and E3 have remaining measurement/discovery work. E4–E6
remain open. This tranche demonstrates query-runtime improvements, not whole-task
or token savings.

## Reproducibility

The preserved baseline is T1–T6 at `e705db72fe7b1f406bbae201394ca42610c80c09`.
Source digests use SHA-256 over JSON pairs of sorted relative source paths and their
content digests; the complete algorithm is in the benchmark.

- Baseline source digest: `3e75bbbaf7b39ed29eac4de0293a854aa2f7e9ce873b1f3849d5370c4dff5fc3`.
- Current source digest: `152d2efa778d3a5f36b0c804a6f49f8c646c5cd79891ba890d9e5e7a4d5235e7`.
- Benchmark digest: `dfc6505b95fc144cf4056887a1527b417cc0042496f0a1756743499f6faf5bb3`.
- Real oracle digest: `3fd70b7b8c7fe580d920f6a6728544a47de4d3d23185864400e27332e2e4f7ac`.

Twenty samples per runtime/mode, alternating runtime order. Two application warm-ups
are excluded; fresh-process samples are all retained. Filesystem cache is exercised
by indexing and is not flushed. An application-state clear is not a process restart.
The new-process query table excludes process/module startup; whole child-process wall
time is recorded separately in JSON. Cold phase medians are not additive.

Synthetic fixtures mix Apex, JS and Python, companion metadata and unindexed relative
imports, with dense/sparse directories and roughly 1k/10k fragments. The small snapshot
is admitted; the large one exceeds admission. Real sources are read-only, with temporary
indexes and aggregate reports. Public MCP runs use temporary synthetic projects because
the public path writes telemetry under projectRoot/wiki; it is not run against the
read-only real checkout.

## Authorized real-repository timings

Baseline and current index 8,289 fragments. Values are
p50 / p95 in milliseconds, instrumented on the same machine and corpus.

| Operation | T1–T6 baseline | Current |
| --- | ---: | ---: |
| Application cache empty | 133.564 / 140.923 | 109.203 / 116.105 |
| Warm query | 42.801 / 45.417 | 42.638 / 48.392 |
| Eight concurrent requests, complete group | 536.192 / 551.085 | 114.419 / 118.395 |
| First query in a new process | 181.734 / 185.717 | 147.677 / 151.486 |

Real warm p50 is essentially unchanged; p95 is 2.975 ms higher in this run.
That tail remains an open acceptance observation, not a demonstrated warm speedup.

| Application-cold phase, p50 ms | Baseline | Current |
| --- | ---: | ---: |
| Snapshot loading/validation/preparation | 40.837 | 42.666 |
| Companion enrichment | 16.339 | 1.507 |
| Manifest discovery and unindexed probes | 16.253 | 9.795 |
| Reference index construction/lookups | 58.490 | 55.685 |

## Synthetic internal and public timings

Public measurements include JSON request/response serialization, domain-tool dispatch,
diagnostics, request telemetry and one returned resource read. They exclude an external
host client, OS pipes and model calls. Public result/content/resource digests and internal
reference/diagnostic digests match across versions after removing only the random request
correlation ID. Tests independently cover invalid/stale/ambiguous cases.

| Workload | Baseline p50 / p95 ms | Current p50 / p95 ms |
| --- | ---: | ---: |
| dense, 1,001 fragments, internal cold | 16.097 / 17.525 | 6.879 / 7.863 |
| dense, 1,001 fragments, MCP cold + resource | 18.135 / 20.060 | 9.983 / 11.440 |
| dense, 1,001 fragments, MCP warm + resource | 4.055 / 4.635 | 4.099 / 5.279 |
| dense, 1,001 fragments, metadata update + MCP + resource | 38.656 / 40.061 | 37.217 / 39.127 |
| dense, 10,003 fragments, internal cold | 145.401 / 151.951 | 57.390 / 60.122 |
| dense, 10,003 fragments, MCP cold + resource | 161.499 / 170.105 | 75.317 / 78.723 |
| dense, 10,003 fragments, MCP warm + resource | 51.704 / 52.450 | 37.574 / 38.366 |
| dense, 10,003 fragments, metadata update + MCP + resource | 229.762 / 236.380 | 227.571 / 235.436 |
| sparse, 1,001 fragments, internal cold | 25.731 / 27.736 | 17.238 / 18.481 |
| sparse, 1,001 fragments, MCP cold + resource | 28.985 / 30.620 | 20.437 / 21.554 |
| sparse, 1,001 fragments, MCP warm + resource | 4.217 / 5.764 | 4.236 / 4.580 |
| sparse, 1,001 fragments, metadata update + MCP + resource | 48.559 / 50.385 | 47.476 / 49.812 |
| sparse, 10,003 fragments, internal cold | 244.300 / 252.850 | 160.752 / 164.526 |
| sparse, 10,003 fragments, MCP cold + resource | 260.414 / 273.323 | 177.620 / 185.574 |
| sparse, 10,003 fragments, MCP warm + resource | 52.963 / 53.799 | 38.504 / 40.202 |
| sparse, 10,003 fragments, metadata update + MCP + resource | 330.340 / 342.841 | 331.104 / 343.618 |

The small warm MCP workload does not establish a speedup: sub-millisecond differences
and tail variation remain visible. The large workload benefits especially from shared
probes and concurrent loading. Metadata-update totals stay close to baseline: avoiding
query preparation transfers work to explicit index writes. These are tool/resource
replays, not verified completed model tasks.

Fresh-index construction is included as a separate observation (one sample, not a
percentile). These figures do not establish an indexing regression or improvement:

| Workload | Baseline rebuild ms | Current rebuild ms |
| --- | ---: | ---: |
| dense, 10k target | 651.712 | 707.919 |
| sparse, 10k target | 646.862 | 723.943 |

## IO, memory and remaining cost

At the dense 10k scale, eight concurrent cold queries read
61,499,174 bytes at
baseline versus 7,913,620
currently at the observed promise/file-handle API boundary. Snapshot bytes grow from
7,679,097 to 7,913,537 because
companion projections are persisted. Oversized snapshots still reload on a later query;
this tranche does not introduce a compact query projection or persisted resolved graph.

| Retained cache admission estimate | Baseline bytes | Current bytes | Full snapshot admitted |
| --- | ---: | ---: | :---: |
| dense, 1,001 fragments | 4,001,268 | 4,126,516 | true |
| dense, 10,003 fragments | 4,215,146 | 3,592,938 | false |
| real, 8,289 fragments | 11,570,992 | 11,351,028 | false |

Admission estimates are not heap/RSS. JSON reports separately contain CPU user/system
time, heap, RSS, external memory and array buffers, sampled peaks, and memory after GC
and eviction. Two-millisecond sampling plus operation boundaries can miss synchronous
peaks. In-process comparisons share a process; restart samples isolate each runtime.
No general reduction in actual RAM is claimed. IO counts include failed fs/promises
calls and handle reads/writes, but exclude callback-based glob discovery, kernel syscalls
and physical disk/cache behavior. Instrumentation adds overhead to both runtimes.

## Validation

- 514 tests across 81 files, TypeScript checks and repository hygiene.
- All 18 existing quality gates, with thresholds unchanged.
- 1,600 identical text/symbol comparisons with the preserved T1–T6 runtime.
- Code-context gate passes at both scales; the largest paired p95 overhead is
  2.065 ms, below the existing 5 ms ceiling. Document-only output is identical.
- All 17/17 pre-reviewed real positive edges remain present in both runtimes.
- Project-precision evaluation: shown recall 0.9231, shown precision 0.75, zero
  silent misses and passage errors. These are fixture metrics, not perfect retrieval.
- Query and context-disclosure benchmarks complete; the latter uses the existing
  byte-based estimator and does not measure model token savings.
- Project knowledge refreshed on six pages with 26 current code anchors and 26
  resources materialized, preserving historical claims. Build passes.

## Open acceptance work

- E0: measured sessions with initial indexing, modifications and 1/5/20 completed
  tasks; stronger peak-memory measurement and client exposure accounting.
- E3: compare point lookups with bounded directory reads on dense/sparse layouts and
  measure filesystem concurrency/contention before changing discovery strategy.
- E4: profile the remaining snapshot/materialization and reference-construction cost;
  evaluate a compact representation only with memory/admission and parity evidence.
- E5/E6: freeze and run the complete bilingual task corpus, compare sufficient initial
  context with progressive disclosure and verify final artifacts, corrections and failures.
- Re-run the original 2.8.0 runtime for the cold acceptance target on the same corpus.
  Improvement over T1–T6 alone does not close that target.
- Model input/output/cache/reasoning tokens, host-client payload exposure and full-task
  success remain unobserved. `totalModelTokens: null`; **token savings not measured**.
  No provider calls or private prompt logging were introduced.

## Commands

```bash
npm run verify
npm run eval:gates
npm run bench:code-efficiency -- --baseline=/path/to/preserved/runtime --scales=1000,10000 --iterations=20 --json=/tmp/dense.json
npm run bench:code-efficiency -- --baseline=/path/to/preserved/runtime --scales=1000,10000 --layout=sparse --iterations=20 --json=/tmp/sparse.json
npm run bench:code-efficiency -- --baseline=/path/to/preserved/runtime --repository=/path/to/authorized/checkout --oracle=/path/to/reviewed-edges.json --iterations=20 --json=/tmp/real.json
npm run bench:code-parity -- --baseline=/path/to/preserved/runtime
npm run bench:code-context -- --baseline=/path/to/preserved/runtime --gate
npm run bench:code-query -- --scales=1000,10000 --iterations=30
npm run bench:context
npm run eval:project-precision
npm run dogfood:import-knowledge
```

Raw run files remain local in ignored `benchmarks/results/`; the repository artifact is this
aggregate report. No private source paths, business vocabulary or prompt content are
included. The read-only real positive-edge evaluator uses the same pre-reviewed oracle
as the previous tranche; selected positive recall is not whole-repository precision.
