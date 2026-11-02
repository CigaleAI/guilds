import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioMessage } from "../../api/types/studio";
import { answered } from "./coachRows";

function message(
  seq: number,
  payload: StudioMessage["payload"],
  metadata: Record<string, unknown> | null = null,
): StudioMessage {
  return {
    id: seq,
    session_id: "bld_1",
    seq,
    generation: 2,
    payload,
    metadata,
    cost_usd: null,
    created_at: "2026-09-26T10:00:00Z",
  };
}

test("a request is answered once the operator writes after it", () => {
  const rows = [
    message(4, { role: "tool", tool_call_id: "c1", content: "" }),
    message(5, { role: "assistant", content: "" }),
  ];
  assert.equal(answered(rows, 4), false);
  assert.equal(answered([...rows, message(6, { role: "user", content: "" })], 4), true);
});
