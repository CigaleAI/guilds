import { sleep } from "../lib/event.js";
import { logOperationFailure, type OperationFailure } from "./errors.js";

type IdleHandle = {
  abort: AbortController;
  promise: Promise<void>;
};

/**
 * Idle stops by key: each runs its callback once the timeout passes without the key being armed
 * again or cancelled, and logs the failure the callback returns or throws. A timeout of zero or
 * less arms nothing.
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

  /** Arms the key's idle stop again, from now; the failure of its stop is logged. */
  arm(key: string, onIdle: () => Promise<OperationFailure | null>): void {
    this.cancel(key);
    if (this.timeoutMs <= 0) {
      return;
    }
    const abort = new AbortController();
    const promise = this.idleStop(key, abort, onIdle).then((failure) => logOperationFailure(failure));
    this.handles.set(key, { abort, promise });
  }

  /**
   * Runs `onIdle` once the timeout passes unless `abort` cancels the arming first, then drops the
   * key; returns the failure of a stop that did not go through.
   */
  private async idleStop(
    key: string,
    abort: AbortController,
    onIdle: () => Promise<OperationFailure | null>,
  ): Promise<OperationFailure | null> {
    try {
      await sleep(this.timeoutMs, abort.signal);
      return abort.signal.aborted ? null : await onIdle();
    } catch (error) {
      return { message: "idle stop failed", fields: { operation: "idle.stop" }, error };
    } finally {
      if (this.handles.get(key)?.abort === abort) {
        this.handles.delete(key);
      }
    }
  }
}
