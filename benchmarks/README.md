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

The gate pins both fixtures and both budgets. It requires final recall at least equal to Milestone A, zero evidence lost after widening, a majority of easy cases at W0, automatic widening for the difficult cases, per-attempt token/evidence/visited-node budget compliance and no full-graph scan.

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

`npm run eval:coverage` reports GAP precision and silent-miss for the pinned 22-case coverage fixture. The same fixture is enforced by `eval:semantic:gate`, which requires lexical coverage to improve over the reproduced 2.0.5 exact-match path, semantic coverage to improve further, and both tiers to retain zero silent misses.

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
