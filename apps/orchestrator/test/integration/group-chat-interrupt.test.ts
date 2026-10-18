import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { GenerationLoop } from "../../src/generation/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};

const dbName = uniqueDbName("agent_platform_group_interrupt");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an operator post may ask to interrupt the runs it targets", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-group-interrupt-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const workspaceRoot = tempDir("guilds-group-interrupt-workspaces-");
  const generation = new GenerationLoop(
    repo,
    notes,
    workspaceRoot,
    new ExportSandboxes(workspaceRoot),
  );
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    generation,
  });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: OWNER,
      payload: { name: "interrupt-room", visibility: "org" },
    });
    assert.equal(created.statusCode, 201);
    const base = `/api/guilds/${String(created.json().id)}/group-chat`;

    const refused = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: "stop", interrupt: "yes" },
    });
    assert.equal(refused.statusCode, 422);

    const posted = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: "new brief", interrupt: true },
    });
    assert.equal(posted.statusCode, 202);
    assert.equal(posted.json().content, "new brief");

    const state = await app.inject({ method: "GET", url: base, headers: OWNER });
    assert.deepEqual(state.json().active_agents, []);
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
