import type { Client } from "@modelcontextprotocol/client";
import { setTimeout as delay } from "node:timers/promises";

export interface DesktopClientProvider {
  getClient(): Promise<Client>;
  invalidate(client: Client, error: unknown): void;
}

export interface DesktopClientConnection {
  client: Client;
  close(): Promise<void>;
}

export interface RecoverableDesktopClientOptions {
  connect(signal: AbortSignal): Promise<DesktopClientConnection>;
  lifecycleSignal: AbortSignal;
  attemptTimeoutMs?: number;
  connectionBudgetMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
}

export class DesktopGatewayAttemptTimeoutError extends Error {
  readonly code = "connection_timeout";

  constructor(timeoutMs: number) {
    super(`The local KnowledgeRail gateway connection did not complete within ${timeoutMs} ms.`);
    this.name = "DesktopGatewayAttemptTimeoutError";
  }
}

function abortError(signal: AbortSignal, timeoutMs: number): unknown {
  if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
    return new DesktopGatewayAttemptTimeoutError(timeoutMs);
  }
  return signal.reason ?? new Error("KnowledgeRail desktop gateway connection was aborted.");
}

function rejectOnAbort(signal: AbortSignal, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal, timeoutMs));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal, timeoutMs)), { once: true });
  });
}

function referencedTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/**
 * Maintains one recoverable desktop-to-gateway connection. It never replays a
 * failed domain operation: an uncertain call invalidates the transport and the
 * following user call reconnects through the single-flight path.
 */
export class RecoverableDesktopClientProvider implements DesktopClientProvider {
  private readonly attemptTimeoutMs: number;
  private readonly connectionBudgetMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private current?: DesktopClientConnection;
  private connecting?: Promise<DesktopClientConnection>;
  private cleanup: Promise<void> = Promise.resolve();
  private retryNotBeforeMs = 0;
  private closed = false;

  constructor(private readonly options: RecoverableDesktopClientOptions) {
    this.attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? (process.platform === "win32" ? 8_000 : 5_000));
    this.connectionBudgetMs = Math.max(this.attemptTimeoutMs, options.connectionBudgetMs ?? 15_000);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
    this.maxRetryDelayMs = Math.max(this.retryDelayMs, options.maxRetryDelayMs ?? 1_000);
    this.now = options.now ?? Date.now;
  }

  private async connectOnce(parentSignal: AbortSignal, attemptTimeoutMs: number): Promise<DesktopClientConnection> {
    await this.cleanup;
    if (this.closed || this.options.lifecycleSignal.aborted) {
      throw this.options.lifecycleSignal.reason ?? new Error("KnowledgeRail desktop adapter is closed.");
    }
    const remainingBackoff = this.retryNotBeforeMs - this.now();
    if (remainingBackoff > 0) {
      await delay(remainingBackoff, undefined, { signal: this.options.lifecycleSignal });
    }
    const attemptTimeout = referencedTimeoutSignal(attemptTimeoutMs);
    const signal = AbortSignal.any([this.options.lifecycleSignal, parentSignal, attemptTimeout.signal]);
    const pending = this.options.connect(signal);
    let accepted = false;
    void pending.then((connection) => {
      if (!accepted && signal.aborted) void connection.close().catch(() => undefined);
    }, () => undefined);
    try {
      const connection = await Promise.race([
        pending,
        rejectOnAbort(signal, attemptTimeoutMs),
      ]);
      accepted = true;
      if (this.closed || signal.aborted) {
        await connection.close().catch(() => undefined);
        throw abortError(signal, attemptTimeoutMs);
      }
      this.retryNotBeforeMs = 0;
      return connection;
    } catch (error) {
      this.retryNotBeforeMs = this.now() + this.retryDelayMs;
      throw error;
    } finally {
      attemptTimeout.clear();
    }
  }

  private async connectWithRetry(): Promise<DesktopClientConnection> {
    const budgetTimeout = referencedTimeoutSignal(this.connectionBudgetMs);
    const budgetSignal = budgetTimeout.signal;
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        try {
          return await this.connectOnce(budgetSignal, this.attemptTimeoutMs);
        } catch (error) {
          lastError = error;
          if (this.closed || this.options.lifecycleSignal.aborted || budgetSignal.aborted || attempt + 1 >= this.maxAttempts) {
            throw error;
          }
          const backoffMs = Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** attempt));
          if (backoffMs > 0) {
            await delay(backoffMs, undefined, {
              signal: AbortSignal.any([this.options.lifecycleSignal, budgetSignal]),
            }).catch(() => { throw lastError; });
          }
        }
      }
      throw lastError ?? new Error("KnowledgeRail desktop gateway connection failed.");
    } finally {
      budgetTimeout.clear();
    }
  }

  async getClient(): Promise<Client> {
    if (this.current) return this.current.client;
    if (!this.connecting) {
      this.connecting = this.connectWithRetry().then((connection) => {
        this.current = connection;
        return connection;
      }).finally(() => {
        this.connecting = undefined;
      });
    }
    return (await this.connecting).client;
  }

  preconnect(): Promise<Client> {
    return this.getClient();
  }

  invalidate(client: Client, _error: unknown): void {
    if (this.current?.client !== client) return;
    const invalid = this.current;
    this.current = undefined;
    this.retryNotBeforeMs = this.now() + this.retryDelayMs;
    this.cleanup = this.cleanup.then(() => invalid.close()).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return this.cleanup;
    this.closed = true;
    const active = this.current;
    this.current = undefined;
    await this.connecting?.catch(() => undefined);
    if (active) this.cleanup = this.cleanup.then(() => active.close()).catch(() => undefined);
    await this.cleanup;
  }
}
