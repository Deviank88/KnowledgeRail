import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import { withWikiFileLock } from "./lock-service.js";

const checkpointLockBrand: unique symbol = Symbol("knowledge-rail-derived-checkpoint-lock");
const activeLocks = new WeakSet<object>();

export interface DerivedCheckpointLock {
  readonly root: string;
  readonly [checkpointLockBrand]: true;
}

export type DerivedCheckpointDirectoryKind = "absent" | "directory" | "symlink" | "other";

export async function derivedCheckpointDirectoryKind(
  wikiRoot: string
): Promise<DerivedCheckpointDirectoryKind> {
  const metadataDirectory = nodePath.join(nodePath.resolve(wikiRoot), ".knowledge-rail");
  const stat = await fs.lstat(metadataDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) return "symlink";
  return stat.isDirectory() ? "directory" : "other";
}

async function assertDerivedCheckpointDirectory(wikiRoot: string): Promise<void> {
  const kind = await derivedCheckpointDirectoryKind(wikiRoot);
  if (kind === "symlink") throw new Error("Derived checkpoint directory must not be a symbolic link.");
  if (kind === "other") throw new Error("Derived checkpoint path must be a directory.");
}

export async function withDerivedCheckpointLock<T>(
  wikiRoot: string,
  operation: (lock: DerivedCheckpointLock) => Promise<T>
): Promise<T> {
  const root = nodePath.resolve(wikiRoot);
  await assertDerivedCheckpointDirectory(root);
  return withWikiFileLock(wikiRoot, `${root}:derived-checkpoints`, async () => {
    await assertDerivedCheckpointDirectory(root);
    const lock = Object.freeze({ root, [checkpointLockBrand]: true as const });
    activeLocks.add(lock);
    try {
      return await operation(lock);
    } finally {
      activeLocks.delete(lock);
    }
  });
}

export async function usingDerivedCheckpointLock<T>(
  wikiRoot: string,
  existing: DerivedCheckpointLock | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (!existing) return withDerivedCheckpointLock(wikiRoot, operation);
  if (!activeLocks.has(existing) || existing.root !== nodePath.resolve(wikiRoot)) {
    throw new Error("Derived checkpoint lock capability is invalid or no longer active.");
  }
  await assertDerivedCheckpointDirectory(wikiRoot);
  return operation();
}
