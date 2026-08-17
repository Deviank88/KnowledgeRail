# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.3...HEAD
[2.0.3]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Deviank88/KnowledgeRail/releases/tag/v1.0.0
