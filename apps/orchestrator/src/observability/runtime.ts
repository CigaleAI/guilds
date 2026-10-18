import { statfsSync, type StatsFs } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { monitorEventLoopDelay, performance, type ELDHistogram } from "node:perf_hooks";
import * as Sentry from "@sentry/node";
import type pg from "pg";
import { writeLog } from "./log.js";

/** An event loop held at least this long is a stall: logged, counted, and its stack sent to Sentry. */
export const EVENT_LOOP_STALL_MS = 1000;

const SAMPLE_INTERVAL_MS = 10_000;
const DELAY_RESOLUTION_MS = 20;
const DB_QUERY_TIMEOUT_MS = 5000;
const NS_PER_MS = 1e6;
const US_PER_MS = 1000;
const PERCENT = 100;

const CONNECTIONS_SQL = `select count(*)::int as connections,
  current_setting('max_connections')::int as max_connections
  from pg_stat_activity where backend_type = 'client backend'`;

export type RuntimeSample = {
  delayMaxMs: number;
  delayP99Ms: number;
  cpuPercent: number;
  heapUsedBytes: number;
  rssBytes: number;
  hostLoad1m: number;
  hostMemoryUsedPercent: number;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
};

/** The process CPU time and the clock when a sample window opened. */
export type CpuWindow = { usage: NodeJS.CpuUsage; at: number };

/** What the sampler carries from one sample to the next. */
export type RuntimeProbe = { histogram: ELDHistogram; cpu: CpuWindow };

/** Mount names, such as root or workspace, to a path on that filesystem. */
export type DiskPaths = Record<string, string>;

export type DiskSample = { mount: string; freeBytes: number; usedPercent: number };

type PoolCounts = Pick<pg.Pool, "totalCount" | "idleCount" | "waitingCount">;

type RuntimePool = PoolCounts & Pick<pg.Pool, "query">;

type ConnectionsRow = { connections: number; max_connections: number };

// pg reads query_timeout per query; its types only declare it on the client.
const CONNECTIONS_QUERY: pg.QueryConfig & { query_timeout: number } = {
  text: CONNECTIONS_SQL,
  query_timeout: DB_QUERY_TIMEOUT_MS,
};

export function openCpuWindow(): CpuWindow {
  return { usage: process.cpuUsage(), at: performance.now() };
}

/** Process CPU since the window opened, as a percent of one core (two busy cores read 200); opens the next. */
export function readCpuPercent(window: CpuWindow): number {
  const used = process.cpuUsage(window.usage);
  const now = performance.now();
  const elapsedMs = Math.max(now - window.at, 1);
  window.usage = process.cpuUsage();
  window.at = now;
  return Math.round(((used.user + used.system) / US_PER_MS / elapsedMs) * PERCENT);
}

/** Reads the process, the host, and the pool since the last sample, then starts the next window. */
export function readRuntimeSample(probe: RuntimeProbe, pool: PoolCounts): RuntimeSample {
  const memory = process.memoryUsage();
  const sample = {
    delayMaxMs: Math.round(probe.histogram.max / NS_PER_MS),
    delayP99Ms: Math.round(probe.histogram.percentile(99) / NS_PER_MS),
    cpuPercent: readCpuPercent(probe.cpu),
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    hostLoad1m: loadavg()[0] ?? 0,
    hostMemoryUsedPercent: Math.round((1 - freemem() / totalmem()) * PERCENT),
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  };
  probe.histogram.reset();
  return sample;
}

/** Sends one sample to Sentry as gauges, and logs a stall when the loop was held. */
export function reportRuntimeSample(sample: RuntimeSample): void {
  Sentry.metrics.gauge("node.event_loop.delay_max", sample.delayMaxMs, { unit: "millisecond" });
  Sentry.metrics.gauge("node.event_loop.delay_p99", sample.delayP99Ms, { unit: "millisecond" });
  Sentry.metrics.gauge("node.cpu", sample.cpuPercent, { unit: "percent" });
  Sentry.metrics.gauge("node.memory.heap_used", sample.heapUsedBytes, { unit: "byte" });
  Sentry.metrics.gauge("node.memory.rss", sample.rssBytes, { unit: "byte" });
  Sentry.metrics.gauge("host.load_1m", sample.hostLoad1m);
  Sentry.metrics.gauge("host.memory.used", sample.hostMemoryUsedPercent, { unit: "percent" });
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

/** One filesystem's free space and fill, as `df` counts them; null for one with no blocks. */
export function toDiskSample(
  mount: string,
  stats: Pick<StatsFs, "blocks" | "bfree" | "bavail" | "bsize">,
): DiskSample | null {
  const usedBlocks = stats.blocks - stats.bfree;
  const usableBlocks = usedBlocks + stats.bavail;
  if (usableBlocks <= 0) {
    return null;
  }
  return {
    mount,
    freeBytes: stats.bavail * stats.bsize,
    usedPercent: Math.round((usedBlocks / usableBlocks) * PERCENT),
  };
}

/** Each mount's free space and fill; a path that cannot be read is left out. */
export function readDiskSamples(paths: DiskPaths): DiskSample[] {
  return Object.entries(paths).flatMap(([mount, path]) => {
    try {
      return [toDiskSample(mount, statfsSync(path))].filter((disk) => disk !== null);
    } catch {
      return [];
    }
  });
}

export function reportDiskSamples(disks: DiskSample[]): void {
  for (const disk of disks) {
    const attributes = { mount: disk.mount };
    Sentry.metrics.gauge("host.disk.free", disk.freeBytes, { unit: "byte", attributes });
    Sentry.metrics.gauge("host.disk.used", disk.usedPercent, { unit: "percent", attributes });
  }
}

/** The database server's client connections against its limit; a failed read waits for the next sample. */
export async function reportDatabaseConnections(pool: Pick<pg.Pool, "query">): Promise<void> {
  try {
    const result = await pool.query<ConnectionsRow>(CONNECTIONS_QUERY);
    const row = result.rows[0];
    if (!row) {
      return;
    }
    Sentry.metrics.gauge("db.server.connections", row.connections);
    Sentry.metrics.gauge("db.server.max_connections", row.max_connections);
  } catch (error) {
    writeLog("debug", "database connections not read", { operation: "runtime.db" }, error);
  }
}

/** Samples the process, the host, its disks, and the database every 10 seconds; returns the stop. */
export function startRuntimeMetrics(pool: RuntimePool, disks: DiskPaths): () => void {
  const probe = {
    histogram: monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS }),
    cpu: openCpuWindow(),
  };
  probe.histogram.enable();
  const timer = setInterval(() => {
    reportRuntimeSample(readRuntimeSample(probe, pool));
    reportDiskSamples(readDiskSamples(disks));
    void reportDatabaseConnections(pool);
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    probe.histogram.disable();
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
