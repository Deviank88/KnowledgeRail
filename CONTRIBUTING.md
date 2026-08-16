# Contributing

KnowledgeRail accepts focused bug fixes, tests, documentation improvements, and features that preserve retrieval accuracy, provenance, and bounded context behavior.

## Setup

Use Node.js `22.12.0` or newer:

```bash
npm ci
npm run build
npm run verify
```

For the local development loop, run `npm run dev`; the TypeScript entry point is restarted as source files change.

## Pull requests

- Keep changes scoped and add regression tests for changed behavior.
- Do not lower an existing quality threshold to make a change pass.
- Never commit project wikis, source documents, generated deliverables, credentials, local agent settings, build output, or dependencies.
- Run `npm run audit:runtime` and every quality gate affected by the change.
- Record relevant benchmark or evaluation results in the pull request.
- Update public documentation when behavior, configuration, compatibility, or security assumptions change.

The complete deterministic gate list and fixture policy are documented in [benchmarks/README.md](benchmarks/README.md). CI remains the source of truth for the supported Node.js matrix and required checks.

## Adding a quality gate

Add a deterministic evaluator and a separate baseline gate under `benchmarks/`, keep its fixture under `benchmarks/fixtures/`, and add the gate script to `scripts/run-quality-gates.mjs`. The fixture is the source of truth: record its schema version, digest or stable IDs, budgets, and accepted thresholds. Run the new gate locally and `npm run eval:gates`; never lower an existing threshold to accommodate a change.

## Architecture map

- `src/mcp` and `src/runtime`: protocol negotiation, catalogs, stdio lifecycle.
- `src/http`, `src/desktop`, and `src/workspaces`: loopback gateway, desktop proxy, registry, and opaque bindings.
- `src/tools`: public domain orchestration and internal tool adapters.
- `src/context`: content-addressed resources, manifests, and task-context compilation.
- `src/core/ingestion`: segmentation, coverage, Evidence IR, linking, and synthesis.
- `src/core/code-evidence`: deterministic code indexing and scoped resource reads.
- `src/core/semantic`: optional embedding provider and bounded ANN retrieval.
- `src/core`: canonical page records, retrieval, graph, migrations, concurrency, durability, and state lifecycle.
- `src/config`: workspace layout, contracts, editorial plans, and generated templates.
- `src/docx`: Markdown parsing and bounded DOCX/Mermaid rendering.
- `tests`: behavior, security, compatibility, cross-process, and packaging regression tests.
- `benchmarks`: deterministic quality gates and performance diagnostics.

Run `npm run docs:generate` after changing a public Zod tool schema. Commit the regenerated [tool/action reference](docs/reference/tool-actions.md) with the schema change.

## Versioning policy

KnowledgeRail follows semantic versioning for its public package and MCP contract. A major version is required when a release removes or renames a public tool/action, makes an input or output schema incompatible, or changes the meaning or required shape of the `state`/`nextAction` response envelope. An incompatible on-disk format also requires a major version unless the same release includes an automatic, lossless migration.

`BINDING_FORMAT_VERSION` and `REGISTRY_SCHEMA_VERSION` in `src/product.ts` version local interoperability formats independently from the npm package. Increment the relevant format constant whenever older processes cannot safely read the new representation. Changes to the supported MCP protocol era must preserve the documented compatibility adapter or be released as a major version.

Patch releases contain backwards-compatible fixes. Minor releases may add compatible actions, optional fields, formats with transparent migration, and new protocol-era support. Every released version must be aligned in `package.json`, `package-lock.json`, `src/product.ts`, `server.json`, and `CHANGELOG.md`; `npm run release:verify` enforces that agreement.
