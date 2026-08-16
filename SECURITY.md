# Security policy

## Supported versions

Security fixes are provided for the latest `2.x` release line. Pre-release users should test the exact reviewed commit on the default development branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private [GitHub security advisory form](https://github.com/Deviank88/KnowledgeRail/security/advisories/new) and include:

- affected version or commit;
- operating system and Node.js version;
- reproduction steps or a minimal proof of concept;
- expected impact and any known workaround.

Please avoid accessing data that is not yours and do not publish details before a fix is available.

## Current trust boundary

KnowledgeRail is local-first. Bound IDE/terminal `stdio` processes infer one project independently; the self-hosted loopback HTTP gateway resolves an opaque workspace binding on every filesystem-capable request; context-free desktop chats select from an approved local catalog. Its tools can read and modify files under the selected workspace, and optional providers can receive source text or document images when explicitly configured. Review MCP tool calls and provider privacy terms before using it with sensitive repositories.

The shipped HTTP mode authenticates requests but accepts loopback binding only. It is not a public endpoint, OAuth deployment, or hostile-user multi-tenant service. Exposing it through an ad-hoc tunnel or reverse proxy bypasses the controls required in [SELF_HOSTING.md](SELF_HOSTING.md).

Workspace IDs and bindings are capabilities, not display-only metadata. Do not paste them into issues, logs, shared prompts, analytics, or repositories. The gateway credential and registry live in the protected per-user state directory, never under a project. Catalog selection prevents model-authored arbitrary paths; it does not make prompt injection harmless. Confirm the displayed workspace and requested scope before approving `knowledge_workspace select`, and prefer a new chat when changing customer context.

The gateway validates canonical roots again when a binding is used. Missing, malformed, expired, released, wrong-principal, read-only, unavailable, or substituted workspace bindings fail before path access. Resource links are binding-qualified and revalidated at read time. Please report any case where one concurrent workspace can observe or mutate another as a security vulnerability.

Keep secrets in environment variables, never in wiki pages, source documents, MCP configuration committed to Git, logs, or issue reports. KnowledgeRail ships no browser renderer. Document review uses an exact-pinned CommonMark/GFM tokenizer to classify source without rewriting it. Mermaid is validated as source, and referenced SVG/PNG assets must remain below `docs/assets`; active Mermaid or SVG content, executable or private URI schemes, path escapes, invalid signatures, and oversized validated assets are review blockers. Remote images and other local image formats are reported as portability warnings; those formats do not receive SVG/PNG signature or active-content guarantees.
