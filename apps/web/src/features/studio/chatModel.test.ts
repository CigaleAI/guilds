import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioMessage } from "../../api/types/studio";
import {
  applyLabel,
  batchReply,
  connectionLabel,
  acceptedDecision,
  declinedDecision,
  draftDecision,
  editTargetLabel,
  focusOf,
  parseConnection,
  parseEdit,
  widgetOf,
} from "./chatModel";

function message(
  seq: number,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> | null = null,
): StudioMessage {
  return {
    id: seq,
    session_id: "stu_1",
    seq,
    generation: 2,
    payload,
    metadata,
    cost_usd: null,
    created_at: "2026-09-26T10:00:00Z",
  };
}

test("edit and access requests are read from tool results", () => {
  const edit = message(4, {
    role: "tool",
    content: JSON.stringify({
      widget: "studio_edit_request",
      title: "Tidy memory",
      edit: { kind: "memory", target: { agent_id: "a_1", agent_name: "wallet" } },
    }),
  });
  const read = widgetOf(edit);
  assert.deepEqual(read, {
    kind: "edit",
    title: "Tidy memory",
    edit: { kind: "memory", target: { agent_id: "a_1", agent_name: "wallet" } },
  });
  assert.ok(read?.kind === "edit");
  assert.equal(editTargetLabel(read.edit), "wallet · Memory");
  assert.equal(
    editTargetLabel({ kind: "guild", target: { guild_name: "degen" }, fields: ["about"] }),
    "degen · about",
  );
  assert.equal(
    editTargetLabel({
      kind: "collection",
      action: "create",
      target: { collection_id: null, name: "leads" },
    }),
    "leads · table",
  );
  assert.equal(
    editTargetLabel({ kind: "access", target: { agent_id: "a_1", agent_name: "wallet" } }),
    "wallet · access",
  );
  assert.equal(
    editTargetLabel({
      kind: "routine",
      action: "create",
      target: {
        agent_id: "a_1",
        agent_name: "wallet",
        schedule_id: null,
        description: "Daily sweep",
      },
    }),
    "wallet · Daily sweep",
  );
  assert.equal(editTargetLabel({ kind: "routine", target: { agent_id: "a_1" } }), "a_1 · routine");
  const access = message(5, {
    role: "tool",
    content: JSON.stringify({
      widget: "studio_connection_access",
      connection: { id: "conn_1", server: { id: "mcp_x", slug: "x", display_name: "X" } },
    }),
  });
  const login = widgetOf(access);
  assert.ok(login?.kind === "access");
  assert.equal(connectionLabel(login.connection), "X");
  assert.equal(widgetOf(message(6, { role: "tool", content: '{"rows":[]}' })), null);
  assert.equal(widgetOf(message(7, { role: "assistant", content: "hi" })), null);
});

test("a focused message names what it was pinned to", () => {
  assert.deepEqual(
    focusOf(
      message(
        1,
        { role: "user" },
        { source: "studio_focus", focus: { kind: "run", label: "Group run" } },
      ),
    ),
    {
      kind: "run",
      label: "Group run",
    },
  );
  assert.equal(focusOf(message(2, { role: "user" }, { source: "ui" })), null);
});

test("a turn's requests are answered by one reply once each is decided", () => {
  const memory = {
    kind: "edit" as const,
    edit: { kind: "memory" as const, target: { agent_name: "wallet" } },
  };
  const note = {
    kind: "edit" as const,
    edit: { kind: "note" as const, target: { title: "Playbook" } },
  };
  const login = { kind: "access" as const, connection: { server: { display_name: "X" } } };
  assert.equal(batchReply([]), null);
  assert.equal(batchReply([acceptedDecision(memory), null]), null);
  assert.equal(
    batchReply([acceptedDecision(memory), acceptedDecision(note)]),
    "Applied the edit to wallet · Memory. Applied the edit to Playbook. Continue.",
  );
  assert.equal(
    batchReply([acceptedDecision(memory), declinedDecision(note), acceptedDecision(login)]),
    "Applied the edit to wallet · Memory. Declined the edit to Playbook. Granted read access to X. Continue without what I declined.",
  );
  assert.equal(
    batchReply([declinedDecision(login)]),
    "Declined read access to X. Continue without it.",
  );
});

