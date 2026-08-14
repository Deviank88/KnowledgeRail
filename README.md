<p align="center">
  <img src="assets/knowledge-rail-logo.png" alt="KnowledgeRail logo" width="180">
</p>

<h1 align="center">KnowledgeRail</h1>

KnowledgeRail is a local-first MCP server that turns project documentation and source code into durable, evidence-backed context for AI agents.

It is designed for agents that need to understand, change, review, or document a codebase without loading the whole repository into the model context. Retrieval is bounded, provenance is preserved, missing evidence is reported explicitly, and difficult queries widen progressively instead of silently losing relevant information.

> **Current status:** initial public release `1.0.0`. The server uses MCP SDK `2.x` and protocol `2026-07-28`. The supported transport is local `stdio`; a remote/serverless deployment is not implemented yet. See [SERVERLESS.md](SERVERLESS.md).

## What it provides

- A menu-first workflow that guides agents through reading, ingestion, code evidence, document generation, and administration.
- Task-aware hybrid retrieval with lexical, graph, passage, and optional semantic evidence.
- Progressive widening with explicit coverage signals and `GAP`/unknown reporting.
- Complete source ingestion through bounded segments, a coverage ledger, and durable Evidence IR.
- A deterministic TypeScript/JavaScript code index with symbol and reference lookup.
- Incremental graph, retrieval, and semantic indexes stored beside the project wiki.
- Contract-driven Markdown deliverables and gated DOCX export with Mermaid diagrams.
- Conservative migration of existing v1/v2/v3 wikis.

KnowledgeRail does not call an LLM itself. The connected MCP client chooses and calls the tools. OCR and embeddings are optional external providers configured by the user.

## Requirements

- Node.js `22.12.0` or newer
- npm
- macOS, Windows, or Linux

Mermaid CLI and its compatible Chromium runtime are installed with the package. A separate global Mermaid installation is not required.

## Install and run

### From source

```bash
git clone https://github.com/Deviank88/KnowledgeRail.git
cd KnowledgeRail
npm ci
npm run build
```

Start it from the project whose knowledge you want to manage:

```bash
cd /path/to/your-project
node /absolute/path/to/KnowledgeRail/dist/index.js
```

### From npm

After the first public package release:

```bash
npm install --global knowledge-rail
cd /path/to/your-project
knowledge-rail
```

The npm package is not considered available until it is published by the maintainers. Installing from source is the supported pre-release path.

## MCP client configuration

Use the standard `stdio` server shape supported by your MCP client:

```json
{
  "mcpServers": {
    "knowledge-rail": {
      "command": "knowledge-rail",
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your-project"
      }
    }
  }
}
```

For a source checkout, replace `knowledge-rail` with Node and the compiled entry point:

```json
{
  "mcpServers": {
    "knowledge-rail": {
      "command": "node",
      "args": ["/absolute/path/to/KnowledgeRail/dist/index.js"],
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your-project"
      }
    }
  }
}
```

Client configuration wrappers and file locations differ, but the `command`, `args`, and `env` values are portable. Use absolute paths on every operating system. When `WIKI_ROOT` is omitted, KnowledgeRail uses the server process working directory. Legacy MCP clients may provide Roots; modern `2026-07-28` sessions do not need them.

## Agent workflow

Every MCP 2.0 task starts with:

```text
knowledge_menu {}
```

The menu returns five areas:

| Area | Purpose |
| --- | --- |
| `read` | Understand, implement, modify, debug, or review using bounded context. |
| `ingest` | Normalize and integrate sources or development reports with provenance. |
| `code` | Search symbols/references or maintain the code evidence index. |
| `document` | Create, review, or export a deliverable. |
| `admin` | Initialize, migrate, lint, or perform a targeted wiki operation. |

Call `knowledge_menu` again with the selected area, choose one returned operation, execute only the next action, and report its observed outcome back to the menu. This keeps the workflow discoverable without profiles or hidden client configuration.

A normal context request is:

```text
knowledge_menu {"area":"read","operation":"understand"}
knowledge_context {
  "intent":"understand",
  "objective":"Explain how lease renewal and expiry work",
  "response_detail":"compact",
  "heuristic_token_budget":2000
}
```

On MCP `2026-07-28`, `knowledge_context` returns selected `knowledge-rail://` resource links. The client should materialize only the passages it needs with `resources/read`, then report `coverageSufficient` and `evidenceGaps` back to `knowledge_menu`.

### Why context has a token budget

The budget bounds evidence sent to the model; it does not declare omitted knowledge irrelevant. If coverage is insufficient because of the budget, the guided read workflow widens from `2,000` to `4,000`, `8,000`, and at most `12,000` heuristic tokens. If evidence is still missing, the result must expose a gap rather than invent an answer.

`response_detail="compact"` is recommended for normal agent use. `full` keeps the complete historical TaskContext payload for diagnostics and integrations that need it.

## Project data

`knowledge_init` creates this structure inside the selected project. The roots are intentionally stable: `wiki/` is canonical agent memory; `docs/` is the document plane for sources, normalized copies, durable evidence state, and deliverables.

```text
project/
├── wiki/
│   ├── index.md
│   ├── log.md
│   ├── SCHEMA.md
│   ├── .knowledge-rail/     # derived indexes, manifests and migration state
│   └── <page-type>/         # created lazily when the first typed page is written
└── docs/
    ├── client/
    ├── transcripts/
    ├── reports/
    ├── changelogs/
    ├── normalized/
    ├── evidence-ir/         # durable Evidence IR and knowledge-recovery state
    ├── deliverables/
    └── assets/
```

