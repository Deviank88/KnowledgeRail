# Graph hub evidence loss — 2026-09-26

**Status, 2026-09-27:** the proposed edge cap has been removed from production
defaults. The results below preserve the original measurement that motivated the
decision. The evaluator now applies that cap explicitly as a rejected comparison,
alongside current production and an explicit uncapped reference.

The edge-work cap can lose decisive graph-only evidence. With the widest tested
budget it recovers **6 of 14** authored targets, while the reference recovers
**12 of 14**. The six additional misses are attributable to the edge cap: **50%
of the evidence recovered by the reference in this deliberately adversarial set**.
This is not an estimate of production query failure or final answer accuracy.

The separate indexed extraction of edges between already-selected nodes is exact:
all 28 paired case/stage comparisons preserve every such edge. That optimization
does not cause the evidence loss measured here.

## Method

- [Fixture](fixtures/graph-hub-quality.json), version 1, frozen before measurement.
  SHA-256: `cf54f460a61e35ac4503276e639fea791300b897a99c1576f0ad0a5636137fbf`.
- [Evaluator](graph-hub-quality-eval.ts) and [raw results](graph-hub-quality-2.9.2.json).
- 14 authored topologies, each with one explicitly identified relevant target;
  seven stress cases and seven controls. Targets are never inferred from runtime
  output. The target summary is a fixed release/lease rule; unrelated nodes are decoys.
- Compare the then-proposed production default edge cap against `maxEdgeWork=Infinity` while
  retaining identical seeds, seed scores, hub penalty, depth, beam width, visited
  node limit and emitted node limit. The reference is unlimited in edge work only;
  it is not an exhaustive graph oracle.
- Initial graph budget: 24 emitted nodes, depth 1, beam 16, 48 visited nodes,
  3,072 neighbor entries. Wide budget: 96 emitted nodes, depth 3, beam 64,
  192 visited nodes, 12,288 neighbor entries. These match the initial and widest
  graph budgets for default retrieval with eight results.
- Stages are run independently. This does not test whether the full hybrid
  pipeline would choose to widen or stop earlier. Lexical search, embeddings,
  passage selection, context truncation and LLM answers are not executed here.
- One warm-up per variant, then five timed repetitions with alternating order.
  Runtime construction, fixture building and oracle assertions are outside timing.
- Node 24.21.0, Linux x64, AMD Ryzen 9 5950X. Timings are diagnostic and have no
  acceptance threshold. Source digests are recorded in the JSON artifact.

Run:

```bash
npm run eval:graph-hubs -- --iterations=5 --json=/tmp/graph-hub-quality.json
```

## Results

| Stage | Relevant targets | With edge cap | Reference | Additional misses from cap | Missed by both |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial | 14 | 5 | 11 | 6 | 3 |
| Wide | 14 | 6 | 12 | 6 | 2 |

At the wide stage, the stress group recovers 1/7 with the cap and 7/7 in the
reference. Controls recover 5/7 in both: the two failures intentionally isolate
beam truncation and a disconnected target, so neither is charged to the edge cap.

| Case | Decoys | Wide: cap / reference | Interpretation |
| --- | ---: | --- | --- |
| Small, early target | 1,000 | found / found | Budget does not bind |
| Small, late target | 1,000 | found / found | Ordering alone is harmless below the cap |
| Medium, late target | 6,000 | found / found | Wider budget recovers an initial-stage miss |
| Large, early target | 16,000 | found / found | Cap binds after finding the evidence |
| Large, late target | 16,000 | missed / found | Late outgoing neighbor is never examined |
| Large, incoming late target | 16,000 | missed / found | Same loss for incoming relationships |
| Request sibling, late target | 16,000 | missed / found | Compact request hub does not avoid the cap |
| Second seed starvation | 16,000 | missed / found | First hub consumes the shared budget |
| Late two-hop target | 16,000 | missed / found | Unexamined bridge hides downstream evidence |
| Very large, late target | 100,000 | missed / found | Wider default budget still cannot reach target |
| High-priority relation, late ID | 16,000 | found / found | Relation ordering brings the target forward |
| Target provided as a seed | 16,000 | found / found | Independent discovery protects this target |
| Equal-degree late target | 16,000 | missed / missed | Beam truncation already loses the target |
| Disconnected target | 1,000 | missed / missed | Neither traversal can reach the target |

For the 100,000-decoy late-target case, median traversal time is 9.265 ms with
the cap and 86.942 ms in the reference. The faster result omits the relevant target;
this speedup therefore cannot be described as a quality-preserving improvement.

## Why previous hub benchmarks did not expose this

The earlier performance fixtures used interchangeable neighbors and compared emitted
node sets, without marking a decisive late neighbor. Their identical results were
correct for those fixtures but did not establish preserved relevant-evidence recall.

The production adjacency order prioritizes relationship weight/type and then node
ID. Final propagated scores also apply a penalty based on the destination node's
degree. In the new stress cases, decoys have extra metadata links while the late
target has lower degree. The reference therefore ranks the late target above the
decoys, but the capped scan never reaches it. The two-hop case applies this to the
bridge. The competing-seed case isolates exhaustion of a shared budget before a
second relevant seed can expand.

## Consequences

Keep the exact indexed result-edge extraction. Do not use the earlier performance
benchmark or passing general quality gates as evidence that the traversal cap is
lossless. Existing `edgeBudgetExhausted` diagnostics remain relevant: a sufficient
coverage label does not prove that every useful graph branch was explored.

Potential changes to evaluate against this frozen fixture include sharing scan
work fairly among seeds, retaining traversal continuations instead of repeatedly
scanning the same prefix, and prioritizing neighbors with indexes that reflect
their propagated scores. Raising the cap alone moves the boundary and does not
eliminate late-target losses. Any change also needs ordinary-corpus regression
and latency checks; these stress-case frequencies cannot serve as production weights.

No retrieval runtime behavior or quality threshold was changed for the original measurement.

## Follow-up: cap removed from production — 2026-09-27

Production now omits the edge-work limit. The explicit internal override remains
only for diagnostic comparisons; retrieval callers do not set it. Lazy neighbor
merging and the exact indexed extraction of result edges are retained.

The same frozen fixture was rerun with five repetitions per variant, rotating the
order of production, explicitly capped and explicitly uncapped traversal. See
the [follow-up raw results](graph-hub-quality-2.9.2-uncapped.json), which record
source hashes and the unchanged fixture hash.

| Stage | Rejected cap | Current production | Explicit uncapped reference | Additional misses in production |
| --- | ---: | ---: | ---: | ---: |
| Initial | 5/14 | 11/14 | 11/14 | 0 |
| Wide | 6/14 | 12/14 | 12/14 | 0 |

Production matches the reference's ordered nodes and traversal statistics in all
28 case/stage comparisons, with no exhausted edge budget. At the wide stage it
recovers all seven stress targets. All three variants preserve every edge between
their selected nodes. The two remaining wide-stage misses are the beam-loss and
disconnected controls; removing the edge cap does not make traversal exhaustive.

For the wide 100,000-decoy case, production's median is 71.617 ms with the target
recovered; the rejected cap takes 8.688 ms and misses it. These synthetic timings
are a cost illustration, not a production latency estimate.

Depth, beam, visited-node and emitted-node limits still apply to each request.
Agents can issue focused queries, increase `max_nodes`/`max_depth` in
`knowledge_context mode="graph"`, and read the resulting page resources. Existing
truncation warnings remain important when deciding whether to continue searching.
