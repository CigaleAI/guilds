import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRow } from "../../src/db/runs.js";
import type { RunError } from "../../src/db/schema/index.js";
import { runStanding } from "../../src/generation/lifecycle.js";

type StandingRow = Pick<RunRow, "status" | "kind" | "errors" | "metadata">;

function runError(operation: string): RunError {
  return {
    at: "2026-01-01T00:00:00.000Z",
    generation: 1,
    operation,
    error_type: "Error",
    message: operation,
  };
}

function standingRow(fields: Partial<StandingRow> = {}): StandingRow {
  return { status: "active", kind: "direct", errors: [], metadata: {}, ...fields };
}

test("a_run_with_a_generation_under_way_is_generating_whatever_its_row_says", () => {
  assert.equal(runStanding(standingRow(), true), "generating");
  assert.equal(
    runStanding(
      standingRow({ status: "completed", errors: [runError("generation.max_chain")] }),
      true,
    ),
    "generating",
  );
});

test("an_active_direct_run_is_open", () => {
  assert.equal(runStanding(standingRow(), false), "open");
});

test("an_active_resumed_schedule_run_is_open", () => {
  assert.equal(
    runStanding(
      standingRow({ kind: "schedule", metadata: { resumed_at: "2026-01-01T00:00:00.000Z" } }),
      false,
    ),
    "open",
  );
});

test("an_active_group_or_schedule_run_is_waiting", () => {
  assert.equal(runStanding(standingRow({ kind: "group" }), false), "waiting");
  assert.equal(runStanding(standingRow({ kind: "schedule" }), false), "waiting");
});

test("an_active_run_that_continued_elsewhere_is_waiting", () => {
  assert.equal(
    runStanding(standingRow({ metadata: { continued_by_run_id: "r_2" } }), false),
    "waiting",
  );
});

test("a_completed_run_that_recorded_a_terminal_cap_is_capped_even_with_a_later_error", () => {
  const errors = [runError("generation.max_tool_calls"), runError("wake.cancelled")];
  assert.equal(runStanding(standingRow({ status: "completed", errors }), false), "capped");
});

test("a_completed_run_that_handed_off_is_continued", () => {
  assert.equal(
    runStanding(
      standingRow({ status: "completed", metadata: { continued_by_run_id: "r_2" } }),
      false,
    ),
    "continued",
  );
});

test("a_completed_run_without_a_cap_or_hand_off_is_completed_whatever_else_failed", () => {
  assert.equal(runStanding(standingRow({ status: "completed" }), false), "completed");
  assert.equal(
    runStanding(
      standingRow({ status: "completed", errors: [runError("generation.cancelled")] }),
      false,
    ),
    "completed",
  );
});
