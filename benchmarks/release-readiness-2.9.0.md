# KnowledgeRail 2.9.0 — release validation

Local measurements: 2026-09-22, Apple M4 Max, 36 GiB RAM, macOS arm64,
Node 24.9.0. KnowledgeRail retrieves knowledge; it makes no generative model call.
Ollama supplies document, search-query and coverage embeddings. All live timing
comparisons include those calls, with no cached or substituted provider response.

## Behavior and compatibility

Semantic work is durable by default. A binary snapshot, saved LSH signatures and
CRC-protected batch journal replace the large vector JSON. Compatible legacy data
migrates without embedding again. Changed canonical bytes regenerate every passage
of that page; changed provider/model/version/dimensions/query prefix regenerate the
whole corpus. Interrupted partial pages resume from committed passage IDs. The
existing cross-process checkpoint lock serializes writes and reloads external changes.

Int8 is the default storage dtype, with Float32 available explicitly. Typed vectors
are shared with ANN; the index retains passage IDs and headings instead of duplicate
bodies. Selected text is read from canonical Markdown and checked against the indexed
fingerprint. Missing or incompatible signatures rebuild asynchronously; queries use
exact vector search until they are ready. Initial embedding runs in batches of 64
with visible partial coverage, query priority and a bounded burst of eight waiting
queries before background work advances.

The release also adds optional explicitly installed static embeddings, bounded local
usage observations, task repository maps, deterministic consolidation previews,
hash-verified Git anchor relocation, claim validity and historical lookup, and test
anchors. Static assets are never downloaded by normal retrieval. Existing canonical
Markdown and claim provenance remain authoritative. Details and limits are in the
[memory guide](../docs/guides/memory-evolution.md).

## Validation scope

The original 18 quality gates retain their thresholds. The drift gate additionally
checks five real Git scenarios: insertions/deletions before an unchanged range,
changed range content, invalid original hash and unavailable revision. A nineteenth
gate checks full and compact context payloads for all 16 semantic golden queries
across two reloads, with zero repeated document embeddings. It also exercises partial
readiness and completes 1,000 distinct synthetic passages during continuous queries
without duplicate embeddings. Deterministic provider delays in that gate measure
scheduler behavior, not real model latency.

The real-provider evaluations use the configured Qwen embedding model and both
pinned static providers. The static comparison uses 404 passages and 20 authored
bilingual queries; the separate production ANN/fusion/coverage comparison preserves
the existing 16-query, 53-passage semantic corpus. This is controlled evidence, not
real-user accuracy or a universal calibration guarantee. Quantized cosine values
can cross a threshold near its boundary; the Qwen crossing from 0.719865 to 0.720169
is retained in the report rather than hidden by changing the 0.72 threshold.

## Real Ollama observations

Identical temporary copies of eight actual project pages (376 passages),
`qwen3-embedding:0.6b`, version `ac6da0dfba84`, 1,024 dimensions. The model was
resident after an explicitly timed 50 ms warmup. Three fresh MCP processes per
variant, alternating order; the measured interval includes initialization,
`tools/list`, `knowledge_context`, and every provider request.

| Restart median | 2.8.7 | 2.9.0 f32 | 2.9.0 int8 |
| --- | ---: | ---: | ---: |
| Startup through first context, seconds | 24.853 | 0.579 | 0.598 |
| Document embeddings per restart | 376 | 0 | 0 |
| Search/coverage embeddings per restart | 7 | 7 | 7 |

Evidence digests and full coverage are identical, with no provider errors. The old
context path disabled semantic persistence. The improvement comes from preserving
completed document embeddings, not from faster computation inside Ollama. Earlier
runs on this machine recorded 19.23/0.60/0.58 seconds; these are local observations,
not service latency guarantees or measurements on 10k/50k actual documents.

With no index, full construction took 21.89 seconds before, 22.79/22.98 seconds
after. The new variants returned partial context after 4.35/4.37 seconds, with no
fully embedded page yet and explicit lexical coverage on unfinished pages. The
1,000 ms page-priority wait does not bound the complete provider request. A repeated
query in the same process took 57/110/93 ms in single samples; no speedup is claimed.

