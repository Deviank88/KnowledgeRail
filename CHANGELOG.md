# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.6.1] - 2026-08-23

### Changed

- Normal task guidance now treats only context-matched decision references as optional project context: selected passages are preferred, one bounded page is the fallback, unrelated decisions are not opened, and an absent decision produces neither evidence nor an artificial gap.
- Durable choices are consolidated at task close by reusing one bounded decision page per coherent flow/component/context and the existing `DECISION` log level.
- Decision-memory guidance explicitly avoids proposals, incidental implementation details, raw conversation, hidden chain-of-thought, secrets, inferred consent, duplicate pages, and silent history replacement; unauthorized sessions report a proposed update without writing.
- `prepare_knowledge_update` now emits a decision-specific living-page draft with current choice, rationale, alternatives, consequences, related evidence, and dated history, without adding a ledger, CLI action, persistence schema, or public tool.
- The always-on decision-memory instruction is intentionally compact; detailed retrieval safeguards are disclosed by `knowledge_context` only when decision candidates are present, while authoring rules stay in the decision update prompt and workspace schema.
- The public MCP catalog removes redundant one-line field glosses while retaining action mappings and complex-payload guidance, restoring deliberate byte/token headroom without weakening routing affordances.

## [2.6.0] - 2026-08-20

### Added

- Added the deterministic `kotlin-deterministic-v1` adapter for `.kt` and `.kts`, including nested types and companions, top-level/member/extension functions, properties, KDoc, test markers, Spring routes, literal Ktor routes, imports, and configuration evidence.
- Added the explicit-suffix `sfmeta-deterministic-v1` adapter for SFDX objects, fields, validation rules, flows, and permission sets, with formula/call extraction and Apex-compatible database-reference links; generic XML remains unclaimed.
- Added a dedicated dependency-free Ruby keyword-block engine and `ruby-deterministic-v1` adapter for `.rb` and `.rake`, covering native qualified names, endless methods, RDoc, RSpec/Minitest, Rails/Sinatra routes, heredocs, percent literals, interpolation, and conservative regex-versus-division masking.
- Expanded the pinned corpus to 52 labeled files, 1,429 lines, and 199 symbols across twelve adapters; baseline v4 retains the existing precision and recall thresholds and adds bounded Kotlin, Ruby, and Salesforce-metadata extraction checks.
- Extended drift evaluation from 42 to 54 scenarios with unchanged, formatting-only, substantive-change, and parser-upgrade cases for Kotlin, Salesforce metadata, and Ruby.

### Changed

- The default code-evidence registry now has 13 mutually exclusive adapters and selectively reparses only the files owned by an upgraded Kotlin, Salesforce-metadata, or Ruby adapter.
- Code-evidence discovery now applies the registry's case-insensitive suffix semantics during globbing, so canonical mixed-case Salesforce metadata names are indexed consistently on Linux, macOS, and Windows.

### Fixed

- Kotlin function extraction now balances parameter parentheses before locating the body, preventing one expression-body function from consuming the next declaration when defaults or consecutive `fun … =` forms are present.
- Kotlin type extraction now uses a bounded linear header scan instead of an ambiguous multiline regular expression, preventing adversarial indentation from causing excessive backtracking or swallowing the following declaration.

## [2.5.0] - 2026-08-19

### Added

- Added the hook-ready `knowledge-rail drift` CLI with global and repeated path scopes, silent all-fresh text output, full JSON output, bounded diagnostics, CI-oriented `--check`, fail-open timeouts, and `--no-ledger` operation.
- Added a project-scoped Claude Code hooks guide and generic shell-hook commands usable by agent harnesses, IDEs, pre-commit checks, and CI without an MCP server process.
- Extended CLI, drift-parity, installed-package, timeout, confinement, and no-ledger coverage without adding runtime dependencies.

### Changed

- Drift CLI and `knowledge_admin action="drift"` now share the same cancellable detector path; cancellation is checked before any late ledger update, while the existing MCP verdict semantics remain unchanged.

