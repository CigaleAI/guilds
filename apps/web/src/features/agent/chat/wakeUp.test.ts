import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWakeUp } from "../../../api/wire";
import { firedWakeTitle, pendingWakeNote, pendingWakeTitle } from "./wakeUp";

const NOW = new Date("2026-11-05T15:00:00.000Z");
const MESSAGE = `Wake-up: ${JSON.stringify(
  {
    id: "wk_1",
    set_at: "2026-11-05T14:02:11.204+00:00",
    due_at: "2026-11-05T14:12:11.204+00:00",
    fired_at: "2026-11-05T14:12:30.517+00:00",
    message: "Check deploy 4812",
    wake_ups_left: 7,
  },
  null,
  2,
)}`;

test("a fired wake-up's message reads as when it was set and for when", () => {
  const wake = parseWakeUp(MESSAGE);
  assert.ok(wake);
  assert.equal(wake.message, "Check deploy 4812");
  assert.equal(wake.wake_ups_left, 7);
  const title = firedWakeTitle(wake, NOW);
  assert.ok(title.startsWith("Woken by its wake-up · set "), title);
  assert.ok(title.includes(" for "), title);
});

test("a wake-up message that cannot be read shows a plain row", () => {
  assert.equal(parseWakeUp("Wake-up: {not json"), null);
  assert.equal(parseWakeUp('Wake-up: {"id": "wk_1"}'), null);
  assert.equal(parseWakeUp("hello"), null);
  assert.equal(firedWakeTitle(null, NOW), "Woken by its wake-up");
});

test("a pending wake-up says when it is due and what the agent will check", () => {
  const pending = {
    id: "wk_1",
    due_at: "2026-11-05T15:10:00.000Z",
    message: "Check the export",
    created_at: "2026-11-05T14:58:00.000Z",
  };
  assert.ok(pendingWakeTitle(pending, NOW).startsWith("Wakes up at "));
  assert.equal(pendingWakeNote(pending), "Check the export");
  assert.equal(pendingWakeNote({ ...pending, message: null }), "The agent left no note.");
});
