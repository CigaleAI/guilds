import assert from "node:assert/strict";
import { test } from "node:test";
import { chainOf, continuationMessage, continuedBy, handoffText } from "../../src/generation/chain.js";

test("a run without a chain position is the first of its own chain", () => {
  assert.deepEqual(chainOf({ id: "r_1", metadata: {} }), { root_run_id: "r_1", index: 1, previous_run_id: null });
  assert.deepEqual(chainOf({ id: "r_1", metadata: { chain: { root_run_id: "r_0", index: 0 } } }), {
    root_run_id: "r_1",
    index: 1,
    previous_run_id: null,
  });
  assert.deepEqual(
    chainOf({ id: "r_3", metadata: { chain: { root_run_id: "r_1", index: 3, previous_run_id: "r_2" } } }),
    { root_run_id: "r_1", index: 3, previous_run_id: "r_2" },
  );
});

test("continuedBy reads the next run of a chain", () => {
  assert.equal(continuedBy({ metadata: { continued_by_run_id: "r_2" } }), "r_2");
  assert.equal(continuedBy({ metadata: { continued_by_run_id: "" } }), null);
  assert.equal(continuedBy({ metadata: {} }), null);
});

test("the hand-off is the reply's text, from a string or content parts", () => {
  assert.equal(handoffText({ content: "  Goal: ship.  " }), "Goal: ship.");
  assert.equal(handoffText({ content: [{ type: "text", text: "Goal: " }, { type: "text", text: "ship." }] }), "Goal: ship.");
  assert.equal(handoffText({ content: null, tool_calls: [] }), "");
});

test("a continuation opens with the previous run and its hand-off, or a note when there is none", () => {
  const [payload, metadata] = continuationMessage("r_1", "Goal: ship.");
  assert.equal(payload.role, "user");
  assert.deepEqual(JSON.parse(String(payload.content).slice("Continuation: ".length)), {
    previous_run_id: "r_1",
    handoff: "Goal: ship.",
  });
  assert.deepEqual(metadata, { generation: 1, source: "continuation", previous_run_id: "r_1" });
  const [empty] = continuationMessage("r_1", "");
  const body = JSON.parse(String(empty.content).slice("Continuation: ".length));
  assert.equal(body.handoff, null);
  assert.match(String(body.note), /no hand-off/);
});
