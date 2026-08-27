import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  CLIENT_SETUP_APPLIED_BACKUP_RETENTION,
  configureClientIntegrations,
} from "../src/core/client-integration.js";
import { PRODUCT_VERSION } from "../src/product.js";

test("client integration previews without writes, applies only project files, and is idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-setup-"));
  try {
    const existingClaude = "# Existing Claude instructions\n";
    const existingCodex = "# Existing Codex instructions\n";
    const existingCursor = "---\ndescription: Existing Cursor instructions\nalwaysApply: true\n---\n# Existing Cursor rule\n";
    await fs.writeFile(path.join(root, "CLAUDE.md"), existingClaude);
    await fs.writeFile(path.join(root, "AGENTS.md"), existingCodex);
    await fs.mkdir(path.join(root, ".claude"));
    await fs.writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
    await fs.mkdir(path.join(root, ".cursor", "rules"), { recursive: true });
    await fs.writeFile(path.join(root, ".cursor", "rules", "knowledge-rail.mdc"), existingCursor);
    const preview = await configureClientIntegrations({ projectRoot: root, clients: ["claude", "codex", "cursor"], mode: "preview" });
    assert.equal(preview.applied, false);
    assert.equal(await fs.access(path.join(root, ".codex", "hooks.json")).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(root, ".knowledge-rail")).then(() => true, () => false), false);

    const applied = await configureClientIntegrations({ projectRoot: root, clients: ["claude", "codex", "cursor"], mode: "apply" });
    assert.equal(applied.changes.filter((item) => item.status !== "unchanged").length, 6);
    assert.ok(applied.backup);
    assert.equal(applied.backup.fileCount, 4);
    const backupDirectory = path.join(root, ...applied.backup.directory.split("/"));
    const backupManifest = JSON.parse(await fs.readFile(
      path.join(root, ...applied.backup.manifest.split("/")),
      "utf8"
    ));
    assert.equal(backupManifest.state, "applied");
    assert.equal(backupManifest.files.length, 6);
    assert.equal(backupManifest.files.filter((entry: { existed: boolean }) => entry.existed).length, 4);
    assert.equal(await fs.readFile(path.join(backupDirectory, "files", "CLAUDE.md"), "utf8"), existingClaude);
    assert.equal(await fs.readFile(path.join(backupDirectory, "files", "AGENTS.md"), "utf8"), existingCodex);
    assert.equal(
      await fs.readFile(path.join(backupDirectory, "files", ".cursor", "rules", "knowledge-rail.mdc"), "utf8"),
      existingCursor
    );
    assert.equal(
      await fs.readFile(path.join(backupDirectory, "files", ".claude", "settings.json"), "utf8"),
      JSON.stringify({ permissions: { allow: ["Read"] } })
    );
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(backupDirectory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(backupDirectory, "manifest.json"))).mode & 0o777, 0o600);
    }
    const claude = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(claude.permissions.allow, [
      "Read",
      "mcp__knowledge-rail__knowledge_context",
      "mcp__knowledge-rail__knowledge_document_context",
    ]);
    assert.equal(Array.isArray(claude.hooks.SessionStart), true);
    const cursor = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    assert.equal(cursor.version, 1);
    const claudeInstructions = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    const codexInstructions = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    const cursorInstructions = await fs.readFile(path.join(root, ".cursor", "rules", "knowledge-rail.mdc"), "utf8");
    for (const [before, after] of [
      [existingClaude, claudeInstructions],
      [existingCodex, codexInstructions],
      [existingCursor, cursorInstructions],
    ]) {
      assert.equal(after.startsWith(before), true);
      assert.equal(after.match(/knowledge-rail:client-integration:start/g)?.length, 1);
      assert.equal(after.match(/knowledge-rail:client-integration:end/g)?.length, 1);
    }

    const repeated = await configureClientIntegrations({ projectRoot: root, clients: ["claude", "codex", "cursor"], mode: "apply" });
    assert.equal(repeated.changes.every((item) => item.status === "unchanged"), true);
    assert.equal(repeated.backup, undefined);
    assert.equal((await fs.readdir(path.join(root, ".knowledge-rail", "backups", "client-setup"))).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("client integration rejects a symlinked project backup boundary before configuration writes", {
  skip: process.platform === "win32",
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-backup-symlink-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-backup-external-"));
  try {
    const original = "# Existing Claude instructions\n";
    await fs.writeFile(path.join(root, "CLAUDE.md"), original);
    await fs.symlink(external, path.join(root, ".knowledge-rail"));
    await assert.rejects(
      configureClientIntegrations({ projectRoot: root, clients: ["claude"], mode: "apply" }),
      /\.knowledge-rail must be a real directory/
    );
    assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), original);
    assert.equal(await fs.access(path.join(root, ".claude", "settings.json")).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(external), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  }
});

test("client integration rejects symlinked project configuration", { skip: process.platform === "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-symlink-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-external-"));
  try {
    await fs.symlink(external, path.join(root, ".codex"));
    await fs.writeFile(path.join(root, "CLAUDE.md"), "# untouched\n");
    await assert.rejects(
      configureClientIntegrations({ projectRoot: root, clients: ["claude", "codex"], mode: "apply" }),
      /regular project file|real directory/
    );
    assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), "# untouched\n");
    assert.equal(await fs.access(path.join(root, ".claude", "settings.json")).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  }
});