Markdown pages are canonical knowledge. Files below `wiki/.knowledge-rail/` are derived or operational state and can be rebuilt where the corresponding workflow supports it. Source documents remain under `docs/`; normalization never overwrites the original.

These directories may contain private project information. Decide deliberately whether the consuming project should commit them.

## Document memory and deliverables

Document generation starts with `knowledge_menu {"area":"document","operation":"create"}`. The guided flow calls `knowledge_plan_document`, compiles a separate bounded evidence pack for every section, saves the draft, and runs a typed review. `knowledge_export_docx` re-reviews the current Markdown and refuses export while any contract blocker remains.

Built-in contracts cover functional specifications, architecture documents, project briefs, onboarding guides, API references, ADRs, runbooks, test plans, incident reports, and release notes. `custom` remains available for a document with an explicit structure. Each contract defines purpose, default language and audience, required sections, minimum useful content, and type-specific checks; callers can override language and client-facing status without disabling structural validation.

The generated document is an output of agent memory, not its replacement. Confirmed facts belong in `wiki/`; source artifacts remain in `docs/`; delivery-ready Markdown and DOCX files belong in `docs/deliverables/`.

## Optional OCR and semantic retrieval

Text, Markdown, JSON, YAML, CSV/TSV, XLSX, and PPTX normalization works locally. Images and PDFs require either an Ollama-compatible OCR service or a configured native OCR endpoint.

Common OCR variables:

| Variable | Purpose |
| --- | --- |
| `KNOWLEDGE_RAIL_OCR_MODE` | `ollama` (default) or `native`. |
| `KNOWLEDGE_RAIL_OLLAMA_HOST` | Ollama base URL; defaults to `http://localhost:11434`. |
| `KNOWLEDGE_RAIL_NATIVE_HOST` | Native OCR base URL; defaults to `http://localhost:5002`. |
| `KNOWLEDGE_RAIL_OCR_MODEL` | OCR model; defaults to `glm-ocr:latest`. |
| `KNOWLEDGE_RAIL_OCR_TIMEOUT_MS` | Positive request timeout in milliseconds. |
| `KNOWLEDGE_RAIL_OCR_RETRIES` | Retry count. |

Semantic retrieval is optional. Without it, deterministic lexical/graph/passage retrieval remains available. To enable an OpenAI-compatible embeddings endpoint, set all three required variables:

```text
KNOWLEDGE_RAIL_EMBEDDING_BASE_URL=https://provider.example/v1
KNOWLEDGE_RAIL_EMBEDDING_MODEL=embedding-model
KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS=1536
```

Optional embedding variables are `KNOWLEDGE_RAIL_EMBEDDING_API_KEY`, `KNOWLEDGE_RAIL_EMBEDDING_MODEL_VERSION`, and `KNOWLEDGE_RAIL_EMBEDDING_TIMEOUT_MS`.

For Mermaid rendering, `KNOWLEDGE_RAIL_MERMAID_NO_SANDBOX=true` is intended only for controlled CI/container environments that cannot launch Chromium with its sandbox. Do not enable it by default on a workstation or shared host.

## Compatibility

| Capability | Status |
| --- | --- |
| MCP SDK | `@modelcontextprotocol/server` `2.x` |
| Modern protocol | `2026-07-28` |
| Local transport | `stdio` |
| Legacy protocol adapter | Served for existing 2025-era clients |
| Modern selective reads | MCP `resources/read` |
| Remote Streamable HTTP | Not implemented |
| Serverless multi-tenant storage | Not implemented |

Modern product-level tools use the `knowledge_*` prefix. The `wiki_*` prefix is reserved for low-level operations that directly inspect or mutate canonical `wiki/` pages. The legacy protocol adapter retains historical tool names for existing 2025-era clients without adding aliases to the modern catalog.

## Development and verification

```bash
npm ci
npm run verify
npm run audit:runtime
```

Run all deterministic retrieval and quality gates:

```bash
npm run eval:retrieval:gate
npm run eval:hybrid:gate
npm run eval:widening:gate
npm run eval:source-coverage:gate
npm run eval:evidence-ir:gate
npm run eval:code-evidence:gate
npm run eval:recovery:gate
npm run eval:task-context:gate
npm run eval:semantic:gate
npm run eval:migration:gate
npm run eval:editorial:gate
npm run eval:documents:gate
npm run eval:tool-surface:gate
```

The benchmark fixtures and acceptance rules are documented in [benchmarks/README.md](benchmarks/README.md). CI verifies Node.js 22 and 24, all regression gates, benchmark smoke tests, and the runtime dependency audit.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Licensed under the [Apache License 2.0](LICENSE). You may use, modify, and distribute the project, including commercially, subject to the license terms and preservation of required notices. The license does not require derivative products to be open source.

## Origins and acknowledgement

KnowledgeRail is an independent project. Its starting point was inspired in part by Andrej Karpathy's [LLM Wiki idea file](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): an LLM maintains durable Markdown knowledge that compounds instead of reconstructing everything from raw sources on every query.

KnowledgeRail has since evolved into a distinct MCP 2.0 agent-memory system with bounded hybrid retrieval, coverage and gap reporting, Evidence IR, deterministic code evidence, migration support, and contract-driven document production. It is not affiliated with or endorsed by Andrej Karpathy. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
