/**
 * The words a routine's timing reads as, the same as the orchestrator's `schedules/describe.ts`
 * and `describeWindow`, so the form shows the label the server will store. The tests pin both to
 * the shared compat fixture.
 */
import type { WakeWindow } from "../../../api/types/schedules";

/** A cron the describer has no words for; describeCron answers with the expression itself. */
class CronDescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronDescriptionError";
  }
}

const DOW: Record<string, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 0,
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};

const DOW_NAME = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH: Record<string, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  "11": 11,
  "12": 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_NAME = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function joinAnd(parts: string[]): string {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function stepSize(field: string): number | null {
  if (field.startsWith("*/") && /^\d+$/.test(field.slice(2))) {
    const size = Number(field.slice(2));
    if (size > 0) {
      return size;
    }
  }
  return null;
}

function parseToken(
  token: string,
  table: Record<string, number> | null,
  lo: number,
  hi: number,
): number {
  const key = token.toLowerCase();
  let value: number;
  if (table && key in table) {
    value = table[key]!;
  } else if (/^\d+$/.test(token)) {
    value = Number(token);
  } else {
    throw new CronDescriptionError(`unsupported cron token ${token}`);
  }
  if (value < lo || value > hi) {
    throw new CronDescriptionError(`cron token ${token} out of range`);
  }
  return value;
}

function expandField(
  field: string,
  table: Record<string, number> | null,
  lo: number,
  hi: number,
): number[] {
  const values: number[] = [];
  for (const item of field.split(",")) {
    if (item.includes("/")) {
      throw new CronDescriptionError(`unsupported cron step ${item}`);
    }
    if (item.includes("-")) {
      const [startS, endS] = item.split("-", 2);
      const start = parseToken(startS!, table, lo, hi);
      const end = parseToken(endS!, table, lo, hi);
      if (start > end) {
        throw new CronDescriptionError(`unsupported cron range ${item}`);
      }
      for (let value = start; value <= end; value += 1) {
        values.push(value);
      }
    } else {
      values.push(parseToken(item, table, lo, hi));
    }
  }
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** A minute step's words: every N minutes of every hour, or of the hours listed. */
function describeMinuteStep(minStep: number, hour: string): string {
  if (hour === "*") {
    return minStep === 1 ? "Every minute" : `Every ${minStep} minutes`;
  }
  if (stepSize(hour) !== null) {
    throw new CronDescriptionError("unsupported time fields");
  }
  const hours = joinAnd(expandField(hour, null, 0, 23).map((value) => `${pad2(value)}:00`));
  return `Every ${minStep} minutes during ${hours}`;
}

/** Fixed minutes past every hour, or past every `hourStep` hours. */
function describeMinutesPast(minute: string, hourStep: number | null): string {
  const minutes = expandField(minute, null, 0, 59);
  const hours = hourStep === null ? "hour" : `${hourStep} hours`;
  if (minutes.length === 1 && minutes[0] === 0) {
    return `Every ${hours}`;
  }
  return `At minute ${joinAnd(minutes.map((value) => pad2(value)))} past every ${hours}`;
}

/** Each listed hour at each listed minute, as clock times; refused past eight of them. */
function describeClockTimes(minute: string, hour: string): string {
  const minutes = expandField(minute, null, 0, 59);
  const hours = expandField(hour, null, 0, 23);
  const times = hours.flatMap((h) => minutes.map((m) => `${pad2(h)}:${pad2(m)}`));
  if (times.length > 8) {
    throw new CronDescriptionError("too many clock times");
  }
  return `At ${joinAnd(times)}`;
}

function describeTime(minute: string, hour: string): string {
  if (minute === "*" && hour === "*") {
    return "Every minute";
  }
  const minStep = stepSize(minute);
  if (minStep !== null) {
    return describeMinuteStep(minStep, hour);
  }
  if (minute === "*") {
    throw new CronDescriptionError("unsupported time fields");
  }
  if (hour === "*") {
    return describeMinutesPast(minute, null);
  }
  const hourStep = stepSize(hour);
  if (hourStep !== null) {
    return describeMinutesPast(minute, hourStep);
  }
  return describeClockTimes(minute, hour);
}

function isClockTime(minute: string, hour: string): boolean {
  return minute !== "*" && hour !== "*" && stepSize(minute) === null && stepSize(hour) === null;
}

/**
 * The values a calendar field of a cron takes, `lo` to `hi`, and `offset`, what a value adds to
 * reach its name in the field's list of names.
 */
type CalendarFieldBounds = { lo: number; hi: number; offset: number };

const WEEKDAY_BOUNDS: CalendarFieldBounds = { lo: 0, hi: 7, offset: 0 };

const MONTH_BOUNDS: CalendarFieldBounds = { lo: 1, hi: 12, offset: -1 };

/** A field that is one range, such as `MON-FRI`, as "Monday through Friday"; null for any other field. */
function describeRange(
  field: string,
  table: Record<string, number>,
  names: readonly string[],
  bounds: CalendarFieldBounds,
): string | null {
  if (field.includes(",") || field.includes("/") || !field.includes("-")) {
    return null;
  }
  const [startS, endS] = field.split("-", 2);
  const start = parseToken(startS!, table, bounds.lo, bounds.hi);
  const end = parseToken(endS!, table, bounds.lo, bounds.hi);
  return `${names[start + bounds.offset]} through ${names[end + bounds.offset]}`;
}

function describeDom(day: string): string | null {
  if (day === "*") {
    return null;
  }
  const step = stepSize(day);
  if (step !== null) {
    return `every ${step} days`;
  }
  const values = expandField(day, null, 1, 31);
  if (values.length === 1) {
    return `on day ${values[0]} of the month`;
  }
  return `on days ${joinAnd(values.map(String))} of the month`;
}

function describeDow(weekday: string): string | null {
  if (weekday === "*") {
    return null;
  }
  const step = stepSize(weekday);
  if (step !== null) {
    return `every ${step} days of the week`;
  }
  const spanned = describeRange(weekday, DOW, DOW_NAME, WEEKDAY_BOUNDS);
  if (spanned !== null) {
    return `on ${spanned}`;
  }
  const names = expandField(weekday, DOW, 0, 7).map((value) => DOW_NAME[value]!);
  if (names.length === 1) {
    return `on ${names[0]}`;
  }
  return `on ${joinAnd(names)}`;
}

function describeMonth(month: string): string | null {
  if (month === "*") {
    return null;
  }
  const step = stepSize(month);
  if (step !== null) {
    return `every ${step} months`;
  }
  const spanned = describeRange(month, MONTH, MONTH_NAME, MONTH_BOUNDS);
  if (spanned !== null) {
    return `in ${spanned}`;
  }
  const names = expandField(month, MONTH, 1, 12).map((value) => MONTH_NAME[value - 1]!);
  if (names.length === 1) {
    return `in ${names[0]}`;
  }
  return `in ${joinAnd(names)}`;
}

function describeCalendar(day: string, month: string, weekday: string): string {
  const dom = describeDom(day);
  const dow = describeDow(weekday);
  const mon = describeMonth(month);
  let days: string;
  if (dom && dow) {
    days = `${dom} and ${dow}`;
  } else {
    days = dom || dow || "";
  }
  if (days && mon) {
    return `${days} ${mon}`;
  }
  return days || mon || "";
}

/** The five fields of a cron expression, minute first. */
type CronFields = { minute: string; hour: string; day: string; month: string; weekday: string };

/** A cron expression's fields; null when it has more or fewer than five. */
function cronFields(text: string): CronFields | null {
  const [minute, hour, day, month, weekday, ...rest] = text.split(" ");
  if (minute === undefined || hour === undefined || day === undefined) return null;
  if (month === undefined || weekday === undefined || rest.length > 0) return null;
  return { minute, hour, day, month, weekday };
}

export function describeCron(value: string): string {
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  const fields = cronFields(text);
  if (!fields) {
    return text;
  }
  const { minute, hour, day, month, weekday } = fields;
  try {
    let label = describeTime(minute, hour);
    let when = describeCalendar(day, month, weekday);
    if (!when && isClockTime(minute, hour)) {
      when = "every day";
    }
    if (when) {
      label = `${label} ${when}`;
    }
    return `${label} (UTC)`;
  } catch (error) {
    if (error instanceof CronDescriptionError) {
      return text;
    }
    throw error;
  }
}

export function describeWindow(win: WakeWindow): string {
  const count = win.max_wakes === 1 ? "1 random wake-up" : `Up to ${win.max_wakes} random wake-ups`;
  return `${count} between ${win.start} and ${win.end} every day (${win.timezone})`;
}
