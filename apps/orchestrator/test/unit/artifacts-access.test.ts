import assert from "node:assert/strict";
import { test } from "node:test";
import { accessRaises, effectiveAccess } from "../../src/artifacts/service.js";
import type { AccessEntry } from "../../src/artifacts/types.js";

function row(type: AccessEntry["type"], id: string, mode: AccessEntry["mode"]): AccessEntry {
  return {
    type,
    id,
    name: id,
    mode,
    guild_id: type === "org" ? null : "guild_new",
    guild_name: null,
  };
}

const GUILD = { guildId: "guild_new", agentId: null };
const WRITER = { guildId: "guild_new", agentId: "a_writer" };

test("a guild's mode is the better of its own row and its organisation's", () => {
  assert.equal(effectiveAccess([row("org", "org_home", "read")], GUILD), "read");
  assert.equal(effectiveAccess([row("org", "org_home", "read"), row("guild", "guild_new", "write")], GUILD), "write");
  assert.equal(effectiveAccess([row("org", "org_home", "write"), row("guild", "guild_new", "read")], GUILD), "write");
  assert.equal(effectiveAccess([row("guild", "guild_new", "read")], GUILD), "read");
  assert.equal(effectiveAccess([row("guild", "guild_other", "write")], GUILD), null);
});

test("a guild's mode ignores the rows of its agents", () => {
  assert.equal(effectiveAccess([row("agent", "a_writer", "write")], GUILD), null);
});

test("an agent's own row replaces its guild's mode, lower or higher", () => {
  const entries = [row("guild", "guild_new", "write"), row("agent", "a_writer", "read")];
  assert.equal(effectiveAccess(entries, WRITER), "read");
  assert.equal(effectiveAccess([row("org", "org_home", "read"), row("agent", "a_writer", "write")], WRITER), "write");
});

test("an agent whose own row is none has no access whatever its guild gets", () => {
  assert.equal(effectiveAccess([row("guild", "guild_new", "write"), row("agent", "a_writer", "none")], WRITER), null);
});

test("an agent without a row of its own takes its guild's mode", () => {
  const entries = [row("org", "org_home", "read"), row("agent", "a_other", "write")];
  assert.equal(effectiveAccess(entries, WRITER), "read");
  assert.equal(effectiveAccess([], WRITER), null);
});

test("accessRaises adds the guild row and writer rows a new item lacks", () => {
  assert.deepEqual(accessRaises([], { guildId: "guild_new", mode: "read", writerIds: ["a_writer"] }), [
    { type: "guild", id: "guild_new", mode: "read" },
    { type: "agent", id: "a_writer", mode: "write" },
  ]);
});

test("accessRaises never lowers the guild's existing row", () => {
  const entries = [row("guild", "guild_new", "write")];
  assert.deepEqual(accessRaises(entries, { guildId: "guild_new", mode: "read", writerIds: ["a_writer"] }), []);
});

test("accessRaises adds no guild row the organisation's row already gives", () => {
  const entries = [row("org", "org_home", "read")];
  assert.deepEqual(accessRaises(entries, { guildId: "guild_new", mode: "read", writerIds: [] }), []);
});

test("accessRaises raises a guild that only reads to write", () => {
  const entries = [row("org", "org_home", "read")];
  assert.deepEqual(accessRaises(entries, { guildId: "guild_new", mode: "write", writerIds: [] }), [
    { type: "guild", id: "guild_new", mode: "write" },
  ]);
});

test("accessRaises leaves out a writer the guild's raised mode already lets write", () => {
  assert.deepEqual(accessRaises([], { guildId: "guild_new", mode: "write", writerIds: ["a_writer"] }), [
    { type: "guild", id: "guild_new", mode: "write" },
  ]);
});

test("accessRaises raises a writer whose own row shuts it out or only reads", () => {
  for (const mode of ["none", "read"] as const) {
    const entries = [row("guild", "guild_new", "read"), row("agent", "a_writer", mode)];
    assert.deepEqual(accessRaises(entries, { guildId: "guild_new", mode: "read", writerIds: ["a_writer"] }), [
      { type: "agent", id: "a_writer", mode: "write" },
    ]);
  }
});

test("accessRaises gives nothing to a guild the raise names no mode for", () => {
  assert.deepEqual(accessRaises([], { guildId: "guild_new", mode: null, writerIds: [] }), []);
});
