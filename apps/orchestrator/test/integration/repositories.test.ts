import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { connect, type Database } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { newId } from "../../src/lib/ids.js";
import { listFileChanges, operatorActor } from "../../src/artifacts/index.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

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
    const repo = new Repositories(database.pool);
    const users = await repo.listUsers();
    assert.equal(users[0]?.id, "user_operator");
    assert.equal(users[0]?.name, "operator");
    const created = await repo.insertUser(newId("user"), "other", new Date());
    assert.equal(created.name, "other");
    const listed = await repo.listUsers();
    assert.deepEqual(
      listed.map((row) => row.name),
      ["operator", "other"],
    );
    const orgs = await repo.listOrgsForUser(String(created.id));
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]?.slug, "other");
    assert.equal(orgs[0]?.role, "owner");
    const home = await repo.getMembership("org_home", "user_operator");
    assert.ok(home);
    assert.equal(home.slug, "home");
  });

  test("script catalog persists through the repository", async () => {
    const repo = new Repositories(database.pool);
    await repo.insertGuild("guild_scripts", "scripts-guild", new Date(), "org_home", "");
    await repo.insertAgent(
      "a_scripts",
      "guild_scripts",
      "scripter",
      {
        model: "openrouter/openai/gpt-5.6-luna",
        temperature: 1,
        max_tokens: 8192,
        max_steps: 30,
        max_tool_calls: 50,
        max_input_tokens: 100000,
        browser: false,
      },
      new Date(),
    );
    const scripts = new Scripts(repo);
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

    await repo.writeAgentTask(actor, "a_scripts", "Updated task");
    const taskChanges = await listFileChanges(
      database.pool,
      "org_home",
      "org/org_home/agents/a_scripts/task.md",
    );
    assert.equal(taskChanges[0]?.operation, "update");
    assert.equal((taskChanges[0]?.actor as Record<string, unknown>).id, "user_operator");
  });

  test("insertMessage with assistant usage increments counters", async () => {
    const repo = new Repositories(database.pool);
    const now = new Date("2026-09-15T12:00:00.000Z");
    await repo.insertGuild("guild_usage", "usage-guild", now, "org_home", "");
    await repo.insertAgent(
      "a_usage",
      "guild_usage",
      "counter",
      {
        model: "openrouter/openai/gpt-5.6-luna",
        temperature: 1,
        max_tokens: 8192,
        max_steps: 30,
        max_tool_calls: 50,
        max_input_tokens: 100000,
        browser: false,
      },
      now,
    );
    await repo.createRun("r_usage", "a_usage", {}, "sys", "task", null, now, {
      systemPromptHash: "s",
      taskPromptHash: "t",
      memoryPromptHash: "m",
    });
    const seq = await repo.nextSeq("r_usage");
    await repo.insertMessage(
      "r_usage",
      seq,
      { role: "assistant", content: "hello" },
      {
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
        cost_usd: 0.001,
      },
      now,
    );
    const agentUsage = await repo.getUsage("agent", "a_usage");
    const guildUsage = await repo.getUsage("guild", "guild_usage");
    const orgUsage = await repo.getUsage("org", "org_home");
    const globalUsage = await repo.getUsage("global", "");
    for (const row of [agentUsage, guildUsage, orgUsage, globalUsage]) {
      assert.ok(row);
      assert.equal(Number(row.input_tokens), 10);
      assert.equal(Number(row.output_tokens), 4);
      assert.equal(Number(row.cache_read_tokens), 2);
      assert.equal(Number(row.cost_usd), 0.001);
      assert.equal(Number(row.calls), 1);
    }
    await repo.insertMessage(
      "r_usage",
      seq + 1,
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { tool_name: "note_read" },
      now,
    );
    const afterTool = await repo.getUsage("agent", "a_usage");
    assert.equal(Number(afterTool?.calls), 1);
    await repo.insertMessage(
      "r_usage",
      seq + 2,
      { role: "assistant", content: "again" },
      {
        usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 },
        cost_usd: 0.0005,
      },
      now,
    );
    const stacked = await repo.getUsage("agent", "a_usage");
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
