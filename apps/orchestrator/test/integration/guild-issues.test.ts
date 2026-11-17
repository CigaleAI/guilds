import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { ISSUE_OPEN_CAP } from "../../src/issues/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_guild_issues");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a guild's issue list says it is at its open issue cap until one of them is resolved", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-guild-issues-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules: agentSchedules(db) });
  let guildId = "";
  const list = async (query: string) => {
    const response = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/issues${query}`, headers: OWNER });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { issues: Array<{ id: string }>; open_cap: number; at_open_cap: boolean };
  };

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "full-desk", visibility: "org" },
    });
    assert.equal(created.statusCode, 201, created.body);
    guildId = String(created.json().id);

    const fill = (count: number) =>
      db.query(
        `INSERT INTO guild_issues (id, guild_id, org_id, agent_id, agent_name, kind, severity, status, summary, detail, created_at, updated_at)
         SELECT 'iss_fill_' || n, $1, 'org_home', NULL, 'scout', 'other', 'low', 'open', 'filler', 'filler', now(), now()
         FROM generate_series(1, $2::int) AS n`,
        [guildId, count],
      );
    await fill(ISSUE_OPEN_CAP - 1);
    const below = await list("");
    assert.equal(below.issues.length, ISSUE_OPEN_CAP - 1);
    assert.equal(below.open_cap, ISSUE_OPEN_CAP);
    assert.equal(below.at_open_cap, false);

    await db.query(`DELETE FROM guild_issues WHERE guild_id = $1`, [guildId]);
    await fill(ISSUE_OPEN_CAP);
    assert.equal((await list("?status=open")).at_open_cap, true);
    const resolvedOnly = await list("?status=resolved");
    assert.deepEqual(resolvedOnly.issues, []);
    assert.equal(resolvedOnly.at_open_cap, true, "the cap counts the open issues whatever the list shows");

    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/guilds/${guildId}/issues/iss_fill_1`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { status: "resolved" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((await list("")).at_open_cap, false);
  } finally {
    await app.close();
    await database.close();
  }
});
