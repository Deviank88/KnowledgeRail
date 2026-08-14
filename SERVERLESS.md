# Remote and serverless readiness

KnowledgeRail currently supports local MCP clients over `stdio`. It is not yet a remote or serverless MCP service.

The MCP `2026-07-28` protocol itself is suitable for stateless HTTP infrastructure: each Streamable HTTP request is an independent POST, protocol-level sessions were removed, and routing metadata is carried in headers. That solves the transport session problem, but it does not make KnowledgeRail's application state stateless.

Official references:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [TypeScript SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)

## Current blockers

| Area | Current implementation | Required for remote/serverless |
| --- | --- | --- |
| Transport | `stdio` entry point only | A separate MCP `2026-07-28` Streamable HTTP entry point with header/body validation, request cancellation, Origin policy, CORS where needed, and bounded request bodies. |
| Workspace identity | One process-global root selected from `WIKI_ROOT` or cwd | An authenticated tenant/workspace identifier on every operation; no process-global mutable workspace. |
| Storage | Node filesystem under `wiki/` and `docs/` | A storage interface backed by durable object storage and/or a database, with atomic compare-and-set semantics. |
| Concurrency | In-process maps and path locks | Distributed locking, optimistic concurrency/version checks, idempotency keys, and conflict reporting. |
| Caches/indexes | In-memory caches plus local derived files | Tenant-scoped caches and durable index snapshots that any instance can load or rebuild safely. |
| Authentication | Trust boundary is the local MCP process | OAuth 2.1 resource-server behavior, Protected Resource Metadata, audience validation, least-privilege read/write/admin scopes, and per-request authorization. |
| Long operations | OCR, ingestion, indexing, and DOCX run inline | Durable jobs or MCP Tasks for work that can exceed function limits, with cancellation, retries, and persisted results. |
| Binary tooling | Puppeteer/Chromium, PDF conversion, local temp files | A container runtime with writable ephemeral storage and adequate memory; isolate document rendering from the request path. |
| Operations | Local stderr and no quotas | Structured logs, traces, metrics, audit records, rate limits, quotas, retention rules, backups, and disaster recovery. |

## Recommended first remote architecture

The lowest-risk first target is a serverless container rather than an edge function:

1. Keep the existing `stdio` entry point for local use and add a separate Streamable HTTP adapter.
2. Extract filesystem access behind a tenant-aware storage interface.
3. Store canonical sources/pages in object storage and metadata, leases, idempotency records, and index manifests in a transactional database.
4. Run OCR, full ingestion, index rebuilds, and DOCX/Mermaid export in a durable worker queue.
5. Put an OAuth-aware gateway in front of the MCP endpoint and enforce operation-specific scopes.
6. Add multi-tenant isolation, concurrency, retry, cold-start, and failure-recovery tests before advertising the endpoint.

An edge-only runtime is not a good initial fit because the current implementation depends on Node filesystem APIs, Chromium/Puppeteer, PDF conversion, and potentially long-running work. Reads can become stateless first; mutations require durable storage and distributed concurrency controls before horizontal scaling is safe.

## Definition of remote-ready

KnowledgeRail should be described as remote/serverless-ready only when all of the following are true:

- the public endpoint passes MCP `2026-07-28` Streamable HTTP conformance tests;
- every request is authenticated and authorized for one tenant and workspace;
- two instances can process concurrent reads and writes without cross-tenant data exposure or lost updates;
- retries are idempotent and interrupted jobs can resume or fail cleanly;
- no canonical data depends on local process memory or ephemeral disk;
- rendering and OCR workloads are isolated and resource-limited;
- backup/restore, observability, rate limiting, and abuse controls have automated tests;
- local `stdio` behavior and all existing quality gates remain unchanged.
