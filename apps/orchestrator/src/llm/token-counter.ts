import { Worker } from "node:worker_threads";
import type { TokenCountJob, TokenCountReply } from "./token-count-worker.js";

const TOKEN_COUNT_WORKER_URL = new URL("./token-count-worker.ts", import.meta.url);

/** A count that did not finish: the queue was full, the count passed its deadline, the worker failed, or the count was cancelled. */
export class TokenCountError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenCountError";
  }
}

/** How many counts wait behind the one the worker encodes, and how long the worker may encode one. */
export type TokenCounterLimits = { maxPending: number; deadlineMs: number };

type PendingCount = {
  job: TokenCountJob;
  resolve: (tokens: number) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

type RunningCount = { worker: Worker; count: PendingCount; deadline: NodeJS.Timeout };

/**
 * Encodes texts on one worker thread, one text at a time, in the order they were asked for.
 * The worker starts on the first count and again after it fails; it holds the process open only
 * while it encodes.
 */
export class TokenCounter {
  /** How many workers the counter has started. */
  workersStarted = 0;
  private worker: Worker | null = null;
  private running: RunningCount | null = null;
  private readonly pending: PendingCount[] = [];
  private nextJobId = 1;

  constructor(
    private readonly encoding: string,
    private readonly limits: TokenCounterLimits,
  ) {}

  /** The token length of `text`; a signal aborted while the count waits removes it from the queue. */
  count(text: string, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) {
      return Promise.reject(new TokenCountError("token count cancelled"));
    }
    if (this.pending.length >= this.limits.maxPending) {
      return Promise.reject(new TokenCountError("token count queue is full"));
    }
    return new Promise((resolve, reject) => {
      const count: PendingCount = {
        job: { id: this.nextJobId++, text },
        resolve,
        reject,
        signal,
        onAbort: () => this.cancelPending(count),
      };
      signal?.addEventListener("abort", count.onAbort, { once: true });
      this.pending.push(count);
      this.dispatch();
    });
  }

  /** Stops the worker and rejects every count it has not answered. A later count starts a new worker. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const closed = new TokenCountError("token counter closed");
    for (const count of this.pending.splice(0)) {
      count.signal?.removeEventListener("abort", count.onAbort);
      count.reject(closed);
    }
    this.rejectRunning(closed);
    await worker?.terminate();
  }

  private dispatch(): void {
    if (this.running) {
      return;
    }
    const count = this.pending.shift();
    if (!count) {
      this.worker?.unref();
      return;
    }
    count.signal?.removeEventListener("abort", count.onAbort);
    const worker = this.startedWorker();
    worker.ref();
    const deadline = setTimeout(
      () => this.failWorker(worker, new TokenCountError(`token count passed ${this.limits.deadlineMs} ms`)),
      this.limits.deadlineMs,
    );
    this.running = { worker, count, deadline };
    worker.postMessage(count.job);
  }

  private startedWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(TOKEN_COUNT_WORKER_URL, { workerData: this.encoding, execArgv: [] });
    worker.on("message", (reply: TokenCountReply) => this.settle(worker, reply));
    worker.on("error", (error) => this.failWorker(worker, new TokenCountError("token count worker failed", { cause: error })));
    worker.on("exit", () => this.failWorker(worker, new TokenCountError("token count worker exited")));
    this.worker = worker;
    this.workersStarted += 1;
    return worker;
  }

  private settle(worker: Worker, reply: TokenCountReply): void {
    const running = this.running;
    if (!running || running.worker !== worker || running.count.job.id !== reply.id) {
      return;
    }
    clearTimeout(running.deadline);
    this.running = null;
    running.count.resolve(reply.tokens);
    this.dispatch();
  }

  /** Ends a worker that failed or passed the deadline: its count is rejected and the next count starts a new worker. */
  private failWorker(worker: Worker, error: TokenCountError): void {
    if (this.worker !== worker) {
      return;
    }
    this.worker = null;
    void worker.terminate();
    this.rejectRunning(error);
    this.dispatch();
  }

  private rejectRunning(error: TokenCountError): void {
    const running = this.running;
    if (!running) {
      return;
    }
    clearTimeout(running.deadline);
    this.running = null;
    running.count.reject(error);
  }

  private cancelPending(count: PendingCount): void {
    const index = this.pending.indexOf(count);
    if (index !== -1) {
      this.pending.splice(index, 1);
      count.reject(new TokenCountError("token count cancelled"));
    }
  }
}
