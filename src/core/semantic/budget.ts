/** A single foreground deadline, shared by initialization, queueing, search and coverage. */
export class SemanticBudget {
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private started = 0;
  private excludedMs = 0;
  private pausedAt?: number;
  expired = false;
  constructor(readonly milliseconds: number) {
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 30_000) {
      throw new Error("Semantic budget must be an integer between 1 and 30,000 ms.");
    }
  }
  get signal(): AbortSignal { return this.controller.signal; }
  get elapsedMs(): number { return this.started ? (this.pausedAt ?? performance.now()) - this.started - this.excludedMs : 0; }
  get remainingMs(): number { return Math.max(0, this.milliseconds - this.elapsedMs); }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.started) {
      this.started = performance.now();
      this.arm();
    }
    // Also catch synchronous work that crossed the deadline before timers could run.
    if (this.elapsedMs >= this.milliseconds) {
      this.expired = true;
      this.controller.abort(new Error("semantic_budget_exceeded"));
    }
    return abortable(operation, this.signal);
  }
  private arm(): void {
    this.timer = setTimeout(() => {
      this.expired = true;
      this.controller.abort(new Error("semantic_budget_exceeded"));
    }, this.remainingMs);
  }
  /** Sequential reranking has its own deadline; it must not consume embedding time.
   * Call only between completed semantic operations, never around concurrent work. */
  async excluding<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.started || this.expired || this.signal.aborted) return operation();
    if (this.pausedAt !== undefined) throw new Error("Semantic budget already paused.");
    if (this.remainingMs <= 0) {
      this.expired = true; this.controller.abort(new Error("semantic_budget_exceeded"));
      return operation();
    }
    this.stop(); this.pausedAt = performance.now();
    try { return await operation(); }
    finally {
      this.excludedMs += performance.now() - this.pausedAt; this.pausedAt = undefined;
      if (!this.signal.aborted) this.arm();
    }
  }
  stop(): void { clearTimeout(this.timer); }
  close(): void { this.stop(); this.controller.abort(new Error("semantic_request_finished")); }
}

/** Release the caller promptly, but keep observing the underlying operation. */
export async function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("semantic_cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
