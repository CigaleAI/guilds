import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run, RunError, Schedule } from "../../api/types";
import { runIsCapped, runState, runTitle } from "./runState";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r_1",
    agent_id: "a_1",
    status: "completed",
    kind: "direct",
    config_snapshot: {} as Run["config_snapshot"],
    errors: [],
    generating: false,
    created_at: "2026-09-26T09:00:00+00:00",
    updated_at: "2026-09-26T09:05:00+00:00",
    archived_at: null,
    group_chat_through_seq: null,
    ...overrides,
  };
}

function error(operation: string, message = "stopped"): RunError {
  return {
    at: "2026-09-26T09:04:00+00:00",
    generation: 1,
    operation,
    error_type: "RunError",
    message,
  };
}

test("generating and archived come before anything the run recorded", () => {
  assert.equal(
    runState(run({ generating: true, errors: [error("llm.complete")] })).label,
    "Generating",
  );
  assert.equal(runState(run({ archived_at: "2026-09-26T10:00:00+00:00" })).label, "Archived");
});

test("an open run stays open after an error", () => {
  assert.deepEqual(runState(run({ status: "active", errors: [error("llm.complete")] })), {
    status: "queued",
    label: "Open",
  });
});

test("an ended run is judged by its last error", () => {
  assert.equal(runState(run()).label, "Completed");
  assert.equal(
    runState(run({ errors: [error("llm.complete"), error("generation.cancelled")] })).label,
    "Cancelled",
  );
  assert.equal(runState(run({ errors: [error("generation.max_steps")] })).label, "Hit a limit");
  assert.deepEqual(runState(run({ errors: [error("llm.complete", "bad escape")] })), {
    status: "failed",
    label: "Failed",
    detail: "bad escape",
  });
});

test("only the tool-call and input-token caps end a run for good", () => {
  assert.equal(runIsCapped(run({ errors: [error("generation.max_tool_calls")] })), true);
  assert.equal(runIsCapped(run({ errors: [error("generation.max_input_tokens")] })), true);
  assert.equal(runIsCapped(run({ errors: [error("generation.max_chain")] })), true);
  assert.equal(runIsCapped(run({ errors: [error("generation.max_steps")] })), false);
});

test("routine runs are named after their routine while it exists", () => {
  const routine = { id: "s_1", description: "Watch pass" } as Schedule;
  assert.equal(runTitle(run({ kind: "schedule", schedule_id: "s_1" }), [routine]), "Watch pass");
  assert.equal(
    runTitle(run({ kind: "schedule", schedule_id: "s_gone" }), [routine]),
    "Routine wake-up",
  );
  assert.equal(runTitle(run({ kind: "group" }), [routine]), "Group chat");
});
