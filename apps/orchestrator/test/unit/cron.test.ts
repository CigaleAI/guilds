import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  DESCRIPTION_MAX,
  INSTRUCTION_MAX,
  ScheduleError,
  MIN_GAP_MS,
  formatOffsetIso,
  nextRunAt,
  shortestGapMs,
  validateCron,
  validateScheduleDescription,
  validateInstruction,
} from "../../src/schedules/cron.js";
import { describeCron } from "../../src/schedules/describe.js";
import { scheduleItem, scheduleWakeUserMessage } from "../../src/schedules/item.js";
import { repoRoot } from "../../src/lib/paths.js";

const fixture = JSON.parse(
  readFileSync(path.join(repoRoot(import.meta.url), "fixtures/compat/schedules/cron.json"), "utf8"),
) as {
  normalized: string;
  every_five: string;
  errors: Record<string, string>;
  describe: Record<string, string>;
  next_run: Record<string, string>;
  vixie_dom_dow_or: { expression: string; base: string; next: string[] };
  wake: { payload: unknown; metadata: unknown };
  schedule_item: Record<string, unknown>;
};

test("validate_cron", () => {
  assert.equal(validateCron("  0 9 * * 1  "), fixture.normalized);
  assert.equal(validateCron("*/5 * * * *"), fixture.every_five);
  assert.throws(() => validateCron("* * * *"), (error: unknown) => {
    assert.ok(error instanceof ScheduleError);
    assert.equal(error.message, fixture.errors.too_few_fields);
    return true;
  });
  assert.throws(() => validateCron("99 9 * * 1"), (error: unknown) => {
    assert.ok(error instanceof ScheduleError);
    assert.equal(error.message, fixture.errors.invalid);
    return true;
  });
  assert.throws(() => validateCron("* * * * *"), (error: unknown) => {
    assert.ok(error instanceof ScheduleError);
    assert.equal(error.message, fixture.errors.too_frequent);
    return true;
  });
});

test("cron_gap_counts_every_wake_up_of_the_day_not_only_the_next_two", () => {
  for (const cron of ["0,1,55 * * * *", "0,1,30 * * * *", "0,1 * * * *", "0-4 0 * * *"]) {
    assert.equal(shortestGapMs(cron), 60_000, cron);
    assert.throws(() => validateCron(cron), ScheduleError, cron);
  }
});

test("cron_gap_counts_the_wait_from_one_day_to_the_next", () => {
  assert.equal(shortestGapMs("0,58 0,23 * * *"), 2 * 60_000);
  assert.equal(shortestGapMs("30 9 * * 1"), 24 * 60 * 60_000);
  assert.ok(shortestGapMs("*/5 * * * *") >= MIN_GAP_MS);
  assert.equal(validateCron("0 9,17 * * 1-5"), "0 9,17 * * 1-5");
});

test("validate instruction and description", () => {
  assert.equal(validateInstruction("  check mail  "), "check mail");
  assert.throws(() => validateInstruction("   "), /non-whitespace/);
  assert.throws(() => validateInstruction("x".repeat(INSTRUCTION_MAX + 1)), /at most/);
  assert.equal(validateScheduleDescription("  check mail\nevery Monday  "), "check mail every Monday");
  assert.throws(() => validateScheduleDescription("   "), /non-whitespace/);
  assert.throws(() => validateScheduleDescription("x".repeat(DESCRIPTION_MAX + 1)), /at most/);
});

test("describe_cron", () => {
  assert.equal(describeCron("0 9 * * 1"), fixture.describe.monday);
  assert.equal(describeCron("0 9 * * 1-5"), fixture.describe.weekdays);
  assert.equal(describeCron("0 9 * * MON,WED,FRI"), fixture.describe.names);
  assert.equal(describeCron("0 9,18 * * *"), "At 09:00 and 18:00 every day (UTC)");
  assert.equal(describeCron("*/30 * * * *"), "Every 30 minutes (UTC)");
  assert.equal(describeCron("0 * * * *"), "Every hour (UTC)");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours (UTC)");
  assert.equal(describeCron("15 14 1 * *"), "At 14:15 on day 1 of the month (UTC)");
  assert.equal(describeCron("0 0 1 1 *"), "At 00:00 on day 1 of the month in January (UTC)");
  assert.equal(describeCron("not cron"), "not cron");
  assert.equal(describeCron("0 9 * jun-aug 1-7"), "At 09:00 on Monday through Sunday in June through August (UTC)");
});

test("describe_cron_answers_with_the_expression_it_has_no_words_for", () => {
  assert.equal(describeCron("0 9 * * moon"), "0 9 * * moon");
  assert.equal(describeCron("0 9 32 * *"), "0 9 32 * *");
  assert.equal(describeCron("0 9 * * 1,3/2"), "0 9 * * 1,3/2");
  assert.equal(describeCron("0 9 * * 5-1,2"), "0 9 * * 5-1,2");
  assert.equal(describeCron("0,30 1-5 * * *"), "0,30 1-5 * * *");
  assert.equal(describeCron("* 9 * * *"), "* 9 * * *");
});

test("next_run follows cron including Vixie DOM/DOW OR", () => {
  const now = new Date("2026-09-12T16:00:00.000Z");
  assert.equal(formatOffsetIso(nextRunAt(now, "0 9 * * 1")), fixture.next_run.monday_0900);
  assert.equal(formatOffsetIso(nextRunAt(now, "*/30 * * * *")), fixture.next_run.every_30);
  const hits: string[] = [];
  let cursor = new Date(fixture.vixie_dom_dow_or.base);
  for (let index = 0; index < 6; index += 1) {
    const next = nextRunAt(cursor, fixture.vixie_dom_dow_or.expression);
    hits.push(formatOffsetIso(next));
    cursor = next;
  }
  assert.deepEqual(hits, fixture.vixie_dom_dow_or.next);
});

test("schedule_item and wake payload match fixtures", () => {
  assert.deepEqual(
    scheduleItem({
      id: "sch_1",
      agent_id: "a_1",
      cron: "0 9 * * 1",
      wake_window: null,
      window_fires: 0,
      description: "Monday inbox",
      instruction: "Check Gmail and write a note.",
      paused: false,
      next_run_at: "2026-09-14T09:00:00+00:00",
      last_run_at: null,
      created_at: "2026-09-13T12:00:00+00:00",
      updated_at: "2026-09-13T12:00:00+00:00",
    }),
    fixture.schedule_item,
  );
  const [payload, metadata] = scheduleWakeUserMessage({
    id: "sch_1",
    timing: { cron: "0 9 * * 1", window: null },
    instruction: "Read shared notes and post if anything is new.",
    previousRunAt: "2026-09-07T09:00:03Z",
  });
  assert.deepEqual(payload, fixture.wake.payload);
  assert.deepEqual(metadata, fixture.wake.metadata);
});

test("schedule_item falls back to first instruction line", () => {
  const fallback = scheduleItem({
    id: "sch_2",
    agent_id: "a_1",
    cron: "0 9 * * 1",
    wake_window: null,
    window_fires: 0,
    description: "",
    instruction: "First line\nRest of the note.",
    paused: false,
    next_run_at: "2026-09-14T09:00:00+00:00",
    last_run_at: null,
    created_at: "2026-09-13T12:00:00+00:00",
    updated_at: "2026-09-13T12:00:00+00:00",
  });
  assert.equal(fallback.description, "First line");
});
