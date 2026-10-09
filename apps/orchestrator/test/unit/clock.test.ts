import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUtcDate, formatUtcNow, utcClock } from "../../src/lib/clock.js";

test("utc clock is whole-second ISO-8601 UTC with a weekday date", () => {
  const now = new Date("2026-09-17T19:14:00.500Z");
  assert.equal(formatUtcNow(now), "2026-09-17T19:14:00Z");
  assert.equal(formatUtcDate(now), "Thursday, 17 September 2026");
  assert.deepEqual(utcClock(now), {
    utc_now: "2026-09-17T19:14:00Z",
    utc_date: "Thursday, 17 September 2026",
  });
});

test("utc clock uses UTC weekday across a local-date boundary", () => {
  const now = new Date("2026-09-13T09:00:12.000Z");
  assert.equal(formatUtcNow(now), "2026-09-13T09:00:12Z");
  assert.equal(formatUtcDate(now), "Sunday, 13 September 2026");
});
