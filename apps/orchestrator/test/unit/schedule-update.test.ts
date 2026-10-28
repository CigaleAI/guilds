import assert from "node:assert/strict";
import { test } from "node:test";
import { ScheduleError } from "../../src/schedules/cron.js";
import {
  Schedules,
  changedFields,
  type ScheduleDatabase,
  type ScheduleQueries,
} from "../../src/schedules/service.js";
import { rowTiming } from "../../src/schedules/timing.js";
import { userActor } from "../../src/lib/change-actor.js";
import type { ConfigChange } from "../../src/db/config-changes.js";
import type { ScheduleKey, ScheduleRow, ScheduleUpdate, PlannedWake } from "../../src/db/schedules.js";

const ACTOR = userActor({ id: "user_operator", name: "operator" });

const ROW: ScheduleRow = {
  id: "sch_1",
  agent_id: "a_1",
  cron: "0 9 * * 1",
  wake_window: null,
  window_fires: 0,
  description: "Weekly sweep",
  instruction: "Sweep the feed.",
  paused: false,
  next_run_at: "2026-10-19T09:00:00.000Z",
  last_run_at: null,
  created_at: "2026-10-12T09:00:00.000Z",
  updated_at: "2026-10-12T09:00:00.000Z",
};

/** A schedule store holding one row, recording the wake each update plans. */
function storeWith(row: ScheduleRow): {
  db: ScheduleDatabase;
  wakes: Array<PlannedWake | null>;
  changes: Array<ConfigChange | null>;
} {
  const wakes: Array<PlannedWake | null> = [];
  const changes: Array<ConfigChange | null> = [];
  const queries: ScheduleQueries = {
    insertSchedule: async () => row,
    deleteSchedule: async () => row,
    getSchedule: async (_agentId: string, scheduleId: string) =>
      scheduleId === row.id ? row : null,
    pauseSchedule: async () => row,
    resumeSchedule: async () => row,
    listSchedules: async () => [],
    listSchedulesForGuild: async () => [],
    updateSchedule: async (_key: ScheduleKey, update: ScheduleUpdate) => {
      wakes.push(update.wake);
      const { timing } = update;
      return {
        ...row,
        ...(timing.window === null
          ? { cron: timing.cron, wake_window: null }
          : { cron: null, wake_window: timing.window }),
        description: update.description,
        instruction: update.instruction,
        paused: update.paused,
      };
    },
    setScheduleNextRun: async () => {},
    lockSchedule: async () => row,
    recordChangeIfAny: async (_actor, change) => {
      changes.push(change);
    },
  };
  const db: ScheduleDatabase = { ...queries, scheduleTransaction: (work) => work(queries) };
  return { db, wakes, changes };
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

test("row_timing_reads_a_cron_row_as_cron_timing", () => {
  assert.deepEqual(rowTiming(ROW), { cron: "0 9 * * 1", window: null });
});

test("row_timing_reads_a_window_row_as_window_timing", () => {
  const window = { timezone: "Europe/Paris", start: "09:00", end: "18:00", max_wakes: 2 };
  assert.deepEqual(rowTiming({ ...ROW, cron: null, wake_window: window }), { cron: null, window });
});

test("changed_fields_without_a_routine_validates_every_field_and_starts_unpaused", () => {
  assert.deepEqual(
    changedFields(null, {
      when: { cron: "0 8 * * *" },
      description: " Daily ",
      instruction: " Look. ",
    }),
    {
      timing: { cron: "0 8 * * *", window: null },
      description: "Daily",
      instruction: "Look.",
      paused: false,
    },
  );
  assert.equal(
    changedFields(null, {
      when: { cron: "0 8 * * *" },
      description: "Daily",
      instruction: "Look.",
      paused: true,
    }).paused,
    true,
  );
});

test("changed_fields_without_a_routine_requires_timing_description_and_instruction", () => {
  assert.throws(
    () => changedFields(null, { description: "Daily", instruction: "Look." }),
    /exactly one of cron or window/,
  );
  assert.throws(
    () => changedFields(null, { when: { cron: "0 8 * * *" }, instruction: "Look." }),
    /description must be a string/,
  );
  assert.throws(
    () => changedFields(null, { when: { cron: "0 8 * * *" }, description: "Daily" }),
    /instruction must be a string/,
  );
});

test("update_refuses_an_unknown_schedule", async () => {
  const { db } = storeWith(ROW);
  await assert.rejects(
    new Schedules(db).update(ACTOR, "a_1", "sch_none", { paused: true }),
    /schedule not found/,
  );
});

test("update_keeps_the_planned_wake_when_timing_stays", async () => {
  const { db, wakes } = storeWith(ROW);
  await new Schedules(db).update(ACTOR, "a_1", "sch_1", { instruction: "Sweep and post." });
  assert.deepEqual(wakes, [null]);
});

test("update_plans_a_new_wake_for_a_new_timing", async () => {
  const { db, wakes } = storeWith(ROW);
  await new Schedules(db).update(ACTOR, "a_1", "sch_1", { when: { cron: "0 10 * * *" } });
  assert.ok(wakes[0]?.at instanceof Date);
});

test("update_plans_a_new_wake_on_resume_and_none_while_paused", async () => {
  const paused = storeWith({ ...ROW, paused: true });
  await new Schedules(paused.db).update(ACTOR, "a_1", "sch_1", { paused: false });
  assert.ok(paused.wakes[0]?.at instanceof Date);
  const active = storeWith(ROW);
  await new Schedules(active.db).update(ACTOR, "a_1", "sch_1", {
    when: { cron: "0 10 * * *" },
    paused: true,
  });
  assert.deepEqual(active.wakes, [null]);
});

test("create_logs_the_new_routine", async () => {
  const { db, changes } = storeWith(ROW);
  await new Schedules(db).create(ACTOR, "a_1", { cron: "0 9 * * 1" }, "Weekly sweep", "Sweep the feed.");
  assert.equal(changes[0]?.operation, "create");
});

test("delete_logs_the_routine_it_removes", async () => {
  const { db, changes } = storeWith(ROW);
  await new Schedules(db).delete(ACTOR, "a_1", "sch_1");
  assert.equal(changes[0]?.operation, "delete");
});

test("update_logs_what_it_changed", async () => {
  const { db, changes } = storeWith(ROW);
  await new Schedules(db).update(ACTOR, "a_1", "sch_1", { instruction: "Sweep and post." });
  assert.equal(changes[0]?.summary, 'Changed the instruction of "Weekly sweep"');
});

test("set_paused_logs_the_pause", async () => {
  const { db, changes } = storeWith(ROW);
  const queries = { ...db, pauseSchedule: async () => ({ ...ROW, paused: true }) };
  const pausing = { ...queries, scheduleTransaction: (work) => work(queries) } satisfies ScheduleDatabase;
  await new Schedules(pausing).setPaused(ACTOR, "a_1", "sch_1", true);
  assert.equal(changes[0]?.summary, 'Paused "Weekly sweep"');
});
