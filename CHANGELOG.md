# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.7] - 2026-09-22

### Internal milestone history

- **2.8.1+ — closed 2026-09-22 (internal, unreleased):** T1–T6 are formally closed
  after 79 test files, 18 quality gates, 1,600 parity comparisons and 17/17
  positive declared-reference checks on an authorized real repository. T7/T8 are
  explicitly deferred as non-blocking validation backlog; they require broader
  real-workspace and anonymized user data. Package metadata was still `2.8.0` at that checkpoint; the work is included in this release.

### Added

- Extend declared references across Salesforce, Poetry/Hatch/Flit/PDM, Rust module attributes and re-exports, JS/TS projects and local package exports, and literal CMake/Go/JVM/C#/Ruby build declarations. Reuse bounded manifest readers, XML/TOML projections, glob matching and generation-local indexes without adding dependencies.
- Expose import inventory causes separately from request/fallback telemetry: platform modules, declared dependencies, verified unindexed paths and unsupported syntax. Keep actionable examples bounded and preserve ambiguous candidates.
- Add Salesforce functional routing, immutable public manifests, declaration regressions and read-only probes for real code and overview/detail wiki selection.
- Add a reproducible code-efficiency benchmark with alternating runtimes, phase timings, process restarts, concurrent queries, CPU/memory observations, filesystem API accounting and serialized MCP replay including telemetry and resource reads. This code replay does not measure model token usage.
- Make all 13 adapter families active targets in the default efficiency workload, with positive/negative reference checks, per-family measurements and 1/5/20-batch sessions. Retain the historical Salesforce profile explicitly. Add 22 bilingual documentary task replays for full/compact context and passage/page reads.
- Add an opt-in local Ollama evaluator with independent development/evaluation handoff tasks, exact fact/citation/uncertainty checks, actual chat-token counters and separate embedding usage. Verify both semantic retrieval and the lexical fallback; keep model-specific measurements distinct from general coding quality.
- Compare manifest strategies and experimental 32/64 MiB admission budgets in disposable runtime copies, including one/four/five-project memory measurements. Select 64 MiB per project with five retained workspaces from the measured local workload.

### Changed

- Retain up to five workspace caches by default, matching the current local operating target. Reuse existing LRU eviction and persisted indexes when switching projects; the configurable cap remains available and the code admission budget is 64 MiB per project (320 MiB of estimated admissions across five workspaces, not a process RAM limit).
- Normalize paths and repeated identifiers once, build shared file inventories in one pass, and resolve repeated declared names once while building each reference index; overlap independent manifest and unindexed-import reads without changing evidence or diagnostics.
- Share in-flight code snapshot loads and generation-bound unindexed-import probes even outside full-snapshot cache admission; reuse Salesforce name/ownership preparation and manifest ancestor traversal within the existing per-project budget.
- Prepare versioned, adapter-owned companion metadata during explicit index writes and restore it after restart; Apex deployment status uses this generic contract. Preserve source IDs and anchors for metadata-only updates, with read-only fallback for older snapshots and incompatible projections.
- Reuse the validated code query generation when materializing resources, preserving source hash checks, index replacement detection, corruption errors and workspace cache limits across languages.

### Fixed

- Refresh the locked transitive Hono dependency from 4.13.2 to 4.13.8 to include upstream security fixes for query parsing, nested form parsing and static-output path validation.
- Confine Apex companion enrichment to its declared source extensions, preserving deployment metadata owned by other language adapters. Older companion projections use the existing compatibility fallback.
- Route whole-page wiki resource URIs through MCP with or without desktop workspace bindings, preserving passage reads, provenance, confinement and truncation.
- Stop treating database names consumed inside a physical source-file module as aliases for that file. Preserve database evidence and entity aliases while restoring actual import edges and excluding unrelated files that merely use the same database name.
- Treat Apex trigger headers as declared object references instead of calls, preserving SOQL evidence. Exclude enclosing class inventories from callers of their own methods; retain actual sibling callers.
- Refresh Apex deployment status through generation-bound sidecar metadata, including bounded reuse when a source snapshot exceeds cache admission. Keep inactive/deleted evidence searchable.


## [2.8.0] - 2026-09-07

### Fixed