## [2.4.0] - 2026-08-19

### Added

- Added the dependency-free `python-deterministic-v1` adapter for `.py` and `.pyi`, with logical-line and indentation-aware ranges, nested qualified names, block and one-line docstrings, bounded `test_` conventions, decorators, FastAPI/Flask Blueprint/Django routes, imports, calls, configuration keys, and database references.
- Added an offset-, UTF-8-width-, and newline-preserving Python masker for comments, prefixed strings, triple strings, and nested-quote f-strings, plus bounded adversarial tests for deep continuations and large string bodies.
- Expanded the pinned extraction corpus to 32 labeled files, 1,082 lines, and 144 symbols across nine adapters; baseline v3 now validates optional route, definition, import, call, configuration, and database metadata as well as symbol ranges.
- Extended the drift fixture to 42 cases with unchanged, formatting-only, substantive-change, and parser-upgrade verdicts for decorated Python anchors.

### Changed

- The default code-evidence registry now claims `.py` and `.pyi` exclusively for Python; a parser upgrade reparses only those files while reusing every existing adapter record.
- Documented the line-based drift boundary explicitly: trailing-whitespace changes remain fresh, while reflows that add or remove lines remain drift because they move the cited range.

## [2.3.0] - 2026-08-19

### Added

- Added deterministic, dependency-free code-evidence adapters for Java, Apex, C#, Go, Rust, PHP, C, and C++, plus LWC decorator and metadata-target awareness in the JavaScript adapter.
- Added a versioned adapter registry with mutually exclusive extension claims, snapshot v2 per-adapter rosters, and selective re-indexing when only one language parser changes.
- Added per-extension grep-fallback demand telemetry surfaced by `knowledge_code action="status"` and `knowledge_admin action="status"` without persisting fallback result paths.
- Added a real-world-shaped, hand-labeled corpus of 25 files, 849 source lines, and 102 symbols, plus a 27-file mixed LWC benchmark, a pinned extraction gate requiring at least 0.95 precision and 0.90 recall, adversarial masking checks, and explicit corpus-size guards.

### Changed

- Drift detection now resolves the expected parser version from each anchor path; its pinned gate covers unchanged, formatting-only, substantive-change, and parser-upgrade cases for every supported adapter.
- PHP extraction masks HTML outside `<?php`/`<?=` regions plus heredoc/nowdoc bodies, and recognizes namespaces, types, functions, PHPUnit tests, common Laravel/Symfony routes, configuration keys, and database references.
- C/C++ extraction is deliberately conservative: `.h` files use the C++ superset adapter, while ambiguous macro-generated, K&R, complex template, and operator constructs remain unindexed instead of receiving unreliable ranges.
- C/C++ function extraction now keeps access labels out of method ranges, recognizes pointer-return functions and constructors, and qualifies namespace-level C++ functions without invalidating other language adapters.

### Fixed

- Normalized `.`, `#`, `::`, PHP namespace backslashes, and `->` only while matching qualified `symbol` queries, so agents can use a familiar separator across languages without changing persisted language-native names.
- Made C/C++ signature matching non-ambiguous under adversarial repeated tokens and canonicalized golden-corpus and drift-fixture integrity metrics across Git checkouts without altering indexed source bytes.
- Code-evidence snapshot v1 is treated as disposable derived state and rebuilt once into snapshot v2; unchanged files remain reusable on later adapter-specific upgrades.

## [2.2.1] - 2026-08-19

### Fixed

- Kept semantic page coverage separate from displayed-passage coverage, rejecting empty or ambiguous excerpt mappings so a strong body passage cannot hide an irrelevant excerpt or suppress `passage_evidence` gaps.
- Replaced the ambiguous entity-matching pattern with bounded linear matching, capped public task objectives and queries at 4,096 characters, and made sentence-initial prose handling symmetric for English and Italian.
- Split the GAP-quality baseline into legacy-display, legacy-full-pool, lexical-full-pool, and semantic-full-pool arms, with precision and silent-miss gates for each stage and no lowered thresholds.

