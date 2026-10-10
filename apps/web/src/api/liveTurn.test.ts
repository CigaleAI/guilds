import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLiveDelta, liveDeltaText, liveTurnActive } from "./liveTurn";

test("liveDeltaText reads coach content and run text", () => {
  assert.equal(liveDeltaText({ content: "hello", text: "hello" }), "hello");
  assert.equal(liveDeltaText({ text: "run" }), "run");
  assert.equal(liveDeltaText({ content: "" }), "");
  assert.equal(liveDeltaText(null), "");
});

test("applyLiveDelta accumulates reasoning then text", () => {
  const thought = applyLiveDelta(null, "assistant.reasoning.delta", { text: "think " });
  assert.deepEqual(thought, { reasoning: "think ", text: "" });
  const more = applyLiveDelta(thought, "assistant.reasoning.delta", { text: "hard" });
  assert.deepEqual(more, { reasoning: "think hard", text: "" });
  const reply = applyLiveDelta(more, "assistant.delta", { content: "done" });
  assert.deepEqual(reply, { reasoning: "think hard", text: "done" });
});

test("liveTurnActive is true for reasoning-only turns", () => {
  assert.equal(liveTurnActive(null), false);
  assert.equal(liveTurnActive({ reasoning: "", text: "" }), false);
  assert.equal(liveTurnActive({ reasoning: "hmm", text: "" }), true);
  assert.equal(liveTurnActive({ reasoning: "", text: "hi" }), true);
});
