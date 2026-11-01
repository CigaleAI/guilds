import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dispatchLiveEvent,
  isAgentChange,
  isAnyPayload,
  isGroupChatState,
  isGroupMessage,
  isLiveDelta,
  isMessageNotice,
  isRunContinuation,
  isRunMessage,
  isSessionFailure,
  isStudioMessageCommit,
  isToolProgressEvent,
  runEventGuards,
  type LiveEventHandlers,
  type RunEvents,
} from "./liveEvents";

const groupMessage = {
  id: 1,
  seq: 4,
  author_type: "agent",
  author_name: "Scout",
  author_agent_id: "a1",
  source_run_id: null,
  content: "Done @Ada",
  tagged: ["Ada"],
  tagged_agent_ids: [],
  tagged_user_ids: ["u1"],
  created_at: "2026-01-01T00:00:00Z",
};

const chatState = {
  guild_id: "g1",
  chat_seq: 4,
  agent_message_count: 2,
  agent_message_limit: 20,
  dispatching: false,
  pending_agent_count: 0,
  active_agents: [{ id: "a1", name: "Scout" }],
  limit_reached: false,
  errors: [
    {
      at: "2026-01-01T00:00:00Z",
      agent_id: "a1",
      operation: "group.delivery",
      error_type: "Timeout",
      message: "timed out",
    },
  ],
};

const runMessage = {
  id: 7,
  seq: 3,
  payload: { role: "assistant", content: "hi" },
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  cost_usd: 0.002,
};

const studioMessage = {
  id: 9,
  session_id: "s1",
  seq: 2,
  generation: 1,
  payload: { role: "assistant", content: "hi" },
  metadata: null,
  cost_usd: 0.002,
  created_at: "2026-01-01T00:00:00Z",
};

test("isGroupMessage admits a committed group message", () => {
  assert.equal(isGroupMessage(groupMessage), true);
});

test("isGroupMessage refuses one with a missing tag list or another author type", () => {
  assert.equal(isGroupMessage({ ...groupMessage, tagged: undefined }), false);
  assert.equal(isGroupMessage({ ...groupMessage, author_type: "bot" }), false);
  assert.equal(isGroupMessage({ ...groupMessage, seq: "4" }), false);
});

test("isGroupChatState admits a chat state, with or without the operator's read cursor", () => {
  assert.equal(isGroupChatState(chatState), true);
  assert.equal(isGroupChatState({ ...chatState, seen_through_seq: null }), true);
  assert.equal(isGroupChatState({ ...chatState, seen_through_seq: 3 }), true);
});

test("isGroupChatState refuses one with a malformed agent or error", () => {
  assert.equal(isGroupChatState({ ...chatState, active_agents: [{ id: "a1" }] }), false);
  assert.equal(
    isGroupChatState({ ...chatState, errors: [{ operation: "group.delivery" }] }),
    false,
  );
  assert.equal(isGroupChatState({ ...chatState, dispatching: "no" }), false);
});

test("isAgentChange admits a change that names its agent", () => {
  assert.equal(isAgentChange({ agent_id: "a1", action: "created" }), true);
  assert.equal(isAgentChange({ action: "created" }), false);
  assert.equal(isAgentChange(null), false);
});

test("isMessageNotice admits a notice from an operator or an agent", () => {
  const notice = {
    guild_id: "g1",
    seq: 5,
    author_type: "user",
    author_name: "Ada",
    preview: "Hello",
    agent: null,
  };
  assert.equal(isMessageNotice(notice), true);
  const agent = { id: "a1", name: "Scout", avatar_shape: "teardrop", avatar_color: "#7c5cff" };
  assert.equal(isMessageNotice({ ...notice, author_type: "agent", agent }), true);
  assert.equal(isMessageNotice({ ...notice, agent: { id: "a1" } }), false);
  assert.equal(isMessageNotice({ ...notice, preview: undefined }), false);
});

test("isRunMessage admits a committed run row and refuses one without its payload or cost", () => {
  assert.equal(isRunMessage(runMessage), true);
  assert.equal(isRunMessage({ ...runMessage, cost_usd: null }), true);
  assert.equal(isRunMessage({ ...runMessage, payload: null }), false);
  assert.equal(isRunMessage({ ...runMessage, cost_usd: "0.002" }), false);
  assert.equal(isRunMessage([]), false);
});