test("the apply button names what a create or delete makes", () => {
  assert.equal(applyLabel({ kind: "note", action: "create" }), "Create note");
  assert.equal(applyLabel({ kind: "note", action: "delete" }), "Delete note");
  assert.equal(applyLabel({ kind: "collection", action: "create" }), "Create table");
  assert.equal(applyLabel({ kind: "collection", action: "delete" }), "Delete table");
  assert.equal(applyLabel({ kind: "note" }), "Apply edit");
  assert.equal(applyLabel({ kind: "access" }), "Apply edit");
  assert.equal(applyLabel({ kind: "routine", action: "create" }), "Create routine");
  assert.equal(applyLabel({ kind: "routine", action: "delete" }), "Delete routine");
  assert.equal(applyLabel({ kind: "routine", action: "edit" }), "Apply edit");
});

test("a Task draft is read from its tool result and answered in the coach's words", () => {
  const draft = widgetOf(
    message(6, {
      role: "tool",
      content: JSON.stringify({
        widget: "studio_task_draft",
        agent: { id: "a_1", name: "wallet" },
        draft_id: "std_1",
        rationale: "No stop rule.",
      }),
    }),
  );
  assert.deepEqual(draft, {
    kind: "draft",
    agent: { id: "a_1", name: "wallet" },
    draft_id: "std_1",
    rationale: "No stop rule.",
  });
  assert.ok(draft?.kind === "draft");
  assert.deepEqual(draftDecision(draft, "published"), {
    accepted: true,
    line: "Published the draft for wallet.",
  });
  assert.deepEqual(draftDecision(draft, "edited"), {
    accepted: true,
    line: "Edited and published the draft for wallet.",
  });
  assert.deepEqual(draftDecision(draft, "discarded"), {
    accepted: false,
    line: "Discarded the draft for wallet.",
  });
  assert.equal(
    widgetOf(
      message(7, {
        role: "tool",
        content: JSON.stringify({ widget: "studio_task_draft", agent: { id: "a_1" } }),
      }),
    ),
    null,
  );
  assert.deepEqual(
    widgetOf(
      message(8, {
        role: "tool",
        content: JSON.stringify({
          widget: "studio_task_draft",
          agent: { id: "a_1" },
          draft_id: "d",
        }),
      }),
    ),
    { kind: "draft", agent: { id: "a_1", name: "a_1" }, draft_id: "d" },
  );
});

test("an edit keeps every field that holds what it names", () => {
  const edit = {
    kind: "access",
    action: "edit",
    target: { agent_id: "a_1", collection_id: null },
    base_version: 3,
    fields: ["about"],
    lines: { added: 2, removed: 1 },
    changes: [{ kind: "mcp", id: "conn_1", label: "Notion", setting: "on" }],
    widens: true,
  };
  assert.deepEqual(parseEdit(edit), edit);
});

test("an edit drops a field of the wrong type and an access change it cannot read", () => {
  assert.deepEqual(
    parseEdit({
      kind: "secret",
      action: 2,
      target: { agent_id: 7, schedule_id: "sch_1" },
      base_version: "3",
      fields: ["about", 4],
      lines: { added: "2" },
      changes: [
        { kind: "mcp", id: "conn_1", label: "Notion", setting: "maybe" },
        { kind: "native_tool", id: "web_fetch", label: "Fetch", setting: "off" },
        "on",
      ],
      widens: "yes",
    }),
    {
      target: { schedule_id: "sch_1" },
      fields: ["about"],
      lines: {},
      changes: [{ kind: "native_tool", id: "web_fetch", label: "Fetch", setting: "off" }],
    },
  );
  assert.deepEqual(parseEdit(null), {});
  assert.deepEqual(parseEdit(["memory"]), {});
});

test("a login keeps the text fields of the connection and its server", () => {
  assert.deepEqual(
    parseConnection({
      id: "conn_1",
      owner_scope: "org",
      account_hint: 5,
      server: { slug: "notion", display_name: null },
    }),
    { id: "conn_1", owner_scope: "org", server: { slug: "notion" } },
  );
  assert.deepEqual(parseConnection("conn_1"), {});
});

test("a focus keeps the ids that locate it and drops a field of the wrong type", () => {
  assert.deepEqual(
    focusOf(
      message(
        3,
        { role: "user" },
        {
          source: "studio_focus",
          focus: { kind: 4, run_id: "r_1", seq: null, call_id: 9, revision_id: null },
        },
      ),
    ),
    { kind: "focus", label: "Pinned evidence", run_id: "r_1", seq: null, revision_id: null },
  );
  assert.deepEqual(focusOf(message(4, { role: "user" }, { source: "studio_focus", focus: [] })), {
    kind: "focus",
    label: "Pinned evidence",
  });
});
