# Memory evolution (2.9.0)

## Durable semantic retrieval

The wiki Markdown remains authoritative. KnowledgeRail returns knowledge and evidence;
it does not generate an LLM answer. Ollama, when configured, computes embeddings for
document passages and search/coverage queries. Semantic retrieval now always saves work in
`wiki/.knowledge-rail/semantic-index.json` (v2 metadata), `semantic-vectors.bin`
(vectors and LSH signatures), and `semantic-journal.bin` (CRC-protected batch records).
An unchanged page needs no document embedding after restart. Changing a page
regenerates **every passage of that page**. Changing the provider identity, model,
model version, dimensions or query prefix regenerates **the entire corpus**. Set a
model version when replacing weights behind an unchanged model name.

The snapshot records its provider, engine, dtype and binary checksum. Compatible v1
JSON indexes migrate without embedding again. Invalid snapshots rebuild from canonical
pages; a truncated journal replays only complete records. Batch durability includes
partly completed large pages. Separate processes coordinate through the existing
workspace checkpoint lock. The journal compacts after a successful build/checkpoint,
or when it exceeds 25% of vector-snapshot size with a 16 MiB floor. Clients configured with different providers will invalidate
each other's semantic index; use one provider configuration per workspace.

Vectors are held as shared typed arrays. The semantic index retains IDs and headings,
not passage bodies; selected results are hydrated from canonical Markdown after checking
the indexed page fingerprint. Snapshot metadata likewise omits duplicate passage bodies. `KNOWLEDGE_RAIL_SEMANTIC_DTYPE=i8` is the
default: symmetric per-vector quantization without a dequantized matrix. Set `f32`
to retain Float32. On the current 16-query fixture, Qwen int8 moved one raw cosine
score across 0.72 (0.719865 → 0.720169), but the complete ANN/fusion/coverage pipeline
returned identical selected pages and coverage judgments for all 16 queries with
Qwen and both static models. This supports the measured tradeoff, not universal
numerical equivalence. Changing dtype invalidates an incompatible v2 snapshot and
rebuilds it; compatible legacy v1 vectors can migrate directly. LSH parameters are unchanged. A
seed/engine change rebuilds signatures without regenerating document embeddings;
queries use exact search while signatures are unavailable.

At workspace activation or the first query, missing/changed pages build in background,
in batches of at most 64 passages. Requested pages take precedence over the remaining
queue, followed by decision/rule pages, incoming graph degree and deterministic path order. Each provider has
one in-flight request; queued queries precede subsequent background batches, with a
maximum burst of eight queries when a background batch is waiting. This prevents a
continuous query stream from starving the build. A request
cannot preempt an already running provider batch. Inputs retain the existing 64,000
character ceiling; no unvalidated truncation has been introduced.

A context request waits up to 1,000 ms for prioritized pages. That is the page-priority
wait budget, **not an end-to-end provider timeout**: loading, an in-flight provider
batch, query embedding and coverage have their own costs. Provider requests retain the
configured timeout. The index exposes `ready`, `building`, `degraded` or `absent`,
with completed/total/pending pages. During `building`, coverage is `semantic-partial`:
current vectors participate where available; remaining pages retain lexical coverage.
Transient ranking can favor already embedded pages, and the response reports partial
coverage. Missing configuration uses lexical retrieval; provider failures add a warning.

Page writes, edits and ingestion invalidate touched pages immediately and prioritize
regeneration. Canonical writes succeed even when the embedding provider fails; the
response reports pending/degraded work and later requests retry. Manual Markdown edits
are reconciled by the lexical generation. `knowledge_admin action=status` reports
semantic state; `action=checkpoint` compacts the journal. `force=true` clears the
semantic generation and starts rebuilding it in background.

## Optional static embeddings

`model2vec` averages a pinned local token-vector table using the official JavaScript
Hugging Face tokenizer. It runs without a model server or neural inference. Setup is
explicit; normal retrieval never downloads model assets or changes configuration.

```json
{"action":"semantic_setup","options":{"model":"potion-multilingual-128M"},"setup_mode":"preview"}
```

Use `setup_mode=apply` to download and verify the immutable assets inside the selected
wiki's `.knowledge-rail/models/`. Supported models are `potion-retrieval-32M` (512
dimensions) and `potion-multilingual-128M` (256). The setup response supplies the
absolute directory for the following environment configuration:

```text
KNOWLEDGE_RAIL_EMBEDDING_PROVIDER=static
KNOWLEDGE_RAIL_EMBEDDING_MODEL=potion-multilingual-128M
KNOWLEDGE_RAIL_STATIC_MODEL_DIR=<directory returned by semantic_setup>
KNOWLEDGE_RAIL_STATIC_MEMORY_MB=256
```

