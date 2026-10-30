import { Cron } from "croner";
import type { PlannedWake } from "../db/schedules.js";
import type { WakeWindow } from "../db/schema/index.js";
import { MIN_GAP_MS, ScheduleError } from "./cron.js";

/** Each gap is drawn uniformly within ±JITTER of the current mean gap. */
export const JITTER = 0.5;

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WINDOW_KEYS = ["timezone", "start", "end", "max_wakes"];

function validateClock(value: string, field: string): string {
  if (!CLOCK_RE.test(value.trim())) {
    throw new ScheduleError(`window.${field} must be a 24-hour HH:MM time`);
  }
  return value.trim();
}

export function validateTimezone(value: string, field = "timezone"): string {
  if (!value.trim()) {
    throw new ScheduleError(`${field} must be an IANA timezone such as Europe/Paris`);
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleError(`${field} must be an IANA timezone such as Europe/Paris`);
  }
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

export function validateWindow(value: WakeWindow): WakeWindow {
  const extra = Object.keys(value).filter((key) => !WINDOW_KEYS.includes(key));
  if (extra.length) {
    throw new ScheduleError(`window has unknown field ${extra[0]}`);
  }
  const timezone = validateTimezone(value.timezone, "window.timezone");
  const start = validateClock(value.start, "start");
  const end = validateClock(value.end, "end");
  if (start === end) {
    throw new ScheduleError("window.start and window.end must differ");
  }
  const maxWakes = value.max_wakes;
  if (!Number.isInteger(maxWakes) || maxWakes < 1) {
    throw new ScheduleError("window.max_wakes must be a positive integer");
  }
  const span = (clockMinutes(end) - clockMinutes(start) + 1440) % 1440;
  const ceiling = Math.floor((span * 60 * 1000) / MIN_GAP_MS);
  if (maxWakes > ceiling) {
    throw new ScheduleError(
      `window.max_wakes must be at most ${ceiling} so wake-ups stay at least 5 minutes apart`,
    );
  }
  return { timezone, start, end, max_wakes: maxWakes };
}

/** The first instant strictly after `after` whose local clock in the window's timezone reads `clock`. */
function boundary(win: WakeWindow, clock: string, after: Date): Date {
  const [hour, minute] = clock.split(":").map(Number);
  const next = new Cron(`${minute} ${hour} * * *`, { timezone: win.timezone }).nextRun(after);
  if (!next) {
    throw new ScheduleError("window is invalid");
  }
  return next;
}

/** End of the window containing `at`, or null when `at` falls between windows. Windows are [start, end). */
export function windowEndAt(win: WakeWindow, at: Date): Date | null {
  const start = boundary(win, win.start, at);
  const end = boundary(win, win.end, at);
  return end.getTime() < start.getTime() ? end : null;
}

function wholeSecond(ms: number): Date {
  return new Date(Math.ceil(ms / 1000) * 1000);
}

/**
 * Plan the wake-up after `from`, given `fired` wake-ups already in the window
 * containing `from`. Inside a window the mean gap is the time left divided by
 * the wake-ups left, jittered by ±JITTER; once the window is spent the plan
 * moves to a random instant in the first slot of the next window.
 */
export function planWindowWake(
  win: WakeWindow,
  from: Date,
  fired: number,
  random: () => number = Math.random,
): PlannedWake {
  const floor = from.getTime() + MIN_GAP_MS;
  const end = windowEndAt(win, from);
  if (end !== null) {
    const remaining = win.max_wakes - fired;
    if (remaining > 0) {
      const mean = (end.getTime() - from.getTime()) / remaining;
      const gap = mean * (1 + JITTER * (2 * random() - 1));
      const at = wholeSecond(Math.max(floor, from.getTime() + gap));
      if (at.getTime() < end.getTime()) {
        return { at, windowFires: fired };
      }
    }
  }
  const start = boundary(win, win.start, from);
  const close = boundary(win, win.end, start);
  const slot = (close.getTime() - start.getTime()) / win.max_wakes;
  return { at: wholeSecond(Math.max(floor, start.getTime() + random() * slot)), windowFires: 0 };
}

/**
 * Plan the wake-up after a fire at `firedAt` of the wake `due`, planned with
 * `due.windowFires` earlier wake-ups in its window. A fire that lands outside
 * any window (a late fire after the window closed) does not count toward the
 * next window.
 */
export function planWindowAfterFire(
  win: WakeWindow,
  due: PlannedWake,
  firedAt: Date,
  random: () => number = Math.random,
): PlannedWake {
  const end = windowEndAt(win, firedAt);
  if (end === null) {
    return planWindowWake(win, firedAt, 0, random);
  }
  const dueEnd = windowEndAt(win, due.at);
  const prior = dueEnd !== null && dueEnd.getTime() === end.getTime() ? due.windowFires : 0;
  return planWindowWake(win, firedAt, prior + 1, random);
}

export function describeWindow(win: WakeWindow): string {
  const count = win.max_wakes === 1 ? "1 random wake-up" : `Up to ${win.max_wakes} random wake-ups`;
  return `${count} between ${win.start} and ${win.end} every day (${win.timezone})`;
}
