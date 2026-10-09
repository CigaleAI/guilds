/**
 * The words a routine's timing reads as, the same as the orchestrator's `schedules/describe.ts`
 * and `describeWindow`, so the form shows the label the server will store. The tests pin both to
 * the shared compat fixture.
 */
import type { WakeWindow } from "../../../api/types";

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
    throw new Error(`unsupported cron token ${token}`);
  }
  if (value < lo || value > hi) {
    throw new Error(`cron token ${token} out of range`);
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
      throw new Error(`unsupported cron step ${item}`);
    }
    if (item.includes("-")) {
      const [startS, endS] = item.split("-", 2);
      const start = parseToken(startS!, table, lo, hi);
      const end = parseToken(endS!, table, lo, hi);
      if (start > end) {
        throw new Error(`unsupported cron range ${item}`);
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

function describeTime(minute: string, hour: string): string {
  const minStep = stepSize(minute);
  const hourStep = stepSize(hour);
  if (minute === "*" && hour === "*") {
    return "Every minute";
  }
  if (minStep !== null && hour === "*") {
    if (minStep === 1) {
      return "Every minute";
    }
    return `Every ${minStep} minutes`;
  }
  if (minStep !== null && hour !== "*" && hourStep === null) {
    const hours = joinAnd(expandField(hour, null, 0, 23).map((value) => `${pad2(value)}:00`));
    return `Every ${minStep} minutes during ${hours}`;
  }
  if (minStep === null && minute !== "*" && hour === "*") {
    const minutes = expandField(minute, null, 0, 59);
    if (minutes.length === 1 && minutes[0] === 0) {
      return "Every hour";
    }
    const labels = minutes.map((value) => pad2(value));
    if (labels.length === 1) {
      return `At minute ${labels[0]} past every hour`;
    }
    return `At minute ${joinAnd(labels)} past every hour`;
  }
  if (minStep === null && minute !== "*" && hourStep !== null) {
    const minutes = expandField(minute, null, 0, 59);
    if (minutes.length === 1 && minutes[0] === 0) {
      return `Every ${hourStep} hours`;
    }
    const labels = minutes.map((value) => pad2(value));
    if (labels.length === 1) {
      return `At minute ${labels[0]} past every ${hourStep} hours`;
    }
    return `At minute ${joinAnd(labels)} past every ${hourStep} hours`;
  }
  if (minStep === null && hourStep === null && minute !== "*" && hour !== "*") {
    const minutes = expandField(minute, null, 0, 59);
    const hours = expandField(hour, null, 0, 23);
    const times = hours.flatMap((h) => minutes.map((m) => `${pad2(h)}:${pad2(m)}`));
    if (times.length > 8) {
      throw new Error("too many clock times");
    }
    return `At ${joinAnd(times)}`;
  }
  throw new Error("unsupported time fields");
}

function isClockTime(minute: string, hour: string): boolean {
  return minute !== "*" && hour !== "*" && stepSize(minute) === null && stepSize(hour) === null;
}

function describeRange(
  field: string,
  table: Record<string, number>,
  names: readonly string[],
  lo: number,
  hi: number,
  offset: number,
): string | null {
  if (field.includes(",") || field.includes("/") || !field.includes("-")) {
    return null;
  }
  const [startS, endS] = field.split("-", 2);
  const start = parseToken(startS!, table, lo, hi);
  const end = parseToken(endS!, table, lo, hi);
  return `${names[start + offset]} through ${names[end + offset]}`;
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
  const spanned = describeRange(weekday, DOW, DOW_NAME, 0, 7, 0);
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
  const spanned = describeRange(month, MONTH, MONTH_NAME, 1, 12, -1);
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

export function describeCron(value: string): string {
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  const parts = text.split(" ");
  if (parts.length !== 5) {
    return text;
  }
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
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
  } catch {
    return text;
  }
}

export function describeWindow(win: WakeWindow): string {
  const count = win.max_wakes === 1 ? "1 random wake-up" : `Up to ${win.max_wakes} random wake-ups`;
  return `${count} between ${win.start} and ${win.end} every day (${win.timezone})`;
}
