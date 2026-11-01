/** Runs tasks one at a time per key, in arrival order. A failed task does not block the next. */
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
