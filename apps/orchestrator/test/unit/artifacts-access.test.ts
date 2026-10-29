import assert from "node:assert/strict";
import { test } from "node:test";
import { accessRaises, effectiveAccess } from "../../src/artifacts/access.js";
import {
  type GuildAccess,
  isAgentRowMode,
  isGuildRowMode,
  planGuildAccess,
} from "../../src/artifacts/access-lists.js";
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

test("a guild's row takes read, write, or none, and an agent's row inherit too", () => {
  assert.deepEqual(["read", "write", "none", "inherit", null].map(isGuildRowMode), [true, true, true, false, false]);
  assert.deepEqual(["read", "write", "none", "inherit", null].map(isAgentRowMode), [true, true, true, true, false]);
});

const BASE: GuildAccess = { guild: "read", org: "read", agents: new Map([["a_writer", "write"]]) };

test("planGuildAccess keeps every row when the proposal names none", () => {
  const plan = planGuildAccess(BASE, "guild_new", { guild: null, agents: [] });
  assert.deepEqual(plan.access, BASE);
  assert.deepEqual(plan.rowChanges, []);
});

test("planGuildAccess sets the guild's row to a mode that differs", () => {
  const plan = planGuildAccess(BASE, "guild_new", { guild: "write", agents: [] });
  assert.equal(plan.access.guild, "write");
  assert.deepEqual(plan.rowChanges, [{ type: "guild", id: "guild_new", mode: "write" }]);
});

test("planGuildAccess removes the guild's row for none", () => {
  const plan = planGuildAccess(BASE, "guild_new", { guild: "none", agents: [] });
  assert.equal(plan.access.guild, null);
  assert.deepEqual(plan.rowChanges, [{ type: "guild", id: "guild_new", mode: null }]);
});

test("planGuildAccess records no change for a row already at the proposed mode", () => {
  const plan = planGuildAccess(BASE, "guild_new", { guild: "read", agents: [{ id: "a_writer", mode: "write" }] });
  assert.deepEqual(plan.rowChanges, []);
});

test("planGuildAccess removes an agent's row for inherit and keeps none as a row that shuts it out", () => {
  const plan = planGuildAccess(BASE, "guild_new", {
    guild: null,
    agents: [
      { id: "a_writer", mode: "inherit" },
      { id: "a_reader", mode: "none" },
    ],
  });
  assert.deepEqual([...plan.access.agents], [["a_reader", "none"]]);
  assert.deepEqual(plan.rowChanges, [
    { type: "agent", id: "a_writer", mode: null },
    { type: "agent", id: "a_reader", mode: "none" },
  ]);
});

test("planGuildAccess records no change for inherit on an agent without a row", () => {
  const plan = planGuildAccess(BASE, "guild_new", { guild: null, agents: [{ id: "a_reader", mode: "inherit" }] });
  assert.deepEqual(plan.rowChanges, []);
});

test("planGuildAccess keeps the organisation's row and leaves the base as it is", () => {
  const plan = planGuildAccess(BASE, "guild_new", { guild: "none", agents: [{ id: "a_writer", mode: "read" }] });
  assert.equal(plan.access.org, "read");
  assert.equal(BASE.guild, "read");
  assert.equal(BASE.agents.get("a_writer"), "write");
});
