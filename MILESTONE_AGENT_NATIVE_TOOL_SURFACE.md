# Milestone — Agent-Native Tool Surface

Status: implemented and locally release-ready; pull-request CI remains required.

## Objective

Make KnowledgeRail directly usable by agents with different capability levels. An agent must be able to start from a normal task, select one coherent domain, receive bounded evidence, and follow the next valid operation without knowing KnowledgeRail's internal pipeline or maintaining menu state.

The target is not merely a smaller tool count. Consolidation is accepted only when retrieval accuracy, provenance, coverage enforcement, document contracts, migration safety, and operational portability remain intact.

## Normative public surface

The server MUST advertise exactly these eight tool names in both modern and legacy wire sessions:

| Tool | Responsibility |
| --- | --- |
| `knowledge_context` | Bounded task context and explicit diagnostic search/graph modes. |
| `knowledge_page` | Canonical page CRUD and durable log append. |
| `knowledge_files` | Controlled file list/read/normalization. |
| `knowledge_ingest` | Source/report ingestion, Evidence IR orchestration, coverage, and recovery state. |
| `knowledge_code` | Deterministic code index, lookup, resources, and fallback telemetry. |
| `knowledge_document_context` | Typed document planning and section evidence packs. |
| `knowledge_document` | Deliverable write, review, and export. |
| `knowledge_admin` | Initialization, lint, and conservative data migration. |

`knowledge_menu`, historical `wiki_*` tools, and one-tool-per-operation aliases MUST NOT appear in `tools/list`. Compatibility with 2025-era MCP clients is a wire/workspace concern only and MUST NOT change the public tool names. Existing v1/v2/v3 data migration remains supported and is not protocol legacy.

## Agent guidance contract

- Normal project tasks SHOULD start with `knowledge_context mode="task"` and a concrete objective.
- Every completed public operation MUST return a machine-readable `state` and at most one `nextAction`.
- `nextAction` MUST identify the tool, optional action, required arguments, and safe suggested arguments when known.
- Invalid action-specific argument combinations MUST be rejected before an operational handler can mutate state.
- Tool-level annotations MUST remain conservative where read and write actions share one tool.
- Compact task context MUST be the default and MUST preserve the evidence pointers and knowledge gaps of the full response.
- Resource bodies MUST remain progressively disclosed through `resources/read` or the bounded compatibility read action.

## Safety-critical orchestration

`knowledge_ingest action="apply_claims"` owns the Evidence IR sequence: durable claim recording, deterministic linking, synthesis planning, validation, canonical mutation, index refresh, and coverage reconciliation. `record_segment`, `source_status`, and `evidence_status` remain separate so an agent never has to infer an operation from optional arguments. An agent MUST NOT be required to discover or call record/link/synthesis implementation steps individually.

A failed link or synthesis may leave durable, retryable IR state, but MUST NOT silently mark the segment represented or permit finalization. Manual segment classification is restricted to allowed non-represented states and requires a reason. Integrated, duplicate, and contradicted states remain derived from Evidence IR.

Document export MUST re-run the typed review contract. Migration apply MUST remain preceded by an explicit plan in returned guidance and followed by lint. Existing lower-level services may remain internal adapters only when they are not advertised and preserve the established regression behavior.

## Acceptance gates

The milestone is release-ready only when all existing CI gates remain unchanged and the new tool-surface gate proves:

- exactly eight public tools and zero menu/historical aliases;
- at least 66% tool-count reduction from the accepted 24-tool surface;
- serialized modern tool array no larger than 14,000 bytes and 4,700 heuristic tokens;
- at least 25% catalog-byte reduction from the measured 19,926-byte baseline;
- at least 94% deterministic catalog-affordance accuracy on 31 routing goldens;
- 100% rejection of the pinned invalid action calls;
- 100% completion of five real MCP workflow traces;
- compact/full evidence and gap parity;
- unchanged retrieval, Evidence IR, migration, document, security, and portability gates.

Deterministic affordance tests are not a substitute for real-model evaluation. Before claiming model-specific improvement, compare the old and new surfaces on representative tasks with at least one frontier agent and one less capable agent, recording tool choice, action choice, retries, workflow completion, result correctness, latency, and tool-catalog/context consumption.

## Measured local result

The accepted local evaluation currently reports:

- tools: `24 → 8` (`66.67%` reduction);
- tool-array catalog: `19,926 → 13,942` bytes (`30.03%` reduction);
- complete `tools/list` result: `26,080 → 14,105` bytes (`45.92%` reduction);
- catalog token proxy: `4,648` (`tool-array UTF-8 bytes / 3`);
- routing goldens: `31/31`;
- invalid calls rejected: `5/5`;
- workflow traces completed: `5/5`;
- menu routing calls saved across those traces: `15/15` (`100%`);
- compact/full evidence parity: `true`;
- compact/full gap parity: `true`.

These values MUST be refreshed in the pull request after the final regression run.

## Provider smoke validation

These are isolated usability smokes, not an old/new provider A/B and therefore do not claim model-specific improvement. Both runs used Claude Code `2.1.226`, disabled all built-in tools, connected only the eight KnowledgeRail tools to the same lease fixture, and required evidence paths plus explicit unknowns.

- Claude Opus 5, `xhigh`: selected task context without a menu, materialized `4/4` pages, produced the correct lease renewal/expiry/fencing explanation, and retained stale/missing evidence warnings. The pre-final run used 12 turns and cost `$0.3123` (`8,188` cache-creation, `104,271` cache-read, `7,099` output tokens). It exposed one redundant semantic-gap widening; the final implementation removes that `nextAction` once no evidence is budget-omitted.
- Claude Haiku 4.5, `high`, final implementation: completed in 8 turns and cost `$0.0509` (`14,976` cache-creation, `37,667` cache-read, `3,277` output tokens). It followed exactly one guided `2,000 -> 4,000` budget widening, materialized `4/4` pages, cited every page, retained the stale-evidence warning, and reported concrete documentation gaps. It did not repeat the internal `query_facets` label literally, so provider-level gap wording is recorded as a remaining evaluation limitation rather than a perfect score.

The deterministic acceptance suite remains the release gate: `31/31` routing goldens, `5/5` workflow traces, `5/5` invalid calls rejected, compact/full evidence and gap parity, all thirteen quality gates, and all discovered test files pass. A future model-specific improvement claim still requires the full old/new A/B defined above. The corrective contract and full state vocabulary are specified separately in [MILESTONE_AGENT_CONTRACT_INTEGRITY.md](MILESTONE_AGENT_CONTRACT_INTEGRITY.md).
