import { monitorEventLoopDelay, type ELDHistogram } from "node:perf_hooks";
import * as Sentry from "@sentry/node";
import type pg from "pg";
import { writeLog } from "./log.js";

/** An event loop held at least this long is a stall: logged, counted, and its stack sent to Sentry. */
export const EVENT_LOOP_STALL_MS = 1000;

const SAMPLE_INTERVAL_MS = 10_000;
const DELAY_RESOLUTION_MS = 20;
const NS_PER_MS = 1e6;

export type RuntimeSample = {
  delayMaxMs: number;
  delayP99Ms: number;
  heapUsedBytes: number;
  rssBytes: number;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
};

type PoolCounts = Pick<pg.Pool, "totalCount" | "idleCount" | "waitingCount">;

/** Reads the event loop delay since the last sample, then starts the next window. */
export function readRuntimeSample(histogram: ELDHistogram, pool: PoolCounts): RuntimeSample {
  const memory = process.memoryUsage();
  const sample = {
    delayMaxMs: Math.round(histogram.max / NS_PER_MS),
    delayP99Ms: Math.round(histogram.percentile(99) / NS_PER_MS),
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  };
  histogram.reset();
  return sample;
}

/** Sends one sample to Sentry as gauges, and logs a stall when the loop was held. */
export function reportRuntimeSample(sample: RuntimeSample): void {
  Sentry.metrics.gauge("node.event_loop.delay_max", sample.delayMaxMs, { unit: "millisecond" });
  Sentry.metrics.gauge("node.event_loop.delay_p99", sample.delayP99Ms, { unit: "millisecond" });
  Sentry.metrics.gauge("node.memory.heap_used", sample.heapUsedBytes, { unit: "byte" });
  Sentry.metrics.gauge("node.memory.rss", sample.rssBytes, { unit: "byte" });
  Sentry.metrics.gauge("db.pool.total", sample.poolTotal);
  Sentry.metrics.gauge("db.pool.idle", sample.poolIdle);
  Sentry.metrics.gauge("db.pool.waiting", sample.poolWaiting);
  if (sample.delayMaxMs < EVENT_LOOP_STALL_MS) {
    return;
  }
  Sentry.metrics.count("node.event_loop.stall");
  writeLog("warn", `event loop stalled for ${sample.delayMaxMs} ms`, {
    operation: "runtime.stall",
  });
}

/** Samples the process and the database pool every 10 seconds; returns the stop. */
export function startRuntimeMetrics(pool: PoolCounts): () => void {
  const histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  histogram.enable();
  const timer = setInterval(() => {
    reportRuntimeSample(readRuntimeSample(histogram, pool));
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

/** A pooled connection that failed while idle: the pool has already dropped it. */
export function reportPoolError(error: Error): void {
  Sentry.metrics.count("db.pool.error");
  writeLog(
    "warn",
    `idle database connection lost: ${error.message}`,
    { operation: "db.pool", error_type: error.name },
    error,
  );
}
