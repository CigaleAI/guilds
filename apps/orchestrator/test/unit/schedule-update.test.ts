import assert from "node:assert/strict";
import { test } from "node:test";
import { ScheduleError } from "../../src/schedules/cron.js";
import { Schedules, changedFields, type ScheduleDatabase } from "../../src/schedules/service.js";
import type { PlannedWake } from "../../src/schedules/window.js";

const ROW = {
  id: "sch_1",
  agent_id: "a_1",
  cron: "0 9 * * 1",
  wake_window: null,
  description: "Weekly sweep",
  instruction: "Sweep the feed.",
  paused: false,
  next_run_at: "2026-10-19T09:00:00.000Z",
};

/** A schedule store holding one row, recording the wake each update plans. */
function storeWith(row: Record<string, unknown>): {
  db: ScheduleDatabase;
  wakes: Array<PlannedWake | null>;
} {
  const wakes: Array<PlannedWake | null> = [];
  const db = {
    getSchedule: async (_agentId: string, scheduleId: string) =>
      scheduleId === row.id ? row : null,
    updateSchedule: async (
      _agentId: string,
      _scheduleId: string,
      fields: Record<string, unknown>,
      wake: PlannedWake | null,
    ) => {
      wakes.push(wake);
      return { ...row, ...fields };
    },
  } as unknown as ScheduleDatabase;
  return { db, wakes };
}

test("changed_fields_keeps_what_a_change_leaves_out", () => {
  assert.deepEqual(changedFields(ROW, {}), {
    timing: { cron: "0 9 * * 1", window: null },
    description: "Weekly sweep",
    instruction: "Sweep the feed.",
    paused: false,
  });
});

test("changed_fields_validates_each_field_it_changes", () => {
  const window = { timezone: "Europe/Paris", start: "09:00", end: "18:00", max_wakes: 2 };
  const next = changedFields(ROW, {
    when: { window },
    description: " Daily ",
    instruction: " Look. ",
    paused: true,
  });
  assert.deepEqual(next.timing, { cron: null, window });
  assert.equal(next.description, "Daily");
  assert.equal(next.instruction, "Look.");
  assert.equal(next.paused, true);
  assert.throws(() => changedFields(ROW, { when: {} }), /exactly one of cron or window/);
  assert.throws(() => changedFields(ROW, { description: "" }), ScheduleError);
  assert.throws(() => changedFields(ROW, { instruction: 4 }), ScheduleError);
});

test("update_refuses_an_unknown_schedule", async () => {
  const { db } = storeWith(ROW);
  await assert.rejects(
    new Schedules(db).update("a_1", "sch_none", { paused: true }),
    /schedule not found/,
  );
});

test("update_keeps_the_planned_wake_when_timing_stays", async () => {
  const { db, wakes } = storeWith(ROW);
  await new Schedules(db).update("a_1", "sch_1", { instruction: "Sweep and post." });
  assert.deepEqual(wakes, [null]);
});

test("update_plans_a_new_wake_for_a_new_timing", async () => {
  const { db, wakes } = storeWith(ROW);
  await new Schedules(db).update("a_1", "sch_1", { when: { cron: "0 10 * * *" } });
  assert.ok(wakes[0]?.at instanceof Date);
});

test("update_plans_a_new_wake_on_resume_and_none_while_paused", async () => {
  const paused = storeWith({ ...ROW, paused: true });
  await new Schedules(paused.db).update("a_1", "sch_1", { paused: false });
  assert.ok(paused.wakes[0]?.at instanceof Date);
  const active = storeWith(ROW);
  await new Schedules(active.db).update("a_1", "sch_1", {
    when: { cron: "0 10 * * *" },
    paused: true,
  });
  assert.deepEqual(active.wakes, [null]);
});
