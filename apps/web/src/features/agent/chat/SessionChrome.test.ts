import assert from "node:assert/strict";
import { test } from "node:test";
import { studioStartAtRun } from "./SessionChrome";

test("Studio's start names the open run's guild, agent and run, and the step the Chat opens at", () => {
  assert.deepEqual(studioStartAtRun("g_1", "a_1", "r_1", { run: "r_1", call: "c_1", seq: 0 }), {
    guild: "g_1",
    agent: "a_1",
    run: "r_1",
    call: "c_1",
    seq: 0,
  });
});

test("Studio's start names no step when the Chat opens at none, and leaves history out", () => {
  assert.deepEqual(studioStartAtRun("g_1", "a_1", "r_1", { history: true }), {
    guild: "g_1",
    agent: "a_1",
    run: "r_1",
  });
});