All four asset hashes and the model revision participate in provider identity. A
provider switch follows the same full-regeneration lifecycle as an HTTP model change.
The matrix cache budget defaults to 256 MiB per provider/workspace. The English matrix
is about 123 MiB and the multilingual matrix about 489 MiB. Above the budget, the
provider reads needed rows from disk without retaining the matrix; tokenizer memory
is additional. The evaluation used a 600 MiB matrix budget: its warm throughput does
not describe the default uncached multilingual path. Unknown-only input produces an
explicit provider failure and lexical fallback, never a fabricated vector.

The static provider remains optional. Its cosine distribution is model-specific;
unchanged coverage thresholds are not a claim that all models are calibrated equally.

## Usage, repository maps and stable context

`usage-ledger.jsonl` retains bounded normalized terms and disclosed/materialized
resource identifiers, gap/fallback flags and explicitly reported outcomes. It never
stores the raw task string. The file is bounded to 2 MiB/10,000 events and 180 days;
read-only workspace bindings do not record usage. Materialization must follow disclosure
in the same session/binding within 15 minutes. Repeated reads do not count twice.
Fallbacks and failed outcomes remove utility. The latest disclosure is the correlation
scope; this is a bounded local observation, not a full task trace.

Utility decays with a 90-day half-life and can boost a candidate by at most 15%.
Reranking operates inside the existing retrieval pool, preserving the leading lexical
candidate and exact title/path matches. `KNOWLEDGE_RAIL_USAGE_RANKING=0` disables the
boost for comparison while leaving observations available.

```json
{"action":"usage","options":{"action":"status"}}
{"action":"usage","options":{"action":"reset"}}
{"action":"usage","options":{"action":"outcome","outcome":"failed"}}
```

### Native usage audit

`knowledge_admin` also exposes a read-only audit of opt-in, project-local native
hook observations:

```json
{"action":"usage","options":{"action":"audit","days":7,"max_turns":20}}
```

`client` optionally filters `codex` or `claude`. `days` is bounded to 1..30 and
`max_turns` to 1..100. The observer stores metadata in the project root's
`.knowledge-rail/usage-audit/`, separately from the wiki usage ledger. The existing
`usage reset` affects the ranking ledger only. No new top-level tool is added.

Native SessionStart/UserPromptSubmit (and subagent start) establish observation
boundaries; PreToolUse records starts and PostToolUse records completions. The local
hook bridge calls `observeUsage` from `dist/runtime/usage-observer.js`, passing a
classified tool invocation. This observer is opt-in; the standard client setup
currently installs awareness/drift hooks and does not install this custom collector.

The audit correlates client, session, actor, turn and call IDs. Codex native turn IDs
are preferred; without them an observed prompt boundary is used. These are not
semantic task IDs. A successful knowledge retrieval must complete **before** a text
search starts. Admin/status/audit calls are excluded. Coverage and successful reads
are reported separately, so an insufficient retrieval is not presented as complete
evidence. Reads cover observed `knowledge_page/code read` calls; direct MCP
`resources/read` outside those hooks is not attributed.

Verdicts are `knowledge_before_search`, `search_without_prior_knowledge`,
`not_verifiable`, or `no_text_search`. The second means no prior successful retrieval
was observed within that turn; it does not establish a policy violation (context may
be reused, and shell searches include valid checks and output filters). Missing
boundaries, unmatched search events, opaque results, tied timestamps, malformed data
and conflicting duplicates cannot produce a positive attestation. No observation
store returns `not_observed`, not proof of zero use. The audit does not assess
comprehension or provide tamper-proof certification.

The collector hashes IDs and resource URIs, retains no prompt, command, content or
output, caps daily files at 5 MiB and prunes files older than 30 days at session start.
Reads are bounded to 20 MiB/30,000 events with explicit incomplete results. Local
rules, hook definitions and observation files remain ignored by Git. Adding a
PreToolUse definition requires the client's normal review/trust flow; the observer
never grants permission or blocks execution.

Code-related task context may include `repositoryMap`: declarations, paths, known
manifest components, and bounded call/import relations expanded to depth two. It
contains no function bodies, performs no build, and shares the existing token budget.
`include_repository_map=false` disables it. Lexical graph edges are navigation
candidates, not proof of execution. The map is fixed-bound (`widenable=false`), and
reports truncation. Response serialization puts stable evidence before task details;
this increases reusable byte prefixes without claiming measured model cache hits.

## Durable claims and maintenance

Claims accept optional UTC ISO `valid_from`/`valid_until` (exclusive end), `provenance`
references (`commit` with a full hash or `pull_request` with an HTTPS URL), and
`verified_by` test resource URIs. Source document and segment provenance remain
mandatory. A supersession closes the previous claim at the replacement's `valid_from`
or recording time. Existing claims default to validity from `createdAt`.

