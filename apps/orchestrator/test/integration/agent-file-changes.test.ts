import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addAgent } from "../../src/agents/persist.js";
import { hashTaskContent, writeAgentTask } from "../../src/agents/task.js";
import { operatorActor } from "../../src/artifacts/actors.js";
import type { Database } from "../../src/db/client.js";
import { insertGuild } from "../../src/db/guilds.js";
import { removeAgentScript, writeAgentScript } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_agent_file_changes");
let database: Database;

const ORG = "org_home";
const GUILD = "guild_changes";
const AGENT = "a_changes";
const ACTOR = operatorActor({ orgId: ORG, actorId: "user_operator", actorName: "operator" });

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  const now = new Date();
  await insertGuild(database.pool, { guildId: GUILD, name: "changes", orgId: ORG }, now);
  await addAgent(database.pool, { agentId: AGENT, guildId: GUILD, name: "scribe", config: {} }, now, ACTOR);
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function changes(): Promise<Array<{ display_path: string; operation: string; version: number }>> {
  const result = await database.pool.query<{ display_path: string; operation: string; version: number }>(
    `SELECT display_path, operation, version FROM file_changes WHERE org_id = $1 ORDER BY created_at, id`,
    [ORG],
  );
  return result.rows;
}

test("an agent's task and scripts log each create, update, and delete", async () => {
  const task = await writeAgentTask(database.pool, ACTOR, AGENT, "Keep the notes tidy.\n");
  assert.equal(task.content_hash, hashTaskContent("Keep the notes tidy.\n"));
  const script = {
    scriptId: "scr_tidy",
    agentId: AGENT,
    name: "tidy",
    description: "Tidies the notes.",
    parameters: null,
    source: "echo tidy",
    sourceHash: "h1",
  };
  await writeAgentScript(database.pool, script, ACTOR, new Date());
  await writeAgentScript(database.pool, { ...script, source: "echo tidier", sourceHash: "h2" }, ACTOR, new Date());
  assert.equal((await removeAgentScript(database.pool, ACTOR, AGENT, "tidy"))?.name, "tidy");
  assert.equal(await removeAgentScript(database.pool, ACTOR, AGENT, "tidy"), null);
  await writeAgentScript(database.pool, { ...script, sourceHash: "h3" }, ACTOR, new Date());
  const logged = (await changes()).map((row) => [row.operation, row.version]);
  assert.deepEqual(logged, [
    ["create", 1],
    ["update", 2],
    ["create", 1],
    ["update", 2],
    ["delete", 2],
    ["create", 3],
  ]);
  const paths = new Set((await changes()).map((row) => row.display_path));
  assert.equal(paths.size, 2);
});
