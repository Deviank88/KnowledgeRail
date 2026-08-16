import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveRealWithin } from "./paths.js";
import { ensureDir } from "./utils.js";

const keyedLocks = new Map<string, Promise<void>>();
const heldFileLocks = new Map<string, string>();
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1_000);
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200;

interface LockRecord {
  version: 1;
  pid: number;
  nonce: string;
  processStartedAt: number;
  acquiredAt: string;
}

export async function withKeyedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const normalized = nodePath.resolve(key);
  const previous = keyedLocks.get(normalized) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  keyedLocks.set(normalized, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (keyedLocks.get(normalized) === tail) keyedLocks.delete(normalized);
  }
}

function lockName(key: string): string {
  return `${createHash("sha256").update(nodePath.resolve(key)).digest("hex")}.lock`;
}

function validLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LockRecord>;
  return record.version === 1 && Number.isInteger(record.pid) && record.pid! > 0 &&
    typeof record.nonce === "string" && record.nonce.length >= 16 &&
    Number.isFinite(record.processStartedAt) && typeof record.acquiredAt === "string";
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
    return validLockRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function recoverStaleLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath);
  if (!record) {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < 2_000) return false;
    await fs.unlink(lockPath).catch(() => undefined);
    return true;
  }

  if (record.pid === process.pid) {
    const heldNonce = heldFileLocks.get(lockPath);
    if (heldNonce === record.nonce) return false;
    if (Math.abs(record.processStartedAt - PROCESS_STARTED_AT) <= 2_000) return false;
    await fs.unlink(lockPath).catch(() => undefined);
    return true;
  }

  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return false;
    if (code !== "ESRCH") throw error;
    await fs.unlink(lockPath).catch(() => undefined);
    return true;
  }
}

async function releaseOwnedLock(lockPath: string, nonce: string, handle: fs.FileHandle): Promise<void> {
  heldFileLocks.delete(lockPath);
  await handle.close().catch(() => undefined);
  const record = await readLockRecord(lockPath);
  if (record?.pid === process.pid && record.nonce === nonce) {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export async function withFileLock<T>(
  key: string,
  operation: () => Promise<T>,
  options: { lockDirectory: string }
): Promise<T> {
  await ensureDir(options.lockDirectory);
  const lockPath = nodePath.join(options.lockDirectory, lockName(key));
  return withKeyedLock(lockPath, async () => {
    let handle: fs.FileHandle | undefined;
    let nonce = "";
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
        nonce = randomUUID();
        const record: LockRecord = {
          version: 1,
          pid: process.pid,
          nonce,
          processStartedAt: PROCESS_STARTED_AT,
          acquiredAt: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        heldFileLocks.set(lockPath, nonce);
        break;
      } catch (error: unknown) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await recoverStaleLock(lockPath);
        if (attempt === LOCK_ATTEMPTS - 1) {
          throw new Error("Workspace mutation is busy; retry shortly.");
        }
        await delay(LOCK_RETRY_MS);
      }
    }
    if (!handle) throw new Error("Workspace mutation lock could not be acquired.");
    try {
      return await operation();
    } finally {
      await releaseOwnedLock(lockPath, nonce, handle);
    }
  });
}

export async function withWikiFileLock<T>(
  wikiRoot: string,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockDirectory = await resolveRealWithin(wikiRoot, ".knowledge-rail/locks");
  return withFileLock(key, operation, { lockDirectory });
}

export function keyedLockCount(): number {
  return keyedLocks.size;
}
