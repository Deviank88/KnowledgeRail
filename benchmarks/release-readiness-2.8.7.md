# KnowledgeRail 2.8.7 — release validation

Measured on 2026-09-22: Apple M4 Max, 36 GiB RAM, macOS arm64,
Node 24.9.0. The operating scope is one to five local projects. Other hardware,
32-project workloads and physical SSD streaming are not acceptance claims.

## Implementation and quality constraints

The release reuses the existing workspace lifetime, confined manifest reader,
adapter registry, snapshot format and resource readers. It adds no dependency,
database or separate storage service. Companion projections are versioned by
their owning adapter; Apex enrichment leaves other adapters’ deployment metadata intact; a custom TypeScript adapter verifies that the contract is
independent of Salesforce. All 13 built-in language families are active benchmark
targets, with positive and negative reference controls and readable resources.

Path normalization, identifier normalization and declared-name resolution are shared during one
reference-index construction. File inventories share one traversal, and import postings
consume resolved targets directly without temporary flattened arrays. Those temporary
maps are then discarded. Ordinal
postings can survive an oversized snapshot without retaining its fragments.
Independent manifest and unindexed-import preparation overlaps, drains both
operations on error and preserves retry behavior. Source-resource reads still
read and hash source bytes on every request.

Two functional corrections have separate oracles: whole-page MCP resource routing
(including desktop bindings), and physical file-module aliases that previously
mistook consumed database names for the identity of the file itself. These fixes
are not described as parity with the previous incorrect behavior.

## Memory decision

The production code-cache admission estimate is 64 MiB per project. The existing
workspace LRU retains five workspaces by default. Opening a sixth releases the
least recently used disposable state and preserves its index and knowledge.
The configurable workspace cap remains available.

The sum of five admission budgets is 320 MiB, not reserved memory or a process RAM
limit. Parsed oversized snapshots, active requests, result copies, graph/lexical/
semantic indexes, clients and Ollama consume additional memory. Each server process
has its own caches. The code path uses CPU memory and does not require unified GPU
memory. The measurements do not establish performance on a physical cold SSD.

The earlier five-project experiment found approximately 48 MiB more retained heap
with the 64 MiB variant, while a sequential batch of 65 queries and 65 resource
reads fell from 2457 to 44 ms. See the
[intermediate report](code-efficiency-multilingual-2.8.7.md) for the full accounting.
The release check repeats this experiment at the runtime checkpoint identified below:

| Five projects, median of three fresh processes per budget | 32 MiB | 64 MiB |
| --- | ---: | ---: |
| Warm batch p50, ms | 2455.855 | 44.702 |
| Warm batch p95, ms | 2476.233 | 51.753 |
| Retained heap increase from pre-query checkpoint, MiB | 13.963 | 61.972 |
| Retained process RSS, MiB | 304.469 | 364.938 |
| Sampled peak process RSS, MiB | 458.094 | 364.938 |
| Retained external-memory increase, MiB | 1.514 | 0.423 |
| Heap increase after workspace eviction, MiB | 0.573 | 1.702 |
| Filesystem API bytes read per warm batch, MiB | 1050.627 | 0.003 |

Each project has 10,362 fragments. Twenty warm batches per process visit the five
projects sequentially; this is not 65 simultaneous requests. Heap checkpoints
follow explicit GC. RSS can remain allocated after eviction, and sampled peaks
can miss synchronous allocation. Filesystem API bytes are not physical SSD reads.
The approximately 48 MiB additional retained heap removes repeated parse/allocation
work and, in this experiment, reduces the observed peak RSS.

For this scope the measured cache policy and existing ordinal postings are the
selected representation. A new compact on-disk projection is not needed to obtain
the measured gain. The compact-JSON prototype did not improve latency consistently;
the existing full fragment representation preserves search, symbol, diagnostic and
resource contracts. Larger or different workloads can motivate a separate design.

## Runtime comparison

The preserved intermediate runtime had the earlier 2.8.7 fixes, a five-workspace
cap and a 32 MiB code budget. Its source digest is
`304dd66e4f3d84119fb72504e231a952bfb52dcbae7a7f5602a0316f39719f40`.
The measured runtime checkpoint, before the final adapter-ownership correction, is
`4552712439682a992711ba67fae829d7bc221d3754005817bdf86c641f373278`.
These are SHA-256 digests of sorted source paths and content hashes, as recorded
by `code-efficiency-bench.ts`. Earlier comparisons against commit `e705db7` remain
in the linked intermediate report; the intermediate snapshot is not a release.

