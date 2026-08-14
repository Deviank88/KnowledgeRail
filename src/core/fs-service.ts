import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir } from "./utils.js";

const locks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = nodePath.resolve(absPath);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, previous.then(() => current, () => current));

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

async function atomicWrite(absPath: string, data: string | Buffer): Promise<void> {
  await ensureDir(nodePath.dirname(absPath));
  const tempPath = nodePath.join(
    nodePath.dirname(absPath),
    `.${nodePath.basename(absPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, absPath);
  } catch (err: unknown) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteText(absPath: string, content: string): Promise<void> {
  await withPathLock(absPath, () => atomicWrite(absPath, content));
}

export async function atomicWriteBuffer(absPath: string, content: Buffer): Promise<void> {
  await withPathLock(absPath, () => atomicWrite(absPath, content));
}

export async function appendTextWithLock(absPath: string, content: string): Promise<void> {
  await withPathLock(absPath, async () => {
    await ensureDir(nodePath.dirname(absPath));
    await fs.appendFile(absPath, content, "utf-8");
  });
}

export async function unlinkWithLock(absPath: string): Promise<void> {
  await withPathLock(absPath, () => fs.unlink(absPath));
}

