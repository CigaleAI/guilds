import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Database } from "../../src/db/client.js";
import { getGuild, insertGuild } from "../../src/db/guilds.js";
import { GuildAgentLimitError } from "../../src/guilds/errors.js";
import { addGuild, assertGuildAgentRoom } from "../../src/guilds/service.js";
import { NotesStore } from "../../src/notes/store.js";
import { connect } from "../../src/seed/connect.js";
import { addTestAgent } from "../helpers/agents.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { agentConfig } from "../helpers/generation.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_guild_create");
let database: Database;

class FailingNotes extends NotesStore {
  override async createGuild(): Promise<void> {
    throw new Error("notes failed");
  }
}

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

test("adding a guild writes its row with its creator as admin and makes its notes folder", async () => {
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-guild-create-"), templatesRoot());
  const created = await addGuild(
    { db, notes },
    {
      guild: {
        guildId: "guild_added",
        name: "research",
        orgId: "org_home",
        about: "weekly synthesis",
        description: "Track papers and post a digest.",
        creatorUserId: "user_operator",
      },
      orgSlug: "home",
    },
    new Date(),
  );
  assert.equal(created.about, "weekly synthesis");
  assert.equal(created.description, "Track papers and post a digest.");
  assert.deepEqual(
    created.operators.map((operator) => [operator.user_id, operator.role]),
    [["user_operator", "admin"]],
  );
  assert.ok(existsSync(path.join(notes.root, "orgs", "home", "guilds", "research")));
});

test("a guild whose notes folder cannot be made is taken back out", async () => {
  const db = database.pool;
  const notes = new FailingNotes(tempDir("guilds-guild-create-failing-"), templatesRoot());
  await assert.rejects(
    addGuild(
      { db, notes },
      { guild: { guildId: "guild_unmade", name: "unmade", orgId: "org_home" }, orgSlug: "home" },
      new Date(),
    ),
    /notes failed/,
  );
  assert.equal(await getGuild(db, "guild_unmade"), null);
});

test("a guild's agent room refuses agents past its limit, and no guild has the default limit", async () => {
  const db = database.pool;
  await insertGuild(db, { guildId: "guild_small", name: "small", orgId: "org_home", maxAgents: 1 }, new Date());
  await assertGuildAgentRoom(db, "guild_small", 1);
  await addTestAgent(db, "org_home", { agentId: "a_small", guildId: "guild_small", name: "only", config: agentConfig({}) });
  await assert.rejects(assertGuildAgentRoom(db, "guild_small", 1), (error: unknown) => {
    assert.ok(error instanceof GuildAgentLimitError);
    assert.equal(error.limit, 1);
    assert.match(error.message, /limited to 1 agents/);
    return true;
  });
  await assertGuildAgentRoom(db, "guild_small", 0);
  await assertGuildAgentRoom(db, null, 15);
  await assert.rejects(assertGuildAgentRoom(db, null, 16), /limited to 15/);
});
