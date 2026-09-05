/** Ordered results with bounded in-flight work. Drain started work before rejecting. */
export async function mapConcurrent<T, U>(items: readonly T[], concurrency: number, operation: (item: T, index: number) => Promise<U>): Promise<U[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  const results = new Array<U>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, () => worker()));
  if (failed) throw failure;
  return results;
}
