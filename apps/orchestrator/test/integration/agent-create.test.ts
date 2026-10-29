import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { addAgent } from "../../src/agents/service.js";
import { getMemoryRow } from "../../src/artifacts/memory.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { taskDisplayPath } from "../../src/artifacts/task.js";
import type { Database } from "../../src/db/client.js";
import { getAgent, markHarnessLogin } from "../../src/db/agents.js";
import { GuildNameTaken } from "../../src/db/errors.js";
import { listFileChanges } from "../../src/db/file-changes.js";
import { addGuild } from "../../src/guilds/service.js";
import { NotesStore } from "../../src/notes/store.js";
import { connect } from "../../src/seed/connect.js";
import { systemActor } from "../helpers/agents.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { agentConfig } from "../helpers/generation.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_agent_create");
const GUILD = "guild_create";
let database: Database;
let notes: NotesStore;

class FailingNotes extends NotesStore {
  override async createAgent(): Promise<void> {
    throw new Error("notes failed");
  }
}

function draftFor(agentId: string, name: string, task: string) {
  return { agent: { agentId, guildId: GUILD, name, config: agentConfig({}), focus: task }, task, placement: {} };
}

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  notes = new NotesStore(tempDir("guilds-agent-create-"), templatesRoot());
  const guild = { guildId: GUILD, name: "desk", orgId: "org_home", creatorUserId: "user_operator" };
  await addGuild({ db: database.pool, notes }, { guild, orgSlug: "home" }, new Date());
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

test("an agent with an artifact store gets its Memory, its task, and no notes folder", async () => {
  const db = database.pool;
  const store = artifactStore(db);
  const actor = systemActor("org_home", { guildId: GUILD, agentId: "a_memory" });
  const created = await addAgent({ db, notes, artifacts: store }, draftFor("a_memory", "keeper", ""), actor, new Date());
  assert.equal(created.name, "keeper");
  assert.equal(created.task, "Assist the user and collaborate with the guild members.\n");
  assert.ok(await getMemoryRow(store, actor, "a_memory"));
  const logged = await listFileChanges(db, "org_home", taskDisplayPath("org_home", "a_memory"));
  assert.deepEqual(logged.map((change) => change.operation), ["create"]);
  assert.equal(existsSync(path.join(notes.root, "orgs", "home", "guilds", "desk", "agents", "keeper")), false);
});

test("an agent without an artifact store gets its notes folder seeded from the draft's task", async () => {
  const db = database.pool;
  const actor = systemActor("org_home", { guildId: GUILD, agentId: "a_folder" });
  const created = await addAgent({ db, notes, artifacts: null }, draftFor("a_folder", "researcher", "read papers"), actor, new Date());
  assert.equal(created.task, "read papers\n");
  const taskFile = path.join(notes.root, "orgs", "home", "guilds", "desk", "agents", "researcher", "task.md");
  assert.equal(readFileSync(taskFile, "utf8"), "read papers\n");
});

test("an agent whose notes folder cannot be made is taken back out", async () => {
  const db = database.pool;
  const failing = new FailingNotes(notes.root, templatesRoot());
  const actor = systemActor("org_home", { guildId: GUILD, agentId: "a_unmade" });
  await assert.rejects(
    addAgent({ db, notes: failing, artifacts: null }, draftFor("a_unmade", "unmade", ""), actor, new Date()),
    /notes failed/,
  );
  assert.equal(await getAgent(db, "a_unmade"), null);
});

test("an agent may not take the name of one of its guild's operators", async () => {
  const db = database.pool;
  const actor = systemActor("org_home", { guildId: GUILD, agentId: "a_operator" });
  await assert.rejects(
    addAgent({ db, notes, artifacts: null }, draftFor("a_operator", "operator", ""), actor, new Date()),
    GuildNameTaken,
  );
  assert.equal(await getAgent(db, "a_operator"), null);
});

test("a harness login found in an agent's home is recorded with when it was seen and whose it is", async () => {
  const db = database.pool;
  const actor = systemActor("org_home", { guildId: GUILD, agentId: "a_login" });
  await addAgent({ db, notes, artifacts: null }, draftFor("a_login", "login", ""), actor, new Date());
  const seen = new Date("2026-03-04T05:06:07.000Z");
  await markHarnessLogin(db, "a_login", { harness: "claude-code", account: "dev@example.com" }, seen);
  const agent = await getAgent(db, "a_login");
  assert.deepEqual(agent?.harness_logins, {
    "claude-code": { seen_at: seen.toISOString(), account: "dev@example.com" },
  });
});
