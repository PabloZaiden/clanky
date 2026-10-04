/**
 * Bounded keyed serialization; idle queues release their keys immediately.
 */

export class KeyedOperationQueue {
  private readonly queues = new Map<string, { tail: Promise<void>; pending: number }>();
  private pending = 0;

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= 128 || this.pending >= 1000) throw new Error("Operation queue capacity reached.");
    const previous = queue.tail;
    const release = Promise.withResolvers<void>();
    queue.tail = release.promise;
    queue.pending += 1;
    this.pending += 1;
    this.queues.set(key, queue);
    try {
      await previous;
      return await operation();
    } finally {
      queue.pending -= 1;
      this.pending -= 1;
      release.resolve();
      if (!queue.pending) this.queues.delete(key);
    }
  }
}
