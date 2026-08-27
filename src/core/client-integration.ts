import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { atomicWriteText } from "./fs-service.js";
import { logger } from "./logger.js";
import { PRODUCT_VERSION } from "../product.js";

export type KnowledgeClient = "claude" | "codex" | "cursor";
export type ClientIntegrationMode = "preview" | "apply" | "status";
type JsonRecord = Record<string, unknown>;

export interface ClientIntegrationChange {
  path: string;
  status: "create" | "update" | "unchanged";
  sha256: string;
  content?: string;
}

export interface ClientIntegrationResult {
  mode: ClientIntegrationMode;
  clients: KnowledgeClient[];
  changes: ClientIntegrationChange[];
  applied: boolean;
  trustRequired: KnowledgeClient[];
  backup?: ClientIntegrationBackup;
}

export interface ClientIntegrationBackup {
  runId: string;
  directory: string;
  manifest: string;
  fileCount: number;
}

interface ClientFileSnapshot {
  content: string;
  mode: number;
}

interface ClientFileProposal {
  original: ClientFileSnapshot | null;
  content: string;
}

type BackupState = "prepared" | "applied" | "rolled_back" | "rollback_failed";

interface BackupManifest {
  schemaVersion: 1;
  kind: "knowledge-rail-client-setup";
  runId: string;
  createdAt: string;
  state: BackupState;
  files: Array<{
    path: string;
    existed: boolean;
    sha256: string | null;
    bytes: number;
    mode: number | null;
    backupPath: string | null;
  }>;
  completedAt?: string;
  failure?: string;
}