`knowledge_context` accepts `as_of`. Historical lookup returns only matching claims
valid at that instant in `temporal.claims`, with source and interval. It does not
pretend unversioned page prose or today's code establishes past facts. Page links
open the current page; the historical text is in the response. Contradiction status
is current ledger status, not reconstructed transaction history. No evidence at the
requested time is an explicit gap.

Test references must identify indexed test fragments. Synthesis labels them
“Verified by” with an explicit qualification: an anchor is evidence of test content,
not an execution result. Drift checks both implementation and test anchors.

Git anchors capture a revision only when the file matches that commit. Drift maps
an untouched range through diff hunks and verifies its hash at the new location.
`relocated` preserves the old anchor in history and updates the current anchor; it
is not stale. Changed, missing or unresolvable code retains the existing conservative
verdicts. Renames and arbitrary moved/deleted hunks are not guessed. Without Git the
original hash/range behavior applies. `knowledge_admin action=drift dry_run=true`
and CLI `--no-ledger` avoid persistence; a normal drift call may update claim anchors
and therefore requires write scope.

```json
{"action":"consolidate","setup_mode":"preview","options":{"days":90}}
{"action":"consolidate","setup_mode":"apply","options":{"days":90,"proposals":["Review the repeated credit policy as a concept."]}}
```

Consolidation links identical active claims to one canonical identity while retaining
all original claim IDs and source provenance. Different targets, validity, origins
or anchors are not merged. It reports before/after logical counts, pages with no
observed disclosure in the retained usage window, and repeated concept candidates.
Absence from the ledger does not prove a page was never used. Apply saves a bounded
review page; it does not delete pages, synthesize concepts, or apply supplied
proposals. Proposals can be authored by a caller/model, but KnowledgeRail makes no
generative call during consolidation.

## Measured limits and reproduction

Measurements are local development results, not production traffic:

- **Real Ollama lifecycle:** identical temporary copies of this project's actual
  wiki (8 pages, 376 passages), `qwen3-embedding:0.6b` version `ac6da0dfba84`, 1024
  dimensions, model loaded after an explicitly measured 50 ms warmup. Three fresh
  MCP processes per version, alternating order, all document/query/coverage requests
  forwarded to Ollama without caching or substituting vectors: startup through the
  first context response was 24.85 s on 2.8.7, 0.58 s with f32 and 0.60 s with i8.
  The old context path disabled semantic persistence and embedded all 376 passages
  on each restart; both new variants reused them. All versions computed seven query/
  coverage embeddings per restart and returned identical evidence and coverage.
  These are measurements on 376 real passages, not on 10k or 50k.
- On a fresh wiki copy with no index, the old version returned full semantic context
  in 21.89 s. New f32/i8 returned **partial** context in 4.35/4.37 s and finished the
  full index in 22.79/22.98 s. At that first response no page was fully embedded;
  selected pages still used lexical coverage under the explicit partial status. The background path does not make initial embedding
  computation disappear. The observed complete-build cost was slightly higher.
  Same-process repeated queries were 57/110/93 ms in single samples; no speedup is
  claimed for that case. The restart gain comes mainly from durable reuse.
- At 10k/50k synthetic 1024-dimensional passages, i8 snapshots plus metadata occupied
  12.55/62.81 MB versus f32 43.27/216.41 MB. Incremental heap + buffers were
  2.18/2.10 KB per passage versus 5.24/5.15 KB; this excludes a separate static-model
  matrix cache. These are storage/memory scaling measurements, not live Ollama timings.
- Float32/1024-dimensional synthetic index, five reloads with warm filesystem cache:
  10k passages median 68 ms; 50k median 357 ms. These are index reloads, not server
  startup. Zero repeated document embeddings; search results preserved across reload.
- At 10k, persisted storage decreased from about 202 MB JSON to 43 MB binary plus
  metadata. Stable incremental heap + buffers were about 5.24 KB/passage at 10k and
  5.15 KB at 50k, including a fixed GC/event-loop settling step in both runtimes.
  At 1k the fixed engine/runtime overhead raises f32 to 6.9 KB/passage, above the
  roadmap's 6 KB target. The default i8 uses 3.78 KB at 1k and meets that target at
  all three measured scales. The previous
  50k JSON snapshot failed with `RangeError: Invalid string length`.
- LSH-only restoration at 1k/10k/50k, median of three runs: saved signatures
  restored in 1.3/13.5/86.3 ms. Missing signatures completed in 81/791/4,000 ms
  in background; changed-seed results were comparable. First exact queries while
  rebuilding took 1.3/10.9/54.1 ms, with zero document embeddings.
- A checkpoint sampled every 5 ms, before creating additional reload instances,
  increased RSS by at most 0.20% over the post-build steady sample in these runs.
  Heap plus ArrayBuffer allocation rose by about 30–50%, reusing already resident
  process memory. This is an RSS observation, not a 20% allocation bound.
