import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { generationLoop } from "../../src/generation/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { mcpPool } from "../../src/mcp/pool.js";

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
  const db = database.pool;
  const workspaceRoot = tempDir("guilds-group-interrupt-workspaces-");
  const generation = generationLoop(db, {
    mcp: mcpPool(db),
    notes,
    workspaceRoot,
    sandboxes: new ExportSandboxes(workspaceRoot),
  });
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
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
    assert.deepEqual(refused.json().detail[0].loc, ["body", "interrupt"]);
    const numbered = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: 5 },
    });
    assert.equal(numbered.statusCode, 422);
    assert.deepEqual(numbered.json().detail[0].loc, ["body", "content"]);

    const posted = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: "new brief", interrupt: true },
    });
    assert.equal(posted.statusCode, 202);
    assert.equal(posted.json().content, "new brief");
    assert.equal(posted.json().reply_to_seq, null);

    const badReplyType = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: "follow up", reply_to_seq: 0 },
    });
    assert.equal(badReplyType.statusCode, 422);
    assert.deepEqual(badReplyType.json().detail[0].loc, ["body", "reply_to_seq"]);

    const missingReply = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: "follow up", reply_to_seq: 99 },
    });
    assert.equal(missingReply.statusCode, 422);
    assert.equal(missingReply.json().detail, "message 99 not found in this guild");

    const replied = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: OWNER,
      payload: { content: "replying to first", reply_to_seq: Number(posted.json().seq) },
    });
    assert.equal(replied.statusCode, 202);
    assert.equal(replied.json().reply_to_seq, Number(posted.json().seq));

    const state = await app.inject({ method: "GET", url: base, headers: OWNER });
    assert.deepEqual(state.json().active_agents, []);
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
