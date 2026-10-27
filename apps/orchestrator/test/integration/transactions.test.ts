import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import { getGuild, insertGuild } from "../../src/db/guilds.js";
import { withTransaction } from "../../src/db/pg.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_transactions");
let database: Database;
const NOW = new Date("2026-10-27T09:00:00.000Z");

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

test("a write that opens its own transaction rolls back with the caller's", async () => {
  await assert.rejects(
    withTransaction(database.pool, async (client) => {
      await insertGuild(client, { guildId: "guild_outer", name: "outer", orgId: "org_home" }, NOW);
      throw new Error("caller fails");
    }),
    /caller fails/,
  );
  assert.equal(await getGuild(database.pool, "guild_outer"), null);
});

test("a nested write that fails leaves the caller's transaction usable", async () => {
  await withTransaction(database.pool, async (client) => {
    await insertGuild(client, { guildId: "guild_kept", name: "kept", orgId: "org_home" }, NOW);
    await assert.rejects(
      insertGuild(client, { guildId: "guild_kept", name: "again", orgId: "org_home" }, NOW),
    );
    await insertGuild(client, { guildId: "guild_after", name: "after", orgId: "org_home" }, NOW);
  });
  assert.equal((await getGuild(database.pool, "guild_kept"))?.name, "kept");
  assert.equal((await getGuild(database.pool, "guild_after"))?.name, "after");
});