interface PreparedBackup {
  result: ClientIntegrationBackup;
  absoluteManifest: string;
  manifest: BackupManifest;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const BACKUP_ROOT = ".knowledge-rail/backups/client-setup";
export const CLIENT_SETUP_APPLIED_BACKUP_RETENTION = 20;
const START = "<!-- knowledge-rail:client-integration:start -->";
const END = "<!-- knowledge-rail:client-integration:end -->";
const POLICY = `${START}\n## Project wiki (KnowledgeRail)\n\n- Start concrete tasks with \`knowledge_context mode=task\` and follow its \`nextAction\`.\n- Treat stale or drift-suspected evidence as untrusted until it is re-verified against source code.\n- After changing source files, update the wiki pages whose evidence anchors those files in the same session. Wiki writes require the user's explicit request or tool approval.\n- Inspect decision metadata and materialize only the exact relevant passage or one bounded page; surface conflicts and do not infer durable decisions from silence.\n- Record only clearly accepted durable decisions. Never store proposals, unresolved options, hidden reasoning, secrets, or raw conversation.\n${END}`;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function command(client: KnowledgeClient, event: "session" | "post-edit" | "stop"): string {
  return `npx --yes --prefer-offline knowledge-rail@${PRODUCT_VERSION} hook --client ${client} --event ${event}`;
}

function nestedHook(client: KnowledgeClient, event: "session" | "post-edit" | "stop"): JsonRecord {
  return {
    ...(event === "session" ? { matcher: "startup|resume|clear|compact" } : {}),
    ...(event === "post-edit" ? { matcher: "Edit|Write|apply_patch" } : {}),
    hooks: [{ type: "command", command: command(client, event), timeout: event === "post-edit" ? 2 : 5 }],
  };
}

function managedCommand(value: unknown, client: KnowledgeClient, event: "session" | "post-edit" | "stop"): boolean {
  return isRecord(value) && typeof value["command"] === "string"
    && /\bknowledge-rail@[^\s]+\s+hook\b/u.test(value["command"])
    && value["command"].includes(`--client ${client}`)
    && value["command"].includes(`--event ${event}`);
}

function mergeNestedEvent(
  values: unknown,
  item: JsonRecord,
  client: "claude" | "codex",
  event: "session" | "post-edit" | "stop",
  label: string
): unknown[] {
  if (values !== undefined && !Array.isArray(values)) throw new Error(`${label} must be a JSON array.`);
  const retained: unknown[] = [];
  for (const value of values ?? []) {
    if (!isRecord(value)) throw new Error(`${label} contains a non-object hook group.`);
    if (!Array.isArray(value["hooks"])) throw new Error(`${label} contains a hook group without a hooks array.`);
    const handlers = value["hooks"] as unknown[];
    if (handlers.some((handler) => !isRecord(handler))) throw new Error(`${label} contains a non-object hook handler.`);
    const remaining = handlers.filter((handler) => !managedCommand(handler, client, event));
    if (remaining.length > 0) retained.push(remaining.length === handlers.length ? value : { ...value, hooks: remaining });
  }
  return [...retained, item];
}

function mergeCursorEvent(
  values: unknown,
  item: JsonRecord,
  event: "session" | "post-edit",
  label: string
): unknown[] {
  if (values !== undefined && !Array.isArray(values)) throw new Error(`${label} must be a JSON array.`);
  const retained = (values ?? []) as unknown[];
  if (retained.some((value) => !isRecord(value))) throw new Error(`${label} contains a non-object hook.`);
  return [...retained.filter((value) => !managedCommand(value, "cursor", event)), item];
}

function mergeNestedHooks(current: JsonRecord, client: "claude" | "codex"): JsonRecord {
  const hooks = current["hooks"] === undefined ? {} : current["hooks"];
  if (!isRecord(hooks)) throw new Error("hooks must be a JSON object.");
  const merged: JsonRecord = {
    ...current,
    hooks: {
      ...hooks,
      SessionStart: mergeNestedEvent(hooks["SessionStart"], nestedHook(client, "session"), client, "session", "hooks.SessionStart"),
      PostToolUse: mergeNestedEvent(hooks["PostToolUse"], nestedHook(client, "post-edit"), client, "post-edit", "hooks.PostToolUse"),
      Stop: mergeNestedEvent(hooks["Stop"], nestedHook(client, "stop"), client, "stop", "hooks.Stop"),
    },
  };
  if (client === "claude") {
    const permissions = current["permissions"] === undefined ? {} : current["permissions"];
    if (!isRecord(permissions)) throw new Error(".claude/settings.json permissions must be a JSON object.");
    const allow = permissions["allow"] === undefined ? [] : permissions["allow"];
    if (!Array.isArray(allow) || allow.some((value) => typeof value !== "string")) {
      throw new Error(".claude/settings.json permissions.allow must be a string array.");
    }
    merged["permissions"] = {
      ...permissions,
      allow: [...new Set([
        ...allow as string[],
        "mcp__knowledge-rail__knowledge_context",
        "mcp__knowledge-rail__knowledge_document_context",
      ])],
    };
  }
  return merged;
}

function mergeCursorHooks(current: JsonRecord): JsonRecord {
  if (current["version"] !== undefined && current["version"] !== 1) throw new Error(".cursor/hooks.json version must be 1.");
  const hooks = current["hooks"] === undefined ? {} : current["hooks"];
  if (!isRecord(hooks)) throw new Error(".cursor/hooks.json hooks must be a JSON object.");
  const item = (event: "session" | "post-edit") => ({ command: command("cursor", event), timeout: event === "post-edit" ? 2 : 5 });
  return {
    ...current,
    version: 1,
    hooks: {
      ...hooks,
      sessionStart: mergeCursorEvent(hooks["sessionStart"], item("session"), "session", "hooks.sessionStart"),
      postToolUse: mergeCursorEvent(
        hooks["postToolUse"],
        { ...item("post-edit"), matcher: "Write" },
        "post-edit",
        "hooks.postToolUse"
      ),
    },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function safeRead(root: string, relative: string): Promise<ClientFileSnapshot | null> {
  const absolute = nodePath.join(root, relative);
  const rel = nodePath.relative(root, absolute);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) throw new Error("Client integration path escaped the project root.");
  let cursor = root;
  for (const segment of nodePath.dirname(relative).split(nodePath.sep).filter((item) => item && item !== ".")) {
    cursor = nodePath.join(cursor, segment);
    const parentStat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error));
    if (!parentStat) break;
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error(`${nodePath.relative(root, cursor)} must be a real directory.`);
    }
  }
  const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${relative} must be a regular project file.`);
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${relative} is too large to update safely.`);
  return { content: await fs.readFile(absolute, "utf8"), mode: stat.mode & 0o777 };
}

