# 2.8.7 — Multilingual efficiency follow-up

> Historical intermediate measurements. The [release validation](release-readiness-2.8.7.md) records the final 64 MiB/five-workspace policy, acceptance checks and scope. Statements about production defaults below describe their measurement checkpoint.

The default efficiency workload now queries all 13 adapter families. Project knowledge also includes requirements, decisions, business rules, incidents and documents without code anchors. Salesforce remains one explicitly named profile, not the acceptance scope.

## Runtime change

Code resource materialization reuses an admitted, identity-checked query generation. Source reads and content-hash checks still happen on every request. External snapshot replacement, corruption and workspace eviction invalidate reuse. No cache budget, public payload or quality threshold changes. Oversized snapshots still require reloading; the optimization does not solve that remaining cost.

A regression checks positive/negative references and resource freshness across all 13 families, including source edits, explicit updates and eviction. A separate TypeScript-only custom adapter checks persisted companion metadata independently of Salesforce.

## Manifest discovery and representation experiments

Experiments run in disposable copies against the current production strategy, with identical reviewed reference/diagnostic results. Twenty samples per mode/runtime; alternating order, two application warm-ups excluded. Timings below are complete batches of 13 target queries, in milliseconds.

| Variant | Actual fragments | Layout | Current p50 / p95 | Experiment p50 / p95 |
| --- | ---: | --- | ---: | ---: |
| concurrency-4 | 1056 | dense | 14.586 / 17.419 | 15.227 / 18.899 |
| concurrency-4 | 1056 | sparse | 19.042 / 21.337 | 19.718 / 21.425 |
| concurrency-32 | 1056 | dense | 14.793 / 15.696 | 14.325 / 17.247 |
| concurrency-32 | 1056 | sparse | 19.249 / 20.801 | 19.068 / 21.168 |
| directory-prefilter | 1056 | dense | 14.923 / 18.869 | 15.669 / 16.996 |
| directory-prefilter | 1056 | sparse | 18.954 / 21.322 | 20.465 / 25.475 |
| compact-json | 1056 | dense | 14.961 / 16.158 | 15.661 / 18.022 |
| compact-json | 1056 | sparse | 18.890 / 21.045 | 19.836 / 21.901 |
| directory-prefilter | 10362 | dense | 303.009 / 314.011 | 311.856 / 321.129 |
| directory-prefilter | 10362 | sparse | 352.962 / 358.911 | 368.769 / 377.966 |
| compact-json | 10362 | dense | 307.396 / 314.857 | 415.867 / 425.213 |
| compact-json | 10362 | sparse | 356.353 / 360.501 | 473.540 / 485.227 |

Decision: retain point lookups and concurrency 16. Bounded directory prefiltering adds work even where it removes negative file probes. Concurrency 4/32 has no consistent latency benefit on the small mixed corpus; it is not promoted from that limited experiment.

Compact JSON reduces the large dense snapshot from 8,474,301 to 6,066,464 bytes, but this prototype reconstructs the original pretty-JSON size to preserve the admission estimate. That added work makes queries slower. Both large variants stay outside admission. These results reject this prototype, not every possible compact representation. A reusable projection for oversized search/symbol/reference queries remains open; file-size reduction alone is not a memory argument.

Memory figures in the machine-readable experiments are process-wide and paired runtimes coexist. They are not isolated per-runtime heap savings. Filesystem counters measure fs/promises calls and file-handle bytes, not physical IO.

Reproduce with:

```sh
npm run bench:code-preparation -- --scales=1000 --iterations=20
npm run bench:code-preparation -- --scales=10000 --iterations=20 --variants=directory-prefilter,compact-json
```

The fixtures are synthetic cases prepared during this milestone, not independent historical evaluation traffic. No model token savings or final task success are inferred from deterministic replay.

## Multilingual lifecycle measurements

The oracle fixes one positive edge and one negative source per adapter family before extraction. Each batch queries all 13 families sequentially; later queries can reuse preparation. Concurrency means eight complete batches. Public modes include one reviewed source resource per family. Timings are batch p50 / p95 in milliseconds, not single-query timings. No public response field is removed except random request IDs when comparing digests.

