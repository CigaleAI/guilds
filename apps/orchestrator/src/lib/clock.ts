const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
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

export type UtcClock = {
  utc_now: string;
  utc_date: string;
};

export function formatUtcNow(now = new Date()): string {
  const utc = new Date(now.getTime());
  utc.setMilliseconds(0);
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatUtcDate(now = new Date()): string {
  const utc = new Date(now.getTime());
  const weekday = WEEKDAYS[utc.getUTCDay()];
  const month = MONTHS[utc.getUTCMonth()];
  return `${weekday}, ${utc.getUTCDate()} ${month} ${utc.getUTCFullYear()}`;
}

export function utcClock(now = new Date()): UtcClock {
  return {
    utc_now: formatUtcNow(now),
    utc_date: formatUtcDate(now),
  };
}
