import { nextRunAt, ScheduleError, validateCron } from "./cron.js";
import { describeCron } from "./describe.js";
import {
  describeWindow,
  planWindowAfterFire,
  planWindowWake,
  validateWindow,
  type PlannedWake,
  type WakeWindow,
} from "./window.js";

/** When a routine wakes: a UTC cron expression, or a daily random window. */
export type ScheduleTiming = { cron: string; window: null } | { cron: null; window: WakeWindow };

export function validateTiming(input: { cron?: unknown; window?: unknown }): ScheduleTiming {
  const hasCron = input.cron !== undefined && input.cron !== null;
  const hasWindow = input.window !== undefined && input.window !== null;
  if (hasCron === hasWindow) {
    throw new ScheduleError("set exactly one of cron or window");
  }
  if (hasCron) {
    return { cron: validateCron(input.cron), window: null };
  }
  return { cron: null, window: validateWindow(input.window) };
}

function windowFromRow(value: unknown): WakeWindow {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const record = parsed as Record<string, unknown>;
  return {
    timezone: String(record.timezone),
    start: String(record.start),
    end: String(record.end),
    max_wakes: Number(record.max_wakes),
  };
}

export function rowTiming(row: Record<string, unknown>): ScheduleTiming {
  if (row.cron !== null && row.cron !== undefined) {
    return { cron: String(row.cron), window: null };
  }
  return { cron: null, window: windowFromRow(row.wake_window) };
}

export function describeTiming(timing: ScheduleTiming): string {
  return timing.window ? describeWindow(timing.window) : describeCron(timing.cron);
}

/** The first wake-up after `from` for a routine starting fresh (create, resume, release). */
export function planWake(
  timing: ScheduleTiming,
  from: Date,
  random: () => number = Math.random,
): PlannedWake {
  if (timing.window) {
    return planWindowWake(timing.window, from, 0, random);
  }
  return { at: nextRunAt(from, timing.cron), windowFires: 0 };
}

/** The wake-up that follows a fire of `row` at `firedAt`. */
export function planAfterFire(
  row: Record<string, unknown>,
  firedAt: Date,
  random: () => number = Math.random,
): PlannedWake {
  const timing = rowTiming(row);
  if (timing.window) {
    const due = row.next_run_at instanceof Date ? row.next_run_at : new Date(String(row.next_run_at));
    return planWindowAfterFire(timing.window, due, Number(row.window_fires ?? 0), firedAt, random);
  }
  return { at: nextRunAt(firedAt, timing.cron), windowFires: 0 };
}