| Layout | Fragments | Operation | T1–T6 baseline | Current |
| --- | ---: | --- | ---: | ---: |
| dense | 1056 | applicationCold | 17.403 / 19.230 | 14.684 / 17.282 |
| dense | 1056 | warm | 5.519 / 5.988 | 5.601 / 6.048 |
| dense | 1056 | concurrent | 20.772 / 22.316 | 18.701 / 19.486 |
| dense | 1056 | publicCold | 56.499 / 60.145 | 28.334 / 32.823 |
| dense | 1056 | publicWarm | 45.778 / 47.719 | 20.340 / 22.104 |
| dense | 1056 | restart | 42.352 / 43.460 | 38.924 / 40.989 |
| dense | 1056 | publicRestart | 122.616 / 127.236 | 90.599 / 94.772 |
| dense | 1056 | publicPostUpdate | 77.262 / 79.302 | 51.276 / 53.153 |
| dense | 10362 | applicationCold | 340.322 / 346.617 | 306.547 / 319.123 |
| dense | 10362 | warm | 267.124 / 274.597 | 260.543 / 270.525 |
| dense | 10362 | concurrent | 2510.890 / 2528.527 | 316.543 / 323.112 |
| dense | 10362 | publicCold | 599.550 / 604.991 | 576.347 / 586.893 |
| dense | 10362 | publicWarm | 517.270 / 533.441 | 519.165 / 524.016 |
| dense | 10362 | restart | 407.547 / 413.278 | 369.731 / 373.228 |
| dense | 10362 | publicRestart | 698.598 / 703.353 | 664.099 / 671.148 |
| dense | 10362 | publicPostUpdate | 669.684 / 684.633 | 659.766 / 676.354 |

The smaller generation is admitted; the large one is not. Resource reuse helps the admitted public path substantially. The large warm public median is essentially unchanged (517.270 → 519.165 ms); there is no general warm-query speedup claim. The concurrent improvement also depends on sharing in-flight work rather than permanent snapshot admission.

Source digests for this follow-up:

- baseline: `3e75bbbaf7b39ed29eac4de0293a854aa2f7e9ce873b1f3849d5370c4dff5fc3`.
- current: `bf9a5eafe1851a2a038ee6bee3b44ceabc8d5b9d2e2373e540d2d767c20b3582`.
- Lifecycle benchmark: `e544407c75e97538dec1e2049bca55bf10420d17bb215c2f801652ba2b25d44a`.

The JSON report retains per-family latency, response/IO bytes, CPU, memory observations, samples and fixture/corpus digests. Scope and memory/IO limitations from the initial report still apply.

## Sparse layouts and sessions

| Fragments | Operation | T1–T6 p50 / p95 ms | Current p50 / p95 ms |
| ---: | --- | ---: | ---: |
| 1056 | applicationCold | 21.857 / 24.429 | 19.576 / 22.982 |
| 1056 | concurrent | 24.338 / 25.200 | 22.292 / 23.065 |
| 1056 | publicWarm | 45.189 / 46.615 | 19.971 / 21.345 |
| 1056 | publicPostUpdate | 82.556 / 84.986 | 56.169 / 57.998 |
| 10362 | applicationCold | 391.285 / 402.700 | 359.188 / 380.230 |
| 10362 | concurrent | 2900.064 / 2913.990 | 360.598 / 371.011 |
| 10362 | publicWarm | 528.185 / 549.074 | 530.326 / 549.350 |
| 10362 | publicPostUpdate | 726.752 / 744.227 | 718.892 / 743.253 |

Twenty repeated fresh sessions each include initial indexing, one explicit manifest update and the indicated number of public batches. External simulated edit IO is included. Each batch contains 13 reference/resource operations. These are tool workloads, not 1/5/20 completed model tasks.

