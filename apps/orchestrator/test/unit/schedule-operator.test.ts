import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduleRow } from "../../src/db/schedules.js";
import { userActor } from "../../src/lib/change-actor.js";
import {
  createRoutine,
  deleteRoutine,
  updateRoutine,
  type RoutineChange,
  type RoutineWriteDeps,
} from "../../src/schedules/operator.js";
import { Schedules, type ScheduleDatabase, type ScheduleQueries } from "../../src/schedules/service.js";

const ACTOR = userActor({ id: "user_operator", name: "operator" });
const AGENT = { id: "a_1", guild_id: "g_1" };

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

/** Routines over a store holding one row, and the changes they announce. */
function announcing(): { deps: RoutineWriteDeps; published: Array<[string, RoutineChange]> } {
  const queries: ScheduleQueries = {
    insertSchedule: async () => ROW,
    deleteSchedule: async () => ROW,
    getSchedule: async () => ROW,
    pauseSchedule: async () => ROW,
    resumeSchedule: async () => ROW,
    listSchedules: async () => [],
    listSchedulesForGuild: async () => [],
    updateSchedule: async () => ROW,
    setScheduleNextRun: async () => {},
    lockSchedule: async () => ROW,
    recordChangeIfAny: async () => {},
  };
  const db: ScheduleDatabase = { ...queries, scheduleTransaction: (work) => work(queries) };
  const published: Array<[string, RoutineChange]> = [];
  const deps: RoutineWriteDeps = {
    schedules: new Schedules(db),
    publishRoutinesChanged: async (guildId, change) => {
      published.push([guildId, change]);
    },
  };
  return { deps, published };
}

test("create_routine_announces_the_new_routine_to_the_agents_guild", async () => {
  const { deps, published } = announcing();
  const row = await createRoutine(deps, ACTOR, AGENT, {
    when: { cron: "0 9 * * 1" },
    description: "Weekly sweep",
    instruction: "Sweep the feed.",
  });
  assert.equal(row.id, "sch_1");
  assert.deepEqual(published, [["g_1", { agentId: "a_1", action: "create", scheduleId: "sch_1" }]]);
});

test("update_routine_announces_a_pause_or_resume_alone_as_such", async () => {
  const { deps, published } = announcing();
  const routine = { agent: AGENT, scheduleId: "sch_1" };
  await updateRoutine(deps, ACTOR, routine, { paused: true });
  await updateRoutine(deps, ACTOR, routine, { paused: false });
  assert.deepEqual(
    published.map(([, change]) => change.action),
    ["pause", "resume"],
  );
});

test("update_routine_announces_any_other_change_as_an_edit", async () => {
  const { deps, published } = announcing();
  const routine = { agent: AGENT, scheduleId: "sch_1" };
  await updateRoutine(deps, ACTOR, routine, { description: "Daily", paused: true });
  await updateRoutine(deps, ACTOR, routine, {});
  assert.deepEqual(published, [
    ["g_1", { agentId: "a_1", action: "edit", scheduleId: "sch_1" }],
    ["g_1", { agentId: "a_1", action: "edit", scheduleId: "sch_1" }],
  ]);
});

test("delete_routine_announces_the_routine_it_named", async () => {
  const { deps, published } = announcing();
  await deleteRoutine(deps, ACTOR, { agent: AGENT, scheduleId: "sch_1" });
  assert.deepEqual(published, [["g_1", { agentId: "a_1", action: "delete", scheduleId: "sch_1" }]]);
});

test("routine_writes_announce_nothing_without_a_publisher", async () => {
  const { deps } = announcing();
  const quiet: RoutineWriteDeps = { schedules: deps.schedules };
  const routine = { agent: AGENT, scheduleId: "sch_1" };
  await createRoutine(quiet, ACTOR, AGENT, { when: { cron: "0 9 * * 1" }, description: "d", instruction: "i" });
  await updateRoutine(quiet, ACTOR, routine, { paused: true });
  await deleteRoutine(quiet, ACTOR, routine);
});
