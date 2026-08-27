# Milestone — 2.7.0: project-scoped client hooks and rules

Status: implementation complete; remote CI/client activation pending
Target release: `2.7.0`
Scope: Claude Code, Codex and Cursor project integrations

## Outcome

Replace the copy/paste setup prompt in [`docs/guides/claude-code-hooks.md`](../guides/claude-code-hooks.md) with a first-party, explicit and idempotent KnowledgeRail operation. A user can ask the connected LLM to configure the currently bound project; the LLM calls:

```text
knowledge_admin action="client_setup" clients=["claude","codex","cursor"] setup_mode="preview"
knowledge_admin action="client_setup" clients=["claude","codex","cursor"] setup_mode="apply"
```

The equivalent terminal flow is:

```text
knowledge-rail setup clients --client claude --client codex --client cursor
knowledge-rail setup clients --client claude --client codex --client cursor --apply
```

Preview is the default. Ordinary `knowledge_admin action="init"` never installs executable hooks implicitly.

## Non-negotiable boundary

- Write only below the canonical project root selected by the current MCP binding or CLI workspace discovery.
- Never modify `~/.claude`, `~/.codex`, `~/.cursor`, system policy, team policy or enterprise-managed configuration.
- Never approve trust prompts or weaken sandbox/permission policy.
- Refuse symlinked parents/files, non-regular files, malformed JSON, oversized configuration and paths resolving outside the project.
- Preserve existing `CLAUDE.md`, `AGENTS.md` and Cursor rule bytes, appending the managed block when absent and replacing only that block on updates. Preserve every unmanaged JSON field and hook in semantic value through structural merge.
- Require write scope for apply and checkpoint persistence; preview/status must remain usable through a read-scoped catalog binding.
- Before apply, create a restricted project-local transaction manifest and exact backups of every pre-existing file that will change. Refuse concurrent target changes, retain the newest 20 validated successful runs, and never retention-prune incomplete, rolled-back, failed or unrecognized recovery evidence.
- Hooks are read-only, bounded and fail-open. Wiki authoring remains an explicit LLM/tool action approved by the user.
- No automatic commit.

## Verified client surfaces

The implementation is pinned to official documentation reviewed on 2026-08-28:

| Client | Static project guidance | Project hook configuration | Activation constraint |
|---|---|---|---|
| Claude Code | `CLAUDE.md` or `.claude/CLAUDE.md`; optional `.claude/rules/*.md` | `.claude/settings.json` | Project hooks execute with user privileges; preserve permissions and unrelated settings. |
| Codex | root/nested `AGENTS.md` | `.codex/hooks.json` | Every non-managed hook definition requires explicit review/trust; KnowledgeRail reports this remaining step. |
| Cursor | `.cursor/rules/*.mdc` or root `AGENTS.md` | `.cursor/hooks.json` schema version 1 | Project hooks run only in trusted workspaces; cloud support differs for session lifecycle events. |

Official references:

- Claude hooks: <https://code.claude.com/docs/en/hooks>
- Claude project memory/rules: <https://code.claude.com/docs/en/memory>
- Codex hooks: <https://learn.chatgpt.com/docs/hooks>
- Codex `AGENTS.md`: <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Cursor hooks: <https://prod.cursor.com/docs/hooks>
- Cursor rules: <https://prod.cursor.com/docs/rules>

This supersedes the earlier exploration note that Cursor had no established lifecycle-hook contract.

## Generated contract

### Shared behavior

Every client receives concise project guidance stating that:

1. concrete tasks begin with `knowledge_context mode=task` and follow `nextAction`;
2. stale or drift-suspected evidence is untrusted until reverified;
3. source edits are followed by an in-session update of affected anchored knowledge, with explicit write approval;
4. only the relevant decision passage or one bounded page is materialized;
5. conflicts are surfaced, not silently rank-selected;
6. only clearly accepted durable decisions are recorded;
7. proposals, unresolved options, raw conversation, hidden reasoning and secrets are never persisted.

Managed marker pairs make static instruction updates idempotent across Claude Code, Codex and Cursor. Existing instruction content is appended to, never overwritten; malformed or half-present markers fail closed.

### Hook bridge

Generated configurations call the version-pinned package:

```text
npx --yes --prefer-offline knowledge-rail@2.7.0 hook --client <client> --event <event>
```

The bridge reads the client's stdin JSON, normalizes an edited `file_path` when present, invokes the read-only drift detector with `--no-ledger`, emits the native output schema for that client, stays silent when healthy except for session awareness, and always fails open.

Events:

- session start: bounded full drift summary plus KnowledgeRail task-awareness context;
- post edit/tool: one-second path-scoped drift check when the client supplies a file path;
- stop: deterministic final drift/reminder on clients whose stop output is advisory; it must never create an automatic Cursor loop.

### Files

