import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dayKey,
  dayLabel,
  formatCost,
  formatSize,
  isoTime,
  messageTime,
  relativeTime,
  upcomingTime,
} from "./format";

test("server timestamps with microseconds parse", () => {
  assert.equal(isoTime("2026-09-26T09:00:00.123456+00:00"), "2026-09-26T09:00:00.123Z");
  assert.equal(isoTime("2026-09-26T09:00:00+00:00"), "2026-09-26T09:00:00.000Z");
});

test("today shows the clock; other days add the date", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  assert.doesNotMatch(messageTime("2026-09-26T09:00:00.5+00:00", now), /Sep/);
  assert.match(messageTime("2026-09-20T09:00:00+00:00", now), /20/);
});

test("days read as today, yesterday, then the date", () => {
  const now = new Date(2026, 8, 26, 0, 30);
  assert.equal(dayLabel(new Date(2026, 8, 26, 0, 5).toISOString(), now), "Today");
  assert.equal(dayLabel(new Date(2026, 8, 25, 23, 55).toISOString(), now), "Yesterday");
  assert.match(dayLabel(new Date(2026, 8, 20, 12).toISOString(), now), /20/);
  assert.doesNotMatch(dayLabel(new Date(2026, 8, 20, 12).toISOString(), now), /2026/);
  assert.match(dayLabel(new Date(2025, 8, 20, 12).toISOString(), now), /2025/);
});

test("a day key groups timestamps by the viewer's calendar day", () => {
  assert.equal(
    dayKey(new Date(2026, 8, 26, 0, 5).toISOString()),
    dayKey(new Date(2026, 8, 26, 23, 55).toISOString()),
  );
  assert.notEqual(
    dayKey(new Date(2026, 8, 26, 0, 5).toISOString()),
    dayKey(new Date(2026, 8, 25, 23, 55).toISOString()),
  );
});

test("recent times read relative, older ones as a date", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  assert.equal(relativeTime("2026-09-26T11:59:40+00:00", now), "just now");
  assert.equal(relativeTime("2026-09-26T11:48:00+00:00", now), "12m ago");
  assert.equal(relativeTime("2026-09-26T08:59:00.123456+00:00", now), "3h ago");
  assert.equal(relativeTime("2026-09-21T12:00:00+00:00", now), "5d ago");
  assert.match(relativeTime("2026-08-01T12:00:00+00:00", now), /Aug/);
});

test("times ahead read as a clock today, a weekday this week, then a date", () => {
  const now = new Date(2026, 8, 26, 12, 0);
  assert.doesNotMatch(upcomingTime(new Date(2026, 8, 26, 18, 0).toISOString(), now), /[A-Za-z]{3}/);
  assert.match(upcomingTime(new Date(2026, 8, 28, 9, 0).toISOString(), now), /Mon/);
  assert.match(upcomingTime(new Date(2026, 9, 20, 9, 0).toISOString(), now), /Oct/);
});

test("Postgres-style timestamps parse too", () => {
  assert.equal(isoTime("2026-09-24 18:56:00.774+00"), "2026-09-24T18:56:00.774Z");
});

test("formatSize reads bytes, kilobytes, and megabytes", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(64 * 1024), "64 KB");
  assert.equal(formatSize(2.5 * 1024 * 1024), "2.5 MB");
  assert.equal(formatSize(10 * 1024 * 1024), "10 MB");
});

test("a cost reads in dollars: none, under a cent to four decimals, else to two", () => {
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.0031), "$0.0031");
  assert.equal(formatCost(0.12), "$0.12");
  assert.equal(formatCost("x"), "");
});