| Batches per session | T1–T6 p50 / p95 ms | Current p50 / p95 ms |
| ---: | ---: | ---: |
| 1 | 173.225 / 178.204 | 147.044 / 151.185 |
| 5 | 369.843 / 383.619 | 242.062 / 249.515 |
| 20 | 1068.475 / 1100.106 | 550.056 / 574.051 |

## Documentary task replay and a functional correction

The reviewed fixture has 22 Italian/English cases across the six intents, with requirements, decisions, incidents, exact identifiers, deep passages, ambiguity, contradictions, stale evidence and missing sources. Every current full/compact × passage/page combination passes (88 cases; 20 repetitions each). Existing compact context reduces serialized response bytes while preserving selected evidence, uncertainty and materializable resources. The context responses match T1–T6 exactly.

The real MCP transport exposed an existing whole-page URI routing bug: the installed SDK requires the query portion of a resource template to be present. A page URI without `passage` did not reach the reader. The correction registers an explicit whole-page template sharing the same bounded reader, including desktop workspace bindings. The original passage template stays available. This is a separate functional correction, not an internal parity-preserving optimization. Successful resource responses match across runtimes; baseline route failures remain failures.

| Current replay, across 22 tasks | Response bytes | Requests | Passed |
| --- | ---: | ---: | ---: |
| passages, full | 319,034 | 143 | 22/22 |
| passages, compact | 211,005 | 143 | 22/22 |
| pages, full | 341,975 | 143 | 22/22 |
| pages, compact | 233,932 | 143 | 22/22 |

Task fixture SHA-256: `dc54bcab9bc800dfd8b7aec8ab3abe5f3b602112fb4ad48215a0888c45570279`. Baseline whole-page replay succeeds only for the two missing-source tasks that require no resource read. Its 40 failed page/detail combinations cannot be counted as cheap successful tasks. No provider calls were made. Client channel exposure, model tokens and final model task quality remain unobserved.

## A real corpus outside Salesforce

KnowledgeRail’s own primarily TypeScript/Node checkout is measured read-only, with temporary indexes outside the checkout. It contains 3,546 indexed fragments in this captured corpus. These historical numbers are single-target internal queries rather than the synthetic 13-target batches. They precede the file-alias correction described below and do not establish successful retrieval of the expected import.

| Operation | T1–T6 p50 / p95 ms | Current p50 / p95 ms |
| --- | ---: | ---: |
| applicationCold | 78.383 / 84.099 | 75.846 / 79.485 |
| warm | 26.754 / 28.865 | 24.501 / 26.692 |
| concurrent | 280.211 / 287.884 | 83.989 / 88.154 |
| restart | 106.988 / 110.188 | 106.707 / 108.560 |

The separate self-oracle fixes an import from the public code tool to the resource reader, a non-importing negative source and an independently materialized fresh resource. This revealed a pre-existing failure in both T1–T6 and the first follow-up runtime: database names consumed in a physical file module were also used as target aliases for that file. Lexical matches could therefore fill the top 100 or mask a genuine import as a generic reference. In the real case the extracted names included `the` from an error message and a newline join separator.

The correction excludes consumed database names from the target aliases of physical file modules only. Database usage remains indexed, and named entity fragments keep their aliases. A TS/Python regression fails before the correction and passes after it, covering a real SQL table shared by unrelated files as well as the prose false positive. The unchanged self-oracle now finds the expected import both unscoped and within `src/`, rejects the negative source and reads the source resource. Baseline failure remains explicit (`baselinePass: false`); this is a functional correction with its own oracle, not a parity claim or repository-wide precision estimate. Improving the database extraction heuristics themselves remains separate.

Runtime source digest including the page-route correction, before the file-alias correction: `759b0d62dbbcd987ddf66a3a23e06c9e58457aedf5da50de4bbc8deb72068e72`. Lifecycle tables above use the separately preserved runtime before either functional correction (`bf9a5e…`). The harness subsequently improved error messages; successful serialized response behavior was unchanged.

## Experimental memory budgets

Only disposable runtime copies change the code admission budget from 32 to 64 MiB. Production remains at 32 MiB. The source used includes the page-route correction and precedes the file-alias correction. All reference/resource digests and all 13 positive/negative controls are identical. Three fresh processes per configuration, alternating order; 20 warm batches per process. Each project has 10,362 fragments. A batch reads all 13 targets and their reviewed resources in each project. No public MCP/client/model overhead is included.

