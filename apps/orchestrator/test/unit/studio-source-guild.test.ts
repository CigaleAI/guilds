import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRow } from "../../src/db/agents.js";
import type { Queryable } from "../../src/db/pg.js";
import { StudioNotFoundError } from "../../src/studio/errors.js";
import { findGuildAgent, requireGuildAgent } from "../../src/studio/source-guild.js";
import { agentRow } from "../helpers/generation.js";

/** A database whose agents table holds `agents`, read by id. */
function agentsDatabase(agents: AgentRow[]): Queryable {
  return {
    query: async (_text: string, params: unknown[] = []) => ({ rows: agents.filter((agent) => agent.id === params[0]) }),
  } as unknown as Queryable;
}

const db = agentsDatabase([
  agentRow({ id: "a_home", guild_id: "guild_1", org_id: "org_1" }),
  agentRow({ id: "a_far", guild_id: "guild_2", org_id: "org_1" }),
  agentRow({ id: "a_other_org", guild_id: "guild_1", org_id: "org_2" }),
]);

test("find_guild_agent_returns_an_agent_of_the_source_guild_in_the_organisation", async () => {
  assert.equal((await findGuildAgent(db, "guild_1", "org_1", "a_home"))?.id, "a_home");
});

test("find_guild_agent_returns_null_for_an_agent_that_does_not_exist", async () => {
  assert.equal(await findGuildAgent(db, "guild_1", "org_1", "a_gone"), null);
});

test("find_guild_agent_returns_null_for_an_agent_of_another_guild", async () => {
  assert.equal(await findGuildAgent(db, "guild_1", "org_1", "a_far"), null);
});

test("find_guild_agent_returns_null_for_an_agent_of_another_organisation", async () => {
  assert.equal(await findGuildAgent(db, "guild_1", "org_1", "a_other_org"), null);
});

test("require_guild_agent_returns_the_agent_it_finds", async () => {
  assert.equal((await requireGuildAgent(db, "guild_1", "org_1", "a_home")).id, "a_home");
});

test("require_guild_agent_throws_not_found_for_an_agent_outside_the_source_guild", async () => {
  await assert.rejects(requireGuildAgent(db, "guild_1", "org_1", "a_far"), StudioNotFoundError);
});