- Seven fresh stdio process starts, empty workspace, through `tools/list`: medians
  293 ms before and 299 ms after. There is no demonstrated protocol startup speedup.
- 404 document/domain passages and 20 authored bilingual probes: cached static
  English/multilingual throughput about 1,705/1,169 passages/s; local Qwen HTTP about
  18 passages/s. Expected-document top-1 was 14/20, 20/20 and 18/20, respectively.
  Int8 changed no top-1 result or coverage-threshold decision on those probes.
  These probes include recorded aliases; they are not a broad independent quality claim.
  Static models remain optional; cached multilingual measurements explicitly use a
  600 MiB matrix budget instead of the default 256 MiB uncached row-reading path.
- A separate production comparison on the checked-in semantic fixture uses 16 queries
  and 53 passages (the roadmap's older count of 29 does not match this fixture).
  Its raw Qwen cosine crossing is reported above. Restricting the fixture to each
  page's first passage reduced raw top-five page recall for both static models,
  so all passages remain indexed. A 128-character cap changed two Qwen result lists
  and one coverage result while leaving mean recall unchanged; 512/2,048-character
  caps do not shorten any passage in this small fixture. Longer-input stability
  is assessed separately in the 1,000-passage throughput ablation.
- Throughput on 1,000 distinct real documentation/source excerpts (1.20 million
  characters), including all Ollama calls: batches of 64 at concurrency 1/2/4 took
  54.86/58.34/78.24 seconds; batches of 128 took 96.37/82.70/80.83 seconds. Every
  256-input variant encountered HTTP 400. The default remains 64 with concurrency 1.
  Capping at 512 characters cut the build to 38.64 seconds but retained only 68% of
  the reference top-five results across ten authored probes. A 2,048-character cap
  retained that ranking on these probes but took 79.09 seconds. No smaller cap is
  adopted: this workload does not demonstrate a reliable throughput/quality benefit.
- The deterministic lifecycle gate compares both full and compact context responses
  for every golden query across two reloads, including evidence, gaps and coverage.
  It also completes 1,000 distinct synthetic passages during continuous query traffic.
  These are scheduler/parity checks, not real-provider timing claims.

```sh
node --expose-gc --import tsx benchmarks/semantic-durability-bench.ts --scale=10000 --reloads=5
node --expose-gc --import tsx benchmarks/semantic-durability-bench.ts --dtype=i8 --scale=50000 --reloads=5 --signature-ablation
node --import tsx benchmarks/ollama-lifecycle-bench.ts --live --config=/path/to/.claude.json --baseline=/path/to/2.8.7 --iterations=3
node --import tsx benchmarks/semantic-throughput-bench.ts --live
node --import tsx benchmarks/static-embedding-bench.ts --assets=/tmp/kr-model-eval --download --live
node --import tsx benchmarks/semantic-quantization-eval.ts --assets=/tmp/kr-model-eval --live --truncation
node --expose-gc --import tsx benchmarks/code-context-bench.ts --scales=1000,10000 --iterations=30 --map-ablation
npm run verify
npm run eval:gates
```

Live benchmarks require explicit local provider configuration. Assets are not included
in the package. Raw local reports live under `benchmarks/results/` (ignored by Git).

A separate **diagnostic** MCP restart benchmark includes initialization, tool discovery
and context compilation against a deterministic HTTP fixture. It must not be used
as an estimate of real Ollama end-to-end latency. At 10k persisted f32
passages, the 2.8.7 JSON baseline took 2.47 s median through the first response; the
new format took 0.56 s. At 50k the new format took 1.26 s. All three runs per case
returned the same evidence URI digest, full semantic coverage and zero document
embedding calls. These timings include the server but exclude real embedding
computation by Ollama for search and coverage queries:

```sh
npm run build
node --import tsx benchmarks/semantic-startup-bench.ts --scale=10000 --iterations=3
node --import tsx benchmarks/semantic-startup-bench.ts --scale=50000 --iterations=3
node --import tsx benchmarks/memory-usage-eval.ts
```

The controlled usage ablation uses four fixed candidate pools with separate authored
training/evaluation phrases. Empty-ledger output is identical; eight simulated useful
materializations increase precision/recall at two from 0.5 to 1.0, while five subsequent
fallback observations remove the boost. It measures the production reranker only;
it is not an end-to-end retrieval or live-agent success rate. The map ablation uses
the actual compiler: at 10k fragments its measured incremental p50 was 2.0–4.6 ms
for 2k/4k token budgets. The 4k-budget p95 had an outlier to 16.4 ms; the p50 target
must not be interpreted as a p95 guarantee. Stable serialization increased the common
prefix from 52 bytes to approximately 4.9–10.9 KB for the same project/query with a
changed objective. This is byte-prefix reuse, not measured provider token caching.