test("client integration preserves unrelated hooks and replaces only an older managed hook", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-merge-"));
  try {
    await fs.mkdir(path.join(root, ".codex"));
    await fs.writeFile(path.join(root, ".codex", "hooks.json"), JSON.stringify({
      description: "keep me",
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] },
          {
            matcher: "Edit|Write|apply_patch",
            hooks: [
              { type: "command", command: "npx -y knowledge-rail@2.6.0 hook --client codex --event post-edit" },
              { type: "command", command: "./keep-this-too.sh" },
            ],
          },
        ],
      },
    }));
    await configureClientIntegrations({ projectRoot: root, clients: ["codex"], mode: "apply" });
    const config = JSON.parse(await fs.readFile(path.join(root, ".codex", "hooks.json"), "utf8"));
    assert.equal(config.description, "keep me");
    const serialized = JSON.stringify(config);
    assert.match(serialized, /\.\/audit\.sh/);
    assert.match(serialized, /\.\/keep-this-too\.sh/);
    assert.doesNotMatch(serialized, /knowledge-rail@2\.6\.0/);
    assert.ok(serialized.includes(`knowledge-rail@${PRODUCT_VERSION}`));
    const managed = (event: "SessionStart" | "PostToolUse" | "Stop", hookEvent: "session" | "post-edit" | "stop") => {
      const groups = config.hooks[event] as Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>;
      assert.ok(Array.isArray(groups), `${event} must use the documented matcher-group array`);
      const handler = groups.flatMap((group) => group.hooks.map((hook) => ({ group, hook })))
        .find(({ hook }) => hook.command.includes(`--client codex --event ${hookEvent}`));
      assert.ok(handler, `${event} must contain the managed Codex command hook`);
      assert.equal(handler.hook.type, "command");
      return handler;
    };
    assert.equal(managed("SessionStart", "session").group.matcher, "startup|resume|clear|compact");
    assert.equal(managed("PostToolUse", "post-edit").group.matcher, "Edit|Write|apply_patch");
    assert.equal(managed("Stop", "stop").group.matcher, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("client integration retains the newest applied backups without pruning recovery evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-retention-"));
  try {
    const backupRoot = path.join(root, ".knowledge-rail", "backups", "client-setup");
    await fs.mkdir(backupRoot, { recursive: true });
    const seededRunIds: string[] = [];
    for (let index = 0; index < CLIENT_SETUP_APPLIED_BACKUP_RETENTION + 2; index++) {
      const runId = `seeded-applied-${String(index).padStart(2, "0")}`;
      seededRunIds.push(runId);
      const directory = path.join(backupRoot, runId);
      await fs.mkdir(directory);
      const completedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      await fs.writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({
        schemaVersion: 1,
        kind: "knowledge-rail-client-setup",
        runId,
        createdAt: completedAt,
        completedAt,
        state: "applied",
        files: [],
      })}\n`);
    }
    const failedRunId = "seeded-rollback-failed";
    await fs.mkdir(path.join(backupRoot, failedRunId));
    await fs.writeFile(path.join(backupRoot, failedRunId, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "knowledge-rail-client-setup",
      runId: failedRunId,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      state: "rollback_failed",
      files: [],
    })}\n`);

    const applied = await configureClientIntegrations({ projectRoot: root, clients: ["claude"], mode: "apply" });
    assert.ok(applied.backup);
    const entries = await fs.readdir(backupRoot);
    assert.equal(entries.length, CLIENT_SETUP_APPLIED_BACKUP_RETENTION + 1);
    assert.equal(entries.includes(failedRunId), true, "failed recovery evidence must never be retention-pruned");
    assert.equal(entries.includes(path.basename(applied.backup.directory)), true, "the current recovery run must be retained");
    assert.equal(entries.includes(seededRunIds[0]!), false);
    assert.equal(entries.includes(seededRunIds[1]!), false);
    assert.equal(entries.includes(seededRunIds[2]!), false);
    assert.equal(entries.includes(seededRunIds.at(-1)!), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("client integration fails before writes on malformed JSON or managed-marker conflicts", async () => {
  const malformedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-malformed-"));
  const conflictRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-client-conflict-"));
  try {
    await fs.mkdir(path.join(malformedRoot, ".claude"));
    await fs.writeFile(path.join(malformedRoot, ".claude", "settings.json"), "{not-json\n");
    await assert.rejects(
      configureClientIntegrations({ projectRoot: malformedRoot, clients: ["claude", "codex"], mode: "apply" }),
      /invalid JSON/
    );
    assert.equal(await fs.access(path.join(malformedRoot, "CLAUDE.md")).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(malformedRoot, "AGENTS.md")).then(() => true, () => false), false);

    await fs.mkdir(path.join(conflictRoot, ".cursor", "rules"), { recursive: true });
    const rule = "---\nalwaysApply: true\n---\n# User-owned rule\n<!-- knowledge-rail:client-integration:start -->\n";
    await fs.writeFile(path.join(conflictRoot, ".cursor", "rules", "knowledge-rail.mdc"), rule);
    await assert.rejects(
      configureClientIntegrations({ projectRoot: conflictRoot, clients: ["claude", "cursor"], mode: "apply" }),
      /managed instruction markers are malformed/
    );
    assert.equal(await fs.readFile(path.join(conflictRoot, ".cursor", "rules", "knowledge-rail.mdc"), "utf8"), rule);
    assert.equal(await fs.access(path.join(conflictRoot, "CLAUDE.md")).then(() => true, () => false), false);
  } finally {
    await fs.rm(malformedRoot, { recursive: true, force: true });
    await fs.rm(conflictRoot, { recursive: true, force: true });
  }
});
