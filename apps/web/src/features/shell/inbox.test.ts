import assert from "node:assert/strict";
import { test } from "node:test";
import { unreadByGuild } from "./inbox";

test("unread counts are keyed by guild, and a guild with none is absent", () => {
  const counts = unreadByGuild({
    issues: [],
    mentions: [],
    unread: [
      { guild_id: "guild_1", count: 3 },
      { guild_id: "guild_2", count: 120 },
    ],
  });
  assert.equal(counts.get("guild_1"), 3);
  assert.equal(counts.get("guild_2"), 120);
  assert.equal(counts.has("guild_3"), false);
});

test("an inbox not loaded yet has no unread guild", () => {
  assert.equal(unreadByGuild(undefined).size, 0);
});