test("isRunMessage refuses a row whose payload is not a stored message", () => {
  const tool = { role: "tool", tool_call_id: "c1", content: "ok" };
  assert.equal(isRunMessage({ ...runMessage, payload: tool }), true);
  assert.equal(isRunMessage({ ...runMessage, payload: { role: "tool", content: "ok" } }), false);
  assert.equal(isRunMessage({ ...runMessage, payload: { role: "user", content: 5 } }), false);
  assert.equal(isRunMessage({ ...runMessage, payload: { role: "robot", content: "hi" } }), false);
  const call = { id: "c1", type: "function", function: { name: "shell", arguments: "{}" } };
  const asking = { role: "assistant", content: "", tool_calls: [call] };
  assert.equal(isRunMessage({ ...runMessage, payload: asking }), true);
  const malformed = { ...asking, tool_calls: [{ id: "c1" }] };
  assert.equal(isRunMessage({ ...runMessage, payload: malformed }), false);
});

test("isLiveDelta admits a run's text and a coach's content, and refuses anything else", () => {
  assert.equal(isLiveDelta({ text: "run" }), true);
  assert.equal(isLiveDelta({ session_id: "s1", content: "hi", text: "hi" }), true);
  assert.equal(isLiveDelta({ content: "hi" }), false);
  assert.equal(isLiveDelta({ content: 5, text: "run" }), false);
  assert.equal(isLiveDelta(null), false);
});

test("isToolProgressEvent admits a call's lines, with or without its session", () => {
  const progress = { run_id: "r1", tool_call_id: "c1", lines: ["read a.py"] };
  assert.equal(isToolProgressEvent(progress), true);
  assert.equal(isToolProgressEvent({ ...progress, session_id: null }), true);
  assert.equal(isToolProgressEvent({ ...progress, session_id: "s1" }), true);
  assert.equal(isToolProgressEvent({ ...progress, session_id: 3 }), false);
});

test("isToolProgressEvent refuses an event that names no call or holds lines that are not text", () => {
  const progress = { run_id: "r1", tool_call_id: "c1", lines: ["a"] };
  assert.equal(isToolProgressEvent(null), false);
  assert.equal(isToolProgressEvent("read a.py"), false);
  assert.equal(isToolProgressEvent({ run_id: "r1", lines: ["x"] }), false);
  assert.equal(isToolProgressEvent({ ...progress, tool_call_id: 7 }), false);
  assert.equal(isToolProgressEvent({ ...progress, lines: ["a", 2, null, "b"] }), false);
  assert.equal(isToolProgressEvent({ ...progress, lines: "a" }), false);
});

test("isRunContinuation admits the run that carries on", () => {
  assert.equal(isRunContinuation({ run_id: "r2" }), true);
  assert.equal(isRunContinuation({ run_id: 2 }), false);
});

test("isStudioMessageCommit admits the committed coach row and refuses a bare row", () => {
  assert.equal(isStudioMessageCommit({ message: studioMessage }), true);
  assert.equal(isStudioMessageCommit({ message: { ...studioMessage, cost_usd: "0.002" } }), false);
  assert.equal(isStudioMessageCommit(studioMessage), false);
});

test("isSessionFailure admits a failure with its detail", () => {
  assert.equal(isSessionFailure({ detail: "input token limit reached" }), true);
  assert.equal(isSessionFailure({ detail: null }), false);
});

test("isAnyPayload admits every payload", () => {
  assert.equal(isAnyPayload(undefined), true);
  assert.equal(isAnyPayload({ generation: 2 }), true);
});

/** Run-stream handlers that record what each was given. */
function recordingHandlers(calls: string[]): LiveEventHandlers<RunEvents> {
  const record = (name: string) => (payload: unknown) =>
    calls.push(`${name}:${JSON.stringify(payload)}`);
  return {
    "generation.started": record("generation.started"),
    "assistant.reasoning.delta": record("assistant.reasoning.delta"),
    "assistant.delta": record("assistant.delta"),
    "message.committed": record("message.committed"),
    "tool.progress": record("tool.progress"),
    "run.error": record("run.error"),
    "generation.finished": record("generation.finished"),
    "run.continued": record("run.continued"),
  };
}

test("dispatchLiveEvent hands a payload that passes its guard to the event's handler", () => {
  const calls: string[] = [];
  dispatchLiveEvent(runEventGuards, recordingHandlers(calls), "run.continued", { run_id: "r2" });
  dispatchLiveEvent(runEventGuards, recordingHandlers(calls), "run.error", undefined);
  assert.deepEqual(calls, ['run.continued:{"run_id":"r2"}', "run.error:undefined"]);
});

test("dispatchLiveEvent ignores a payload that fails its guard and an event it does not name", () => {
  const calls: string[] = [];
  dispatchLiveEvent(runEventGuards, recordingHandlers(calls), "run.continued", {});
  dispatchLiveEvent(runEventGuards, recordingHandlers(calls), "message.committed", null);
  dispatchLiveEvent(runEventGuards, recordingHandlers(calls), "draft.changed", {});
  dispatchLiveEvent(runEventGuards, recordingHandlers(calls), "toString", {});
  assert.deepEqual(calls, []);
});
