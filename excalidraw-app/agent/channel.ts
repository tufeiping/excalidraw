/**
 * Tiny async queue used to bridge callback-style streaming (provider deltas)
 * with the async generator that drives the agent loop.
 */
export class AsyncChannel<T> {
  private buffer: T[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(value: T) {
    if (this.closed) {
      return;
    }
    this.buffer.push(value);
    this.wake();
  }

  close() {
    this.closed = true;
    this.wake();
  }

  private wake() {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  async next(): Promise<{ value: T | null; done: boolean }> {
    while (this.buffer.length === 0) {
      if (this.closed) {
        return { value: null, done: true };
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    return { value: this.buffer.shift()!, done: false };
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      const item = await this.next();
      if (item.done) {
        return;
      }
      yield item.value as T;
    }
  }
}
