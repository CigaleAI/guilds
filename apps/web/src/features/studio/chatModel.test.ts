import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioMessage } from "../../api/types";
import { connectionLabel, editTargetLabel, focusOf, widgetOf } from "./chatModel";

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
