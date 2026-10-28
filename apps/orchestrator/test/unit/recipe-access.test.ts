import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessEntry } from "../../src/artifacts/access.js";
import { accessRaises, agentsOfRoles, guildModeOn } from "../../src/recipes/access.js";

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

const SUBJECTS = { guildId: "guild_new", writerIds: ["a_writer"] };

test("a guild's mode is the better of its own row and its organisation's", () => {
  assert.equal(guildModeOn([row("org", "org_home", "read")], "guild_new"), "read");
  assert.equal(
    guildModeOn([row("org", "org_home", "read"), row("guild", "guild_new", "write")], "guild_new"),
    "write",
  );
  assert.equal(
    guildModeOn([row("org", "org_home", "write"), row("guild", "guild_new", "read")], "guild_new"),
    "write",
  );
  assert.equal(guildModeOn([row("guild", "guild_other", "write")], "guild_new"), null);
});

test("accessRaises adds the guild row and writer rows a new item lacks", () => {
  assert.deepEqual(accessRaises([], { guild: "read", writers: ["writer"] }, SUBJECTS), [
    { type: "guild", id: "guild_new", mode: "read" },
    { type: "agent", id: "a_writer", mode: "write" },
  ]);
});

test("accessRaises never lowers the guild's existing row", () => {
  const entries = [row("guild", "guild_new", "write")];
  assert.deepEqual(accessRaises(entries, { guild: "read", writers: ["writer"] }, SUBJECTS), []);
});

test("accessRaises adds no guild row the organisation's row already gives", () => {
  const entries = [row("org", "org_home", "read")];
  assert.deepEqual(
    accessRaises(entries, { guild: "read", writers: [] }, { guildId: "guild_new", writerIds: [] }),
    [],
  );
});

test("accessRaises raises a guild that only reads to write", () => {
  const entries = [row("org", "org_home", "read")];
  assert.deepEqual(
    accessRaises(entries, { guild: "write", writers: [] }, { guildId: "guild_new", writerIds: [] }),
    [{ type: "guild", id: "guild_new", mode: "write" }],
  );
});

test("accessRaises leaves out a writer the guild's mode already lets write", () => {
  assert.deepEqual(accessRaises([], { guild: "write", writers: ["writer"] }, SUBJECTS), [
    { type: "guild", id: "guild_new", mode: "write" },
  ]);
});

test("accessRaises raises a writer whose own row shuts it out or only reads", () => {
  for (const mode of ["none", "read"] as const) {
    const entries = [row("guild", "guild_new", "read"), row("agent", "a_writer", mode)];
    assert.deepEqual(accessRaises(entries, { guild: "read", writers: ["writer"] }, SUBJECTS), [
      { type: "agent", id: "a_writer", mode: "write" },
    ]);
  }
});

test("accessRaises gives nothing to a guild the recipe names no mode for", () => {
  assert.deepEqual(accessRaises([], { writers: [] }, { guildId: "guild_new", writerIds: [] }), []);
});

test("agentsOfRoles skips a role apply did not create", () => {
  assert.deepEqual(agentsOfRoles(["writer", "ghost"], new Map([["writer", "a_writer"]])), [
    "a_writer",
  ]);
});