- Recognize complete long identifiers and inferred artifact headings in retrieval coverage without accepting identifier prefixes or weakening explicit page-type requirements. Remove strictly dominated lexical candidates from display only below half of all query signals, preserving substantial specific-page coverage beneath an overview. Retain the full coverage pool, semantic/graph evidence, source diversity and explicit artifact-chain widening.
- Keep C/C++ file extensions out of lexical module aliases so an import is not misreported as a generic reference. Preserve Java/Kotlin interoperability and static-owner imports, nested C#/PHP namespace scopes and compatible C# partial declarations within one project boundary. Java, Kotlin, C# and PHP extraction advance to v2.
- Scope TOML reads to relevant declaration fields so unrelated tool grammar does not disable Python/Cargo resolution. Keep valid Cargo package roots and literal members when workspace member globs or invalid member values require warnings.
- Recover corrupt request counters under the workspace lock, preserving the original file in an archive and starting a distinct counting period. Preserve future formats and files outside the recovery contract; warnings identify the counter path.
- Resolve Python imports from declared setuptools roots or verified package/script boundaries; exclude implicit namespace and undeclared repository-root guesses. Resolve Ruby relative paths and C/C++ quoted headers without unrelated stems, system-header guesses or implementation twins.
- Exclude fixture/template/comment text from the TS/JS import inventory and avoid showing an enclosing file module as its own declaration's caller. TS/JS extraction advances to v5, Ruby to v2 and C/C++ to v3; raw import arrays and snapshot v2 remain compatible through optional syntax provenance.
- Stop legacy basename import collisions from creating several definite edges. Preserve explicit namespace/package groups and custom resolver arrays; surface ambiguous choices separately.
- Preserve TypeScript/JavaScript declarations and function bodies after expression-position regex literals containing quotes, backticks or braces. Keep division operators visible and preserve UTF-16 offsets for supplementary Unicode characters. The TypeScript adapter advances to v4; refresh existing code indexes and revalidate affected anchors.
- Keep superseded anchor drift in the audit ledger while excluding it from page staleness using current claim status, including supersession after the last drift check. Active, ambiguous and contradicted claims still flag drift.

### Added

- Read Python setuptools and Cargo target/workspace declarations through the existing confined manifest reader and a bounded dependency-free TOML subset. Composer supports PSR-4, PSR-0, classmap, files and literal exclusions, including PHP constants and mixed grouped imports.
- Resolve literal Ruby gemspec require_paths in order, preserving require_relative independently. Read confined C/C++ compilation database include directories and bounded literal CMake target declarations without executing code. Discover bounded *.gemspec and *.csproj declarations through the shared manifest reader.
- Propose up to eight direct code neighbors when recording anchored claims, with relation, direction, provenance and URI. Candidates are response-only; further claims require explicit author action.
- Count public code requests and linked fallbacks per workspace/language. Return request IDs, deduplicate correlated fallbacks, expose aggregates in admin status and a local report, and keep unknown/expired events separate. New aggregates contain no query text or source paths; counters use atomic OS-buffered writes.
- Extend the import oracle to 30 development/evaluation fixtures and add 29 functional routing scenarios covering domain aliases, layout changes, documents/code-only projects and unreliable anchors. Add a separate gate using unchanged manifest bytes from six public projects pinned by commit and SHA-256, with controlled source overlays. Keep existing quality thresholds and prior language oracles unchanged.
- Expose bounded `unresolvedImports` in code reference responses, with matched names, reasons and candidate paths. Sample twelve issues per indexed generation and four candidates per issue; mark truncation and snapshot scope explicitly. Task context warns about incomplete import resolution without inventing an indexing GAP. Keep per-language-family inventory counts internal and reuse adapter callbacks, memoization and cache admission; ordinary reference callers avoid copying diagnostics.
- Let adapters declare bounded project-manifest readers. Go now uses `go.mod` module identities and nested module boundaries where manifests are available; external imports with matching directory suffixes no longer create local edges in those projects. Invalid manifests return bounded reference diagnostics.
- Refresh known manifests on reference queries without reparsing sources. Discover new nested manifests on index rebuild or `knowledge_code action="update"` for the manifest path. Parsed manifest retention participates in the existing per-project cache admission budget.
- Resolve declared JS/TS `paths` and `baseUrl` from JSONC configs, with exact-pattern and longest-prefix precedence, ordered targets and one local `extends` level. Reuse the common confined reader for dependencies, refreshing changed references and pruning removed dependencies. Preserve relative option origins and child-map replacement.
- Add bounded code impact to `knowledge_context`: repository source paths, paths named in the task and selected active anchored claims yield code roots, incoming candidates and related wiki links. Reuse the existing runtime through a read-only API; absent or invalid indexes yield a GAP without automatic rebuild. Full and compact responses expose the same resources.
- Add opt-in live semantic and functional-routing evaluations, plus a query-only embedding instruction prefix through KNOWLEDGE_RAIL_EMBEDDING_QUERY_PREFIX. The prefix participates in provider identity and leaves document embeddings unchanged.