### Changed

- Centralized repository-confined code reads used by code-anchor capture and drift detection while preserving their distinct missing-file verdicts.

## [2.2.0] - 2026-08-18

### Added

- Added durable normalized code-range anchors to code-targeted Evidence IR claims, best-effort anchor backfill during migration apply, and a deterministic `knowledge_admin action="drift"` check with global and path-scoped modes.
- Added derived drift state and explicit `stale`/`drift_suspected` context gaps in compact and full task-context responses.
- Added a pinned drift-verdict gate covering unchanged code, formatting-only edits, substantive changes, deleted files, invalid ranges, parser upgrades, and a 1,000-anchor workload.

### Fixed

- Progressive widening now stops on coverage of the evidence actually returned to the model, while preserving full-pool coverage as the missing-vs-budget-limited oracle; task manifests expose display-budget gaps and per-attempt graph depth.
- Restored conservative single-word proper-noun coverage (including named `Payment`/`System` concepts) without accepting substring-only token matches.
- Scoped the missing-embedding notice to each active workspace and eliminated the duplicate coverage snapshot when no display subset is supplied.
- Extended the pinned GAP fixture from 22 to 25 cases and added an enforced W2/depth-3 progressive-widening probe.
- Drift checks now isolate unreadable, unsafe, or non-file anchors as `anchor_unresolvable` instead of aborting the run, and stale evidence omitted from the display still produces an explicit category GAP.
- Code-anchor capture and backfill now refresh only referenced code paths on the ingestion hot path; a complete repository rebuild is reserved for index recovery or parser-version migration.

### Changed

- Stale or unresolvable code-backed pages remain traceable in returned evidence but no longer satisfy clean evidence buckets or change-impact claims until re-verified.

## [2.1.0] - 2026-08-18

### Added

- Added opt-in semantic-aware coverage for query facets, entities, and required artifacts, with `coverageMode` and graceful provider-degradation warnings in task-context responses.
- Added a deterministic 22-case GAP-quality evaluation to the semantic quality gate, measuring both GAP precision and silent misses for lexical and semantic coverage.

### Changed

- Coverage now evaluates the full fused candidate set independently of the bounded evidence display and shares artifact equivalences with task classification.
- Improved offline lexical coverage with conservative stemming, delimiter-tolerant entity matching, and tighter entity extraction.

### Fixed

- Reclassified retrieved evidence omitted by count or token budgets as `budget_limited` instead of `missing_evidence`.

## [2.0.5] - 2026-08-17

### Fixed

- Aligned README status and installation examples with the package version, and served its packaged logo from a versioned public URL that renders on both GitHub and npm.
- Extended release verification to reject stale README versions, non-portable logo references, and invalid packaged PNG assets.

## [2.0.4] - 2026-08-17

### Fixed

- Made desktop workspace selection portable across MCP hosts by advertising its output schema and returning the opaque per-chat binding in both structured output and text content.
- Extended desktop regressions and installed-package smoke coverage through legacy negotiation and a real `list` → `select` → authenticated domain-call flow.

## [2.0.3] - 2026-08-17

### Changed

- Replaced the environment-dependent internal manifest with deterministic v2 output: POSIX/NFC paths, LF-normalized Markdown hashes and sizes, stable entry ordering, and no generation or filesystem timestamps. Manifest v1 remains readable and upgrades on rebuild or invalidation.

### Fixed

- Restored migration from the pre-rebrand `.llm-wiki` namespace, including conservative manifest assessment, CRLF/LF-aware diagnostics, verified source-coverage import, complete metadata backup, and rollback.
- Blocked ambiguous dual-namespace state, unsafe legacy metadata symlinks, and incomplete legacy migration journals instead of silently rebuilding over them.

## [2.0.2] - 2026-08-17

### Fixed

