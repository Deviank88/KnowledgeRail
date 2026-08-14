# Security policy

## Supported versions

Security fixes are provided for the latest `4.x` release line. Pre-release users should test the latest commit on the default development branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private [GitHub security advisory form](https://github.com/Deviank88/KnowledgeRail/security/advisories/new) and include:

- affected version or commit;
- operating system and Node.js version;
- reproduction steps or a minimal proof of concept;
- expected impact and any known workaround.

Please avoid accessing data that is not yours and do not publish details before a fix is available.

## Current trust boundary

KnowledgeRail is currently a local `stdio` MCP server. Its tools can read and modify files under the selected workspace, and optional providers can receive source text or document images when explicitly configured. Review MCP tool calls and provider privacy terms before using it with sensitive repositories.

There is no supported public HTTP endpoint. Exposing the process through an ad-hoc network wrapper bypasses the authentication, tenant isolation, Origin validation, rate limiting, and distributed concurrency work listed in [SERVERLESS.md](SERVERLESS.md).

Keep secrets in environment variables, never in wiki pages, source documents, MCP configuration committed to Git, logs, or issue reports. `KNOWLEDGE_RAIL_MERMAID_NO_SANDBOX=true` weakens Chromium isolation and should only be used in a separately sandboxed CI/container environment.
