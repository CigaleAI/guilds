import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationMessageRow } from "../../src/db/conversations.js";
import type { MessagePayload } from "../../src/db/schema/index.js";
import { awaitOperator, type StudioEdit } from "../../src/studio/edit-request.js";
import { findEditRecord } from "../../src/studio/edits.js";
import { StudioNotFoundError } from "../../src/studio/errors.js";

// The operator's side of an edit request: the record a tool message and its call hold.

const MEMORY_EDIT: StudioEdit = {
  kind: "memory",
  target: { agent_id: "a_1", agent_name: "curator" },
  base_version: 2,
  base_hash: "base",
  proposed_hash: "proposed",
  lines: { added: 1, removed: 0 },
};

const MEMORY_ARGS = {
  agent_id: "a_1",
  content: "Keep the digest.",
  base_version: 2,
  reason: "It drifted.",
};

function row(seq: number, payload: MessagePayload): ConversationMessageRow {
  return {
    id: seq,
    session_id: "s_1",
    seq,
    generation: 1,
    payload,
    metadata: {},
    cost_usd: null,
    created_at: "2026-11-10T09:30:00.000Z",
  };
}

function callMessage(name: string, args: string): ConversationMessageRow {
  return row(1, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }],
  });
}

function widgetMessage(content: string): ConversationMessageRow {
  return row(2, { role: "tool", tool_call_id: "call_1", content });
}

const WIDGET = JSON.stringify(awaitOperator("Edit curator's Memory", "It drifted.", MEMORY_EDIT));

test("an edit record holds the widget, the decoded call, and the tool message's metadata", () => {
  const record = findEditRecord(
    [callMessage("studio_edit_memory", JSON.stringify(MEMORY_ARGS)), widgetMessage(WIDGET)],
    2,
  );
  assert.equal(record.kind, "memory");
  assert.equal(record.seq, 2);
  assert.equal(record.toolName, "studio_edit_memory");
  assert.equal(record.toolCallId, "call_1");
  assert.deepEqual(record.edit, MEMORY_EDIT);
  assert.deepEqual(record.args, MEMORY_ARGS);
  assert.deepEqual(record.metadata, {});
});

test("no edit record is found at a seq no message holds", () => {
  assert.throws(
    () => findEditRecord([callMessage("studio_edit_memory", JSON.stringify(MEMORY_ARGS))], 2),
    StudioNotFoundError,
  );
});

test("no edit record is found at a message that is not a tool result", () => {
  assert.throws(
    () => findEditRecord([callMessage("studio_edit_memory", JSON.stringify(MEMORY_ARGS))], 1),
    StudioNotFoundError,
  );
});

test("no edit record is found at a tool result that holds no edit widget", () => {
  const messages = [
    callMessage("studio_edit_memory", JSON.stringify(MEMORY_ARGS)),
    widgetMessage('{"ok":true}'),
  ];
  assert.throws(() => findEditRecord(messages, 2), StudioNotFoundError);
});

test("no edit record is found when no assistant message made the call", () => {
  assert.throws(() => findEditRecord([widgetMessage(WIDGET)], 2), StudioNotFoundError);
});

test("no edit record is found when the call's arguments are not an object", () => {
  const messages = [callMessage("studio_edit_memory", "[1, 2]"), widgetMessage(WIDGET)];
  assert.throws(() => findEditRecord(messages, 2), StudioNotFoundError);
});

test("no edit record is found when the call's arguments are not JSON", () => {
  const messages = [callMessage("studio_edit_memory", "{"), widgetMessage(WIDGET)];
  assert.throws(() => findEditRecord(messages, 2), StudioNotFoundError);
});

test("no edit record is found when the call is not an edit tool's", () => {
  const messages = [
    callMessage("studio_get_run", JSON.stringify(MEMORY_ARGS)),
    widgetMessage(WIDGET),
  ];
  assert.throws(() => findEditRecord(messages, 2), StudioNotFoundError);
});