### Changed

- Compile Python/Composer literal glob filters once per manifest with a shared matcher that avoids exponential regex backtracking. Preserve Go's no-manifest suffix fallback with explicit legacy_suffix_heuristic diagnostics.
- Refresh the code snapshot and manifest structure once for a batch of related-evidence proposals, preserving per-target errors and response caps. Document compact action hints and expose normalized fallback reasons in the input schema while retaining free-text compatibility.
- Reuse stable bounded result selection for incoming references, preserving relation priority, path filters, test preference and ties.
- Add manifest freshness, isolation and memory-admission regressions and a dedicated structure benchmark. Repair the project-precision fixture's obsolete source pointer without changing its questions, document bodies or expected results.
- Make the project knowledge maintenance script explicitly supersede its own prior source revisions and verify every current claim link, while preserving and reporting older anchors that still show drift.
- Batch whole-file reference targets through the existing postings and bounded selection. Share claim/page associations and one evidence-store read with drift; fit code disclosure using bounded prefix searches. Preserve query, source paths and page-type scope when suggesting a larger context budget, and avoid futile widening for fixed expansion limits.

### Known limitations

- Lexical dominance selection remains under observation for specific pages covering less than half the query signals; higher-coverage pages are protected from dominance, subject to ordinary display budgets. Deterministic overview/detail regressions do not establish general answer quality. A relevant unsupported CMake declaration discards all CMake roots/targets from its file, preserving local quoted includes; broad real-CMake coverage is not established. Changing the embedding query prefix triggers full document re-embedding at the next synchronization despite identical document inputs.
- Manifest support is bounded to literal declarations and indexed files. Installed dependencies, full build-tool evaluation, MSBuild/Gradle ownership, dynamic Ruby paths, compiler macros/system headers, transitive CMake configuration, Rust cfg/path attributes/re-exports and TS project/package/bundler resolution remain unsupported. Compilation databases are discovered at indexed ancestors/root, not arbitrary build directories.
- Ollama qwen3-embedding:0.6b passes the 29 recorded-alias functional scenarios but does not recover either of the two paraphrase-only probes with production ANN thresholds. A query instruction prefix reduces no-benefit token growth from six queries to one (+2 estimated tokens) in the final run; it does not establish general semantic accuracy. Public manifest overlays are not full-project or user-population evaluation. Request rates count correlated reported fallback use; expired, unknown and unreported events cannot reconstruct historical user rates. The legacy fallback journal is unchanged.

- Python layout manifests currently support setuptools only. Poetry/Hatch/Flit/PDM declarations are not interpreted: package-boundary/script-directory resolution still works, but tests or scripts outside the package can miss absolute imports from repository-root modules or separate source trees. Implicit namespace packages and runtime sys.path additions remain unsupported.
- Go without a discovered go.mod still uses the legacy directory-suffix heuristic and can produce false positives. Import diagnostics do not yet distinguish every external, unsupported and unindexed cause. TypeScript rootDir does not define import identity or aliases.
- Manifest projection preserves unrelated balanced values, but ambiguous lexical boundaries (such as unterminated multiline strings) still prevent safe declaration discovery. Cargo workspace member globs are diagnosed without expanding them.


## [2.7.4] - 2026-09-05

### Fixed

