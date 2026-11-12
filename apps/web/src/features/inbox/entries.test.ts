import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notifications } from "../../api/types/chat";
import { entryGround, inboxEntries } from "./entries";

const inbox: Notifications = {
  mentions: [
    {
      id: 1,
      guild_id: "guild_1",
      guild_name: "Research",
      seq: 4,
      author_type: "agent",
      author_name: "scout",
      content: "@operator which source?",
      created_at: "2026-01-01T10:00:00.000Z",
      agent: null,
    },
  ],
  issues: [
    {
      id: "issue_1",
      guild_id: "guild_2",
      guild_name: "Sales",
      agent_id: null,
      agent_name: "closer",
      run_id: null,
      kind: "api",
      severity: "high",
      status: "open",
      summary: "The model API refused the key",
      detail: "401",
      tool_name: null,
      created_at: "2026-01-01T11:00:00.000Z",
      updated_at: "2026-01-01T11:00:00.000Z",
      resolved_at: null,
      resolved_by: null,
      agent: null,
    },
  ],
  unread: [{ guild_id: "guild_1", count: 9 }],
};

test("All lists tags and issues together, newest first", () => {
  const entries = inboxEntries(inbox, "all");
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["issue", "tag"],
  );
});

test("Tags lists the messages that tag the operator only", () => {
  const entries = inboxEntries(inbox, "tags");
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["tag"],
  );
});

test("Issues lists the open issues only", () => {
  const entries = inboxEntries(inbox, "issues");
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["issue"],
  );
});

test("an inbox not loaded yet lists nothing", () => {
  assert.deepEqual(inboxEntries(undefined, "all"), []);
});

test("a tag card sits on a blue wash and an issue card on a red one", () => {
  assert.equal(entryGround.tag, "bg-signal-wash");
  assert.equal(entryGround.issue, "bg-alert-wash");
});