async function jsonProposal(
  root: string,
  relative: string,
  merge: (value: JsonRecord) => JsonRecord
): Promise<ClientFileProposal> {
  const original = await safeRead(root, relative);
  let parsed: unknown = {};
  if (original !== null) {
    try { parsed = JSON.parse(original.content); } catch { throw new Error(`${relative} contains invalid JSON.`); }
  }
  if (!isRecord(parsed)) throw new Error(`${relative} must contain a JSON object.`);
  return { original, content: `${JSON.stringify(merge(parsed), null, 2)}\n` };
}

function markdownProposal(raw: string | null): string {
  if (raw === null || raw === "") return `${POLICY}\n`;
  const start = raw.indexOf(START);
  const end = raw.indexOf(END);
  if (
    (start < 0) !== (end < 0)
    || (start >= 0 && end < start)
    || (start >= 0 && raw.lastIndexOf(START) !== start)
    || (end >= 0 && raw.lastIndexOf(END) !== end)
  ) throw new Error("KnowledgeRail managed instruction markers are malformed.");
  if (start < 0) {
    const separator = raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
    return `${raw}${separator}${POLICY}\n`;
  }
  return `${raw.slice(0, start)}${POLICY}${raw.slice(end + END.length)}`;
}

async function cursorRuleProposal(root: string): Promise<ClientFileProposal> {
  const relative = ".cursor/rules/knowledge-rail.mdc";
  const original = await safeRead(root, relative);
  if (original === null || original.content === "") {
    return {
      original,
      content: `---\ndescription: KnowledgeRail project knowledge workflow\nalwaysApply: true\n---\n${POLICY}\n`,
    };
  }
  return { original, content: markdownProposal(original.content) };
}