| Client | Files managed |
|---|---|
| Claude Code | `CLAUDE.md`, `.claude/settings.json` |
| Codex | `AGENTS.md`, `.codex/hooks.json` |
| Cursor | `.cursor/rules/knowledge-rail.mdc`, `.cursor/hooks.json` |

## Delivery stages

- [x] **M1 — Contract verification and threat model**
  - Recheck official hook/rule locations, event names, stdin and stdout schemas.
  - Make project-only scope and trust boundaries explicit.
- [x] **M2 — Deterministic planning and merge engine**
  - Add `preview`, `apply` and `status` modes.
  - Preserve unmanaged JSON and Markdown; add only exact version-pinned managed entries.
  - Reject unsafe filesystem/configuration state.
  - Persist a checksummed project-local recovery transaction before changing existing configuration.
  - Bound ordinary accumulation to the newest 20 validated `applied` transactions without pruning recovery exceptions.
- [x] **M3 — LLM and CLI surfaces**
  - Add `knowledge_admin action="client_setup"` with explicit client targets.
  - Add `knowledge-rail setup clients` and the internal hook bridge.
- [ ] **M4 — Verification matrix**
  - [x] Unit-test create, merge, upgrade replacement, idempotency, malformed JSON, conflicts, symlinks and project confinement.
  - [x] Contract-test native hook configuration, input/output and non-blocking/fail-open behavior across all clients; Codex event names, matcher groups and handler shape match the official hooks reference.
  - [x] Verify existing unrelated hooks, settings and Markdown survive.
  - [x] Exercise preview, apply, six generated project files and reapply from the packed npm artifact on macOS.
  - [ ] Confirm the existing installed-package CI matrix on Linux/macOS/Windows and perform client-side trust inspection; automation must not approve either step.
- [x] **M5 — Documentation migration**
  - Replace the copy/paste-first guide with direct LLM and CLI setup.
  - Retire the former prompt; repository history remains the troubleshooting fallback without keeping a second mutable contract.
  - Document preview/apply, generated files, trust steps, manual removal/reapply behavior and client limitations.

## Acceptance gates

1. A plain-language user request can cause the LLM to preview and, after explicit apply intent, configure any subset of the three clients without prompt copy/paste.
2. `init` without client targets changes none of the integration files.
3. Preview is byte-identical on disk and returns every proposed project-relative file and content hash.
4. Reapplying the same version produces zero changes and zero duplicate hooks/managed blocks.
5. Existing valid hooks, permissions, rules and unknown JSON fields survive semantic equality.
6. Unsafe, concurrently changed or ambiguous state produces no partial write; apply leaves a project-local recovery manifest while preview/status/no-op do not, and retention never removes exceptional recovery states.
7. Every installed hook is read-only, bounded, version-pinned and fail-open.
8. Codex and Cursor results explicitly report remaining project trust/review rather than claiming activation.
9. No user/global configuration path is ever accepted or written.
10. `npm run verify`, the hook contract suite, quality gates and package smoke pass before release.
11. A read-scoped catalog binding can preview client setup but cannot apply it or persist checkpoints.

## Deferred beyond 2.7.0

- User/global and enterprise-managed installation.
- Automatic trust approval.
- Writing wiki content directly from hooks.
- Auto-installation as an implicit side effect of ordinary initialization.
- Distribution as native marketplace plugins; the project-scoped installer remains the portable baseline.

## Local closure evidence — 2026-08-28

- `npm run verify`: PASS, all 61 test files.
- `npm run eval:gates`: PASS, all 15 quality gates; MCP routing accuracy `1.0`, catalog reduced from `13,999` to `13,266` bytes while retaining the advertised `resultText` contract. Redundant root `$schema` annotations were removed without changing Zod validation, public integers now expose meaningful bounds, and the enforced ceiling is tightened from `14,000` to `13,500` bytes.
- `npm run eval:phrase:ab`: PASS / `GO`; production bigram held-out NDCG@5 `0.7651 -> 0.9664`, passage accuracy `0.1818 -> 0.9091`, critical Top-1 `0.25 -> 1.0`, zero per-query regressions.
- `npm run package:smoke`: PASS on the installed tarball, including client preview/apply/reapply, exact recovery of pre-existing project instructions, a safe project-relative manifest and no backup on the idempotent reapply. The latest macOS arm64 ready times were stdio `310.11 ms`, existing desktop `159.00 ms`, cold desktop `314.98 ms`. Failure diagnostics distinguish gateway recovery from contract projection without exposing bindings.
- `npm run mcpb:smoke`: PASS; desktop ready in `330.35 ms`. Artifact hashes remain release outputs rather than self-referential content embedded inside the packaged milestone.
- `npm run release:verify -- v2.7.0`: PASS.
- `git diff --check`: PASS.

The implementation is ready for repository CI. The milestone remains partially open only for results that cannot be truthfully produced locally: Linux/Windows runners and each client's own trust/review UI.
