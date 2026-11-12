import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { MentionNotice, Notifications } from "../../api/types/chat";
import type { Issue } from "../../api/types/issues";
import { faviconForInboxCount, inboxCountsByGuild } from "./inbox";

function tag(id: number, guildId: string): MentionNotice {
  return {
    id,
    guild_id: guildId,
    guild_name: guildId,
    seq: id,
    author_type: "agent",
    author_name: "scout",
    content: "@operator",
    created_at: "2026-01-01T00:00:00.000Z",
    agent: null,
  };
}

function openIssue(id: string, guildId: string): Issue & { guild_name: string } {
  return {
    id,
    guild_id: guildId,
    guild_name: guildId,
    agent_id: null,
    agent_name: "scout",
    run_id: null,
    kind: "tool_failure",
    severity: "medium",
    status: "open",
    summary: "The tool failed",
    detail: "It timed out",
    tool_name: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    agent: null,
  };
}

test("each guild counts its inbox tags and its open issues apart", () => {
  const counts = inboxCountsByGuild({
    issues: [openIssue("i1", "guild_1"), openIssue("i2", "guild_1"), openIssue("i3", "guild_2")],
    mentions: [tag(1, "guild_1"), tag(2, "guild_3"), tag(3, "guild_3"), tag(4, "guild_3")],
    unread: [],
  });
  assert.deepEqual(counts.get("guild_1"), { tags: 1, issues: 2 });
  assert.deepEqual(counts.get("guild_2"), { tags: 0, issues: 1 });
  assert.deepEqual(counts.get("guild_3"), { tags: 3, issues: 0 });
  assert.equal(counts.has("guild_4"), false);
});

test("tags count no guild while no guild has an open issue", () => {
  const inbox: Notifications = {
    issues: [],
    mentions: [tag(1, "guild_1"), tag(2, "guild_2")],
    unread: [{ guild_id: "guild_1", count: 5 }],
  };
  assert.equal(inboxCountsByGuild(inbox).size, 0);
});

test("one open issue in any guild shows the tags of every guild", () => {
  const counts = inboxCountsByGuild({
    issues: [openIssue("i1", "guild_2")],
    mentions: [tag(1, "guild_1")],
    unread: [],
  });
  assert.deepEqual(counts.get("guild_1"), { tags: 1, issues: 0 });
  assert.deepEqual(counts.get("guild_2"), { tags: 0, issues: 1 });
});

test("unread chat messages that tag no one are not counted", () => {
  const counts = inboxCountsByGuild({
    issues: [openIssue("i1", "guild_1")],
    mentions: [tag(1, "guild_1")],
    unread: [
      { guild_id: "guild_1", count: 40 },
      { guild_id: "guild_2", count: 7 },
    ],
  });
  assert.deepEqual(counts.get("guild_1"), { tags: 1, issues: 1 });
  assert.equal(counts.has("guild_2"), false);
});

test("an inbox not loaded yet counts no guild", () => {
  assert.equal(inboxCountsByGuild(undefined).size, 0);
});

test("an inbox count above zero uses the static unread favicon", () => {
  const path = faviconForInboxCount(2);
  assert.equal(path, "/favicon-unread.svg");
  assert.equal(path.startsWith("data:"), false);
  const svg = readFileSync(
    fileURLToPath(new URL(`../../../public${path}`, import.meta.url)),
    "utf8",
  );
  assert.match(svg, /<svg[\s>]/);
  assert.equal(svg.includes("data:"), false);
  assert.match(svg, /#d9d5c7/);
  assert.match(svg, /#120e11/);
});

test("an empty inbox uses the plain favicon", () => {
  assert.equal(faviconForInboxCount(0), "/favicon.svg");
});

test("an inbox count that has not loaded uses the plain favicon", () => {
  assert.equal(faviconForInboxCount(undefined), "/favicon.svg");
});
