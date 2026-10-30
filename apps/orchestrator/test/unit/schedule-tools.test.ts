import assert from "node:assert/strict";
import { test } from "node:test";
import type { NewSchedule, ScheduleRow, ScheduleUpdate } from "../../src/db/schedules.js";
import { ScheduleError } from "../../src/schedules/cron.js";
import { Schedules, type ScheduleDatabase, type ScheduleQueries } from "../../src/schedules/service.js";
import { scheduleCreateCron, scheduleCreateWindow, scheduleUpdate } from "../../src/toolbox/schedule.js";
import { toolFixture, toolInvocation, type ToolFixture } from "../helpers/toolbox.js";

const ROW: ScheduleRow = {
  id: "sch_1",
  agent_id: "a_1",
  cron: "0 9 * * 1",
  wake_window: null,
  window_fires: 0,
  description: "Weekly sweep",
  instruction: "Sweep the feed.",
  paused: false,
  next_run_at: "2026-10-19T09:00:00+00:00",
  last_run_at: null,
  created_at: "2026-10-12T09:00:00+00:00",
  updated_at: "2026-10-12T09:00:00+00:00",
};

const PARIS = { timezone: "Europe/Paris", start: "09:00", end: "18:00", max_wakes: 2 };

/** A chat run's tools over a store holding one routine, and the inserts and updates they write. */
function chatTools(): { ctx: ToolFixture; inserted: NewSchedule[]; updated: ScheduleUpdate[] } {
  const inserted: NewSchedule[] = [];
  const updated: ScheduleUpdate[] = [];
  const queries: ScheduleQueries = {
    insertSchedule: async (schedule) => {
      inserted.push(schedule);
      return ROW;
    },
    deleteSchedule: async () => ROW,
    getSchedule: async () => ROW,
    pauseSchedule: async () => ROW,
    resumeSchedule: async () => ROW,
    listSchedules: async () => [],
    listSchedulesForGuild: async () => [],
    updateSchedule: async (_key, update) => {
      updated.push(update);
      return ROW;
    },
    setScheduleNextRun: async () => {},
    lockSchedule: async () => ROW,
    recordChangeIfAny: async () => {},
  };
  const db: ScheduleDatabase = { ...queries, scheduleTransaction: (work) => work(queries) };
  const ctx = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: null,
    secrets: {},
    schedules: new Schedules(db),
  });
  return { ctx, inserted, updated };
}

test("schedule_create_cron_creates_the_routine_its_arguments_name", async () => {
  const { ctx, inserted } = chatTools();
  const call = toolInvocation("schedule_create_cron", {
    cron: "0 9 * * 1",
    description: "Weekly sweep",
    instruction: "Sweep the feed.",
  });
  await scheduleCreateCron.handler(ctx.services, ctx.run, ctx.hooks, call);
  assert.deepEqual(inserted[0]?.timing, { cron: "0 9 * * 1", window: null });
  assert.equal(inserted[0]?.description, "Weekly sweep");
});

test("schedule_create_cron_refuses_a_cron_that_is_not_a_string", async () => {
  const { ctx, inserted } = chatTools();
  const call = toolInvocation("schedule_create_cron", { cron: 9, description: "d", instruction: "i" });
  await assert.rejects(
    scheduleCreateCron.handler(ctx.services, ctx.run, ctx.hooks, call),
    (error: unknown) => error instanceof ScheduleError && error.message.startsWith("/cron"),
  );
  assert.deepEqual(inserted, []);
});

test("schedule_create_window_creates_the_window_its_arguments_name", async () => {
  const { ctx, inserted } = chatTools();
  const call = toolInvocation("schedule_create_window", { ...PARIS, description: "Daily", instruction: "Look." });
  await scheduleCreateWindow.handler(ctx.services, ctx.run, ctx.hooks, call);
  assert.deepEqual(inserted[0]?.timing, { cron: null, window: PARIS });
});

test("schedule_create_window_refuses_a_max_wakes_that_is_not_a_number", async () => {
  const { ctx, inserted } = chatTools();
  const call = toolInvocation("schedule_create_window", {
    ...PARIS,
    max_wakes: "2",
    description: "Daily",
    instruction: "Look.",
  });
  await assert.rejects(
    scheduleCreateWindow.handler(ctx.services, ctx.run, ctx.hooks, call),
    (error: unknown) => error instanceof ScheduleError && error.message.startsWith("/max_wakes"),
  );
  assert.deepEqual(inserted, []);
});

test("schedule_update_changes_what_its_arguments_name_and_ignores_paused", async () => {
  const { ctx, updated } = chatTools();
  const call = toolInvocation("schedule_update", { schedule_id: "sch_1", instruction: "Sweep and post.", paused: true });
  await scheduleUpdate.handler(ctx.services, ctx.run, ctx.hooks, call);
  assert.equal(updated[0]?.instruction, "Sweep and post.");
  assert.equal(updated[0]?.paused, false);
});

test("schedule_update_refuses_a_description_that_is_not_a_string", async () => {
  const { ctx, updated } = chatTools();
  const call = toolInvocation("schedule_update", { schedule_id: "sch_1", description: 4 });
  await assert.rejects(
    scheduleUpdate.handler(ctx.services, ctx.run, ctx.hooks, call),
    (error: unknown) => error instanceof ScheduleError && error.message.startsWith("/description"),
  );
  assert.deepEqual(updated, []);
});