Twenty samples per mode, alternating runtimes, two warmups; restart modes launch
fresh child processes. Each batch queries all 13 families. Public batches also
read one returned resource per family through serialized MCP, including telemetry.
OS filesystem caches are warm. Timing is per batch, not per query or completed
model task. Identical result/diagnostic digests exclude only request correlation
IDs and the server version in MCP envelope metadata; transport byte counts retain
the actual messages.

| 10,362 fragments | Intermediate p50/p95, ms | Measured checkpoint p50/p95, ms |
| --- | ---: | ---: |
| Application-cold internal batch | 301.15 / 314.78 | 69.71 / 75.24 |
| Warm internal batch | 253.70 / 257.19 | 5.92 / 7.10 |
| Eight concurrent internal batches | 308.82 / 315.24 | 75.52 / 81.02 |
| Application-cold MCP batch | 567.17 / 580.55 | 87.96 / 95.47 |
| Warm MCP batch | 516.35 / 522.37 | 25.91 / 28.31 |
| Internal batch after process restart | 362.81 / 366.96 | 121.48 / 123.01 |
| MCP batch after process restart | 655.68 / 664.96 | 174.42 / 183.45 |
| Update plus first internal batch | 387.93 / 393.73 | 152.23 / 167.90 |
| Update plus first MCP batch | 652.67 / 670.10 | 175.36 / 183.29 |

Restart rows time work inside the child; reports also record process wall time.
Both snapshots contain 8,474,301 bytes. Estimated admission is 45,573,910 bytes in
the release, explaining why it benefits from the new budget. The intermediate
runtime retains only derived structures. At 1,056 fragments both already admit the
snapshot: warm MCP p50 is 21.04 → 20.43 ms and p95 is 22.13 → 23.05 ms. Small-case
variability is retained rather than presented as a universal speedup.

The separate application-cold acceptance compares actual v2.8.0 (`34d1684`) and
the final release on one authorized real corpus, with temporary indexes and 100 alternating
samples. The first shared reviewed oracle ID determines the timed target.

| Metric | v2.8.0 | Release |
| --- | ---: | ---: |
| First query p50, ms | 83.533 | 81.797 |
| First query p95, ms | 87.977 | 87.623 |
| Reviewed positive edges | 5/17 | 17/17 |

This meets the local non-regression criterion; the latency difference is small.
An earlier 30-sample candidate failed p95 (90.602 → 91.567 ms) and prompted
declared-resolution reuse. After the adapter-ownership fix, a 40-sample check
failed p50/p95 (86.772/89.697 → 87.326/90.989 ms). Normalizing paths once and avoiding
flattened import arrays improved p95; its 40-sample check still failed p50 by
0.033 ms (84.206 → 84.238). The final single-pass inventory construction is then
checked on 100 samples above. These failures remain in the experimental record;
the gate still requires both p50 and p95 no worse than the paired baseline.
These selected edges do not establish precision across the entire real repository.

## Deterministic acceptance

- 521 tests across 83 files, TypeScript checks and repository hygiene pass.
- All 18 quality gates pass without lowering their thresholds.
- All 1,600 text/symbol comparisons pass against the preserved T1–T6 runtime.
- The reviewed real TypeScript import and negative control pass, scoped and
  unscoped; the baseline's missing import remains a reported failure.
- All 88 documentary combinations (22 English/Italian tasks, six intents,
  full/compact context and page/passage reads) pass. Forty old whole-page resource
  failures remain failures in the baseline. Evidence and uncertainty are preserved.
- Code-context warm p95 overhead is 0.857, 1.296, 1.414 and 2.524 ms across the four
  scale/budget combinations, below the unchanged 5 ms gate.
- Ollama embedding preparation finds every expected source in all 48 combinations
  of 24 tasks and two context modes. The evaluator requires semantic coverage to
  be active and cannot silently count lexical fallback as semantic success.
- Project precision fixture v2 updates source facts for the new memory defaults
  and declared imports, preserving expected pages, gap labels and thresholds.
  Evaluation coverage recall is 1.0, shown recall 0.923 and shown precision 0.706;
  there are no silent misses, false gaps or passage errors. The one-page display
  budget deliberately cannot show both conflicting sources and reports that gap.
