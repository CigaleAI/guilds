import { Worker } from "node:worker_threads";
import type { MessagePayload } from "../db/schema/index.js";
import type { FunctionTool } from "../lib/tool-schema.js";
import type { TokenCountJob, TokenCountReply } from "./token-count-worker.js";

const TOKEN_COUNT_WORKER_URL = new URL("./token-count-worker.ts", import.meta.url);

/** A count that did not finish: the queue was full, the count passed its deadline, the worker failed or could not take it, or the count was cancelled. */
export class TokenCountError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenCountError";
  }
}

/** How many counts wait behind the one the worker encodes, and how long a count may take from the moment it is asked for. */
export type TokenCounterLimits = { maxPending: number; deadlineMs: number };

type PendingCount = {
  job: TokenCountJob;
  resolve: (tokens: number) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  deadline: NodeJS.Timeout;
};

type RunningCount = { worker: Worker; count: PendingCount };

/**
 * Serializes and encodes inputs on one worker thread, one input at a time, in the order they were
 * asked for. The worker starts on the first count and again after it fails; it holds the process
 * open only while it encodes.
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

  /** The token length of the input's text; a signal aborted while the count waits removes it from the queue. */
  count(
    messages: readonly MessagePayload[],
    tools: readonly FunctionTool[] | null | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    if (signal?.aborted) {
      return Promise.reject(new TokenCountError("token count cancelled"));
    }
    if (this.pending.length >= this.limits.maxPending) {
      return Promise.reject(new TokenCountError("token count queue is full"));
    }
    return new Promise((resolve, reject) => {
      const count: PendingCount = {
        job: { id: this.nextJobId++, messages, tools },
        resolve,
        reject,
        signal,
        onAbort: () => this.rejectPending(count, new TokenCountError("token count cancelled")),
        deadline: setTimeout(() => this.expire(count), this.limits.deadlineMs),
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
      this.release(count);
      count.reject(closed);
    }
    this.rejectRunning(closed);
    await worker?.terminate();
  }

  private dispatch(): void {
    while (!this.running) {
      const count = this.pending.shift();
      if (!count) {
        this.worker?.unref();
        return;
      }
      count.signal?.removeEventListener("abort", count.onAbort);
      const refused = this.send(count);
      if (refused) {
        this.running = null;
        this.release(count);
        count.reject(refused);
      }
    }
  }

  /** Hands the count to the worker, starting it when none runs; the error when it could not start or be sent the count. */
  private send(count: PendingCount): TokenCountError | null {
    try {
      const worker = this.startedWorker();
      worker.ref();
      this.running = { worker, count };
      worker.postMessage(count.job);
      return null;
    } catch (error) {
      return new TokenCountError("token count worker could not take the count", { cause: error });
    }
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
    this.running = null;
    this.release(running.count);
    running.count.resolve(reply.tokens);
    this.dispatch();
  }

  /** Rejects a count past its deadline: a waiting one leaves the queue, the one being encoded ends its worker. */
  private expire(count: PendingCount): void {
    const error = new TokenCountError(`token count passed ${this.limits.deadlineMs} ms`);
    if (this.running?.count === count) {
      this.failWorker(this.running.worker, error);
    } else {
      this.rejectPending(count, error);
    }
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
    this.running = null;
    this.release(running.count);
    running.count.reject(error);
  }

  private rejectPending(count: PendingCount, error: TokenCountError): void {
    const index = this.pending.indexOf(count);
    if (index !== -1) {
      this.pending.splice(index, 1);
      this.release(count);
      count.reject(error);
    }
  }

  /** Clears the count's deadline and abort listener once it leaves the counter. */
  private release(count: PendingCount): void {
    clearTimeout(count.deadline);
    count.signal?.removeEventListener("abort", count.onAbort);
  }
}
