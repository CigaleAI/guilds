import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_private_guild_artifacts");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("organisation-wide note, table, and change routes keep a private guild to its operators", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-private-artifacts-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules: new Schedules(scheduleDatabase(db)) });
  const teammate = await insertUser(db, {
      userId: "user_teammate_vault",
      name: "teammate-vault",
      image: null,
      email: "vault@example.com",
    }, new Date());
  await insertMember(db, "org_home", String(teammate.id), "member", new Date());
  const TEAMMATE = { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" };

  try {
    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "vault", visibility: "private" },
    });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "keeper", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const note = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}/notes/plans.md`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: "# Plans\n\nkept in the vault" },
    });
    assert.equal(note.statusCode, 200, note.body);
    const notePath = String(note.json().display_path);
    const table = await app.inject({
      method: "POST",
      url: "/api/collections",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "vault_ledger", purpose: "Entries kept in the vault", guild_id: guildId },
    });
    assert.equal(table.statusCode, 201, table.body);
    const tableId = String(table.json().id);

    const ownerNotes = await app.inject({ method: "GET", url: "/api/org/embeddable-notes", headers: OWNER });
    assert.ok((ownerNotes.json() as Array<{ display_path: string }>).some((item) => item.display_path === notePath));
    const ownerTables = await app.inject({ method: "GET", url: "/api/collections", headers: OWNER });
    assert.ok((ownerTables.json() as Array<{ id: string }>).some((item) => item.id === tableId));
    const ownerChanges = await app.inject({
      method: "GET",
      url: `/api/file-changes?display_path=${encodeURIComponent(notePath)}`,
      headers: OWNER,
    });
    assert.equal((ownerChanges.json() as unknown[]).length, 1);

    const memberNotes = await app.inject({ method: "GET", url: "/api/org/embeddable-notes", headers: TEAMMATE });
    assert.equal(memberNotes.statusCode, 200);
    assert.ok(!(memberNotes.json() as Array<{ display_path: string }>).some((item) => item.display_path === notePath));
    const memberNote = await app.inject({
      method: "GET",
      url: `/api/org/embeddable-notes?display_path=${encodeURIComponent(notePath)}`,
      headers: TEAMMATE,
    });
    assert.equal(memberNote.statusCode, 404);

    const memberTables = await app.inject({ method: "GET", url: "/api/collections", headers: TEAMMATE });
    assert.ok(!(memberTables.json() as Array<{ id: string }>).some((item) => item.id === tableId));
    const memberTable = await app.inject({ method: "GET", url: `/api/collections/${tableId}`, headers: TEAMMATE });
    assert.equal(memberTable.statusCode, 404);
    const memberDelete = await app.inject({ method: "DELETE", url: `/api/collections/${tableId}`, headers: TEAMMATE });
    assert.equal(memberDelete.statusCode, 404);
    const memberCreate = await app.inject({
      method: "POST",
      url: "/api/collections",
      headers: { ...TEAMMATE, ...JSON_BODY },
      payload: { name: "planted", purpose: "A table placed in the vault", guild_id: guildId },
    });
    assert.equal(memberCreate.statusCode, 404);

    const memberChanges = await app.inject({
      method: "GET",
      url: `/api/file-changes?display_path=${encodeURIComponent(notePath)}`,
      headers: TEAMMATE,
    });
    assert.deepEqual(memberChanges.json(), []);
    const memberLatest = await app.inject({
      method: "POST",
      url: "/api/file-changes/latest",
      headers: { ...TEAMMATE, ...JSON_BODY },
      payload: { display_paths: [notePath] },
    });
    assert.deepEqual(memberLatest.json(), {});

    const ownerTable = await app.inject({ method: "GET", url: `/api/collections/${tableId}`, headers: OWNER });
    assert.equal(ownerTable.statusCode, 200);
  } finally {
    await app.close();
    await database.close();
  }
});
