export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  get queueDepth(): number {
    return this.depth;
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      this.depth--;
      release();
    }
  }
}
