export class AsyncLock {
  private chain: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Locks by key: the work of each key runs one at a time, in the order it came; a key no work holds keeps nothing. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const release = (): void => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
    const tail: Promise<void> = run.then(release, release);
    this.tails.set(key, tail);
    return run;
  }
}
