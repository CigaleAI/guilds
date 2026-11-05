import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { faviconForInboxCount, unreadByGuild } from "./inbox";

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
