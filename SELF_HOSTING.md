# Local self-hosting and future remote architecture

KnowledgeRail ships a local, self-hosted multi-workspace gateway. It does not ship or operate a hosted service.

## What is available now

`knowledge-rail --transport http` starts an MCP 2.x Streamable HTTP endpoint on `127.0.0.1:3333/mcp` by default. It uses the official per-request MCP handler and has no process-global project root. One gateway can serve concurrent clients working on different local projects because every filesystem-capable request is resolved to an immutable `WorkspaceContext` first.

The local architecture is:

```text
Cursor project process --stdio + explicit workspace root--> one bound workspace
cwd-aware IDE/terminal --stdio + automatic cwd/root-----> one bound workspace

desktop chat --stdio adapter--\
local HTTP client ----------+--> loopback gateway --> binding A --> project A
                             \                    \-> binding B --> project B
```

The desktop adapter discovers or starts the gateway, reads its protected local credential, and forwards MCP calls. It never selects a project from the desktop application's cwd. The chat lists user-approved workspaces and carries an opaque binding returned by `knowledge_workspace`.

### Local trust and security boundary

- The gateway binds to loopback and rejects non-loopback hosts in this release.
- MCP requests require a random bearer credential stored outside repositories with per-user filesystem permissions.
- Host and Origin headers are allowlisted; CORS and wildcard origins are not enabled.
- Request bodies and timeouts are bounded, and logs exclude roots, request bodies, bindings, credentials, and wiki content.
- Workspace registrations contain canonical local roots, but MCP catalog responses expose only random IDs, display names, a short disambiguator, availability, and allowed scopes.
- Bindings are random capabilities scoped to a workspace, local adapter principal, access level, expiry, and maximum lifetime. Releasing or restarting the gateway invalidates them.
- A resource link contains the same opaque capability so `resources/read` can revalidate the workspace instead of consulting mutable server state.

This protects concurrent projects inside one local user's trust boundary. When a host does not provide a trustworthy conversation identity, the model-visible opaque binding provides logical per-chat isolation; it is not isolation between hostile operating-system users. A new chat is recommended when switching customers because KnowledgeRail cannot erase earlier conversation history.

### Local lifecycle and state

The owner-protected rendezvous record contains the endpoint, process identity nonce, product/protocol version, binding format, and registry schema version. The credential is stored separately. Desktop adapters validate health and exact compatibility before reuse and never replace a healthy gateway started by another process.

The state directory follows native conventions:

- Windows: `%LOCALAPPDATA%\KnowledgeRail`
- macOS: `~/Library/Application Support/KnowledgeRail`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/knowledge-rail`

`KNOWLEDGE_RAIL_STATE_DIR` is available for tests and intentional custom local deployments. State must not be committed with a project.

## Pre-commit and CI drift checks

`knowledge_admin action="drift"` is an MCP operation, not a shell subcommand. A hook or CI job should use the same authenticated/local MCP client runner already used by the team, call the operation, and fail or comment when `structuredContent.summary.driftSuspected` is greater than zero. KnowledgeRail deliberately does not bundle a second command-line transport for this check.

A pre-commit integration should:

1. Collect staged repository-relative paths with `git diff --cached --name-only --diff-filter=ACMR`.
2. Call `knowledge_admin` with `{"action":"drift","scope":"paths","paths":[...]}` through the local MCP runner.
3. Block the commit when the summary reports drift, showing `topDrifted` claim IDs, pages, ranges, and reasons.
4. Re-verify those claims through the normal Evidence IR workflow; never rewrite a wiki page automatically from the hook.

A CI integration uses the same payload with paths changed relative to the target branch. It can publish `topDrifted` as a review annotation and should fail the job on `driftSuspected > 0` or `anchorUnresolvable > 0`. For a periodic repository-wide audit, use `{"action":"drift"}`. The operation mutates only the disposable `wiki/.knowledge-rail/drift/ledger.json`; canonical pages, claims, and repository files remain byte-preserved.

Do not share or hard-code the loopback gateway credential in CI. Prefer a job-local `stdio` server bound to the checked-out workspace, or provision the protected local gateway state using the same trust boundary described above.

## What is deliberately not available

The shipped HTTP gateway is not a public endpoint, OAuth resource server, managed relay, AWS service, or multi-tenant SaaS. Claude remote custom connectors and `claude.ai` cannot reach a user's localhost endpoint because their requests originate in the provider cloud. Use the local Claude Desktop MCP adapter.

Do not expose the loopback service through a public tunnel or ad-hoc reverse proxy. A static local bearer token is not sufficient for internet-facing authorization, tenant isolation, audit, abuse protection, or distributed consistency.

## Possible future remote architecture

A future remote mode can preserve the same request-scoped workspace contract while replacing local filesystem access. It would require, at minimum:

1. OAuth 2.1 resource-server behavior with audience validation and explicit read/write/admin scopes.
2. A tenant-aware storage interface backed by durable object storage and transactional metadata rather than arbitrary server-local paths.
3. Distributed concurrency control, optimistic versions, idempotency keys, and deterministic conflict handling.
4. Durable queues for OCR, indexing, ingestion, and other long-running evidence workloads.
5. Tenant-scoped caches and index snapshots that can be rebuilt safely by any instance.
6. Rate limits, quotas, structured audit records, redacted telemetry, backups, restore tests, and incident procedures.
7. End-to-end tests proving cross-tenant isolation, cancellation, retry safety, and behavior across rolling versions.

A serverless container is a more realistic first remote target than an edge function because current workflows use Node filesystem APIs, local indexing, PDF ingestion, and potentially long-running operations. None of this future work is implied by the local gateway.

## Remote-ready definition

KnowledgeRail should be described as remote-ready only after a public deployment passes MCP conformance and proves per-request authentication/authorization, multi-instance mutation safety, durable jobs, tenant isolation, operational controls, and backup/restore. Until then, public URLs and hosted-service claims are out of scope.

Official background:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)


## First start after upgrading to 2.7.4

The first wiki query after upgrading rebuilds the lexical retrieval index from
canonical Markdown because the passage builder changed. In the local synthetic
100,000-page benchmark this took about 14 seconds; allow for that one-time delay
before treating the first request as stalled. Subsequent starts reuse the new
checkpoint when persistence is enabled. Read-only operation without persisting
the replacement checkpoint repeats the rebuild in later processes. Canonical
Markdown and code-evidence snapshots do not require migration.

The TypeScript/JavaScript adapter also advances to v3 to correct function ranges
with destructured or object-typed parameters. The next code-index refresh reparses
files owned by that adapter, including its LWC metadata companions; other language
files remain reusable. Existing code anchors retain their recorded parser version
and may need recapture after a drift check. The import resolver refactor itself
does not invalidate persisted files.

## Memory and workspace lifetime

Code-query caches have an independent estimated admission budget of 32 MiB per
project. The process retains up to 32 workspace states by default; set
`KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP` to a positive integer to change that LRU cap.
At the default cap, estimated admissions can sum to 1,024 MiB. This is not reserved
memory or a limit on measured heap/RSS: uncached large snapshots, in-flight work,
result copies and other indexes consume additional memory. Multiple server
processes each have their own state.

There is no idle TTL. Internal writes invalidate the affected generation;
external changes are checked on the next query. Workspace release and automatic
LRU eviction discard its disposable state. An idle workspace does not notice an
external edit until another query. See the [cache measurements and lifecycle](benchmarks/README.md#code-evidence-queries)
for the distinction between admission estimates, heap and RSS.
