import assert from "node:assert/strict";
import { test } from "node:test";
import { hashArtifactContent } from "../../src/artifacts/store.js";
import type { ConversationMessageRow } from "../../src/db/conversations.js";
import type { ConversationMessageMetadata, MessagePayload } from "../../src/db/schema/index.js";
import { awaitOperator, type StudioEdit } from "../../src/studio/edit-request.js";
import {
  findEditRecord,
  formatContentEditView,
  guildTextHash,
  type EditBase,
  type EditRecord,
} from "../../src/studio/edits.js";
import { StudioNotFoundError } from "../../src/studio/errors.js";
import type { JsonObject } from "../../src/lib/json.js";

// The operator's side of an edit request: the record a tool message and its call hold, and the
// view the operator reviews it in.

const LIVE_MEMORY = "Keep it short.";

const MEMORY_EDIT: StudioEdit = {
  kind: "memory",
  target: { agent_id: "a_1", agent_name: "curator" },
  base_version: 2,
  base_hash: hashArtifactContent(LIVE_MEMORY),
  proposed_hash: hashArtifactContent("Keep the digest."),
  lines: { added: 1, removed: 1 },
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

/** The record of an edit request made by `tool` with `args`, answered as `metadata` says. */
function recordOf(
  tool: string,
  edit: StudioEdit,
  args: JsonObject,
  metadata: ConversationMessageMetadata = {},
): EditRecord {
  const widget = JSON.stringify(awaitOperator("Edit", "Because.", edit));
  const record = findEditRecord(
    [callMessage(tool, JSON.stringify(args)), widgetMessage(widget)],
    2,
  );
  return { ...record, metadata };
}

const MEMORY_BASE: EditBase = {
  kind: "memory",
  agentId: "a_1",
  agentName: "curator",
  guildId: "g_1",
  version: 2,
  content: LIVE_MEMORY,
};

const APPLIED: ConversationMessageMetadata = {
  edit_status: "applied",
  edit_resolved_at: "2026-11-10T10:00:00.000Z",
  edit_version: 3,
};

const DECLINED: ConversationMessageMetadata = {
  edit_status: "declined",
  edit_resolved_at: "2026-11-10T10:00:00.000Z",
  edit_version: null,
};

test("a pending content edit shows the live content, its version, and the proposal", () => {
  const record = recordOf("studio_edit_memory", MEMORY_EDIT, MEMORY_ARGS);
  const view = formatContentEditView(record, {
    state: "read",
    base: MEMORY_BASE,
    proposed: "Keep the digest.",
  });
  assert.deepEqual(view, {
    seq: 2,
    tool: "studio_edit_memory",
    status: "pending",
    title: "Edit",
    reason: "Because.",
    edit: MEMORY_EDIT,
    live: LIVE_MEMORY,
    live_version: 2,
    proposed: "Keep the digest.",
    stale: false,
  });
});

test("a content edit is stale when the live content no longer hashes to its base", () => {
  const record = recordOf("studio_edit_memory", MEMORY_EDIT, MEMORY_ARGS);
  const moved: EditBase = { ...MEMORY_BASE, version: 3, content: "Keep it long." };
  const view = formatContentEditView(record, {
    state: "read",
    base: moved,
    proposed: "Keep the digest.",
  });
  assert.equal(view.stale, true);
  assert.equal(view.live, "Keep it long.");
  assert.equal(view.live_version, 3);
});

test("a guild text edit shows the live about and description, with no version", () => {
  const text = { about: "Ops", description: "Runs the floor." };
  const edit: StudioEdit = {
    kind: "guild",
    target: { guild_id: "g_1", guild_name: "Ops" },
    fields: ["about"],
    base_hash: guildTextHash(text),
    proposed_hash: guildTextHash({ ...text, about: "Operations" }),
    lines: { added: 1, removed: 1 },
  };
  const record = recordOf("studio_edit_guild", edit, { about: "Operations", reason: "Clearer." });
  const base: EditBase = { kind: "guild", guildId: "g_1", guildName: "Ops", text };
  const view = formatContentEditView(record, {
    state: "read",
    base,
    proposed: { ...text, about: "Operations" },
  });
  assert.deepEqual(view.live, text);
  assert.equal(view.live_version, null);
  assert.deepEqual(view.proposed, { about: "Operations", description: "Runs the floor." });
  assert.equal(view.stale, false);
});

test("a content edit whose live content cannot be read is stale and says why", () => {
  const record = recordOf("studio_edit_memory", MEMORY_EDIT, MEMORY_ARGS);
  const view = formatContentEditView(record, {
    state: "refused",
    error: "agent is not in the source guild",
  });
  assert.equal(view.live, null);
  assert.equal(view.live_version, null);
  assert.equal(view.proposed, null);
  assert.equal(view.stale, true);
  assert.equal(view.error, "agent is not in the source guild");
});

test("an applied content edit shows when it was answered and the version it wrote", () => {
  const record = recordOf("studio_edit_memory", MEMORY_EDIT, MEMORY_ARGS, APPLIED);
  const view = formatContentEditView(record, {
    state: "read",
    base: MEMORY_BASE,
    proposed: "Keep the digest.",
  });
  assert.equal(view.status, "applied");
  assert.equal(view.resolved_at, "2026-11-10T10:00:00.000Z");
  assert.equal(view.applied_version, 3);
});

test("an applied content edit that wrote no version shows a null applied version", () => {
  const record = recordOf("studio_edit_memory", MEMORY_EDIT, MEMORY_ARGS, {
    ...APPLIED,
    edit_version: null,
  });
  const view = formatContentEditView(record, {
    state: "read",
    base: MEMORY_BASE,
    proposed: "Keep the digest.",
  });
  assert.ok("applied_version" in view);
  assert.equal(view.applied_version, null);
});

test("a declined content edit shows when it was answered and no applied version", () => {
  const record = recordOf("studio_edit_memory", MEMORY_EDIT, MEMORY_ARGS, DECLINED);
  const view = formatContentEditView(record, {
    state: "read",
    base: MEMORY_BASE,
    proposed: "Keep the digest.",
  });
  assert.equal(view.status, "declined");
  assert.equal(view.resolved_at, "2026-11-10T10:00:00.000Z");
  assert.ok(!("applied_version" in view));
});
