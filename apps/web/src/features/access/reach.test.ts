import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReachedNote } from "../../api/types/access";
import { noteLink, notePlacement } from "./reach";

function note(
  level: ReachedNote["level"],
  owner: { id: string; name?: string; guildId?: string | null },
): ReachedNote {
  return {
    id: "n_1",
    display_path: `org/o_1/${owner.id}/plan.md`,
    title: "plan",
    level,
    owner_id: owner.id,
    owner_name: owner.name ?? owner.id,
    guild_id: owner.guildId ?? null,
    mode: "read",
  };
}

test("an organisation note opens in the listed guild's Files view", () => {
  assert.deepEqual(noteLink(note("org", { id: "o_1" }), "g_1"), {
    guildId: "g_1",
    path: "org/o_1/o_1/plan.md",
  });
});

test("a guild note opens in its own guild's Files view", () => {
  assert.deepEqual(noteLink(note("guild", { id: "g_2", guildId: "g_2" }), "g_1"), {
    guildId: "g_2",
    path: "org/o_1/g_2/plan.md",
  });
});

test("an agent note opens in its agent's Notes view in the note's guild, and has no link without one", () => {
  assert.deepEqual(noteLink(note("agent", { id: "a_7", guildId: "g_2" }), "g_1"), {
    guildId: "g_2",
    agentId: "a_7",
    path: "org/o_1/a_7/plan.md",
  });
  assert.equal(noteLink(note("agent", { id: "a_9" }), "g_1"), null);
});

test("a note's placement names its owner as the reach listing gives it", () => {
  assert.equal(notePlacement(note("org", { id: "o_1", name: "Acme" })), "Organisation");
  assert.equal(
    notePlacement(note("guild", { id: "g_2", name: "Ops", guildId: "g_2" })),
    "Guild · Ops",
  );
  assert.equal(
    notePlacement(note("agent", { id: "a_9", name: "scout", guildId: "g_1" })),
    "Agent · scout",
  );
});