Values below are medians across the three process runs; heap delta is after GC relative to the same process before query preparation. RSS includes the process, not just the cache.

| Projects | Budget/project MiB | Warm batch ms | Retained heap delta MiB | Retained RSS MiB | Sampled peak RSS MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 32 | 493.656 | 3.05 | 267.94 | 405.95 |
| 1 | 64 | 9.266 | 13.55 | 192.97 | 192.97 |
| 4 | 32 | 1995.845 | 11.31 | 291.17 | 504.61 |
| 4 | 64 | 38.162 | 49.99 | 337.53 | 337.53 |

In this corpus the 64 MiB budget admits approximately 43.46 MiB of estimated code state per project. The 32 MiB budget retains only derived structures and reloads the snapshot. Actual additional retained heap is approximately 10.5 MiB for one project and 38.7 MiB across four. Fewer repeated parses reduce allocation peaks in these runs despite retaining more useful state. This is local evidence, not a bound for arbitrary repositories or machines. Sampling can miss synchronous peaks; raw results also include the process maximum RSS.

At the time of this experiment, the process default retained up to 32 workspace states. The 64 MiB × 32 = 2 GiB figure was a theoretical sum of possible admissions, not a measured workload or a requirement for 32 simultaneous projects. The user subsequently fixed the operating scope at four/five projects on the available Mac. The workspace default is now five, using existing LRU eviction; this supersedes the earlier suggestion that a new total-process manager was a prerequisite. Admission estimates are not process-RAM limits. [Node memory accounting](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage) distinguishes V8 heap, external buffers and resident process memory.

