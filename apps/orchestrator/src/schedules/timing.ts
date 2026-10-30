import type { PlannedWake, ScheduleRow, ScheduleTiming, ScheduleTimingColumns } from "../db/schedules.js";
import { nextRunAt, ScheduleError, validateCron } from "./cron.js";
import { describeCron } from "./describe.js";
import type { RoutineTimingInput } from "./input.js";
import { describeWindow, planWindowAfterFire, planWindowWake, validateWindow } from "./window.js";

/** The timing `input` names, validated; it names exactly one of a cron and a window. */
export function validateTiming(input: RoutineTimingInput): ScheduleTiming {
  const cron = input.cron ?? null;
  const window = input.window ?? null;
  if (cron !== null && window === null) {
    return { cron: validateCron(cron), window: null };
  }
  if (window !== null && cron === null) {
    return { cron: null, window: validateWindow(window) };
  }
  throw new ScheduleError("set exactly one of cron or window");
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
    const due = { at: new Date(row.next_run_at), windowFires: row.window_fires };
    return planWindowAfterFire(timing.window, due, firedAt, random);
  }
  return { at: nextRunAt(firedAt, timing.cron), windowFires: 0 };
}
