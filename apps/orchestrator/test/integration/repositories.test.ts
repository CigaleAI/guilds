import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { newId } from "../../src/lib/ids.js";
import { listFileChanges, operatorActor } from "../../src/artifacts/index.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { listUsersInSeedOrder } from "../../src/users/directory.js";
import { getMembership, listOrgsForUser } from "../../src/db/orgs.js";
import { insertGuild } from "../../src/db/guilds.js";
import { addAgent } from "../../src/agents/persist.js";
import { writeAgentTask } from "../../src/db/agents.js";
import { createRun, insertMessage, nextSeq } from "../../src/db/runs.js";
import { getUsage } from "../../src/db/usage.js";

const dbName = uniqueDbName("agent_platform_r2");
let database: Database;

before(async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  database = await connect(databaseUrl);
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

describe("repositories", { concurrency: 1 }, () => {
  test("insert_user creates a personal org and list_users keeps seed order", async () => {
    const db = database.pool;
    const users = await listUsersInSeedOrder(db);
    assert.equal(users[0]?.id, "user_operator");
    assert.equal(users[0]?.name, "operator");
    const created = await insertUser(db, { userId: newId("user"), name: "other" }, new Date());
    assert.equal(created.name, "other");
    const listed = await listUsersInSeedOrder(db);
    assert.deepEqual(
      listed.map((row) => row.name),
      ["operator", "other"],
    );
    const orgs = await listOrgsForUser(db, String(created.id));
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]?.slug, "other");
    assert.equal(orgs[0]?.role, "owner");
    const home = await getMembership(db, "org_home", "user_operator");
    assert.ok(home);
    assert.equal(home.slug, "home");
  });

  test("script catalog persists through the repository", async () => {
    const db = database.pool;
    await insertGuild(db,
      { guildId: "guild_scripts", name: "scripts-guild", orgId: "org_home", about: "" },
      new Date(),
    );
    await addAgent(db,
      {
        agentId: "a_scripts",
        guildId: "guild_scripts",
        name: "scripter",
        config: {
          model: "openrouter/openai/gpt-5.6-luna",
          temperature: 1,
          max_tokens: 8192,
          max_steps: 30,
          max_tool_calls: 50,
          max_input_tokens: 100000,
          browser: false,
        },
      },
      new Date(),
    );
    const scripts = new Scripts(scriptDatabase(db));
    const actor = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_scripts",
      agentId: "a_scripts",
    });
    await scripts.create(actor, "a_scripts", "send_usdc", "Sign and send USDC", "print('ok')\n");
    const row = await scripts.get("a_scripts", "send_usdc");
    assert.equal(row.source, "print('ok')\n");
    assert.equal((await scripts.listForAgent("a_scripts")).length, 1);
    const scriptChanges = await listFileChanges(
      database.pool,
      "org_home",
      "org/org_home/agents/a_scripts/scripts/send_usdc",
    );
    assert.equal(scriptChanges[0]?.operation, "create");
    assert.deepEqual(scriptChanges[0]?.actor, {
      type: "user",
      id: "user_operator",
      name: "operator",
    });

    await writeAgentTask(db, actor, "a_scripts", "Updated task");
    const taskChanges = await listFileChanges(
      database.pool,
      "org_home",
      "org/org_home/agents/a_scripts/task.md",
    );
    assert.equal(taskChanges[0]?.operation, "update");
    assert.equal((taskChanges[0]?.actor as Record<string, unknown>).id, "user_operator");
  });

  test("insertMessage with assistant usage increments counters", async () => {
    const db = database.pool;
    const now = new Date("2026-09-15T12:00:00.000Z");
    await insertGuild(db,
      { guildId: "guild_usage", name: "usage-guild", orgId: "org_home", about: "" },
      now,
    );
    await addAgent(db,
      {
        agentId: "a_usage",
        guildId: "guild_usage",
        name: "counter",
        config: {
          model: "openrouter/openai/gpt-5.6-luna",
          temperature: 1,
          max_tokens: 8192,
          max_steps: 30,
          max_tool_calls: 50,
          max_input_tokens: 100000,
          browser: false,
        },
      },
      now,
    );
    await createRun(db,
      {
        runId: "r_usage",
        agentId: "a_usage",
        configSnapshot: {},
        systemContent: "sys",
        taskContent: "task",
        userContent: null,
        systemPromptHash: "s",
        taskPromptHash: "t",
        memoryPromptHash: "m",
      },
      now,
    );
    const seq = await nextSeq(db, "r_usage");
    await insertMessage(db,
      {
        runId: "r_usage",
        seq,
        payload: { role: "assistant", content: "hello" },
        metadata: {
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
          cost_usd: 0.001,
        },
      },
      now,
    );
    const agentUsage = await getUsage(db, "agent", "a_usage");
    const guildUsage = await getUsage(db, "guild", "guild_usage");
    const orgUsage = await getUsage(db, "org", "org_home");
    const globalUsage = await getUsage(db, "global", "");
    for (const row of [agentUsage, guildUsage, orgUsage, globalUsage]) {
      assert.ok(row);
      assert.equal(Number(row.input_tokens), 10);
      assert.equal(Number(row.output_tokens), 4);
      assert.equal(Number(row.cache_read_tokens), 2);
      assert.equal(Number(row.cost_usd), 0.001);
      assert.equal(Number(row.calls), 1);
    }
    await insertMessage(db,
      {
        runId: "r_usage",
        seq: seq + 1,
        payload: { role: "tool", tool_call_id: "c1", content: "ok" },
        metadata: { tool_name: "note_read" },
      },
      now,
    );
    const afterTool = await getUsage(db, "agent", "a_usage");
    assert.equal(Number(afterTool?.calls), 1);
    await insertMessage(db,
      {
        runId: "r_usage",
        seq: seq + 2,
        payload: { role: "assistant", content: "again" },
        metadata: {
          usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 },
          cost_usd: 0.0005,
        },
      },
      now,
    );
    const stacked = await getUsage(db, "agent", "a_usage");
    assert.equal(Number(stacked?.input_tokens), 11);
    assert.equal(Number(stacked?.output_tokens), 6);
    assert.equal(Number(stacked?.cache_read_tokens), 2);
    assert.equal(Number(stacked?.calls), 2);
    const costs = await database.pool.query(
      `SELECT seq, cost_usd FROM messages WHERE run_id = $1 ORDER BY seq`,
      ["r_usage"],
    );
    assert.deepEqual(
      costs.rows.map((row) => ({
        seq: Number(row.seq),
        cost: row.cost_usd === null ? null : Number(row.cost_usd),
      })),
      [
        { seq: 0, cost: null },
        { seq: 1, cost: 0.001 },
        { seq: 2, cost: null },
        { seq: 3, cost: 0.0005 },
      ],
    );
  });
});
