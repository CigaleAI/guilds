import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, type ELDHistogram } from "node:perf_hooks";
import { test } from "node:test";
import { createPool } from "../../src/db/client.js";
import { logWriter } from "../../src/observability/log.js";
import {
  EVENT_LOOP_STALL_MS,
  openCpuWindow,
  readCpuPercent,
  readDiskSamples,
  readRuntimeSample,
  reportDatabaseConnections,
  reportPoolError,
  reportRuntimeSample,
  startRuntimeMetrics,
  toDiskSample,
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
    cpuPercent: 0,
    heapUsedBytes: 1,
    rssBytes: 1,
    hostLoad1m: 0,
    hostMemoryUsedPercent: 0,
    poolTotal: 1,
    poolIdle: 1,
    poolWaiting: 0,
  };
}

test("a runtime sample reads the delay in milliseconds, the host, and the pool counts, then resets the window", () => {
  let resets = 0;
  const histogram = {
    max: 2_500_000_000,
    percentile: (p: number) => (p === 99 ? 40_000_000 : 0),
    reset: () => {
      resets += 1;
    },
  } as unknown as ELDHistogram;
  const read = readRuntimeSample(
    { histogram, cpu: openCpuWindow() },
    { totalCount: 4, idleCount: 1, waitingCount: 2 },
  );
  assert.equal(read.delayMaxMs, 2500);
  assert.equal(read.delayP99Ms, 40);
  assert.deepEqual([read.poolTotal, read.poolIdle, read.poolWaiting], [4, 1, 2]);
  assert.ok(read.heapUsedBytes > 0);
  assert.ok(read.rssBytes > 0);
  assert.ok(read.cpuPercent >= 0);
  assert.ok(read.hostLoad1m >= 0);
  assert.ok(read.hostMemoryUsedPercent > 0 && read.hostMemoryUsedPercent <= 100);
  assert.equal(resets, 1);
});

test("process CPU reads as a percent of one core over the window, then opens the next window", () => {
  const now = process.cpuUsage();
  const window = {
    usage: { user: now.user - 500_000, system: now.system },
    at: performance.now() - 1000,
  };
  const percent = readCpuPercent(window);
  assert.ok(percent >= 45 && percent <= 60, `read ${percent}`);
  assert.ok(performance.now() - window.at < 100);
  assert.ok(readCpuPercent(window) < 45);
});

test("a disk sample counts free space and fill as df does", () => {
  assert.deepEqual(toDiskSample("root", { blocks: 100, bfree: 30, bavail: 20, bsize: 4096 }), {
    mount: "root",
    freeBytes: 20 * 4096,
    usedPercent: 78,
  });
});

test("a filesystem with no blocks gives no disk sample", () => {
  assert.equal(toDiskSample("proc", { blocks: 0, bfree: 0, bavail: 0, bsize: 4096 }), null);
});

test("disk samples read each mount and leave out a path that cannot be read", () => {
  const disks = readDiskSamples({
    temp: tmpdir(),
    gone: join(tmpdir(), "no-such-mount-for-guilds"),
  });
  assert.deepEqual(
    disks.map((disk) => disk.mount),
    ["temp"],
  );
  assert.ok(disks[0]!.freeBytes > 0);
});

test("database connections are read from pg_stat_activity with a query timeout", async () => {
  const asked: { text: string; query_timeout: number }[] = [];
  const pool = {
    query: async (config: { text: string; query_timeout: number }) => {
      asked.push(config);
      return { rows: [{ connections: 12, max_connections: 400 }] };
    },
  } as unknown as Parameters<typeof reportDatabaseConnections>[0];
  await reportDatabaseConnections(pool);
  assert.match(asked[0]!.text, /pg_stat_activity/);
  assert.equal(asked[0]!.query_timeout, 5000);
});

test("database connections with no row report nothing", async () => {
  const pool = {
    query: async () => ({ rows: [] }),
  } as unknown as Parameters<typeof reportDatabaseConnections>[0];
  await reportDatabaseConnections(pool);
});

test("a failed database connections read logs at debug and does not throw", async () => {
  const pool = {
    query: async () => {
      throw new Error("timeout exceeded");
    },
  } as unknown as Parameters<typeof reportDatabaseConnections>[0];
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    await reportDatabaseConnections(pool);
  } finally {
    logWriter.write = originalWrite;
  }
  const line = JSON.parse(chunks[0]!) as Record<string, unknown>;
  assert.equal(line.level, "debug");
  assert.equal(line.operation, "runtime.db");
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
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 0, query: async () => ({ rows: [] }) };
  const stop = startRuntimeMetrics(
    pool as unknown as Parameters<typeof startRuntimeMetrics>[0],
    {},
  );
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
