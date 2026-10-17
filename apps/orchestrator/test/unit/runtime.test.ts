import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ELDHistogram } from "node:perf_hooks";
import { test } from "node:test";
import { createPool } from "../../src/db/client.js";
import { logWriter } from "../../src/observability/log.js";
import {
  EVENT_LOOP_STALL_MS,
  readRuntimeSample,
  reportPoolError,
  reportRuntimeSample,
  startRuntimeMetrics,
  type RuntimeSample,
} from "../../src/observability/runtime.js";

function captureLines(run: () => void): Record<string, unknown>[] {
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    run();
  } finally {
    logWriter.write = originalWrite;
  }
  return chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
}

function sample(delayMaxMs: number): RuntimeSample {
  return {
    delayMaxMs,
    delayP99Ms: 0,
    heapUsedBytes: 1,
    rssBytes: 1,
    poolTotal: 1,
    poolIdle: 1,
    poolWaiting: 0,
  };
}

test("a runtime sample reads the delay in milliseconds and the pool counts, then resets the window", () => {
  let resets = 0;
  const histogram = {
    max: 2_500_000_000,
    percentile: (p: number) => (p === 99 ? 40_000_000 : 0),
    reset: () => {
      resets += 1;
    },
  } as unknown as ELDHistogram;
  const read = readRuntimeSample(histogram, { totalCount: 4, idleCount: 1, waitingCount: 2 });
  assert.equal(read.delayMaxMs, 2500);
  assert.equal(read.delayP99Ms, 40);
  assert.deepEqual([read.poolTotal, read.poolIdle, read.poolWaiting], [4, 1, 2]);
  assert.ok(read.heapUsedBytes > 0);
  assert.ok(read.rssBytes > 0);
  assert.equal(resets, 1);
});

test("a sample whose loop was held past the stall threshold logs a stall warning", () => {
  const lines = captureLines(() => reportRuntimeSample(sample(EVENT_LOOP_STALL_MS + 1500)));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "warn");
  assert.equal(lines[0]?.operation, "runtime.stall");
  assert.equal(lines[0]?.message, `event loop stalled for ${EVENT_LOOP_STALL_MS + 1500} ms`);
});

test("a sample under the stall threshold logs nothing", () => {
  assert.deepEqual(
    captureLines(() => reportRuntimeSample(sample(EVENT_LOOP_STALL_MS - 1))),
    [],
  );
});

test("runtime metrics stop when asked", () => {
  const stop = startRuntimeMetrics({ totalCount: 0, idleCount: 0, waitingCount: 0 });
  stop();
});

test("a lost idle connection logs a warning naming the error", () => {
  const error = new Error("Connection terminated unexpectedly");
  const lines = captureLines(() => reportPoolError(error));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "warn");
  assert.equal(lines[0]?.operation, "db.pool");
  assert.equal(lines[0]?.error_type, "Error");
  assert.equal(
    lines[0]?.message,
    "idle database connection lost: Connection terminated unexpectedly",
  );
});

test("the pool keeps connections alive, bounds the handshake, and reports idle errors", async () => {
  const pool = await createPool("postgresql://user:pass@127.0.0.1:1/db");
  try {
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    assert.equal(options.keepAlive, true);
    assert.equal(options.connectionTimeoutMillis, 10_000);
    assert.equal(pool.listenerCount("error"), 1);
    const lines = captureLines(() => {
      (pool as unknown as EventEmitter).emit("error", new Error("gone"));
    });
    assert.equal(lines[0]?.operation, "db.pool");
  } finally {
    await pool.end();
  }
});
