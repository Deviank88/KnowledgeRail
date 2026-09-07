# Project client hooks and rules

Requires KnowledgeRail 2.7.0 or later.

KnowledgeRail can configure Claude Code, Codex and Cursor directly in the open project. You no longer need to copy a setup prompt into each client.

## Ask the knowledge

In a client connected to the project, ask:

> Preview the KnowledgeRail hooks and project rules for Claude Code, Codex and Cursor. Do not change global configuration.

The model calls:

```text
knowledge_admin action="client_setup" clients=["claude","codex","cursor"] setup_mode="preview"
```

After reviewing the proposed project-relative files, explicitly ask it to apply the setup. The model then calls the same action with `setup_mode="apply"`.

Ordinary `knowledge_admin action="init"` does not install executable hooks. Setup is always a separate, explicit operation.

## Terminal equivalent

Preview all clients:

```bash
npx -y knowledge-rail@2.8.0 setup clients
```

Apply all clients:

```bash
npx -y knowledge-rail@2.8.0 setup clients --apply
```

Select one or more clients with repeated `--client` flags:

```bash
npx -y knowledge-rail@2.8.0 setup clients --client claude --client codex --apply
```

An optional project path may follow `clients`. Without it, KnowledgeRail discovers the current project safely.

## Project files

| Client | Static rules | Hooks |
|---|---|---|
| Claude Code | `CLAUDE.md` | `.claude/settings.json` |
| Codex | `AGENTS.md` | `.codex/hooks.json` |
| Cursor | `.cursor/rules/knowledge-rail.mdc` | `.cursor/hooks.json` |

The installer first checks every target. Existing `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/knowledge-rail.mdc` content is preserved byte-for-byte and the marked KnowledgeRail block is appended. On reapply or upgrade, only that marked block is replaced. Existing JSON settings are merged structurally so unrelated fields, permissions and hooks survive; raw text is never appended to JSON because that would make it invalid. The installer refuses malformed JSON or managed markers, symlinks, non-regular files, oversized configuration and paths outside the project. Reapplying the same version is idempotent.

Immediately before an apply that would change files, KnowledgeRail creates a project-local transaction under `.knowledge-rail/backups/client-setup/<run-id>/`. Its `manifest.json` records every target, whether it existed, its original SHA-256, byte count, mode and backup path. Exact bytes are copied only for pre-existing files. The manifest state distinguishes a prepared, successfully applied, rolled-back or incompletely rolled-back transaction. On POSIX systems the transaction directory is mode `0700` and backup files are mode `0600`. Preview, status and no-op reapply create no backup. After a successful apply, only the oldest validated `applied` transactions beyond the newest 20 are pruned; prepared, rolled-back, rollback-failed, malformed and otherwise unrecognized entries are left untouched for recovery or diagnosis. If setup is interrupted, use the manifest to restore the listed backup files and remove only entries marked `existed: false`; inspect current files first and never overwrite later user edits blindly.

No file under `~/.claude`, `~/.codex` or `~/.cursor` is touched. No configuration is committed automatically.

In the desktop/catalog profile, `setup_mode="apply"` requires a write-scoped workspace binding. `preview` and `status` remain available with read scope. `knowledge_admin action="checkpoint"` also requires write scope because it persists project-local derived indexes even though canonical Markdown remains unchanged.

## Runtime behavior

- Session start injects a short KnowledgeRail awareness message and reports non-fresh evidence anchors.
- Post-edit hooks run a bounded, path-scoped drift check when the client provides the edited file path.
- Hooks never write the wiki, never approve operations and fail open.
- Retrieval and decision relevance remain model judgments through `knowledge_context`.
- Wiki updates remain explicit write-capable tool calls subject to the client permission flow.

The generated commands pin the installed KnowledgeRail release, prefer the local npm cache, and use the internal cross-client hook bridge, which translates each client's stdin and output schema. The first hook invocation may still need npm to resolve the package if it is not cached; hook failures and timeouts remain fail-open.

## Trust and verification

Project hooks execute commands and therefore remain subject to each client's security controls:

- Claude Code: inspect project hooks with `/hooks`.
- Codex: open `/hooks`, review the exact definitions and explicitly trust their current hashes. KnowledgeRail cannot do this for you.
- Cursor: open the repository as a trusted workspace and inspect `.cursor/hooks.json`.

Run the preview again after application. Every file should report `unchanged`. Then start a new session and make a harmless edit to a source file with an evidence anchor; the post-edit hook should report drift without blocking the edit or modifying the wiki.

Cursor cloud agents load project hooks only after they receive a writable environment, and do not currently run `sessionStart`; post-tool hooks remain available there.

## Reapply or remove

Reapply with `setup clients --apply` after upgrading KnowledgeRail. The installer removes only older KnowledgeRail hook commands for the same client/event before adding the version-pinned replacement; unrelated handlers and settings survive.

There is deliberately no automatic uninstall in 2.7.0. To remove the integration, first preview the current generated state, then delete only the marked KnowledgeRail block from `CLAUDE.md` and `AGENTS.md`, the dedicated `.cursor/rules/knowledge-rail.mdc` file, and the hook entries whose command contains `knowledge-rail@... hook --client ...`. Remove the two Claude read-only permission entries only if they were added solely for this integration. Do not delete whole configuration files when they contain unrelated settings.

## What the installed rules say

The concise managed block instructs the client to start concrete tasks with `knowledge_context mode=task`, distrust stale evidence until reverified, update affected anchored knowledge after source changes only through approved writes, materialize only relevant decision evidence, surface conflicts and record only clearly accepted durable decisions. It explicitly excludes proposals, unresolved options, hidden reasoning, secrets and raw conversation.