Unified memory concerns CPU/GPU sharing; this code query path uses the CPU and does not require that architecture. [Apple architecture documentation](https://developer.apple.com/videos/play/wwdc2020/10686/) describes that distinction. All measurements used a warm OS filesystem cache; cached file data can already reside in RAM, and memory pressure can introduce compression or swap. [Apple memory documentation](https://support.apple.com/en-in/guide/activity-monitor/actmntr1004/mac). No slower-SSD, Windows or Linux machine was measured.

Engineering direction: keep reusable lookup data in bounded RAM and use selective disk reads for details that are actually requested. Streaming the whole snapshot would bound temporary buffers but still scan and parse every query; it is not the selected optimization. Further work is measured within the agreed one-to-five-project local scope. Other machines and a new global memory architecture are not prerequisites for this tranche.

## Final integrated verification

Final source digest: `fe209aa9820465f47ad70ee8e367ebad6a655c14ce2b4b0dd03110f1ed517092`. Benchmark digest: `e23d783a32f82d3b1788e858f4f929113e945e3d0afeeb8f2258b07cac38495c`. After both functional corrections, the dense multilingual workload was repeated for 20 alternating samples per mode/runtime, with two application warm-ups excluded. All 13 positive/negative controls and exact reference/diagnostic response digests pass on this fixture. Functional differences on the reviewed real source and whole-page URI are checked separately.

| Fragments | Operation | T1–T6 p50 / p95 ms | Final p50 / p95 ms |
| ---: | --- | ---: | ---: |
| 1056 | applicationCold | 18.398 / 23.303 | 15.397 / 16.903 |
| 1056 | warm | 6.117 / 6.374 | 6.192 / 6.768 |
| 1056 | concurrent | 20.384 / 21.139 | 18.093 / 19.107 |
| 1056 | publicWarm | 43.759 / 50.378 | 19.475 / 21.247 |
| 10362 | applicationCold | 336.378 / 343.534 | 306.095 / 312.934 |
| 10362 | warm | 262.671 / 271.297 | 255.689 / 264.282 |
| 10362 | concurrent | 2494.245 / 2521.294 | 313.249 / 323.063 |
| 10362 | publicWarm | 510.437 / 534.736 | 514.356 / 525.113 |

The final large public warm median remains effectively unchanged. The internal small warm median is also slightly higher; neither supports a universal warm-path speedup. Concurrency and admitted resource materialization retain their measured benefit.

- `npm run verify`: 519 tests across 83 files, repository hygiene and both TypeScript checks passed.
- `npm run eval:gates`: all 18 gates passed without lower thresholds.
- Build passed; all 1,600 text/symbol parity comparisons are identical.
- Code-context p95 maximum 2.703 ms, below the existing 5 ms gate; document parity preserved.
- The real Salesforce oracle remains 17/17 for both T1–T6 and final runtime. The separate real TypeScript oracle passes in the final runtime while preserving the baseline failure in its report. Neither is a repository-wide precision estimate.
- Knowledge maintenance records 28 fresh current anchors on seven pages, reads every current cited resource and validates code-impact resources. Historical claims and 176 older drift observations remain preserved; fresh current evidence does not retroactively repair them.

## Remaining milestone work

E1–E3 have implementation and local validation. E4 retains the compact-query investigation, including search/symbol/details costs, but its priority is determined by results on the available Mac with at most five retained workspaces. Existing workspace eviction supplies the selected retention policy. E0/E5/E6 still require completed model/client tasks, an independent evaluation set, actual input/output usage and the same-corpus 2.8.0 cold comparison within that local scope. Windows/Linux and slower physical storage have not been measured and are outside the current acceptance requirements. Byte savings from deterministic replay are not total model-token savings. The package stays at 2.8.0; the milestone remains open and no release is published.

## Confirmed local scope: up to five projects

The user fixed the current operating target at four/five projects on the available Apple M4 Max with 36 GiB RAM. Additional servers, 32-project workloads and unavailable hardware are not acceptance requirements. KnowledgeRail supports the agents on this local machine; implementation choices follow workloads that can actually be reproduced here.

The workspace retention default is reduced from 32 to five, using the existing LRU disposers. Five projects remain eligible for reuse; opening another releases the least recently used cached workspace. Persisted indexes and knowledge are preserved, and reopening recovers the same evidence. The environment override remains available. The production code-cache budget is still 32 MiB/project, giving at most 160 MiB of estimated code admissions across five retained states. A 64 MiB experimental budget gives 320 MiB by the same accounting. Neither number limits total process memory. No new global cache manager or idle timer is introduced.

The memory experiment was repeated with five synthetic multilingual projects, each with 10,362 fragments. Three fresh processes per budget, alternating budget order, 20 warm batches per process and a five-workspace retention cap. Each batch performs 65 reference queries and 65 source-resource reads, visiting the projects sequentially; this measures five retained projects, not 65 simultaneous requests. All positive/negative controls and response digests match.

| Budget/project MiB | Warm batch p50 ms | Median retained heap delta MiB | Median retained RSS MiB | Median sampled peak RSS MiB | Admitted projects |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 2457.061 | 13.95 | 303.97 | 525.08 | 0 |
| 64 | 44.025 | 61.99 | 373.27 | 373.27 | 5 |

The warm-batch value is the median of the three process-level p50 values. The experimental increase retains approximately 48 MiB more heap across all five projects and avoids repeated whole-snapshot parsing. This provides a locally measured tuning option; 64 MiB is not yet the production default. The test isolates the code subsystem: full MCP, document/semantic caches, clients and other applications are excluded. It does not establish their combined memory footprint or a physical SSD latency bound.

```sh
npm run bench:code-memory -- --scale=10000 --workspaces=5 --iterations=20 --repetitions=3 --json=benchmarks/results/287-five-project-memory.json
```

Verification after the retention change: `npm run verify` passes 520 tests across 83 files, repository hygiene and both TypeScript checks; build passes. The new regression keeps five real query caches admitted, confirms LRU release when a sixth project is queried, verifies the persisted index is untouched and reopens identical evidence. Knowledge maintenance records 29 fresh current anchors across eight pages; historical drift is preserved. Source digest: `304dd66e4f3d84119fb72504e231a952bfb52dcbae7a7f5602a0316f39719f40`.
