import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { REGISTRY_SCHEMA_VERSION } from "../product.js";
import { atomicWriteBuffer, atomicWriteText } from "../core/fs-service.js";
import { canonicalizeExistingDirectory } from "../mcp/workspace-discovery.js";
import { resolveStateDirectory } from "./state-paths.js";

export interface WorkspaceRegistration {
  id: string;
  canonicalRoot: string;
  displayName: string;
  source: "automatic" | "operator";
  allowedScopes: Array<"read" | "write">;
  createdAt: string;
  lastSeenAt: string;
}

export interface SafeWorkspaceMetadata {
  id: string;
  displayName: string;
  disambiguator: string;
  availability: "available" | "unavailable";
  allowedScopes: Array<"read" | "write">;
}

interface RegistryDocument {
  schemaVersion: number;
  workspaces: WorkspaceRegistration[];
}

interface RegistryLockRecord {
  version: 1;
  pid: number;
  nonce: string;
  processStartedAt: number;
  acquiredAt: string;
}

const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1_000);

const EMPTY_REGISTRY: RegistryDocument = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  workspaces: [],
};

function comparableRoot(root: string): string {
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function isRegistration(value: unknown): value is WorkspaceRegistration {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceRegistration>;
  return typeof item.id === "string" && item.id.startsWith("ws_") &&
    typeof item.canonicalRoot === "string" && nodePath.isAbsolute(item.canonicalRoot) &&
    typeof item.displayName === "string" && item.displayName.length > 0 &&
    (item.source === "automatic" || item.source === "operator") &&
    Array.isArray(item.allowedScopes) &&
    typeof item.createdAt === "string" && typeof item.lastSeenAt === "string";
}

function parseRegistry(text: string): RegistryDocument {
  const value = JSON.parse(text) as Partial<RegistryDocument>;
  if (value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.workspaces) || !value.workspaces.every(isRegistration)) {
    throw new Error("Unsupported or invalid workspace registry.");
  }
  return { schemaVersion: value.schemaVersion, workspaces: value.workspaces };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function pathAvailable(root: string): Promise<boolean> {
  try {
    return (await fs.stat(root)).isDirectory() && comparableRoot(await fs.realpath(root)) === comparableRoot(root);
  } catch {
    return false;
  }
}

export class WorkspaceRegistry {
  readonly directory: string;
  readonly filePath: string;
  readonly backupPath: string;
  readonly lockPath: string;
  private inProcessQueue: Promise<unknown> = Promise.resolve();

  constructor(directory = resolveStateDirectory()) {
    this.directory = nodePath.resolve(directory);
    this.filePath = nodePath.join(this.directory, "workspaces.json");
    this.backupPath = nodePath.join(this.directory, "workspaces.backup.json");
    this.lockPath = nodePath.join(this.directory, "workspaces.lock");
  }

  private async readDocument(): Promise<RegistryDocument> {
    let primaryError: unknown;
    try {
      return parseRegistry(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") primaryError = error;
    }
    try {
      return parseRegistry(await fs.readFile(this.backupPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !primaryError) primaryError = error;
    }
    if (primaryError) {
      throw new Error("Workspace registry is corrupt and no valid backup is available.");
    }
    return structuredClone(EMPTY_REGISTRY);
  }

  private async recoverStaleLock(): Promise<boolean> {
    let record: RegistryLockRecord | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as Partial<RegistryLockRecord>;
      if (parsed.version === 1 && Number.isInteger(parsed.pid) && typeof parsed.nonce === "string" &&
          Number.isFinite(parsed.processStartedAt) && typeof parsed.acquiredAt === "string") {
        record = parsed as RegistryLockRecord;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    }
    if (!record) {
      const stat = await fs.stat(this.lockPath).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < 2_000) return false;
      await fs.unlink(this.lockPath).catch(() => undefined);
      return true;
    }
    if (record.pid === process.pid && Math.abs(record.processStartedAt - PROCESS_STARTED_AT) <= 2_000) {
      return false;
    }
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return false;
      if (code !== "ESRCH") throw error;
      await fs.unlink(this.lockPath).catch(() => undefined);
      return true;
    }
  }

  private async acquireFileLock(): Promise<{ handle: fs.FileHandle; nonce: string }> {
    await ensurePrivateDirectory(this.directory);
    for (let attempt = 0; attempt < 40; attempt++) {
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(this.lockPath, "wx", 0o600);
        const nonce = randomBytes(16).toString("hex");
        const record: RegistryLockRecord = {
          version: 1,
          pid: process.pid,
          nonce,
          processStartedAt: PROCESS_STARTED_AT,
          acquiredAt: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        return { handle, nonce };
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
          await fs.unlink(this.lockPath).catch(() => undefined);
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.recoverStaleLock();
        if (attempt === 39) throw new Error("Workspace registry is busy; retry shortly.");
        await delay(25);
      }
    }
    throw new Error("Workspace registry lock could not be acquired.");
  }

  private async writeDocument(document: RegistryDocument): Promise<void> {
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    const existing = await fs.readFile(this.filePath).catch(() => null);
    if (existing) await atomicWriteBuffer(this.backupPath, existing);
    await atomicWriteText(this.filePath, serialized);
    if (process.platform !== "win32") await fs.chmod(this.filePath, 0o600);
  }

  private mutate<T>(operation: (document: RegistryDocument) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const lock = await this.acquireFileLock();
      try {
        return await operation(await this.readDocument());
      } finally {
        await lock.handle.close().catch(() => undefined);
        try {
          const current = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as Partial<RegistryLockRecord>;
          if (current.pid === process.pid && current.nonce === lock.nonce) {
            await fs.unlink(this.lockPath).catch(() => undefined);
          }
        } catch {
          // Never remove a lock whose ownership cannot be proven.
        }
      }
    };
    const result = this.inProcessQueue.then(run, run);
    this.inProcessQueue = result.catch(() => undefined);
    return result;
  }

  async register(
    root: string,
    source: WorkspaceRegistration["source"] = "operator"
  ): Promise<WorkspaceRegistration> {
    const canonicalRoot = await canonicalizeExistingDirectory(root);
    return this.mutate(async (document) => {
      const now = new Date().toISOString();
      const existing = document.workspaces.find((workspace) =>
        comparableRoot(workspace.canonicalRoot) === comparableRoot(canonicalRoot)
      );
      if (existing) {
        existing.lastSeenAt = now;
        if (source === "operator") existing.source = "operator";
        await this.writeDocument(document);
        return structuredClone(existing);
      }

      const registration: WorkspaceRegistration = {
        id: `ws_${randomBytes(12).toString("base64url")}`,
        canonicalRoot,
        displayName: nodePath.basename(canonicalRoot),
        source,
        allowedScopes: ["read", "write"],
        createdAt: now,
        lastSeenAt: now,
      };
      document.workspaces.push(registration);
      await this.writeDocument(document);
      return structuredClone(registration);
    });
  }

  async unregister(workspaceId: string): Promise<boolean> {
    return this.mutate(async (document) => {
      const next = document.workspaces.filter((workspace) => workspace.id !== workspaceId);
      if (next.length === document.workspaces.length) return false;
      document.workspaces = next;
      await this.writeDocument(document);
      return true;
    });
  }

  async get(workspaceId: string): Promise<WorkspaceRegistration | null> {
    const document = await this.readDocument();
    return structuredClone(document.workspaces.find((workspace) => workspace.id === workspaceId) ?? null);
  }

  async listSafe(): Promise<SafeWorkspaceMetadata[]> {
    const document = await this.readDocument();
    return Promise.all(document.workspaces.map(async (workspace) => ({
      id: workspace.id,
      displayName: workspace.displayName,
      disambiguator: workspace.id.slice(-6),
      availability: await pathAvailable(workspace.canonicalRoot) ? "available" : "unavailable",
      allowedScopes: [...workspace.allowedScopes],
    })));
  }
}
