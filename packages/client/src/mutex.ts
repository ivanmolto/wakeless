/**
 * Runs tasks one at a time per key, in arrival order; a failed task does not block
 * the next. The wrapper keys it by (vendor, mint), so one channel never has two
 * requests in flight: concurrent first calls to a vendor make one deposit, and
 * vouchers are signed in watermark order.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const run = prior.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}
