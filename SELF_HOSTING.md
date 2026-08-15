# Local self-hosting and future remote architecture

KnowledgeRail ships a local, self-hosted multi-workspace gateway. It does not ship or operate a hosted service.

## What is available now

`knowledge-rail --transport http` starts an MCP 2.x Streamable HTTP endpoint on `127.0.0.1:3333/mcp` by default. It uses the official per-request MCP handler and has no process-global project root. One gateway can serve concurrent clients working on different local projects because every filesystem-capable request is resolved to an immutable `WorkspaceContext` first.

The local architecture is:

```text
IDE/terminal process --stdio + automatic cwd/root--> one bound workspace

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

## What is deliberately not available

The shipped HTTP gateway is not a public endpoint, OAuth resource server, managed relay, AWS service, or multi-tenant SaaS. Claude remote custom connectors and `claude.ai` cannot reach a user's localhost endpoint because their requests originate in the provider cloud. Use the local Claude Desktop MCP adapter.

Do not expose the loopback service through a public tunnel or ad-hoc reverse proxy. A static local bearer token is not sufficient for internet-facing authorization, tenant isolation, audit, abuse protection, or distributed consistency.

## Possible future remote architecture

A future remote mode can preserve the same request-scoped workspace contract while replacing local filesystem access. It would require, at minimum:

1. OAuth 2.1 resource-server behavior with audience validation and explicit read/write/admin scopes.
2. A tenant-aware storage interface backed by durable object storage and transactional metadata rather than arbitrary server-local paths.
3. Distributed concurrency control, optimistic versions, idempotency keys, and deterministic conflict handling.
4. Durable queues for OCR, indexing, ingestion, DOCX, and Mermaid/Chromium workloads.
5. Tenant-scoped caches and index snapshots that can be rebuilt safely by any instance.
6. Rate limits, quotas, structured audit records, redacted telemetry, backups, restore tests, and incident procedures.
7. End-to-end tests proving cross-tenant isolation, cancellation, retry safety, and behavior across rolling versions.

A serverless container is a more realistic first remote target than an edge function because current document workflows use Node filesystem APIs, Chromium, PDF conversion, and potentially long-running operations. None of this future work is implied by the local gateway.

## Remote-ready definition

KnowledgeRail should be described as remote-ready only after a public deployment passes MCP conformance and proves per-request authentication/authorization, multi-instance mutation safety, durable jobs, tenant isolation, operational controls, and backup/restore. Until then, public URLs and hosted-service claims are out of scope.

Official background:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
