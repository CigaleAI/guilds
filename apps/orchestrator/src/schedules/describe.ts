import { ScheduleError } from "./cron.js";

/** A cron the describer has no words for; describeCron answers with the expression itself. */
class CronDescriptionError extends ScheduleError {
  constructor(message: string) {
    super(message);
    this.name = "CronDescriptionError";
  }
}

/** The values a cron field takes: the names it reads beside numbers, and its lowest and highest value. */
type CronFieldRange = { tokens: Record<string, number> | null; lo: number; hi: number };

/** A cron field whose values have labels: the label of a value is `labels[value + offset]`. */
type LabelledCronField = CronFieldRange & { labels: readonly string[]; offset: number };

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

const MINUTE_FIELD: CronFieldRange = { tokens: null, lo: 0, hi: 59 };
const HOUR_FIELD: CronFieldRange = { tokens: null, lo: 0, hi: 23 };
const DAY_FIELD: CronFieldRange = { tokens: null, lo: 1, hi: 31 };
const WEEKDAY_FIELD: LabelledCronField = { tokens: DOW, lo: 0, hi: 7, labels: DOW_NAME, offset: 0 };
const MONTH_FIELD: LabelledCronField = { tokens: MONTH, lo: 1, hi: 12, labels: MONTH_NAME, offset: -1 };

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

function parseToken(token: string, range: CronFieldRange): number {
  const key = token.toLowerCase();
  let value: number;
  if (range.tokens && key in range.tokens) {
    value = range.tokens[key]!;
  } else if (/^\d+$/.test(token)) {
    value = Number(token);
  } else {
    throw new CronDescriptionError(`unsupported cron token ${token}`);
  }
  if (value < range.lo || value > range.hi) {
    throw new CronDescriptionError(`cron token ${token} out of range`);
  }
  return value;
}

function expandField(field: string, range: CronFieldRange): number[] {
  const values: number[] = [];
  for (const item of field.split(",")) {
    if (item.includes("/")) {
      throw new CronDescriptionError(`unsupported cron step ${item}`);
    }
    if (item.includes("-")) {
      const [startS, endS] = item.split("-", 2);
      const start = parseToken(startS!, range);
      const end = parseToken(endS!, range);
      if (start > end) {
        throw new CronDescriptionError(`unsupported cron range ${item}`);
      }
      for (let value = start; value <= end; value += 1) {
        values.push(value);
      }
    } else {
      values.push(parseToken(item, range));
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
    const hours = joinAnd(expandField(hour, HOUR_FIELD).map((value) => `${pad2(value)}:00`));
    return `Every ${minStep} minutes during ${hours}`;
  }
  if (minStep === null && minute !== "*" && hour === "*") {
    const minutes = expandField(minute, MINUTE_FIELD);
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
    const minutes = expandField(minute, MINUTE_FIELD);
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
    const minutes = expandField(minute, MINUTE_FIELD);
    const hours = expandField(hour, HOUR_FIELD);
    const times = hours.flatMap((h) => minutes.map((m) => `${pad2(h)}:${pad2(m)}`));
    if (times.length > 8) {
      throw new CronDescriptionError("too many clock times");
    }
    return `At ${joinAnd(times)}`;
  }
  throw new CronDescriptionError("unsupported time fields");
}

function isClockTime(minute: string, hour: string): boolean {
  return minute !== "*" && hour !== "*" && stepSize(minute) === null && stepSize(hour) === null;
}

function labelOf(field: LabelledCronField, value: number): string {
  return field.labels[value + field.offset]!;
}

function describeRange(field: string, labelled: LabelledCronField): string | null {
  if (field.includes(",") || field.includes("/") || !field.includes("-")) {
    return null;
  }
  const [startS, endS] = field.split("-", 2);
  const start = parseToken(startS!, labelled);
  const end = parseToken(endS!, labelled);
  return `${labelOf(labelled, start)} through ${labelOf(labelled, end)}`;
}

function describeDom(day: string): string | null {
  if (day === "*") {
    return null;
  }
  const step = stepSize(day);
  if (step !== null) {
    return `every ${step} days`;
  }
  const values = expandField(day, DAY_FIELD);
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
  const spanned = describeRange(weekday, WEEKDAY_FIELD);
  if (spanned !== null) {
    return `on ${spanned}`;
  }
  const names = expandField(weekday, WEEKDAY_FIELD).map((value) => labelOf(WEEKDAY_FIELD, value));
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
  const spanned = describeRange(month, MONTH_FIELD);
  if (spanned !== null) {
    return `in ${spanned}`;
  }
  const names = expandField(month, MONTH_FIELD).map((value) => labelOf(MONTH_FIELD, value));
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

/** The five fields of a cron: minute, hour, day, month, and weekday. */
type CronFields = [string, string, string, string, string];

function isCronFields(parts: string[]): parts is CronFields {
  return parts.length === 5;
}

export function describeCron(value: string): string {
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  const parts = text.split(" ");
  if (!isCronFields(parts)) {
    return text;
  }
  const [minute, hour, day, month, weekday] = parts;
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
