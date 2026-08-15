# Milestone — Agent Contract Integrity

Status: implemented and locally release-ready on `agent/fix-agent-contract-integrity`; pull-request CI remains required.

## Objective

Make the consolidated eight-tool surface safe to consume as an agent contract. Server guidance must never rewrite caller-owned content, workflow transitions must derive from structured state, every public result must expose the same guidance envelope, and the benchmark must compare like-for-like measurements from one versioned baseline.

This milestone corrects the post-consolidation findings only. It does not implement the distribution, remote transport, embeddings, bi-temporal claims, engineering-signal ingestion, or LSP roadmap.

## Normative requirements

1. Bytes inside page, controlled-file, code-resource, and other caller-owned payloads MUST be returned unchanged. Response framing and explicitly documented read truncation MAY be added, but runtime compatibility logic MUST NOT rename tool references inside those payloads.
2. `resources/read` and `knowledge_page action="read"` MUST materialize the same page or passage text for the same URI and limit.
3. Retired operation names MAY be rewritten only by the explicit, non-automatic schema migration proposal. Canonical `SCHEMA.md` remains unchanged until a user applies an approved edit.
4. Ingestion MUST use unambiguous public actions: `apply_claims`, `record_segment`, `source_status`, and `evidence_status`. The former overloaded `apply` and `status` actions are invalid.
5. Ingestion transitions MUST read `queueEmpty`, `readyForFinalization`, segment IDs, and metrics from internal `structuredContent`; parsing localized prose is forbidden.
6. Every advertised tool MUST declare the shared output envelope and return `state`, `nextAction`, optional `guidance`, and optional `resultText`. Text-only clients MUST also see `Next:` and `Guidance:` lines when applicable.
7. A mixed tool MUST advertise conservative annotations: if any action writes, `readOnlyHint=false` and `destructiveHint=true`; all eight tools operate within the closed KnowledgeRail domain and use `openWorldHint=false`.
8. `knowledge_context mode="search"` MUST require a non-empty query. A bounded catalog is requested explicitly with `mode="list"`.
9. Public complex records MAY use a compact advertised shape to control catalog cost, but the complete claim and recovery schemas MUST validate each record before mutation.
10. A dry-run MUST report a preview state and no mutation follow-up. Empty code lookup MUST use a distinct no-match state. Public document export MUST use `project_name` consistently.

## Public state vocabulary

The stable states are grouped by domain. Errors from any domain use `blocked` and always return `nextAction: null`.

| Domain | States |
| --- | --- |
| Context | `context_ready`, `context_incomplete`, `pages_listed`, `search_complete`, `graph_complete` |
| Pages/files | `page_read`, `page_updated`, `page_move_preview`, `files_listed`, `file_read`, `source_normalized` |
| Ingestion | `ingest_started`, `segment_ready`, `segment_applied`, `segment_classified`, `source_queue_empty`, `coverage_complete`, `coverage_incomplete`, `source_finalized`, `report_prepared`, `evidence_status_ready`, `recovery_updated` |
| Code | `code_status_complete`, `code_rebuild_complete`, `code_update_complete`, `code_remove_complete`, `code_search_complete`, `code_symbol_complete`, `code_references_complete`, `code_read_complete`, `code_record_fallback_complete`, `code_no_matches` |
| Documents | `document_planned`, `section_context_ready`, `document_written`, `document_reviewed`, `document_needs_revision`, `document_exported` |
| Administration | `workspace_initialized`, `lint_complete`, `migration_plan_complete`, `migration_apply_complete`, `migration_rollback_complete` |

`nextAction` is advisory and contains exactly one next operation or `null`; it never grants authority to mutate data. Clients remain responsible for presenting or applying consequential operations according to their own approval policy.

## Benchmark contract

The versioned fixture `benchmarks/fixtures/tool-surface-baseline-v4.json` is the only source of accepted baselines and thresholds. Two byte units are reported independently:

- `modernCatalogBytes`: UTF-8 bytes of `JSON.stringify(result.tools)`; the matching pre-consolidation baseline is `19,926` bytes.
- `toolsListResultBytes`: UTF-8 bytes of `JSON.stringify(result)` for the complete `tools/list` result; the matching pre-consolidation baseline is `26,080` bytes.

The historical menu required three routing calls per evaluated workflow (root, domain, operation); the direct surface requires zero. Across the five workflow traces the benchmark therefore pins 15 routing round trips saved and a 100% routing-call reduction.

Routing goldens are realistic English and Italian requests with paraphrases. The deterministic tokenizer normalizes stop words, plurals, and a small transparent cross-language concept set before matching the actual advertised descriptions and schemas. This is a catalog-affordance regression signal, not proof of any model's behavior.

## Acceptance gates

This milestone is ready only when:

- all pre-existing CI, retrieval, ingestion, recovery, migration, document, security, and portability gates remain unchanged and pass;
- exactly eight tools are advertised and no menu or historical alias is public;
- the existing 14,000-byte, 4,700-token-proxy, 66%, 25%, 94%, invalid-call, and workflow thresholds are not lowered;
- at least 31 realistic routing goldens are evaluated;
- all eight tools advertise and produce the guidance envelope;
- read/resource parity and read-to-edit byte preservation pass;
- every public domain action named in the corrective review has a regression test;
- the self-wiki dogfood completes without uncommitted generated artifacts.

## Current local measurement

The final local evaluation reports:

- tools: `24 → 8` (`66.67%` reduction);
- tool-array catalog: `19,926 → 13,942` bytes (`30.03%` reduction);
- complete `tools/list` result: `26,080 → 14,105` bytes (`45.92%` reduction);
- catalog token proxy: `4,648` (`tool-array UTF-8 bytes / 3`);
- routing goldens: `31/31`;
- invalid calls rejected: `5/5`;
- workflow traces completed: `5/5`;
- routing calls saved: `15/15` (`100%`);
- compact/full evidence and gap parity: `true`.

These values must be recorded in the pull request. Repository integration still requires explicit maintainer authorization and a green required CI run.
