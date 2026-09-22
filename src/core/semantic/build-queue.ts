/** One deterministic worker; priority changes are observed between durable batches. */
export class SemanticBuildQueue {
  private readonly pending = new Map<string, number>();
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly waiters = new Set<() => void>();
  error: unknown;

  constructor(private readonly process: (keys: readonly string[]) => Promise<readonly string[]>, private readonly complete: () => Promise<void>) {}

  enqueue(keys: readonly string[], priority = 0): void {
    if (this.stopped) return;
    for (const key of keys) this.pending.set(key, Math.max(priority, this.pending.get(key) ?? -Infinity));
    if (!this.running && this.pending.size) {
      this.error = undefined;
      this.running = this.run().catch((error: unknown) => { this.error = error; }).finally(() => {
        this.running = undefined;
        this.notify();
        if (!this.error && this.pending.size) this.enqueue([]);
      });
    }
  }
  private notify(): void { for (const waiter of this.waiters) waiter(); }
  private async run(): Promise<void> {
    // Let the initiating query enqueue its lexical candidates first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.pending.size && !this.stopped) {
      const keys = [...this.pending.keys()].sort((a, b) => this.pending.get(b)! - this.pending.get(a)! || a.localeCompare(b)).slice(0, 64);
      const priorities = new Map(keys.map((key) => [key, this.pending.get(key)!]));
      for (const key of keys) this.pending.delete(key);
      const done = new Set(await this.process(keys));
      for (const key of keys) if (!done.has(key) && !this.stopped) {
        this.pending.set(key, Math.max(priorities.get(key)!, this.pending.get(key) ?? -Infinity));
      }
      this.notify();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!this.stopped) await this.complete();
  }
  async waitUntil(predicate: () => boolean, budgetMs: number): Promise<void> {
    if (predicate() || !this.running) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(check); resolve(); };
      const check = () => { if (predicate() || !this.running || this.error || this.stopped) done(); };
      const timer = setTimeout(done, Math.max(0, budgetMs));
      this.waiters.add(check);
      check();
    });
  }
  async idle(): Promise<void> { await this.running; }
  stop(): void { this.stopped = true; this.pending.clear(); this.notify(); }
}

/** One in-flight request; queries have priority, with a bounded burst to prevent build starvation. */
export class EmbeddingRequestQueue {
  private running = false;
  private priorityBurst = 0;
  private pending: Array<{ priority: boolean; execute: () => void }> = [];
  run<T>(operation: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = { priority, execute: () => {
        this.running = true;
        Promise.resolve().then(operation).then(resolve, reject).finally(() => { this.running = false; this.next(); });
      } };
      this.pending.push(request); this.next();
    });
  }
  private next(): void {
    if (this.running || !this.pending.length) return;
    const priority = this.pending.findIndex((request) => request.priority);
    const background = this.pending.findIndex((request) => !request.priority);
    const chosen = background >= 0 && this.priorityBurst >= 8 ? background : priority < 0 ? 0 : priority;
    const request = this.pending.splice(chosen, 1)[0]!;
    this.priorityBurst = request.priority ? this.priorityBurst + 1 : 0;
    request.execute();
  }
}