- Project knowledge has 29 fresh current code anchors on eight pages, with all
  resources read successfully. The 183 other drift observations remain in history
  for review; they are not relabeled as fresh or deleted to improve this result.

## Local Ollama handoff evaluation

The fixture has 24 authored tasks, six intents, four synthetic domains and both
English and Italian, with 12 development and 12 evaluation cases. All 24 pass
source preparation in both semantic context modes. The main live evaluation uses
the 12 evaluation tasks, two repetitions, alternating mode order. These are
structured handoff artifacts, not general programming tasks or production traffic.
The separate six-call development pilot passed; its 22,447 chat tokens remain
experimental cost and are excluded from the paired evaluation comparison.

Ollama version is 0.34.2. The installed chat model is `qwen3.8:27b` (digest
`22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643`),
with temperature 0, context 16,384, output limit 1,600, `think=false` and seeds
42/43. Embeddings use installed `qwen3-embedding:0.6b`, 1,024 dimensions (digest
`ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`).
No model was downloaded. The fixed client calls `knowledge_context`, then reads
every selected distinct resource and exposes both MCP content channels plus the
resource responses. It does not model an autonomous client's routing decisions.

The first pass succeeds on 20/24 runs in each mode. The same two cases fail twice
in both modes: the Lumen review uses a prefixed field name; the Porto modification
blocks a supported handoff because of an unrelated timeout conflict. The full
mode also adds an unrequested fact with an unsupported placeholder. These failures
remain failures. There is no new failing case in the compact mode, and all required
sources were retrieved with semantic coverage active.

An explicit client contract constrains the keys to those named in the visible
objective and scopes handoff readiness to those requested fields. It supplies no
expected values, statuses or citations and leaves the frozen oracle unchanged.
All eight follow-up runs pass. Thus each mode completes 24/24 task/repetition
pairs after four extra calls, with the original failures included in its costs.
The contract correction was informed by evaluation failures: these follow-ups are
repair checks, not a fresh held-out evaluation of that prompt. `--client-contract=legacy`
reproduces the original contract; the explicit contract is the evaluator default.

| Main evaluation including failed attempts and follow-ups | Previous/full | Current/compact |
| --- | ---: | ---: |
| Chat calls | 28 | 28 |
| Input tokens, including cached subset | 128,111 | 76,662 |
| Cached input subset reported by provider | 11,002 | 6,310 |
| Output tokens | 5,545 | 5,341 |
| Total chat tokens | 133,656 | 82,003 |
| Embedding input tokens, separate tokenizer | 6,175 | 6,175 |
| Embedding requests | 45 | 45 |
| MCP requests / resource reads | 184 / 156 | 184 / 156 |
| Total observed task time, seconds | 1,641.22 | 1,127.89 |
| Completed-pair chat tokens p50 / p95 | 4,808 / 11,592 | 2,954 / 6,970 |

Chat tokens fall by 38.65% for this client comparison, including its extra calls;
no completed pair or intent increases its total. The existing full/compact choice
predates 2.8.7: this validates reuse of that interface, not a token saving caused by
the new cache. The model dominates elapsed time; the runtime benchmark's speedup
must not be applied to whole model tasks. Timing is observed local wall time, not
an isolated model-performance claim.

| Intent, four task/repetition pairs including repairs | Previous/full tokens | Current/compact tokens |
| --- | ---: | ---: |
| Understand | 17,671 | 10,957 |
| Implement | 13,229 | 8,006 |
| Modify | 34,713 | 20,734 |
| Debug | 19,332 | 12,002 |
| Review | 30,609 | 18,932 |
| Document | 18,102 | 11,372 |

The following are cumulative prefixes of the observed paired experiment, with
repairs charged to their original task. They are not separately rerun sessions or
20 independent cases. Initial source-file writes cost 4.53/4.86 ms; first retrieval
includes initial indexing and embeddings. A neutral page edit before task six
costs 0.72/1.66 ms plus the subsequent reindex/embedding work already in task time.
The repair run starts fresh and its repeated embedding preparation is charged too;
its source-file writes take another 4.66/8.53 ms, below table rounding.
Fixture pages were already authored: setup and maintenance have zero generative
calls here. Real wiki authoring costs and their break-even point are unmeasured.

