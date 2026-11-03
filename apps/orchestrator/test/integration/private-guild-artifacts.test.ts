import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";
import { deleteAgent } from "../../src/db/agents.js";
import { listConfigChanges } from "../../src/db/config-changes.js";
import { listFileChanges } from "../../src/db/file-changes.js";
import { deleteGuild } from "../../src/db/guilds.js";
import { listWindowConfigChanges, listWindowFileChanges } from "../../src/db/state.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_private_guild_artifacts");
const deletionDbName = uniqueDbName("agent_platform_private_guild_deletion");

after(async () => {
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(deletionDbName);
});

test("organisation-wide note, table, and change routes keep a private guild to its operators", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-private-artifacts-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules: agentSchedules(db) });
  const teammate = await insertUser(db, {
      userId: "user_teammate_vault",
      name: "teammate-vault",
      image: null,
      email: "vault@example.com",
    }, new Date());
  await insertMember(
    db,
    { org_id: "org_home", user_id: String(teammate.id), role: "member" },
    new Date(),
  );
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
    const agentId = String(agent.json().id);
    const note = await app.inject({
      method: "PUT",
      url: "/api/org/notes/plans.md",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: "# Plans\n\nkept in the vault", access: { type: "guild", id: guildId, mode: "write" } },
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
    assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/plans.md", headers: TEAMMATE })).statusCode, 404);
    const memberOrgNotes = await app.inject({ method: "GET", url: "/api/org/notes", headers: TEAMMATE });
    assert.ok(!(memberOrgNotes.json() as Array<{ path: string }>).some((item) => item.path === "plans.md"));
    const memberOverwrite = await app.inject({
      method: "PUT",
      url: "/api/org/notes/plans.md",
      headers: { ...TEAMMATE, ...JSON_BODY },
      payload: { content: "taken over" },
    });
    assert.equal(memberOverwrite.statusCode, 422, "a hidden note is not written over");
    assert.equal((await app.inject({ method: "DELETE", url: "/api/org/notes/plans.md", headers: TEAMMATE })).statusCode, 404);

    // A note whose only row names an agent of the private guild is hidden too; a row outside it, or no row, shows it.
    const keeperNote = await app.inject({
      method: "PUT",
      url: "/api/org/notes/keeper.md",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: "the keeper's", access: { type: "agent", id: agentId, mode: "write" } },
    });
    assert.equal(keeperNote.statusCode, 200, keeperNote.body);
    assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/keeper.md", headers: TEAMMATE })).statusCode, 404);
    const keeperId = String(keeperNote.json().id);
    const opened = await app.inject({
      method: "PUT",
      url: `/api/notes/${keeperId}/access`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { subjects: [{ type: "agent", id: agentId, mode: "write" }, { type: "org", id: "org_home", mode: "read" }] },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const shown = await app.inject({ method: "GET", url: "/api/notes/" + keeperId + "/access", headers: TEAMMATE });
    assert.deepEqual(
      (shown.json() as { subjects: Array<{ type: string }> }).subjects.map((entry) => entry.type),
      ["org"],
      "the private guild's agent row stays out of the list a member reads",
    );
    const emptied = await app.inject({
      method: "PUT",
      url: `/api/notes/${keeperId}/access`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { subjects: [] },
    });
    assert.equal(emptied.statusCode, 200, emptied.body);
    assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/keeper.md", headers: TEAMMATE })).statusCode, 200);

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
    const unlisted = await app.inject({
      method: "POST",
      url: "/api/file-changes/latest",
      headers: { ...TEAMMATE, ...JSON_BODY },
      payload: { display_paths: notePath },
    });
    assert.equal(unlisted.statusCode, 422);
    assert.deepEqual(unlisted.json().detail[0].loc, ["body", "display_paths"]);

    // A name the vault's deleted note held, taken again by a note the member reads, does not open the vault note's history.
    const reused = "/api/org/notes/vault-history.md";
    const vaultNote = await app.inject({
      method: "PUT",
      url: reused,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: "kept in the vault", access: { type: "guild", id: guildId, mode: "write" } },
    });
    assert.equal(vaultNote.statusCode, 200, vaultNote.body);
    assert.equal((await app.inject({ method: "DELETE", url: reused, headers: OWNER })).statusCode, 204);
    const memberNoteAgain = await app.inject({
      method: "PUT",
      url: reused,
      headers: { ...TEAMMATE, ...JSON_BODY },
      payload: { content: "the member's own" },
    });
    assert.equal(memberNoteAgain.statusCode, 200, memberNoteAgain.body);
    const reusedPath = String(memberNoteAgain.json().display_path);
    const history = async (headers: Record<string, string>) =>
      (await app.inject({ method: "GET", url: `/api/file-changes?display_path=${encodeURIComponent(reusedPath)}`, headers })).json() as Array<{
        operation: string;
        actor: { id: string };
      }>;
    assert.deepEqual(
      (await history(TEAMMATE)).map((change) => [change.operation, change.actor.id]),
      [["create", String(teammate.id)]],
      "the member reads its own note's history alone",
    );
    assert.deepEqual(
      (await history(OWNER)).map((change) => change.operation),
      ["create", "delete", "create"],
      "the vault's operator reads both notes' history",
    );
    const memberLatestAgain = await app.inject({
      method: "POST",
      url: "/api/file-changes/latest",
      headers: { ...TEAMMATE, ...JSON_BODY },
      payload: { display_paths: [reusedPath] },
    });
    assert.equal((memberLatestAgain.json() as Record<string, { actor: { id: string } }>)[reusedPath]?.actor.id, String(teammate.id));

    const ownerTable = await app.inject({ method: "GET", url: `/api/collections/${tableId}`, headers: OWNER });
    assert.equal(ownerTable.statusCode, 200);
  } finally {
    await app.close();
    await database.close();
  }
});

