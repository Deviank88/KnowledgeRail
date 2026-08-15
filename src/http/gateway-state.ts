import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import {
  BINDING_FORMAT_VERSION,
  MCP_PROTOCOL_VERSION,
  PRODUCT_VERSION,
  REGISTRY_SCHEMA_VERSION,
} from "../product.js";
import { resolveStateDirectory } from "../workspaces/state-paths.js";

export interface GatewayRendezvous {
  pid: number;
  nonce: string;
  endpoint: string;
  productVersion: string;
  protocolVersion: string;
  bindingFormatVersion: number;
  registrySchemaVersion: number;
  startedAt: string;
}

export class GatewayStateStore {
  readonly directory: string;
  readonly lockPath: string;
  readonly rendezvousPath: string;
  readonly credentialPath: string;

  constructor(directory = resolveStateDirectory()) {
    this.directory = nodePath.resolve(directory);
    this.lockPath = nodePath.join(this.directory, "gateway.lock");
    this.rendezvousPath = nodePath.join(this.directory, "gateway.json");
    this.credentialPath = nodePath.join(this.directory, "gateway.credential");
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
  }

  async credential(): Promise<string> {
    await this.ensureDirectory();
    try {
      const existing = (await fs.readFile(this.credentialPath, "utf8")).trim();
      if (/^[A-Za-z0-9_-]{40,}$/.test(existing)) return existing;
    } catch {
      // Create below.
    }
    const token = randomBytes(32).toString("base64url");
    const handle = await fs.open(this.credentialPath, "wx", 0o600).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return null;
    });
    if (handle) {
      await handle.writeFile(`${token}\n`);
      await handle.close();
      return token;
    }
    const raced = (await fs.readFile(this.credentialPath, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{40,}$/.test(raced)) throw new Error("Invalid gateway credential store.");
    return raced;
  }

  async acquire(nonce: string): Promise<fs.FileHandle> {
    await this.ensureDirectory();
    try {
      const handle = await fs.open(this.lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce })}\n`);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error("A KnowledgeRail gateway already owns this local state directory.");
    }
  }

  async publish(endpoint: string, nonce: string): Promise<GatewayRendezvous> {
    const record: GatewayRendezvous = {
      pid: process.pid,
      nonce,
      endpoint,
      productVersion: PRODUCT_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      bindingFormatVersion: BINDING_FORMAT_VERSION,
      registrySchemaVersion: REGISTRY_SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
    };
    const temp = nodePath.join(this.directory, `.gateway.${process.pid}.${nonce}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.rendezvousPath);
    return record;
  }

  async read(): Promise<GatewayRendezvous | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.rendezvousPath, "utf8")) as GatewayRendezvous;
      if (!value || typeof value.endpoint !== "string" || typeof value.nonce !== "string" || typeof value.pid !== "number") return null;
      return value;
    } catch {
      return null;
    }
  }

  async recoverStaleOwnership(): Promise<void> {
    let owner: { pid?: number; nonce?: string } | null = null;
    try {
      owner = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { pid?: number; nonce?: string };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Gateway ownership record is invalid; inspect the local KnowledgeRail state directory.");
    }
    if (!Number.isInteger(owner?.pid) || typeof owner?.nonce !== "string") {
      throw new Error("Gateway ownership record is invalid; inspect the local KnowledgeRail state directory.");
    }
    try {
      process.kill(owner.pid!, 0);
      throw new Error("A KnowledgeRail gateway process already owns the local state directory.");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
    }
    const rendezvous = await this.read();
    if (!rendezvous || rendezvous.nonce === owner.nonce) {
      await fs.unlink(this.rendezvousPath).catch(() => undefined);
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }

  async release(nonce: string, lock: fs.FileHandle): Promise<void> {
    await lock.close().catch(() => undefined);
    const record = await this.read();
    if (record?.nonce === nonce && record.pid === process.pid) {
      await fs.unlink(this.rendezvousPath).catch(() => undefined);
    }
    try {
      const lockValue = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { nonce?: string; pid?: number };
      if (lockValue.nonce === nonce && lockValue.pid === process.pid) {
        await fs.unlink(this.lockPath).catch(() => undefined);
      }
    } catch {
      // Never remove a lock whose ownership cannot be proven.
    }
  }
}
