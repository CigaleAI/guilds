import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};
const JSON_HEADERS = { ...OWNER, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_rename");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("guild and agent names can be updated, with uniqueness and notes folders", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const notesRoot = tempDir("guilds-rename-notes-");
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(notesRoot, templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
  });

  try {
    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: JSON_HEADERS,
      payload: { name: "research-desk" },
    });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    const other = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: JSON_HEADERS,
      payload: { name: "ops-desk" },
    });
    assert.equal(other.statusCode, 201, other.body);
    const otherId = String(other.json().id);

    const guildFolder = path.join(notes.root, "orgs", "home", "guilds", "research-desk");
    assert.ok(existsSync(path.join(guildFolder, "shared")));

    const badName = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { name: "Research" },
    });
    assert.equal(badName.statusCode, 422);

    const taken = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { name: "ops-desk" },
    });
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().detail, "guild name already exists");

    const renamedGuild = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { name: "lab-desk", about: "papers" },
    });
    assert.equal(renamedGuild.statusCode, 200, renamedGuild.body);
    assert.equal(renamedGuild.json().name, "lab-desk");
    assert.equal(renamedGuild.json().about, "papers");
    assert.ok(!existsSync(guildFolder));
    assert.ok(existsSync(path.join(notes.root, "orgs", "home", "guilds", "lab-desk", "shared")));

    const sameGuild = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { name: "lab-desk" },
    });
    assert.equal(sameGuild.statusCode, 200, sameGuild.body);
    assert.equal(sameGuild.json().name, "lab-desk");

    const omitted = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}`,
      headers: JSON_HEADERS,
      payload: { about: "weekly synthesis" },
    });
    assert.equal(omitted.statusCode, 200);
    assert.equal(omitted.json().name, "lab-desk");
    assert.equal(omitted.json().about, "weekly synthesis");

    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_HEADERS,
      payload: { name: "researcher", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);
    const sibling = await app.inject({
      method: "POST",
      url: `/api/guilds/${otherId}/agents`,
      headers: JSON_HEADERS,
      payload: { name: "scribe", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(sibling.statusCode, 201, sibling.body);

    await notes.createAgent("home", "lab-desk", "researcher");
    const scratch = path.join(
      notes.root,
      "orgs",
      "home",
      "guilds",
      "lab-desk",
      "agents",
      "researcher",
      "notes",
      "scratch.md",
    );
    writeFileSync(scratch, "scratch");

    const detail = await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: OWNER });
    assert.equal(detail.statusCode, 200, detail.body);
    const config = detail.json().config as Record<string, unknown>;

    const reserved = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: JSON_HEADERS,
      payload: { name: "user", config },
    });
    assert.equal(reserved.statusCode, 422);

    const operatorClash = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: JSON_HEADERS,
      payload: { name: "operator", config },
    });
    assert.equal(operatorClash.statusCode, 409, operatorClash.body);

    const agentTaken = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: JSON_HEADERS,
      payload: { name: "scribe", config },
    });
    assert.equal(agentTaken.statusCode, 409);

    const renamedAgent = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: JSON_HEADERS,
      payload: { name: "analyst", focus: "read papers", config },
    });
    assert.equal(renamedAgent.statusCode, 200, renamedAgent.body);
    assert.equal(renamedAgent.json().name, "analyst");
    assert.equal(renamedAgent.json().focus, "read papers");
    assert.ok(!existsSync(path.dirname(scratch)));
    assert.equal(
      readFileSync(
        path.join(notes.root, "orgs", "home", "guilds", "lab-desk", "agents", "analyst", "notes", "scratch.md"),
        "utf8",
      ),
      "scratch",
    );

    const sameAgent = await app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/config`,
      headers: JSON_HEADERS,
      payload: { name: "analyst", config },
    });
    assert.equal(sameAgent.statusCode, 200, sameAgent.body);
    assert.equal(sameAgent.json().name, "analyst");
  } finally {
    await app.close();
    await database.close();
  }
});