test("deleting an agent or a guild removes the rows naming it; a private guild takes the notes only its operators saw, live or deleted, with every change to them, and its agent leaves the notes only it reached homed in the guild", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(deletionDbName));
  const notes = new NotesStore(tempDir("guilds-private-deletion-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules: agentSchedules(db) });
  const teammate = await insertUser(db, { userId: "user_teammate_attic", name: "teammate-attic", image: null, email: "attic@example.com" }, new Date());
  await insertMember(db, { org_id: "org_home", user_id: String(teammate.id), role: "member" }, new Date());
  const TEAMMATE = { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" };
  const opened = new Date(0);

  try {
    const createGuild = async (name: string, visibility: string) => {
      const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: { ...OWNER, ...JSON_BODY }, payload: { name, visibility } });
      assert.equal(guild.statusCode, 201, guild.body);
      return String(guild.json().id);
    };
    const createAgent = async (guildId: string, name: string) => {
      const agent = await app.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/agents`,
        headers: { ...OWNER, ...JSON_BODY },
        payload: { name, config: { model: TEST_MODEL, browser: false } },
      });
      assert.equal(agent.statusCode, 201, agent.body);
      return String(agent.json().id);
    };
    const atticId = await createGuild("attic", "private");
    const porterId = await createAgent(atticId, "porter");
    const hallId = await createGuild("hall", "org");
    const clerkId = await createAgent(hallId, "clerk");
    const galleryId = await createGuild("gallery", "org");
    const quarryId = await createGuild("quarry", "org");

    /** Writes a note homed in `home` as the owner, then replaces its list with `subjects`. */
    const write = async (key: string, home: string, subjects: Array<{ type: string; id: string; mode: string }>) => {
      const created = await app.inject({
        method: "PUT",
        url: `/api/org/notes/${key}`,
        headers: { ...OWNER, ...JSON_BODY },
        payload: { content: `# ${key}`, home_guild_id: home },
      });
      assert.equal(created.statusCode, 200, created.body);
      const id = String(created.json().id);
      const listed = await app.inject({ method: "PUT", url: `/api/notes/${id}/access`, headers: { ...OWNER, ...JSON_BODY }, payload: { subjects } });
      assert.equal(listed.statusCode, 200, listed.body);
      return { id, key, path: String(created.json().display_path) };
    };
    const remove = async (key: string) =>
      assert.equal((await app.inject({ method: "DELETE", url: `/api/org/notes/${key}`, headers: OWNER })).statusCode, 204);
    const history = async (path: string, headers: Record<string, string>) =>
      ((await app.inject({ method: "GET", url: `/api/file-changes?display_path=${encodeURIComponent(path)}`, headers })).json() as Array<{
        operation: string;
      }>).map((change) => change.operation);
    const subjects = async (noteId: string) =>
      (await db.query<{ subject: string }>(
        `SELECT subject_type || ' ' || subject_id AS subject FROM artifact_access
          WHERE target_kind = 'note' AND target_id = $1 ORDER BY subject`,
        [noteId],
      )).rows.map((row) => row.subject);
    const homeOf = async (noteId: string) =>
      (await db.query<{ origin_guild_id: string | null }>(`SELECT origin_guild_id FROM artifacts WHERE id = $1`, [noteId])).rows[0]
        ?.origin_guild_id;
    const pageOf = async (guildId: string) =>
      (await app.inject({ method: "GET", url: `/api/guilds/${guildId}/notes`, headers: OWNER })).json() as {
        own: Array<{ id: string; viewer_mode: string }>;
        shared: Array<{ id: string; viewer_mode: string }>;
      };

    const atticShared = await write("attic-shared.md", atticId, [
      { type: "guild", id: atticId, mode: "write" },
      { type: "org", id: "org_home", mode: "read" },
    ]);
    const atticBare = await write("attic-bare.md", atticId, []);
    const atticPlans = await write("attic-plans.md", atticId, [
      { type: "guild", id: atticId, mode: "write" },
      { type: "agent", id: porterId, mode: "read" },
    ]);
    await remove(atticPlans.key);
    const atticOld = await write("attic-old.md", atticId, [{ type: "org", id: "org_home", mode: "read" }]);
    await remove(atticOld.key);
    const clerkShut = await write("clerk-shut.md", hallId, [{ type: "agent", id: clerkId, mode: "none" }]);
    const clerkLog = await write("clerk-log.md", hallId, [{ type: "agent", id: clerkId, mode: "write" }]);
    await remove(clerkLog.key);
    const forGallery = await write("hall-for-gallery.md", hallId, [{ type: "guild", id: galleryId, mode: "read" }]);
    const atticHomeless = await write("attic-homeless.md", "", [
      { type: "guild", id: atticId, mode: "write" },
      { type: "agent", id: porterId, mode: "read" },
    ]);
    const atticHomelessOld = await write("attic-homeless-old.md", "", [{ type: "guild", id: atticId, mode: "read" }]);
    await remove(atticHomelessOld.key);
    const atticAndOrg = await write("attic-and-org.md", "", [
      { type: "guild", id: atticId, mode: "write" },
      { type: "org", id: "org_home", mode: "read" },
    ]);
    const porterOnly = await write("porter-only.md", "", [{ type: "agent", id: porterId, mode: "write" }]);
    const porterOld = await write("porter-old.md", "", [{ type: "agent", id: porterId, mode: "read" }]);
    await remove(porterOld.key);
    const clerkHomeless = await write("clerk-homeless.md", "", [{ type: "agent", id: clerkId, mode: "write" }]);
    const quarryOpen = await write("quarry-open.md", quarryId, [
      { type: "guild", id: quarryId, mode: "write" },
      { type: "org", id: "org_home", mode: "read" },
    ]);
    assert.deepEqual(await history(atticPlans.path, OWNER), ["delete", "create"]);
    assert.deepEqual(await history(atticPlans.path, TEAMMATE), [], "a private guild's deleted note is hidden while the guild lives");

    await deleteAgent(db, clerkId);
    assert.deepEqual(await subjects(clerkShut.id), [], "the agent's row goes");
    assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/clerk-shut.md", headers: OWNER })).statusCode, 200, "a note the agent was shut out of stays");
    assert.deepEqual((await pageOf(hallId)).own.filter((item) => item.id === clerkShut.id).map((item) => item.viewer_mode), ["none"], "greyed under its home");
    assert.deepEqual(await history(clerkLog.path, OWNER), ["delete", "create"], "a deleted note only the agent reached keeps its history");
    assert.equal(await homeOf(clerkHomeless.id), null, "a public guild's agent leaves the notes only it reached without a home");
    assert.deepEqual(await subjects(clerkHomeless.id), []);

    assert.deepEqual(await history(porterOld.path, TEAMMATE), [], "a deleted note only a private guild's agent reached is hidden by its rows");
    await deleteAgent(db, porterId);
    for (const note of [porterOnly, porterOld]) {
      assert.equal(await homeOf(note.id), atticId, "a private guild's agent leaves the notes only it reached homed in the guild");
      assert.deepEqual(await subjects(note.id), []);
    }
    assert.deepEqual(await subjects(atticHomeless.id), [`guild ${atticId}`], "a note its guild reaches keeps its other rows and no home");
    assert.equal(await homeOf(atticHomeless.id), null);
    assert.deepEqual((await pageOf(atticId)).own.filter((item) => item.id === porterOnly.id).map((item) => item.viewer_mode), ["none"], "listed greyed under its new home");
    assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/porter-only.md", headers: TEAMMATE })).statusCode, 404);
    assert.deepEqual(await history(porterOld.path, TEAMMATE), [], "and its history stays hidden");
    assert.deepEqual(await history(porterOld.path, OWNER), ["delete", "create"]);

    await deleteGuild(db, galleryId);
    assert.deepEqual(await subjects(forGallery.id), [], "the guild's row goes");
    assert.equal(await homeOf(forGallery.id), hallId, "a note homed elsewhere keeps its home");
    assert.deepEqual(
      (await pageOf(hallId)).own.filter((item) => item.id === forGallery.id).map((item) => item.viewer_mode),
      ["none"],
      "a note shared only with the deleted guild stays on its home's page, greyed",
    );

    await deleteGuild(db, quarryId);
    assert.equal(await homeOf(quarryOpen.id), null, "a public guild's note becomes the organisation's");
    assert.deepEqual(await subjects(quarryOpen.id), ["org org_home"]);
    const orgNotes = (await app.inject({ method: "GET", url: "/api/org/notes", headers: TEAMMATE })).json() as Array<{
      id: string;
      home: unknown;
    }>;
    assert.deepEqual(orgNotes.filter((item) => item.id === quarryOpen.id).map((item) => item.home), [null]);

    await deleteGuild(db, atticId);
    assert.equal(await homeOf(atticAndOrg.id), null, "a note with no home and a row outside the guild stays");
    assert.deepEqual(await subjects(atticAndOrg.id), ["org org_home"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/attic-and-org.md", headers: TEAMMATE })).statusCode, 200);
    const gone = [atticShared, atticBare, atticPlans, atticOld, atticHomeless, atticHomelessOld, porterOnly, porterOld];
    for (const headers of [OWNER, TEAMMATE]) {
      for (const note of gone) {
        assert.deepEqual(await history(note.path, headers), []);
        assert.equal((await app.inject({ method: "GET", url: `/api/notes/${note.id}/access`, headers })).statusCode, 404);
        assert.equal((await app.inject({ method: "GET", url: `/api/org/notes/${note.key}`, headers })).statusCode, 404);
      }
      const latest = await app.inject({
        method: "POST",
        url: "/api/file-changes/latest",
        headers: { ...headers, ...JSON_BODY },
        payload: { display_paths: gone.map((note) => note.path) },
      });
      assert.deepEqual(latest.json(), {});
    }
    const removed = gone.map((note) => note.id);
    for (const id of removed) {
      assert.equal(await homeOf(id), undefined, "the note's row is gone");
      assert.deepEqual(await subjects(id), [], "no row of its list is left");
      assert.deepEqual(await listFileChanges(db, "org_home", { artifactIds: [id], taskAgentId: null }), [], "no history is read by the note's id");
      assert.deepEqual(await listConfigChanges(db, "org_home", { kind: "note", id }), [], "no access change is read by the note's id");
    }
    const window = { since: opened, until: new Date() };
    const fileChanges = await listWindowFileChanges(db, "org_home", window);
    assert.deepEqual(fileChanges.filter((change) => removed.includes(change.artifact_id ?? "")), [], "no file change lists a removed note");
    const configChanges = await listWindowConfigChanges(db, "org_home", window);
    assert.deepEqual(configChanges.filter((change) => removed.includes(change.target_id)), [], "no access change lists a removed note");
  } finally {
    await app.close();
    await database.close();
  }
});
