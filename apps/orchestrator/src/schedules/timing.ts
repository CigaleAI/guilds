import type { PlannedWake, ScheduleRow, ScheduleTiming, ScheduleTimingColumns } from "../db/schedules.js";
import { nextRunAt, ScheduleError, validateCron } from "./cron.js";
import { describeCron } from "./describe.js";
import { describeWindow, planWindowAfterFire, planWindowWake, validateWindow } from "./window.js";

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

export function rowTiming(row: ScheduleTimingColumns): ScheduleTiming {
  return row.wake_window === null
    ? { cron: row.cron, window: null }
    : { cron: null, window: row.wake_window };
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
  row: ScheduleRow,
  firedAt: Date,
  random: () => number = Math.random,
): PlannedWake {
  const timing = rowTiming(row);
  if (timing.window) {
    return planWindowAfterFire(
      timing.window,
      new Date(row.next_run_at),
      row.window_fires,
      firedAt,
      random,
    );
  }
  return { at: nextRunAt(firedAt, timing.cron), windowFires: 0 };
}
