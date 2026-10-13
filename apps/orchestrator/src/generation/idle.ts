import { sleep } from "../lib/event.js";

type IdleHandle = {
  abort: AbortController;
  promise: Promise<void>;
};

/**
 * Idle stops by key: each runs its callback once the timeout passes without the key being armed
 * again or cancelled. A timeout of zero or less arms nothing.
 */
export class IdleTimers {
  private readonly handles = new Map<string, IdleHandle>();

  constructor(private readonly timeoutMs: number) {}

  has(key: string): boolean {
    return this.handles.has(key);
  }

  get(key: string): IdleHandle | undefined {
    return this.handles.get(key);
  }

  keys(): string[] {
    return [...this.handles.keys()];
  }

  cancel(key: string): void {
    this.handles.get(key)?.abort.abort();
    this.handles.delete(key);
  }

  /** Arms the key's idle stop again, from now. */
  arm(key: string, onIdle: () => Promise<void>): void {
    this.cancel(key);
    if (this.timeoutMs <= 0) {
      return;
    }
    const abort = new AbortController();
    const promise = (async () => {
      try {
        await sleep(this.timeoutMs, abort.signal);
        if (!abort.signal.aborted) {
          await onIdle();
        }
      } catch {
        return;
      } finally {
        if (this.handles.get(key)?.abort === abort) {
          this.handles.delete(key);
        }
      }
    })();
    this.handles.set(key, { abort, promise });
  }
}
