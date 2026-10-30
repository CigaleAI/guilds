import assert from "node:assert/strict";
import { test } from "node:test";
import type { Schedule } from "../../../api/types/schedules";
import { routineDraft, scheduleInput, timingNote } from "./RoutineForm";

const window = { timezone: "Europe/Paris", start: "09:00", end: "17:00", max_wakes: 3 };

function routine(timing: Pick<Schedule, "cron" | "window">): Schedule {
  return {
    id: "s_1",
    agent_id: "a_1",
    instruction_hash: "h",
    updated_at: "2026-10-01T00:00:00Z",
    description: "Morning digest",
    instruction: "Summarise the news.",
    label: "",
    paused: false,
    next_run_at: null,
    last_run_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...timing,
  };
}

test("a new routine starts on a cron, with a daytime window in the operator's timezone", () => {
  const draft = routineDraft(undefined, "Europe/Paris");
  assert.equal(draft.mode, "cron");
  assert.equal(draft.cron, "");
  assert.deepEqual(draft.window, { ...window, start: "08:00", end: "20:00", max_wakes: 10 });
  assert.equal(draft.description, "");
});

test("a routine on a window opens on its window", () => {
  const draft = routineDraft(routine({ cron: null, window }), null);
  assert.equal(draft.mode, "window");
  assert.deepEqual(draft.window, window);
  assert.equal(draft.instruction, "Summarise the news.");
});

test("the form saves the timing its mode picks", () => {
  const draft = { ...routineDraft(routine({ cron: "0 9 * * 1", window: null }), null), window };
  assert.deepEqual(scheduleInput({ ...draft, cron: " 0 9 * * 1 " }), {
    cron: "0 9 * * 1",
    description: "Morning digest",
    instruction: "Summarise the news.",
  });
  assert.deepEqual(scheduleInput({ ...draft, mode: "window" }), {
    window,
    description: "Morning digest",
    instruction: "Summarise the news.",
  });
});

test("the timing reads in words, and not before a cron is typed", () => {
  const draft = routineDraft(undefined, "UTC");
  assert.equal(timingNote(draft), null);
  assert.equal(timingNote({ ...draft, cron: "0 * * * *" }), "Every hour (UTC)");
  assert.equal(
    timingNote({ ...draft, mode: "window" }),
    "Up to 10 random wake-ups between 08:00 and 20:00 every day (UTC)",
  );
});
