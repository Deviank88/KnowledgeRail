# Claude Code hooks integration

Requires `knowledge-rail` ≥ 2.5.0 (the `drift` CLI subcommand).

When a project is worked on with Claude Code, the recommended division of labor between the harness and the model is:

- **Drift and awareness run from hooks** — deterministic, read-only, guaranteed to execute: a session-start drift summary, a per-edit path-scoped check, and a stop-time reminder. Hooks are the right home because their value is running *every time*, not when the model remembers.
- **Retrieval stays with the model** — hooks make Claude aware the wiki exists; `CLAUDE.md` tells it *when* to call `knowledge_context`. Deliberately no auto-retrieval on every prompt: deciding whether a task needs wiki context, and which, requires the model's judgment, and indiscriminate injection wastes tokens on trivial turns.
- **Decision relevance stays with the model** — Claude inspects returned decision metadata and materializes only a link matching the current flow/component/context, normally its selected passage. A single bounded page is the fallback only when that relevant hit has no reliable passage; no matching decision means no decision read and no gap.
- **Writes stay gated and consolidated** — hooks never write the wiki (authoring wiki content requires editorial judgment, which a shell hook cannot supply); write-capable tools stay behind the permission prompt. After source changes, Claude updates affected knowledge in the same session. If a durable choice becomes clearly accepted, it performs one end-of-task decision-page update and one `DECISION` log write instead of interrupting the discussion with capture prompts.

## Setup prompt

Paste this prompt into Claude Code inside your project to configure the flow:

```text
Configure this repository's Claude Code harness to integrate the
KnowledgeRail wiki. Work only in project scope (.claude/settings.json,
CLAUDE.md); do not touch user-level settings and do not commit anything.
Read the current Claude Code hooks documentation before writing any hook
(event names, stdin JSON shape, context-injection semantics, matcher
syntax) — do not work from memory. Verify `npx -y knowledge-rail@2.6.0 drift --help`
works before wiring it into any hook.

1. HOOKS in .claude/settings.json (all fail-open; each under ~5s):
   - SessionStart: run `npx -y knowledge-rail@2.6.0 drift --no-ledger` so its
     summary lands in context (it prints nothing when all anchors are
     fresh), prefixed with one line stating the project has a KnowledgeRail
     wiki and that task work should start with knowledge_context mode=task.
   - PostToolUse with a matcher for Edit and Write: extract the edited
     file_path from the hook's stdin JSON and run
     `npx -y knowledge-rail@2.6.0 drift --no-ledger --path <file>` so a broken
     anchor is reported in the same turn as the edit that broke it.
   - Stop: deterministic check only — if git status shows modified source
     files in this session AND no wiki content change accompanied them,
     emit ONE short reminder that the wiki pages covering those files may
     need updating. Never write the wiki from this hook.

2. PERMISSIONS in .claude/settings.json: allowlist ONLY the KnowledgeRail
   MCP tools that are entirely read-only, verifying each tool's actions
   from its schema first. A tool that multiplexes read and write actions
   (e.g. knowledge_page or knowledge_admin) must NOT be allowlisted.
   knowledge_document and knowledge_ingest must never be allowlisted: the
   permission prompt on write-capable tools IS the user's operational
   consent for an end-of-task wiki update during analysis sessions.

3. CLAUDE.md (create or extend, keeping existing content): add a concise
   "Project wiki (KnowledgeRail)" section stating that (a) concrete tasks
   start with knowledge_context mode=task and follow its nextAction;
   (b) pages flagged stale/drift_suspected by the session drift summary
   are untrusted until re-verified against the code; (c) after modifying
   source files as part of a task, Claude updates the wiki pages whose
   evidence anchors those files in the same session, without being asked;
   (d) Claude inspects decision titles, headings, retrieval reasons and
   change-impact relations, then materializes only an exact relevant link,
   preferring its selected passage; it reads the single bounded page only
   if that hit has no passage, never opens all decisions, and treats no
   matching decision as a normal empty result rather than a gap; if the bounded
   page is truncated it retrieves only the missing section and never blindly
   overwrites unread content; conflicting matches are surfaced rather than silently
   rank-selected; (e) when a durable
   project choice is clearly accepted, Claude first rereads and reuses a matching
   decision page for the same flow/component/context (or creates a separate
   bounded page for a different context), updates its current decision, concise rationale and
   dated history with what changed and why at task close, then appends one log entry at level
   DECISION; (f) Claude never records proposals, unresolved options, raw
   conversation, hidden chain-of-thought, secrets, or consent inferred
   from silence; (g) if no durable decision arose, or the session has no
   permission to write, Claude writes nothing and reports any proposed
   update once in its final response.

4. VERIFY, then report: run the drift command in both modes by hand; make
   a throwaway edit to confirm the PostToolUse hook fires and revert it;
   confirm the Stop reminder fires only when source changed without a wiki
   change; confirm a read-only knowledge tool runs unprompted while a
   knowledge_page write and knowledge_document write ask for permission.
   Confirm that a simulated accepted decision produces one page update and
   one DECISION log entry, while an unresolved discussion produces neither.
   Report what was configured, measured hook latencies, and anything not
   verifiable.

Constraints: hooks are read-only reporters (never write the wiki, never
block a tool call); every hook exits 0; keep SessionStart under ~3s and
per-edit under ~1s; no new dependencies; commit nothing.
```

## Notes

- The drift hooks rely on the `knowledge-rail drift` subcommand being silent and exit-0 when everything is fresh, so a healthy project adds zero noise and zero blocked turns. `--path` accepts the hook's absolute `file_path` only when it is confined to the discovered project; repository-relative paths also work. For CI or pre-commit use `--check`, which exits `2` on any non-fresh anchor or timeout.
- The permission split works because KnowledgeRail's read surfaces (`knowledge_context`, `knowledge_code`, …) are separate tools from the write surfaces (`knowledge_document`, `knowledge_ingest`). `knowledge_admin` multiplexes read-only drift with administrative mutations, so it stays behind the prompt; use the CLI subcommand where unprompted drift is needed.
