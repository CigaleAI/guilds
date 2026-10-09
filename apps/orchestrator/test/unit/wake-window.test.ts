import assert from "node:assert/strict";
import test from "node:test";
import { MIN_GAP_MS, ScheduleError } from "../../src/schedules/cron.js";
import { planAfterFire, planWake, validateTiming } from "../../src/schedules/timing.js";
import {
  describeWindow,
  planWindowAfterFire,
  planWindowWake,
  validateWindow,
  windowEndAt,
  type WakeWindow,
} from "../../src/schedules/window.js";

const PARIS: WakeWindow = { timezone: "Europe/Paris", start: "08:00", end: "20:00", max_wakes: 20 };
const MINUTE = 60 * 1000;

function fixed(value: number): () => number {
  return () => value;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test("validateWindow normalises and bounds the window", () => {
  assert.deepEqual(validateWindow({ timezone: "europe/paris", start: " 08:00", end: "20:00", max_wakes: 20 }), PARIS);
  assert.deepEqual(validateWindow({ timezone: "UTC", start: "22:00", end: "02:00", max_wakes: 48 }), {
    timezone: "UTC",
    start: "22:00",
    end: "02:00",
    max_wakes: 48,
  });
  const cases: Array<[unknown, RegExp]> = [
    [{ ...PARIS, timezone: "Mars/Olympus" }, /IANA timezone/],
    [{ ...PARIS, start: "8:00" }, /window.start must be a 24-hour HH:MM time/],
    [{ ...PARIS, end: "24:00" }, /window.end must be a 24-hour HH:MM time/],
    [{ ...PARIS, end: "08:00" }, /must differ/],
    [{ ...PARIS, max_wakes: 0 }, /positive integer/],
    [{ ...PARIS, max_wakes: 2.5 }, /positive integer/],
    [{ ...PARIS, max_wakes: 145 }, /at most 144/],
    [{ ...PARIS, jitter: 1 }, /unknown field jitter/],
    ["08:00-20:00", /must be an object/],
  ];
  for (const [input, message] of cases) {
    assert.throws(
      () => validateWindow(input),
      (error: unknown) => error instanceof ScheduleError && message.test(error.message),
    );
  }
});

test("validateTiming takes exactly one of cron or window", () => {
  assert.deepEqual(validateTiming({ cron: " 0 9 * * 1 " }), { cron: "0 9 * * 1", window: null });
  assert.deepEqual(validateTiming({ window: PARIS }), { cron: null, window: PARIS });
  for (const input of [{}, { cron: "0 9 * * 1", window: PARIS }, { cron: null, window: null }]) {
    assert.throws(() => validateTiming(input), /set exactly one of cron or window/);
  }
});

test("windowEndAt treats windows as [start, end) in local time", () => {
  assert.equal(windowEndAt(PARIS, new Date("2026-09-25T05:59:59Z")), null);
  assert.equal(windowEndAt(PARIS, new Date("2026-09-25T06:00:00Z"))?.toISOString(), "2026-09-25T18:00:00.000Z");
  assert.equal(windowEndAt(PARIS, new Date("2026-09-25T17:59:59Z"))?.toISOString(), "2026-09-25T18:00:00.000Z");
  assert.equal(windowEndAt(PARIS, new Date("2026-09-25T18:00:00Z")), null);
  const overnight: WakeWindow = { timezone: "UTC", start: "22:00", end: "02:00", max_wakes: 4 };
  assert.equal(windowEndAt(overnight, new Date("2026-09-25T23:00:00Z"))?.toISOString(), "2026-09-26T02:00:00.000Z");
  assert.equal(windowEndAt(overnight, new Date("2026-09-26T01:00:00Z"))?.toISOString(), "2026-09-26T02:00:00.000Z");
  assert.equal(windowEndAt(overnight, new Date("2026-09-26T12:00:00Z")), null);
});

test("between windows the first wake lands in the first slot of the next window", () => {
  const from = new Date("2026-09-25T03:00:00Z");
  assert.deepEqual(planWindowWake(PARIS, from, 0, fixed(0)), { at: new Date("2026-09-25T06:00:00Z"), windowFires: 0 });
  // Slot is 12h / 20 = 36 minutes.
  assert.deepEqual(planWindowWake(PARIS, from, 0, fixed(0.5)), { at: new Date("2026-09-25T06:18:00Z"), windowFires: 0 });
  // Winter time moves the same local window by an hour in UTC.
  assert.equal(
    planWindowWake(PARIS, new Date("2026-12-01T03:00:00Z"), 0, fixed(0)).at.toISOString(),
    "2026-12-01T07:00:00.000Z",
  );
});

test("inside a window the gap is time left over wakes left, jittered by half", () => {
  const from = new Date("2026-09-25T08:00:00Z"); // 10:00 Paris, 10h before the end.
  // 15 wakes left → mean gap 40 minutes.
  assert.equal(planWindowWake(PARIS, from, 5, fixed(0.5)).at.getTime() - from.getTime(), 40 * MINUTE);
  assert.equal(planWindowWake(PARIS, from, 5, fixed(0)).at.getTime() - from.getTime(), 20 * MINUTE);
  assert.equal(planWindowWake(PARIS, from, 5, fixed(1)).at.getTime() - from.getTime(), 60 * MINUTE);
  assert.equal(planWindowWake(PARIS, from, 5, fixed(0.5)).windowFires, 5);
});

test("a spent window or a gap past the end moves to the next window", () => {
  const from = new Date("2026-09-25T17:00:00Z"); // 19:00 Paris.
  const spent = planWindowWake(PARIS, from, 20, fixed(0));
  assert.deepEqual(spent, { at: new Date("2026-09-26T06:00:00Z"), windowFires: 0 });
  // One wake left over one hour, jittered to 1.5h, overshoots the end.
  const overshoot = planWindowWake(PARIS, from, 19, fixed(1));
  assert.equal(overshoot.windowFires, 0);
  assert.ok(overshoot.at.getTime() >= new Date("2026-09-26T06:00:00Z").getTime());
});

test("wakes stay at least five minutes apart", () => {
  const tight: WakeWindow = { timezone: "UTC", start: "10:00", end: "11:00", max_wakes: 12 };
  const from = new Date("2026-09-25T10:00:00Z");
  assert.equal(planWindowWake(tight, from, 0, fixed(0)).at.getTime() - from.getTime(), MIN_GAP_MS);
});

test("fires count within the window they land in", () => {
  const due = new Date("2026-09-25T08:00:00Z");
  // Same window: the fire is the sixth.
  const same = planWindowAfterFire(PARIS, due, 5, new Date("2026-09-25T08:00:05Z"), fixed(0.5));
  assert.equal(same.windowFires, 6);
  // Late fire after the window closed: plan the next window from scratch.
  const late = planWindowAfterFire(PARIS, due, 5, new Date("2026-09-25T19:00:00Z"), fixed(0));
  assert.deepEqual(late, { at: new Date("2026-09-26T06:00:00Z"), windowFires: 0 });
  // Late fire that lands in the next day's window counts as its first.
  const nextDay = planWindowAfterFire(PARIS, due, 5, new Date("2026-09-26T07:00:00Z"), fixed(0.5));
  assert.equal(nextDay.windowFires, 1);
});

test("a simulated month never exceeds max_wakes per window", () => {
  const random = seeded(7);
  const timing = validateTiming({ window: PARIS });
  let wake = planWake(timing, new Date("2026-09-25T00:00:00Z"), random);
  const perDay = new Map<string, number>();
  let previous: Date | null = null;
  while (wake.at.getTime() < new Date("2026-10-25T00:00:00Z").getTime()) {
    assert.notEqual(windowEndAt(PARIS, wake.at), null);
    if (previous) assert.ok(wake.at.getTime() - previous.getTime() >= MIN_GAP_MS);
    const day = wake.at.toLocaleDateString("en-CA", { timeZone: PARIS.timezone });
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    previous = wake.at;
    wake = planAfterFire(
      { cron: null, wake_window: PARIS, next_run_at: wake.at, window_fires: wake.windowFires },
      wake.at,
      random,
    );
  }
  assert.equal(perDay.size, 30);
  for (const count of perDay.values()) {
    assert.ok(count <= PARIS.max_wakes && count >= PARIS.max_wakes - 3, `day had ${count} wakes`);
  }
});

test("describeWindow names the count, span, and timezone", () => {
  assert.equal(describeWindow(PARIS), "Up to 20 random wake-ups between 08:00 and 20:00 every day (Europe/Paris)");
  assert.equal(
    describeWindow({ ...PARIS, max_wakes: 1 }),
    "1 random wake-up between 08:00 and 20:00 every day (Europe/Paris)",
  );
});