- Include function bodies in TypeScript/JavaScript code resources with destructured parameters, inline object types and multiline signatures. The TypeScript adapter advances to v3 so existing files receive corrected ranges on refresh; the snapshot schema stays unchanged.
- Preserve Markdown comments and headings inside backtick/tilde code fences, including unclosed fences and passage splits; invalidate older retrieval builders so unchanged pages restore corrected passages.
- Resolve unambiguous relative JS/TS imports with explicit source extensions, runtime extension substitutions and directory indexes. Recognize uppercase extensions such as `.TS` while preserving exact path casing. Remove basename-only matching for JS/TS sources; package specifiers, aliases and ambiguous JS/TS modules remain unresolved.
- Preserve Python module import references with unambiguous dotted/relative paths, `.py` or package `__init__.py` targets and `.pyi` fallback. Absolute imports search the repository root, importer directory and source root attested by a regular-package chain. This fixes the pre-release regressions that dropped non-JS/TS edges and then still missed Python `src/` imports.
- Resolve realistic Java/Kotlin/PHP declarations, C# namespaces, Go package files regardless of filename, Rust crate/module paths and literal C/C++ header includes. These close gaps inherited from 2.7.3; includes do not manufacture edges to implementation twins.
- Resolve supported LWC imports to Apex methods, schema declarations and local component bundles, preserving existing Apex/metadata reference and drift checks.
- Include direct code-resource links and captured line ranges in synthesized knowledge pages when a claim has a verified code anchor. Claims without anchored code evidence remain free of fabricated references.
- Preserve external-change notifications during reconciliation and targeted updates, and make workspace LRU ordering independent of clock ties and rollback.
- Stop snapshot retries as soon as deletion is observed, reload recreated snapshots, and propagate filesystem failures instead of treating them as corrupt derived data.

### Changed

- Reuse validated code-query generations and lazy symbol/reference maps with independent per-project admission budgets. Document the 32 MiB estimate, workspace LRU cap, absence of TTL and distinction from measured heap/RSS.
- Remove only a changed page's posting terms, bound file reconciliation to 64 concurrent checks, and use stable bounded result selection for code and lexical queries. Hoist query-invariant IDF while preserving scores, filters, tie order and the complete phrase-reranking pool.
- Retain the bounded 2 MiB phrase cache and make its passage alignment guard explicit.
- Let adapters build their own disposable import resolvers from indexed declarations and paths. Use one incoming import index, preserve custom-adapter fallback, and isolate cached rules by registry. The import refactor changes neither snapshot schema nor extraction versions.
- Add reproducible update, reconciliation, query profiling, parity, project precision and stability workloads. Local evaluation reports both retrieved and displayed evidence, including false GAPs and heuristic adapter limits, without weakening existing quality gates.

### Known limitations

- Static import evidence is bounded by the indexed inventory. Go directory suffix matching does not verify `go.mod` or build tags; Rust conventions do not implement arbitrary `path`/`cfg`/re-export rules. Compiler include paths, dynamic imports, unindexed declarations and ambiguous targets remain unresolved. Ruby retains its legacy stem heuristic. Passing realistic fixtures is not universal language coverage.

## [2.7.3] - 2026-09-05

### Fixed

- Wiki frontmatter `sources` validation now confines document paths under `docs/` with realpath containment, rejecting directories, missing files, traversal segments, and symlink escapes when existence checks are enabled.
- Source paths now normalize path separators and Unicode NFC while rejecting null bytes and cross-platform absolute paths; the `SOURCE_INVALID` message explains that sources are `docs/` documents, that code is cited through Evidence IR `code://` targets, and that external documents are imported with `knowledge_files action="normalize"`.
- Source validation reasons no longer embed filesystem paths, and `knowledge_admin action="lint"` output redacts the workspace root like other tool errors.

## [2.7.2] - 2026-09-02

### Changed

- Removed the tracked client-integration milestone from documentation and npm packaging; milestone plans remain local-only and repository verification rejects future tracked or packaged milestone directories.

### Fixed

- Replaced the unavailable jsDelivr README logo with an immutable versioned GitHub Raw asset that renders on both GitHub and npm.
- Added release checks for PNG structure, source-to-tarball byte equality, tagged GitHub README/assets, and the README/assets actually published by npm.

## [2.7.1] - 2026-09-02

### Added

- Added source-aware stakeholder evidence: transcripts require extraction, client/report sources suggest it when explicit evidence exists, and Evidence IR creates or updates stable temporal `stakeholders/` pages without merging ambiguous identities.
- Added privacy-preserving user-domain resolution from `KNOWLEDGE_RAIL_USER_EMAIL` or project-root Git configuration, deterministic stakeholder affiliation, full-address redaction, and domain context in document/source plans.

### Changed

- Added the canonical `stakeholder` page type with temporal role/organization/domain/affiliation fields and kept wiki page directories open-ended and lazily created.
- Preserve source-declared client/internal affiliations when no domain comparison is available; deterministic domain comparison still wins when available, while identity changes require a server restart.
- Retained the historical `data-models/` linker path for existing workspace compatibility.

