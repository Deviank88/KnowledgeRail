import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { createWorkspaceContext, type WorkspaceAccessScope, type WorkspaceContext } from "../core/workspace-context.js";
import { BINDING_FORMAT_VERSION } from "../product.js";
import { WorkspaceRegistry, type SafeWorkspaceMetadata } from "./registry.js";

export interface WorkspaceBindingStatus {
  binding: string;
  workspace: SafeWorkspaceMetadata;
  scope: WorkspaceAccessScope;
  expiresAt: string;
}

interface BindingRecord {
  digest: Buffer;
  workspaceId: string;
  principalId: string;
  scope: WorkspaceAccessScope;
  createdAtMs: number;
  expiresAtMs: number;
  maximumExpiresAtMs: number;
}

export class WorkspaceBindingError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "malformed" | "expired" | "revoked" | "principal" | "scope" | "unavailable"
  ) {
    super(message);
    this.name = "WorkspaceBindingError";
  }
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safeTokenMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class WorkspaceBindingManager {
  private readonly records = new Map<string, BindingRecord>();

  constructor(
    readonly registry: WorkspaceRegistry,
    readonly ttlMs = 30 * 60 * 1_000,
    readonly maximumLifetimeMs = 8 * 60 * 60 * 1_000,
    private readonly now: () => number = Date.now,
    private readonly onWorkspaceInactive?: (workspaceId: string) => void | Promise<void>
  ) {}

  private notifyIfInactive(workspaceId: string): void {
    if ([...this.records.values()].some((record) => record.workspaceId === workspaceId)) return;
    void this.onWorkspaceInactive?.(workspaceId);
  }

  private key(digest: Buffer): string {
    return digest.toString("base64url");
  }

  private async safeMetadata(workspaceId: string): Promise<SafeWorkspaceMetadata> {
    const item = (await this.registry.listSafe()).find((workspace) => workspace.id === workspaceId);
    if (!item || item.availability !== "available") {
      throw new WorkspaceBindingError("The selected workspace is unavailable; choose another catalog entry.", "unavailable");
    }
    return item;
  }

  async issue(
    workspaceId: string,
    scope: WorkspaceAccessScope,
    principalId: string
  ): Promise<WorkspaceBindingStatus> {
    const registration = await this.registry.get(workspaceId);
    if (!registration || !registration.allowedScopes.includes(scope)) {
      throw new WorkspaceBindingError("The workspace or requested scope is not authorized.", "scope");
    }
    const workspace = await this.safeMetadata(workspaceId);
    const token = `krb${BINDING_FORMAT_VERSION}_${randomBytes(32).toString("base64url")}`;
    const digest = tokenDigest(token);
    const now = this.now();
    const record: BindingRecord = {
      digest,
      workspaceId,
      principalId,
      scope,
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      maximumExpiresAtMs: now + this.maximumLifetimeMs,
    };
    this.records.set(this.key(digest), record);
    return { binding: token, workspace, scope, expiresAt: new Date(record.expiresAtMs).toISOString() };
  }

  private recordFor(token: string, principalId: string): BindingRecord {
    if (!token) throw new WorkspaceBindingError("A workspace binding is required.", "missing");
    if (!new RegExp(`^krb${BINDING_FORMAT_VERSION}_[A-Za-z0-9_-]{40,}$`).test(token)) {
      throw new WorkspaceBindingError("The workspace binding is malformed or uses an unsupported version.", "malformed");
    }
    const digest = tokenDigest(token);
    const record = this.records.get(this.key(digest));
    if (!record || !safeTokenMatch(record.digest, digest)) {
      throw new WorkspaceBindingError("The workspace binding is unknown or was released.", "revoked");
    }
    if (record.principalId !== principalId) {
      throw new WorkspaceBindingError("The workspace binding is not valid for this local client.", "principal");
    }
    if (this.now() >= record.expiresAtMs) {
      this.records.delete(this.key(digest));
      this.notifyIfInactive(record.workspaceId);
      throw new WorkspaceBindingError("The workspace binding expired; renew or select the workspace again.", "expired");
    }
    return record;
  }

  async resolve(token: string, principalId: string, requireWrite = false): Promise<WorkspaceContext> {
    const record = this.recordFor(token, principalId);
    if (requireWrite && record.scope !== "write") {
      throw new WorkspaceBindingError("This operation requires a write-scoped workspace binding.", "scope");
    }
    const registration = await this.registry.get(record.workspaceId);
    if (!registration) throw new WorkspaceBindingError("The workspace registration was removed.", "revoked");
    const canonicalNow = await fs.realpath(registration.canonicalRoot).catch(() => null);
    const canonicalMatches = canonicalNow && (process.platform === "win32"
      ? canonicalNow.toLowerCase() === registration.canonicalRoot.toLowerCase()
      : canonicalNow === registration.canonicalRoot);
    if (!canonicalMatches) {
      throw new WorkspaceBindingError("The workspace is unavailable or its canonical path changed.", "unavailable");
    }
    return createWorkspaceContext(registration.canonicalRoot, {
      workspaceId: record.workspaceId,
      generation: record.createdAtMs,
      source: "workspace-binding",
      scope: record.scope,
      binding: token,
    });
  }

  async status(token: string, principalId: string): Promise<WorkspaceBindingStatus> {
    const record = this.recordFor(token, principalId);
    return {
      binding: token,
      workspace: await this.safeMetadata(record.workspaceId),
      scope: record.scope,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  async renew(token: string, principalId: string): Promise<WorkspaceBindingStatus> {
    const record = this.recordFor(token, principalId);
    const nextExpiry = Math.min(this.now() + this.ttlMs, record.maximumExpiresAtMs);
    if (nextExpiry <= this.now()) {
      throw new WorkspaceBindingError("The maximum binding lifetime was reached; select the workspace again.", "expired");
    }
    record.expiresAtMs = nextExpiry;
    return this.status(token, principalId);
  }

  release(token: string, principalId: string): boolean {
    const record = this.recordFor(token, principalId);
    const removed = this.records.delete(this.key(record.digest));
    if (removed) this.notifyIfInactive(record.workspaceId);
    return removed;
  }

  revokeAll(): void {
    const workspaceIds = new Set([...this.records.values()].map((record) => record.workspaceId));
    this.records.clear();
    for (const workspaceId of workspaceIds) this.notifyIfInactive(workspaceId);
  }

  activeBindingCount(): number {
    return this.records.size;
  }

  activeWorkspaceCount(): number {
    return new Set([...this.records.values()].map((record) => record.workspaceId)).size;
  }
}
