/** Bounded stable selection: the root is the worst currently retained result. */
export class TopResults<T> {
  private heap: Array<{ value: T; ordinal: number }> = [];
  private ordinal = 0;
  constructor(private readonly limit: number, private readonly compare: (left: T, right: T) => number) {}

  private order(left: { value: T; ordinal: number }, right: { value: T; ordinal: number }): number {
    return this.compare(left.value, right.value) || left.ordinal - right.ordinal;
  }

  add(value: T): void {
    const ordinal = this.ordinal++;
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      const entry = { value, ordinal };
      let index = this.heap.length;
      this.heap.push(entry);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this.order(this.heap[parent]!, entry) >= 0) break;
        this.heap[index] = this.heap[parent]!;
        index = parent;
      }
      this.heap[index] = entry;
      return;
    }
    // Equal later results cannot displace an earlier result in a stable sort.
    if (this.compare(value, this.heap[0]!.value) >= 0) return;
    const entry = { value, ordinal };
    let index = 0;
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && this.order(this.heap[child + 1]!, this.heap[child]!) > 0) child++;
      if (this.order(entry, this.heap[child]!) >= 0) break;
      this.heap[index] = this.heap[child]!;
      index = child;
    }
    this.heap[index] = entry;
  }

  sorted(): T[] {
    return [...this.heap].sort((left, right) => this.order(left, right)).map((entry) => entry.value);
  }
}
