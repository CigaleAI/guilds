import { Cron } from "croner";

export const INSTRUCTION_MAX = 2000;
export const DESCRIPTION_MAX = 400;
export const MIN_GAP_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Any UTC day: a routine wakes at the same times of day on every day it fires.
const PATTERN_DAY_MS = Date.UTC(2000, 0, 3);

/** A refused routine request, with the HTTP status it answers with: 404 for one that does not exist, else 422. */
export class ScheduleError extends Error {
  status: 404 | 422;

  constructor(message: string, status: 404 | 422 = 422) {
    super(message);
    this.name = "ScheduleError";
    this.status = status;
  }
}

function collapseWs(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

export function validateCron(value: unknown): string {
  if (typeof value !== "string") {
    throw new ScheduleError("cron must be a string");
  }
  const text = collapseWs(value);
  if (!text) {
    throw new ScheduleError("cron must contain a 5-field expression");
  }
  if (text.split(" ").length !== 5) {
    throw new ScheduleError("cron must be 5 fields: minute hour day month weekday (UTC)");
  }
  try {
    const probe = new Cron(text, { timezone: "UTC" });
    if (!probe.nextRun()) {
      throw new ScheduleError("cron is invalid");
    }
  } catch (error) {
    if (error instanceof ScheduleError) {
      throw error;
    }
    throw new ScheduleError("cron is invalid");
  }
  if (shortestGapMs(text) < MIN_GAP_MS) {
    throw new ScheduleError("cron must wait at least 5 minutes between wake-ups");
  }
  return text;
}

/**
 * The shortest wait between two wake-ups of a 5-field cron. It reads the times of day the
 * minute and hour fields name, and counts the wait from a day's last wake-up to the first of
 * the next day as though the next day fires too.
 */
export function shortestGapMs(cron: string): number {
  const [minute, hour] = cron.split(" ");
  const fires = timesOfDay(`${minute} ${hour} * * *`);
  const first = fires[0] ?? PATTERN_DAY_MS;
  const gaps = fires.slice(1).map((at, index) => at - (fires[index] ?? at));
  return Math.min(first + DAY_MS - (fires[fires.length - 1] ?? first), ...gaps);
}

function timesOfDay(cron: string): number[] {
  const job = new Cron(cron, { timezone: "UTC" });
  const fires: number[] = [];
  let next = job.nextRun(new Date(PATTERN_DAY_MS - 1000));
  while (next && next.getTime() < PATTERN_DAY_MS + DAY_MS) {
    fires.push(next.getTime());
    next = job.nextRun(next);
  }
  return fires;
}

export function validateScheduleDescription(description: unknown): string {
  if (typeof description !== "string") {
    throw new ScheduleError("description must be a string");
  }
  const text = collapseWs(description);
  if (!text) {
    throw new ScheduleError("description must contain non-whitespace text");
  }
  if (text.length > DESCRIPTION_MAX) {
    throw new ScheduleError(`description must be at most ${DESCRIPTION_MAX} characters`);
  }
  return text;
}

export function validateInstruction(instruction: unknown): string {
  if (typeof instruction !== "string") {
    throw new ScheduleError("instruction must be a string");
  }
  const text = instruction.trim();
  if (!text) {
    throw new ScheduleError("instruction must contain non-whitespace text");
  }
  if (text.length > INSTRUCTION_MAX) {
    throw new ScheduleError(`instruction must be at most ${INSTRUCTION_MAX} characters`);
  }
  return text;
}

/**
 * next_run_at uses Croner. Croner and cron-parser both matched the R0 Vixie
 * DOM/DOW OR fixture (`0 0 1,15 * 1`). Croner is the pin; Quartz AND is rejected.
 */
export function nextRunAt(now: Date, cron: string): Date {
  const job = new Cron(cron, { timezone: "UTC" });
  const next = job.nextRun(now);
  if (!next) {
    throw new ScheduleError("cron is invalid");
  }
  next.setUTCMilliseconds(0);
  return next;
}

export function formatOffsetIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00").replace(/Z$/, "+00:00");
}
