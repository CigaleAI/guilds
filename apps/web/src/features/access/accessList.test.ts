import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessEntry } from "../../api/types/access";
import {
  accessCandidates,
  findCandidate,
  modeForType,
  subjectCaption,
  withMode,
  withoutSubject,
  withSubject,
} from "./accessList";

function entry(overrides: Partial<AccessEntry> & Pick<AccessEntry, "type" | "id">): AccessEntry {
  return { name: overrides.id, mode: "read", guild_id: null, guild_name: null, ...overrides };
}

const org = entry({ type: "org", id: "org_1", name: "Acme" });
const guild = entry({ type: "guild", id: "g_1", name: "Research", mode: "write", guild_id: "g_1" });
const agent = entry({
  type: "agent",
  id: "a_1",
  name: "scout",
  mode: "none",
  guild_id: "g_1",
  guild_name: "Research",
});
const list = [org, guild, agent];

test("the rows sent drop the names the list was read with", () => {
  assert.deepEqual(withoutSubject([org, guild], org), [
    { type: "guild", id: "g_1", mode: "write" },
  ]);
});

test("changing a mode keeps every other row as it is", () => {
  assert.deepEqual(withMode(list, { type: "agent", id: "a_1" }, "write"), [
    { type: "org", id: "org_1", mode: "read" },
    { type: "guild", id: "g_1", mode: "write" },
    { type: "agent", id: "a_1", mode: "write" },
  ]);
});

test("removing a subject keeps a row of another type with the same id", () => {
  const twin = entry({ type: "agent", id: "g_1", mode: "read" });
  assert.deepEqual(withoutSubject([guild, twin], { type: "guild", id: "g_1" }), [
    { type: "agent", id: "g_1", mode: "read" },
  ]);
});

test("adding a subject appends it, and adding one already listed replaces its row", () => {
  assert.deepEqual(withSubject([org], { type: "guild", id: "g_2", mode: "read" }), [
    { type: "org", id: "org_1", mode: "read" },
    { type: "guild", id: "g_2", mode: "read" },
  ]);
  assert.deepEqual(withSubject([org], { type: "org", id: "org_1", mode: "write" }), [
    { type: "org", id: "org_1", mode: "write" },
  ]);
});

test("none falls back to read for the organisation and guilds, and stays for an agent", () => {
  assert.equal(modeForType("org", "none"), "read");
  assert.equal(modeForType("guild", "write"), "write");
  assert.equal(modeForType("agent", "none"), "none");
});

test("candidates leave out listed subjects and empty groups, agents grouped by guild", () => {
  const groups = accessCandidates({
    org: { id: "org_1", name: "Acme" },
    guilds: [
      { id: "g_1", name: "Research" },
      { id: "g_2", name: "Ops" },
    ],
    agentsByGuild: new Map([
      [
        "g_1",
        [
          { id: "a_1", name: "scout" },
          { id: "a_2", name: "scribe" },
        ],
      ],
    ]),
    taken: list,
    ownerAgentId: null,
  });
  assert.deepEqual(
    groups.map((group) => [group.label, group.options.map((option) => option.value)]),
    [
      ["Guilds", ["guild:g_2"]],
      ["Agents · Research", ["agent:a_2"]],
    ],
  );
  assert.equal(findCandidate(groups, "agent:a_2")?.label, "scribe");
  assert.equal(findCandidate(groups, "agent:a_1"), undefined);
});

test("candidates never offer the note's owner agent", () => {
  const groups = accessCandidates({
    org: { id: "org_1", name: "Acme" },
    guilds: [{ id: "g_1", name: "Research" }],
    agentsByGuild: new Map([
      [
        "g_1",
        [
          { id: "a_1", name: "scout" },
          { id: "a_2", name: "scribe" },
        ],
      ],
    ]),
    taken: [org],
    ownerAgentId: "a_2",
  });
  assert.deepEqual(
    groups.map((group) => [group.label, group.options.map((option) => option.value)]),
    [
      ["Guilds", ["guild:g_1"]],
      ["Agents · Research", ["agent:a_1"]],
    ],
  );
});

test("a row's caption says what it covers, an agent's with its guild", () => {
  assert.equal(subjectCaption(org), "Organisation · every agent");
  assert.equal(subjectCaption(guild), "Guild · every agent in it");
  assert.equal(subjectCaption(agent), "Agent · Research");
  assert.equal(subjectCaption({ ...agent, guild_name: null }), "Agent · another guild");
});