### Fixed

- Fixed caller-supplied `wiki/...` page paths creating `wiki/wiki/...`: redundant leading wiki-root markers are canonicalized, nested `wiki` directories and hidden page paths are rejected, derived indexes exclude malformed legacy paths, and lint reports existing nested wiki trees.
- Added collision-safe lint preview/apply repair for legacy nested wiki pages, including link rewrites, journaling, rollback, and derived-index cleanup.
- Fixed explicit, legacy, and registered workspaces that point at an existing canonical `wiki/` directory or its descendants by resolving them back to the project root only when `.knowledge-rail/` proves it is a managed wiki.
- Aligned page URI parsing with direct page paths by accepting and removing a redundant leading `wiki/`.
- Fixed stakeholder email detection and redaction for internationalized domains ending in a non-ASCII TLD.

## [2.7.0] - 2026-08-28

### Added

- Added revisioned lexical and graph checkpoints with validated warm restore, base-aware journals, bounded persistence, cross-process CAS protection, automatic cold rebuild on invalid state, and startup/restart performance gates.
- Added bounded ordered-bigram reranking with identifier protection, passage selection diagnostics, a pinned held-out quality evaluation, and a production-formula regression gate.
- Added explicit project-scoped Claude Code, Codex, and Cursor hook/rule setup through `knowledge_admin action="client_setup"` and `knowledge-rail setup clients`, including preview/apply modes, safe merges, checksummed project-local recovery transactions, bounded successful-backup retention, native hook output translation, and trust handoff.
- Added a deferred desktop catalog and recoverable loopback connection manager so MCP protocol readiness no longer waits for gateway startup.

### Changed

- Desktop gateway connection attempts now use configurable bounded retries and platform-aware timeouts while keeping shared gateway ownership separate from individual MCP client sessions.
- Internal search output labels scores as relative ranking signals, and phrase diagnostics/configuration use one canonical scoring contract.
- MCP catalog metadata retains 100% routing accuracy while restoring explicit byte/token headroom below a stricter surface gate; redundant per-tool dialect annotations are omitted and public integer budgets expose meaningful bounds without weakening Zod validation.

### Fixed

- Fixed stale checkpoint CAS state failing to converge after another process persisted a generation.
- Fixed desktop gateway leaks across abort, credential, and rendezvous failures, and prevented one adapter transport error from closing the shared owned gateway.
- Fixed unsanitized prompt/resource connection errors and an exact-identifier phrase-score tie.
- Fixed catalog authorization so read-scoped bindings cannot apply client configuration or persist checkpoints while retaining read-only setup preview/status.

## [2.6.2] - 2026-08-24

### Added

- Added `knowledge-rail setup cursor [<path>]`, which safely creates or merges a project-scoped `.cursor/mcp.json`, preserves unrelated configuration, pins the installed package version, passes `${workspaceFolder}` through `--root`, and remains idempotent.
- Added the read-only `knowledge-rail doctor [--root <absolute-path>]` command for reporting the canonical workspace root and resolution source without starting an MCP server.

### Changed

- Cursor guidance now uses deterministic project-scoped configuration, while Claude Code, cwd-aware IDEs, terminal agents, desktop chats, and multi-root workspaces have separate setup contracts and examples.
- Known Cursor application, shared-process, and global configuration directories now fail closed during automatic root discovery.

### Fixed

- Fixed Cursor sessions binding KnowledgeRail through an application or user-home cwd by replacing global cwd inference with explicit project-scoped setup.

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

[Unreleased]: https://github.com/Deviank88/KnowledgeRail/compare/v2.8.0...HEAD
[2.8.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.7.4...v2.8.0
[2.7.4]: https://github.com/Deviank88/KnowledgeRail/compare/v2.7.3...v2.7.4
[2.7.3]: https://github.com/Deviank88/KnowledgeRail/compare/v2.7.2...v2.7.3
[2.7.2]: https://github.com/Deviank88/KnowledgeRail/compare/v2.7.1...v2.7.2
[2.7.1]: https://github.com/Deviank88/KnowledgeRail/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/Deviank88/KnowledgeRail/compare/v2.6.2...v2.7.0
[2.6.2]: https://github.com/Deviank88/KnowledgeRail/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/Deviank88/KnowledgeRail/compare/v2.6.0...v2.6.1
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
