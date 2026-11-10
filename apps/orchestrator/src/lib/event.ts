import type { JsonObject } from "./json.js";

/** What each event of a stream carries, by the event's name: the JSON object sent as its data. */
export type EventPayloads = { [name: string]: JsonObject };

/** One event of a stream whose events `Events` names: the event's name, and the data it carries. */
export type StreamEvent<Events extends EventPayloads> = {
  [Name in keyof Events & string]: [name: Name, data: Events[Name]];
}[keyof Events & string];

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
  private readonly dropping = new AbortController();

  /** Whether the queue was dropped: it then holds nothing and refuses every read. */
  get dropped(): boolean {
    return this.dropping.signal.aborted;
  }

  /** Drops the queue: what it holds is discarded, and every read, waiting or to come, is refused. */
  drop(): void {
    this.items = [];
    this.dropping.abort();
  }

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

  /** The next item; refused once `signal` aborts or the queue is dropped. */
  async get(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted || this.dropped) {
      throw new Error("aborted");
    }
    const item = this.items.shift();
    if (item !== undefined) {
      return item;
    }
    return new Promise((resolve, reject) => {
      const stopListening = () => {
        signal?.removeEventListener("abort", onAbort);
        this.dropping.signal.removeEventListener("abort", onAbort);
      };
      const waiter = (value: T) => {
        stopListening();
        resolve(value);
      };
      const onAbort = () => {
        stopListening();
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("aborted"));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.dropping.signal.addEventListener("abort", onAbort, { once: true });
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
