import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageNotice } from "../../api/types/chat";
import { announces, chimeDue, chimeGapMs, showsGroupChat } from "./newMessages";

const agentPost: MessageNotice = {
  guild_id: "g1",
  seq: 4,
  author_type: "agent",
  author_name: "scout",
  preview: "the feed is back",
  agent: { id: "a1", name: "scout", avatar_shape: "clay:scout", avatar_color: "#1d9bf0" },
};
const reading = { name: "ada", pathname: "/guilds/g1", attending: true };

test("a guild's home and its agent inspector show the group chat; its other tabs do not", () => {
  assert.equal(showsGroupChat("/guilds/g1", "g1"), true);
  assert.equal(showsGroupChat("/guilds/g1/agents/a1/prompt", "g1"), true);
  assert.equal(showsGroupChat("/guilds/g1/settings", "g1"), false);
  assert.equal(showsGroupChat("/guilds/g2", "g1"), false);
  assert.equal(showsGroupChat("/inbox", "g1"), false);
  assert.equal(showsGroupChat("/guilds/g%201", "g 1"), true);
});

test("a message is announced unless the reader wrote it or is watching that chat", () => {
  assert.equal(announces(agentPost, reading), false, "watching the chat");
  assert.equal(
    announces(agentPost, { ...reading, attending: false }),
    true,
    "tab hidden or window unfocused",
  );
  assert.equal(
    announces(agentPost, { ...reading, pathname: "/guilds/g1/settings" }),
    true,
    "another tab of the guild",
  );
  assert.equal(announces(agentPost, { ...reading, pathname: "/guilds/g2" }), true, "another guild");
  const ownPost = { ...agentPost, author_type: "user" as const, author_name: "ada", agent: null };
  assert.equal(announces(ownPost, { ...reading, pathname: "/inbox" }), false, "one's own message");
  const otherPost = { ...ownPost, author_name: "bo" };
  assert.equal(
    announces(otherPost, { ...reading, pathname: "/inbox" }),
    true,
    "another operator's message",
  );
});

test("chimes keep a gap, and the first one is always due", () => {
  assert.equal(chimeDue(null, 1000), true);
  assert.equal(chimeDue(1000, 1000 + chimeGapMs - 1), false);
  assert.equal(chimeDue(1000, 1000 + chimeGapMs), true);
});