On 1,000 distinct real documentation/source excerpts, batch 64 at concurrency 1
was the fastest tested setting (54.86 seconds). Concurrency 2/4 took 58.34/78.24
seconds; batch 128 took 80.83–96.37 seconds. All batch-256 settings encountered
HTTP 400. Capping at 512 characters reduced runtime to 38.64 seconds but retained
only 68% of top-five results on ten authored probes. Capping at 2,048 retained
those results but took 79.09 seconds. The 64,000-character ceiling stays unchanged.
On the short semantic golden fixture, a 128-character cap changed two Qwen result
lists and one coverage result; 512/2,048 shorten none of its passages.

The 20-query static comparison recovered the expected document first for 14/20
English-static, 20/20 multilingual-static and 18/20 Qwen queries. Throughput was
1,705/1,169/18 passages per second. Static timings explicitly use a 600 MiB cache;
the default 256 MiB budget cannot cache the full multilingual table. The sample is
authored and alias-rich; these figures do not establish broad provider superiority.

## Storage and memory scaling

Synthetic 1,024-dimensional vectors, five reloads with warm filesystem cache;
these timings exclude Ollama. Incremental retained heap plus ArrayBuffers uses the
same fixed GC/event-loop settling protocol for both dtypes. Canonical input records
are present before the baseline sample; optional model matrices are excluded.

| Passages | int8 storage, MB | int8 KB/passage | int8 reload, ms | f32 storage, MB | f32 KB/passage | f32 reload, ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.25 | 3.78 | 10.48 | — | — | — |
| 10,000 | 12.55 | 2.18 | 51.68 | 43.27 | 5.24 | 68.13 |
| 50,000 | 62.81 | 2.10 | 270.06 | 216.41 | 5.15 | 357.17 |

Reloaded searches are identical and no documents are re-embedded. The previous JSON
format occupied 201.61 MB at 10k and failed at 50k with `Invalid string length`.

Three LSH restoration runs per mode/scale isolate signature reuse. At 1k/10k/50k,
saved signatures restore in 1.3/13.5/86.3 ms. Missing signatures complete in
81/791/4,000 ms in background; changed seed takes 78/790/4,009 ms. The initial exact
queries while rebuilding take 1.3/10.9/54.1 ms. No provider calls occur in any mode.
These figures do not include a full application startup.

A streamed checkpoint sampled every 5 ms, before creating reload instances, grew
RSS by at most 0.20% over its post-build baseline. Transient heap plus buffers rose
by roughly 30–50%, reusing already resident memory; the RSS result must not be
interpreted as a 20% allocation cap. OS scheduling can miss shorter allocation peaks.

Local release checks passed: all 87 test files, all 19 quality gates, installed-package
stdio/HTTP/desktop smoke tests, zero reported runtime vulnerabilities and verified
registry signatures for all 71 production packages (19 with attestations). The
package smoke recorded about 1.04 MB compressed and 3.97 MB unpacked.

## Reproduction

```sh
npm run verify
npm run eval:gates
npm run package:smoke
npm run audit:runtime
npm run audit:signatures
npm run release:verify -- v2.9.0
node --expose-gc --import tsx benchmarks/semantic-durability-bench.ts --dtype=i8 --scale=50000 --signature-ablation
node --import tsx benchmarks/semantic-throughput-bench.ts --live
node --import tsx benchmarks/static-embedding-bench.ts --assets=/path/to/explicitly-installed-models --live
node --import tsx benchmarks/semantic-quantization-eval.ts --assets=/path/to/explicitly-installed-models --live --truncation
node --import tsx benchmarks/ollama-lifecycle-bench.ts --live --config=/path/to/client-config.json --baseline=/path/to/2.8.7 --iterations=3
```

Local inputs, provider configuration and raw results remain outside Git and npm.
The optional asset benchmarks require explicit setup. Synthetic scaling results
exclude Ollama computation and must not be quoted as full application latency.