async function ensureSafeParent(root: string, relative: string): Promise<void> {
  const parent = nodePath.dirname(nodePath.join(root, relative));
  const relParent = nodePath.relative(root, parent);
  let cursor = root;
  for (const segment of relParent.split(nodePath.sep).filter(Boolean)) {
    cursor = nodePath.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${nodePath.relative(root, cursor)} must be a real directory.`);
    if (!stat) await fs.mkdir(cursor, { mode: 0o755 });
  }
}

async function ensurePrivateDirectory(root: string, relative: string): Promise<string> {
  let cursor = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    cursor = nodePath.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error));
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`${nodePath.relative(root, cursor)} must be a real directory.`);
    }
    if (!stat) await fs.mkdir(cursor, { mode: 0o700 });
  }
  if (process.platform !== "win32") await fs.chmod(cursor, 0o700);
  return cursor;
}

function snapshotsEqual(left: ClientFileSnapshot | null, right: ClientFileSnapshot | null): boolean {
  return left === null ? right === null : right !== null && left.content === right.content && left.mode === right.mode;
}

async function assertProposalBaseCurrent(
  root: string,
  relative: string,
  proposal: ClientFileProposal
): Promise<void> {
  if (!snapshotsEqual(await safeRead(root, relative), proposal.original)) {
    throw new Error(`${relative} changed while client setup was being prepared; retry from preview.`);
  }
}

function portablePath(...segments: string[]): string {
  return segments.join("/").replace(/\\/g, "/");
}

async function writeBackupManifest(backup: PreparedBackup): Promise<void> {
  await atomicWriteText(backup.absoluteManifest, `${JSON.stringify(backup.manifest, null, 2)}\n`);
  if (process.platform !== "win32") await fs.chmod(backup.absoluteManifest, 0o600);
}

async function appliedBackupCandidate(
  backupRoot: string,
  runId: string
): Promise<{ directory: string; completedAt: number } | null> {
  const directory = nodePath.join(backupRoot, runId);
  const directoryStat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) return null;
  const manifestPath = nodePath.join(directory, "manifest.json");
  const manifestStat = await fs.lstat(manifestPath).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_CONFIG_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch { return null; }
  if (
    !isRecord(parsed) ||
    parsed["schemaVersion"] !== 1 ||
    parsed["kind"] !== "knowledge-rail-client-setup" ||
    parsed["runId"] !== runId ||
    parsed["state"] !== "applied" ||
    typeof parsed["completedAt"] !== "string"
  ) return null;
  const completedAt = Date.parse(parsed["completedAt"]);
  return Number.isFinite(completedAt) ? { directory, completedAt } : null;
}

async function pruneAppliedBackups(root: string, currentRunId: string): Promise<void> {
  const backupRoot = nodePath.join(root, ...BACKUP_ROOT.split("/"));
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const candidates = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map(async (entry) => {
      const candidate = await appliedBackupCandidate(backupRoot, entry.name);
      return candidate ? { ...candidate, runId: entry.name } : null;
    })))
    .filter((candidate): candidate is { directory: string; completedAt: number; runId: string } => candidate !== null);
  if (!candidates.some((candidate) => candidate.runId === currentRunId)) {
    throw new Error("The current client-setup recovery manifest could not be revalidated.");
  }
  const previous = candidates
    .filter((candidate) => candidate.runId !== currentRunId)
    .sort((left, right) => right.completedAt - left.completedAt || right.runId.localeCompare(left.runId));
  const obsolete = previous.slice(Math.max(0, CLIENT_SETUP_APPLIED_BACKUP_RETENTION - 1));
  for (const candidate of obsolete) {
    if (!await appliedBackupCandidate(backupRoot, candidate.runId)) continue;
    await fs.rm(candidate.directory, { recursive: true });
  }
}

async function prepareBackup(
  root: string,
  proposals: ReadonlyMap<string, ClientFileProposal>,
  changedPaths: readonly string[]
): Promise<PreparedBackup> {
  const backupRoot = await ensurePrivateDirectory(root, BACKUP_ROOT);
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
  const directory = portablePath(BACKUP_ROOT, runId);
  const absoluteDirectory = nodePath.join(backupRoot, runId);
  await fs.mkdir(absoluteDirectory, { mode: 0o700 });
  const manifest: BackupManifest = {
    schemaVersion: 1,
    kind: "knowledge-rail-client-setup",
    runId,
    createdAt: new Date().toISOString(),
    state: "prepared",
    files: [],
  };
  const prepared: PreparedBackup = {
    result: {
      runId,
      directory,
      manifest: portablePath(directory, "manifest.json"),
      fileCount: 0,
    },
    absoluteManifest: nodePath.join(absoluteDirectory, "manifest.json"),
    manifest,
  };
  try {
    for (const relative of changedPaths) {
      const original = proposals.get(relative)!.original;
      const backupPath = original ? portablePath("files", relative) : null;
      if (original && backupPath) {
        const destination = nodePath.join(absoluteDirectory, ...backupPath.split("/"));
        await ensurePrivateDirectory(absoluteDirectory, nodePath.dirname(backupPath).replace(/\\/g, "/"));
        await atomicWriteText(destination, original.content);
        if (process.platform !== "win32") await fs.chmod(destination, 0o600);
        prepared.result.fileCount++;
      }
      manifest.files.push({
        path: portablePath(relative),
        existed: original !== null,
        sha256: original ? sha256(original.content) : null,
        bytes: original ? Buffer.byteLength(original.content, "utf8") : 0,
        mode: original?.mode ?? null,
        backupPath,
      });
    }
    await writeBackupManifest(prepared);
    return prepared;
  } catch (error) {
    await fs.rm(absoluteDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreWrittenProposal(
  root: string,
  relative: string,
  proposal: ClientFileProposal
): Promise<void> {
  const current = await safeRead(root, relative);
  if (!current || current.content !== proposal.content) {
    throw new Error(`${relative} changed after client setup wrote it; automatic rollback refused.`);
  }
  const absolute = nodePath.join(root, relative);
  if (proposal.original === null) {
    await fs.rm(absolute);
    return;
  }
  await atomicWriteText(absolute, proposal.original.content);
  if (process.platform !== "win32") await fs.chmod(absolute, proposal.original.mode);
}

export async function configureClientIntegrations(params: {
  projectRoot: string;
  clients: readonly KnowledgeClient[];
  mode: ClientIntegrationMode;
}): Promise<ClientIntegrationResult> {
  const root = await fs.realpath(params.projectRoot);
  const clients = [...new Set(params.clients)].sort() as KnowledgeClient[];
  if (clients.length === 0) throw new Error("Select at least one client integration.");
  const proposals = new Map<string, ClientFileProposal>();
  if (clients.includes("claude")) {
    proposals.set(".claude/settings.json", await jsonProposal(root, ".claude/settings.json", (value) => mergeNestedHooks(value, "claude")));
    const original = await safeRead(root, "CLAUDE.md");
    proposals.set("CLAUDE.md", { original, content: markdownProposal(original?.content ?? null) });
  }
  if (clients.includes("codex")) {
    proposals.set(".codex/hooks.json", await jsonProposal(root, ".codex/hooks.json", (value) => mergeNestedHooks(value, "codex")));
    const original = await safeRead(root, "AGENTS.md");
    proposals.set("AGENTS.md", { original, content: markdownProposal(original?.content ?? null) });
  }
  if (clients.includes("cursor")) {
    proposals.set(".cursor/hooks.json", await jsonProposal(root, ".cursor/hooks.json", mergeCursorHooks));
    proposals.set(".cursor/rules/knowledge-rail.mdc", await cursorRuleProposal(root));
  }
  const changes: ClientIntegrationChange[] = [];
  for (const [relative, proposal] of proposals) {
    const status = proposal.original === null
      ? "create"
      : proposal.original.content === proposal.content ? "unchanged" : "update";
    changes.push({
      path: relative,
      status,
      sha256: sha256(proposal.content),
      ...(params.mode === "preview" ? { content: proposal.content } : {}),
    });
  }
  let backup: PreparedBackup | undefined;
  if (params.mode === "apply") {
    const changedPaths = changes.filter((change) => change.status !== "unchanged").map((change) => change.path);
    const written: string[] = [];
    try {
      for (const relative of changedPaths) await assertProposalBaseCurrent(root, relative, proposals.get(relative)!);
      if (changedPaths.length > 0) backup = await prepareBackup(root, proposals, changedPaths);
      for (const relative of changedPaths) {
        const proposal = proposals.get(relative)!;
        await assertProposalBaseCurrent(root, relative, proposal);
        await ensureSafeParent(root, relative);
        await atomicWriteText(nodePath.join(root, relative), proposal.content);
        written.push(relative);
        if (proposal.original && process.platform !== "win32") {
          await fs.chmod(nodePath.join(root, relative), proposal.original.mode);
        }
      }
      if (backup) {
        backup.manifest.state = "applied";
        backup.manifest.completedAt = new Date().toISOString();
        await writeBackupManifest(backup);
        try {
          await pruneAppliedBackups(root, backup.result.runId);
        } catch (error) {
          logger.warn("client-integration", "backup_retention_failed", {
            retainedLimit: CLIENT_SETUP_APPLIED_BACKUP_RETENTION,
          }, error);
        }
      }
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const relative of written.reverse()) {
        try {
          await restoreWrittenProposal(root, relative, proposals.get(relative)!);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
        }
      }
      if (backup) {
        backup.manifest.state = rollbackErrors.length === 0 ? "rolled_back" : "rollback_failed";
        backup.manifest.completedAt = new Date().toISOString();
        backup.manifest.failure = error instanceof Error ? error.message : "Client setup failed.";
        try { await writeBackupManifest(backup); } catch (manifestError) {
          rollbackErrors.push(manifestError instanceof Error ? manifestError : new Error(String(manifestError)));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "Client setup failed and automatic rollback was incomplete.");
      }
      throw error;
    }
  }
  return {
    mode: params.mode,
    clients,
    changes,
    applied: params.mode === "apply",
    trustRequired: clients.filter((client) => client === "codex" || client === "cursor"),
    ...(backup ? { backup: backup.result } : {}),
  };
}
