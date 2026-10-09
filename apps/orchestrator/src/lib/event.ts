export class AsyncEvent {
  private flagged = false;
  private waiters: Array<() => void> = [];

  isSet(): boolean {
    return this.flagged;
  }

  set(): void {
    this.flagged = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  clear(): void {
    this.flagged = false;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.flagged) {
      return Promise.resolve();
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("aborted"));
    }
    return new Promise((resolve, reject) => {
      const wrapped = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("aborted"));
      };
      const cleanup = () => {
        this.waiters = this.waiters.filter((item) => item !== wrapped);
        signal?.removeEventListener("abort", onAbort);
      };
      this.waiters.push(wrapped);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class EventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  dropped = false;

  get size(): number {
    return this.items.length;
  }

  empty(): boolean {
    return this.items.length === 0;
  }

  async put(item: T): Promise<void> {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async get(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    const item = this.items.shift();
    if (item !== undefined) {
      return item;
    }
    return new Promise((resolve, reject) => {
      const waiter = (value: T) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("aborted"));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