| Observed prefix | Calls per mode | Full chat tokens | Compact chat tokens | Embedding tokens per mode | Full / compact seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 task | 1 | 4,390 | 2,725 | 1,595 | 44.67 / 31.27 |
| 5 tasks | 6 | 30,255 | 18,330 | 4,216 | 364.23 / 236.42 |
| 20 tasks | 23 | 107,633 | 65,959 | 6,043 | 1,334.50 / 910.46 |

Counts use actual `prompt_eval_count + eval_count`; cached tokens are a subset,
not an extra charge, following [Ollama's usage contract](https://github.com/ollama/ollama/blob/main/docs/api/usage.mdx).
All chat and embedding input counters were available. Separate hidden reasoning
usage is not claimed. MCP byte counts are not added to model tokens. Explicitly
archived facts test stale handling here; actual source-drift flags are exercised
in the separate deterministic replay. These results do not establish quality for
other models, autonomous clients or long production sessions.


### Direct-source comparison

Six cases selected in advance cover one case per intent: Lumen understand/modify/
debug and Porto implement/review/document. The direct client reads all 34 source
pages from disk, without relevance preselection, using the same model and original
client contract. It passes 5/6 initially; the Porto review prefixes its field name
while preserving the conflicting values and citations. Its one explicit-contract
follow-up passes and costs another 3,380 chat tokens. The first failure is retained.
The matched first repetition of both wiki modes passes 6/6 without repairs.

| Six matched task completions, including required repairs | Previous/full | Current/compact | Direct sources |
| --- | ---: | ---: | ---: |
| Chat calls | 6 | 6 | 7 |
| Chat tokens | 26,265 | 16,210 | 23,533 |
| Embedding input tokens, separate tokenizer | 2,606 | 2,606 | 0 |
| First-attempt successes | 6/6 | 6/6 | 5/6 |

Direct first attempts use 20,153 chat tokens. Reading this small corpus directly
costs less than full MCP exposure; compact MCP costs less in this selected subset,
even before direct's repair. One repetition on six cases does not establish a
universal advantage or a real wiki-authoring break-even point. All 69 live calls
in this work (six pilot, 48 evaluation, eight evaluation repairs, six direct and
one direct repair) consumed 261,639 chat tokens in total; experimental work is not
presented as free or as ordinary per-session product cost.

## Distribution checks

A clean `npm ci` installs the 2.8.7 lockfile, including Hono 4.13.8. The full
verification, all 18 deterministic gates, 1,600 parity comparisons, documentary
replay, project-precision evaluation and release metadata verification pass on
that installation. The final context overhead p95 remains below 5 ms in all four
cases. No gate threshold or expected quality outcome was relaxed.

The installed npm tarball passes stdio, HTTP and desktop smoke checks: 978,505
compressed bytes, 3,689,415 unpacked bytes and 619 package files. Runtime dependency
audit reports zero vulnerabilities; 70 registry signatures and 18 attestations
verify. Package, lockfile, server metadata, product identity, desktop bundle
manifest, changelog and README pins all identify version 2.8.7.

## Final runtime confirmation

The final source digest is `e3921d53ca1215b67182d2eaa9ee99412819c31326306dd7f0af10122fb78508` (152 TypeScript source files).
After the path/inventory refinements, ten alternating samples per mode at both
1,056 and 10,362 fragments preserve exact result/diagnostic digests and all 13
positive/negative family oracles. This final check covers application-cold, warm,
concurrent and serialized MCP warm batches. Earlier 20-sample update/restart and
five-project memory tables above retain their explicitly identified checkpoint;
they are not relabeled as measurements of this last source digest.

| Final check, 10,362 fragments | Intermediate p50 / p95, ms | Final p50 / p95, ms |
| --- | ---: | ---: |
| Application-cold internal batch | 306.990 / 314.471 | 72.972 / 79.785 |
| Warm internal batch | 251.105 / 253.593 | 5.919 / 7.348 |
| Eight concurrent internal batches | 309.495 / 321.373 | 72.895 / 74.860 |
| Warm MCP batch | 514.172 / 522.770 | 23.007 / 25.626 |

At 1,056 fragments, warm MCP p50/p95 is 19.144/21.005 → 19.228/22.205 ms. Both versions already admit this smaller snapshot. The final 100-sample real-corpus cold gate above and the final deterministic/distribution checks also use this source digest.
