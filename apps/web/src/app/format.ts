/**
 * Server timestamps carry microseconds, and some come in Postgres's own form
 * (`2026-09-24 18:56:00.774+00`); Date parses ISO with milliseconds reliably.
 */
function toDate(timestamp: string): Date {
  const iso = timestamp
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/(\.\d{3})\d+/, "$1");
  return new Date(iso);
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "06:04" today, "Sep 24, 06:04" on other days, in the viewer's locale and time zone. */
export function messageTime(timestamp: string, now: Date = new Date()): string {
  const date = toDate(timestamp);
  return date.toDateString() === now.toDateString() ? clock.format(date) : dayAndClock.format(date);
}

/** "06:04", in the viewer's locale and time zone. */
export function clockTime(timestamp: string): string {
  return clock.format(toDate(timestamp));
}

const weekdayAndDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const dayAndYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** The viewer's calendar day of a timestamp, for grouping a list by day. */
export function dayKey(timestamp: string): string {
  return toDate(timestamp).toDateString();
}

/** "Today", "Yesterday", "Thu, Sep 24" this year, "Sep 24, 2025" before. */
export function dayLabel(timestamp: string, now: Date = new Date()): string {
  const date = toDate(timestamp);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.getFullYear() === now.getFullYear()
    ? weekdayAndDay.format(date)
    : dayAndYear.format(date);
}

const weekdayAndClock = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** A time ahead: "14:00" today, "Mon 00:00" within the week, then the date. */
export function upcomingTime(timestamp: string, now: Date = new Date()): string {
  const date = toDate(timestamp);
  if (date.toDateString() === now.toDateString()) return clock.format(date);
  const days = (date.getTime() - now.getTime()) / 86_400_000;
  return days > 0 && days < 6 ? weekdayAndClock.format(date) : dayAndClock.format(date);
}

/** "just now", "12m ago", "3h ago", "5d ago", then the date. */
export function relativeTime(timestamp: string, now: Date = new Date()): string {
  const date = toDate(timestamp);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return dayAndClock.format(date);
}

export function isoTime(timestamp: string): string {
  return toDate(timestamp).toISOString();
}

/** A size in bytes as people read it: bytes, kilobytes, or megabytes. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A dollar cost: "$0", four decimals under a cent, two otherwise; empty for non-numeric input. */
export function formatCost(usd: unknown): string {
  const value = Number(usd);
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
