import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, EmbeddableNote, FileChange } from "../../../api/types";
import { changeActor, embedIsBroken, pickableNotes } from "./taskContext";

const scope = { orgId: "org_a", guildId: "guild_1", agentId: "a_1" };

function note(level: EmbeddableNote["level"], owner: string, key: string): EmbeddableNote {
  const prefix =
    level === "org"
      ? "org/org_a/"
      : `org/org_a/${level === "agent" ? "agents" : "guilds"}/${owner}/`;
  return {
    display_path: `${prefix}${key}`,
    kind: "note",
    level,
    key,
    title: null,
    author: null,
    version: 1,
    updated_at: "2026-09-26T09:00:00+00:00",
    content: "",
  };
}

test("the picker offers this agent's, this guild's and the organisation's notes", () => {
  const groups = pickableNotes(
    [
      note("agent", "a_1", "process.md"),
      note("agent", "a_2", "other-agent.md"),
      note("guild", "guild_1", "scoring.md"),
      note("guild", "guild_2", "other-guild.md"),
      note("org", "", "brand.md"),
      note("agent", "a_1", "data.json"),
    ],
    scope,
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.notes.map((item) => item.key)]),
    [
      ["This agent", ["process.md"]],
      ["Guild", ["scoring.md"]],
      ["Organisation", ["brand.md"]],
    ],
  );
});

test("an embed is broken when the server says so or nothing visible matches it", () => {
  const notes = [note("guild", "guild_1", "scoring.md")];
  const collections = [{ id: "c_1", name: "orders", purpose: "" } satisfies Pick<Collection, "id" | "name" | "purpose">];
  const known = { serverBroken: [], notes, collections, orgId: "org_a" };
  assert.equal(embedIsBroken("org/org_a/guilds/guild_1/scoring.md", known), false);
  assert.equal(embedIsBroken("org/org_a/guilds/guild_1/gone.md", known), true);
  assert.equal(embedIsBroken("org/org_a/collections/orders", known), false);
  assert.equal(embedIsBroken("org/org_a/collections/gone", known), true);
  assert.equal(
    embedIsBroken("org/org_a/guilds/guild_1/scoring.md", {
      ...known,
      serverBroken: ["org/org_a/guilds/guild_1/scoring.md"],
    }),
    true,
  );
  assert.equal(
    embedIsBroken("org/org_a/guilds/guild_1/gone.md", { ...known, notes: undefined }),
    false,
  );
});

test("a change names the person, or the run and the tool it wrote through", () => {
  const base = {
    id: "fchg_1",
    display_path: "org/org_a/agents/a_1/task.md",
    operation: "update",
    version: 3,
    created_at: "2026-09-26T09:00:00+00:00",
  };
  const byUser: FileChange = {
    ...base,
    actor: { type: "user", id: "u_1", name: "emma" },
    run: null,
    tool: null,
  };
  assert.deepEqual(changeActor(byUser), { kind: "user", name: "emma" });
  const byRun: FileChange = {
    ...base,
    actor: { type: "run", id: "r_1", name: null },
    run: { id: "r_1", agent_id: "a_1", kind: "schedule" },
    tool: { name: "task_write", call_id: "call_1" },
  };
  assert.deepEqual(changeActor(byRun), {
    kind: "run",
    runId: "r_1",
    trigger: "routine wake-up",
    tool: "task_write",
  });
});
