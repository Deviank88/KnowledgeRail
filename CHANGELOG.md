# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Deviank88/KnowledgeRail/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Deviank88/KnowledgeRail/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Deviank88/KnowledgeRail/releases/tag/v1.0.0
