import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir } from "./utils.js";
import { withKeyedLock } from "./lock-service.js";

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWrite(absPath: string, data: string | Buffer): Promise<void> {
  await ensureDir(nodePath.dirname(absPath));
  const tempPath = nodePath.join(
    nodePath.dirname(absPath),
    `.${nodePath.basename(absPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, absPath);
    await fsyncDirectory(nodePath.dirname(absPath));
  } catch (err: unknown) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteText(absPath: string, content: string): Promise<void> {
  await withKeyedLock(absPath, () => atomicWrite(absPath, content));
}

export async function atomicWriteBuffer(absPath: string, content: Buffer): Promise<void> {
  await withKeyedLock(absPath, () => atomicWrite(absPath, content));
}

export async function appendTextWithLock(absPath: string, content: string): Promise<void> {
  await withKeyedLock(absPath, async () => {
    await ensureDir(nodePath.dirname(absPath));
    await fs.appendFile(absPath, content, "utf-8");
  });
}

export async function unlinkWithLock(absPath: string): Promise<void> {
  await withKeyedLock(absPath, () => fs.unlink(absPath));
}
