import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileChange } from "../../api/types/notes";
import { changeActor } from "./changeActor";

test("a change names the person, or the run and the tool it wrote through", () => {
  const base = {
    id: "fchg_1",
    display_path: "org/org_a/agents/a_1/task.md",
    operation: "update",
    version: 3,
    created_at: "2026-09-26T09:00:00+00:00",
  };
  const byUser: FileChange = {
    ...base,
    actor: { type: "user", id: "u_1", name: "emma" },
    run: null,
    tool: null,
  };
  assert.deepEqual(changeActor(byUser), { kind: "user", name: "emma" });
  const byRun: FileChange = {
    ...base,
    actor: { type: "run", id: "r_1", name: null },
    run: { id: "r_1", agent_id: "a_1", kind: "schedule" },
    tool: { name: "task_write", call_id: "call_1" },
  };
  assert.deepEqual(changeActor(byRun), {
    kind: "run",
    runId: "r_1",
    trigger: "routine wake-up",
    tool: "task_write",
  });
});