- Replaced regex-based Markdown scrubbing in document review with one exact-pinned CommonMark/GFM tokenizer pass shared by headings, fences, placeholders, links, images, raw HTML, Mermaid blocks, and section checks.
- Excluded leading frontmatter and fenced examples from body checks while correctly handling tilde fences, malformed fence-like prose, cross-paragraph backticks, and resolved shortcut-reference images.
- Restored placeholder detection in link and image destinations and fully inspected extensionless local assets that contain SVG data.
- Centralized document-profile classification, asset-size limits, and bounded concurrent asset review without changing the Markdown-first tool surface.

### Security

- Restored blocking findings for `javascript:`, `vbscript:`, `data:`, filesystem, and private image/link URIs, including entity-encoded variants.
- Blocked inline Mermaid interaction directives, URLs, init directives, executable URI schemes, event handlers, and active HTML elements regardless of statement position.
- Added adversarial delivery-readiness fixtures for all confirmed review bypasses and kept every quality threshold unchanged.

## [2.0.1] - 2026-08-17

### Fixed

- Guarded document-profile resolution against prototype keys and internal templates; every non-preset name now follows the same custom-profile contract.
- Moved image validation into core document review and covered inline, reference-style, and HTML image sources while ignoring fenced examples and frontmatter.
- Kept high-confidence Mermaid and local SVG/PNG security findings as blockers while treating ambiguous syntax, remote images, and legacy image formats as portability warnings.
- Made diagram-mode enforcement explicitly opt-in and made requested diagram evidence packs independent of English or Italian heading heuristics.
- Renamed review finding codes to stable English identifiers, including `NO_BLOCKERS`, `MERMAID_INVALID`, `ASCII_DIAGRAM`, `WEAK_SECTIONS`, and related sibling codes.

## [2.0.0] - 2026-08-16

### Added

- Added open-ended document profiles, caller-defined required sections, and built-in user manual, functional analysis, and technical analysis presets.
- Added opt-in diagram choices, bounded graph-backed diagram evidence packs, local SVG/PNG review, and `contentSha256` for the exact Markdown inspected.

### Changed

- Made a passing document review terminal; downstream conversion and branded templates belong to the user's own tools.

### Removed

- Removed DOCX/PDF production, the document export action, delivery manifests, Chromium/Puppeteer, Mermaid CLI, and server-side diagram rendering.

## [1.0.2] - 2026-08-16

### Fixed

- Preserved the canonical GitHub owner casing in the MCP Registry namespace so GitHub OIDC authorization can publish the server metadata.
- Added release verification that rejects an MCP namespace whose owner casing differs from the configured GitHub repository.

## [1.0.1] - 2026-08-16

### Added

- Cross-process workspace mutation locks, atomic durable writes, move journals, stale-lock recovery, and bounded workspace-state lifecycle management.
- Structured redacting logs, authenticated local metrics, richer path-free health reporting, release provenance automation, dependency updates, and CodeQL analysis.

### Changed

- Hardened every model-controlled filesystem boundary with validated glob patterns, realpath containment, bounded enumeration, and workspace-root redaction.
- Tightened loopback gateway Host and Origin validation while preserving zero-write read bindings.
- Kept MCP metadata and control files in English while making wiki pages and deliverables follow the user's request language by default, with explicit overrides and edit-language preservation.

### Security

- Prevented glob traversal and symlink-based workspace escapes across wiki, source, and deliverable operations.
- Prevented unsafe frontmatter keys and stopped absolute workspace paths from reaching tool responses or logs.

## [1.0.0] - 2026-08-15

### Added

- Initial local-first MCP server with persistent evidence-backed knowledge, bounded retrieval, document workflows, and eight public `knowledge_*` tools.
- Multi-workspace loopback HTTP gateway, opaque per-chat bindings, desktop adapter, and portable npm/npx distribution.

[Unreleased]: https://github.com/Deviank88/KnowledgeRail/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/Deviank88/KnowledgeRail/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.5...v2.1.0
[2.0.5]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Deviank88/KnowledgeRail/releases/tag/v1.0.0
