import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../../src/app.js";
import type { ItemAccessChange } from "../../src/artifacts/access-lists.js";
import { operatorActor } from "../../src/artifacts/actors.js";
import { ArtifactFiles } from "../../src/artifacts/files.js";
import { listStateArtifacts, readStateNotes, upsertNote } from "../../src/artifacts/notes.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };
const BYTES = { "content-type": "application/octet-stream" };

/** A note or a file as a page lists it, as far as these tests read it. */
type Listed = { id: string; home: { id: string; name: string } | null; viewer_mode: string };

/** What a guild's or an agent's page lists. */
type Sections = { own: Listed[]; shared: Listed[] };

const dbName = uniqueDbName("agent_platform_home_guild");
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let TEAMMATE: Record<string, string>;
let vaultId: string;
let openId: string;
let keeperId: string;
const accessChanges: Array<[string, ItemAccessChange]> = [];

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-home-guild-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(db, templatesRoot());
  app = await buildApp(database, {
    db,
    notes,
    artifacts,
    files: new ArtifactFiles(artifacts, new MemoryBlobStore()),
    publishItemAccessChanged: async (guildId, change) => {
      accessChanges.push([guildId, change]);
    },
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
  });
  const teammate = await insertUser(db, { userId: "user_teammate_home", name: "teammate-home", image: null, email: "home@example.com" }, new Date());
  await insertMember(db, { org_id: "org_home", user_id: String(teammate.id), role: "member" }, new Date());
  TEAMMATE = { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" };
  vaultId = await createGuild("vault", "private");
  openId = await createGuild("open", "org");
  const keeper = await app.inject({
    method: "POST",
    url: `/api/guilds/${vaultId}/agents`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { name: "keeper", config: { model: TEST_MODEL, browser: false } },
  });
  assert.equal(keeper.statusCode, 201, keeper.body);
  keeperId = String(keeper.json().id);
});

after(async () => {
  await app.close();
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function createGuild(name: string, visibility: string): Promise<string> {
  const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: { ...OWNER, ...JSON_BODY }, payload: { name, visibility } });
  assert.equal(guild.statusCode, 201, guild.body);
  return String(guild.json().id);
}

async function list(url: string, headers: Record<string, string>): Promise<Sections> {
  const listed = await app.inject({ method: "GET", url, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  return listed.json() as Sections;
}

function modesOf(listed: Listed[], ids: string[]): string[][] {
  return listed.filter((item) => ids.includes(item.id)).map((item) => [item.id, item.viewer_mode]);
}

test("a note written with a home lists in its home guild's own section and in other pages' shared section", async () => {
  const homed = await app.inject({
    method: "PUT",
    url: "/api/org/notes/vault-plan.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "kept at home", home_guild_id: vaultId, access: { type: "org", id: "org_home", mode: "read" } },
  });
  assert.equal(homed.statusCode, 200, homed.body);
  const noteId = String(homed.json().id);

  const vaultPage = await list(`/api/guilds/${vaultId}/notes`, OWNER);
  assert.deepEqual(vaultPage.own.filter((item) => item.id === noteId).map((item) => [item.home, item.viewer_mode]), [
    [{ id: vaultId, name: "vault" }, "all_read"],
  ]);
  assert.deepEqual(modesOf(vaultPage.shared, [noteId]), []);
  const keeperPage = await list(`/api/agents/${keeperId}/notes`, OWNER);
  assert.deepEqual(modesOf(keeperPage.own, [noteId]), [[noteId, "read"]]);
  const openPage = await list(`/api/guilds/${openId}/notes`, OWNER);
  assert.deepEqual(modesOf(openPage.shared, [noteId]), [[noteId, "all_read"]]);

  // the member outside the private home guild does not see it, though the organisation row reaches every agent
  assert.deepEqual(modesOf((await list(`/api/guilds/${openId}/notes`, TEAMMATE)).shared, [noteId]), []);
  const memberOrg = (await app.inject({ method: "GET", url: "/api/org/notes", headers: TEAMMATE })).json() as Listed[];
  assert.equal(memberOrg.some((item) => item.id === noteId), false);
  assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/vault-plan.md", headers: TEAMMATE })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/notes/${noteId}/access`, headers: TEAMMATE })).statusCode, 404);
});

test("a note homed in a guild that no row reaches is listed greyed in its own section", async () => {
  const greyed = await app.inject({
    method: "PUT",
    url: "/api/org/notes/open-greyed.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "made on the open page", home_guild_id: openId, access: { type: "agent", id: keeperId, mode: "read" } },
  });
  assert.equal(greyed.statusCode, 200, greyed.body);
  const noteId = String(greyed.json().id);
  assert.deepEqual(modesOf((await list(`/api/guilds/${openId}/notes`, OWNER)).own, [noteId]), [[noteId, "none"]]);
  assert.deepEqual(modesOf((await list(`/api/guilds/${vaultId}/notes`, OWNER)).shared, [noteId]), [[noteId, "some"]]);
});

test("an agent row at none beside an organisation or a guild row tags the guilds of that agent some agents, not all", async () => {
  const write = async (key: string, home: string, subjects: Array<{ type: string; id: string; mode: string }>) => {
    const created = await app.inject({
      method: "PUT",
      url: `/api/org/notes/${key}`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: key, home_guild_id: home },
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = String(created.json().id);
    const listed = await app.inject({ method: "PUT", url: `/api/notes/${id}/access`, headers: { ...OWNER, ...JSON_BODY }, payload: { subjects } });
    assert.equal(listed.statusCode, 200, listed.body);
    return id;
  };
  const orgShut = await write("org-shut.md", openId, [
    { type: "org", id: "org_home", mode: "read" },
    { type: "agent", id: keeperId, mode: "none" },
  ]);
  const guildShut = await write("guild-shut.md", vaultId, [
    { type: "guild", id: vaultId, mode: "write" },
    { type: "agent", id: keeperId, mode: "none" },
  ]);
  const vaultPage = await list(`/api/guilds/${vaultId}/notes`, OWNER);
  assert.deepEqual(modesOf(vaultPage.shared, [orgShut]), [[orgShut, "some"]]);
  assert.deepEqual(modesOf(vaultPage.own, [guildShut]), [[guildShut, "some"]]);
  assert.deepEqual(modesOf((await list(`/api/guilds/${openId}/notes`, OWNER)).own, [orgShut]), [[orgShut, "all_read"]], "no agent of the open guild is shut out");
  const orgList = (await app.inject({ method: "GET", url: "/api/org/notes", headers: OWNER })).json() as Listed[];
  assert.deepEqual(modesOf(orgList, [orgShut, guildShut]), [[guildShut, "some"], [orgShut, "some"]]);
});

test("a blank home on a write or an upload homes the item in the organisation", async () => {
  for (const home of ["", "  "]) {
    const key = `blank-home-${home.length}.md`;
    const note = await app.inject({
      method: "PUT",
      url: `/api/org/notes/${key}`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: "x", home_guild_id: home },
    });
    assert.equal(note.statusCode, 200, note.body);
    const file = await app.inject({
      method: "POST",
      url: "/api/org/files",
      headers: { ...OWNER, ...BYTES, "x-filename": `blank-home-${home.length}.txt`, "x-description": "d", "x-home-guild": home },
      payload: Buffer.from("x"),
    });
    assert.equal(file.statusCode, 201, file.body);
    const homes = await database.pool.query<{ origin_guild_id: string | null }>(
      `SELECT origin_guild_id FROM artifacts WHERE id = ANY($1::text[])`,
      [[String(note.json().id), String(file.json().id)]],
    );
    assert.deepEqual(homes.rows.map((row) => row.origin_guild_id), [null, null]);
  }
});

test("a note or a file whose home guild is gone by its insert is 404 unknown guild", async () => {
  const store = artifactStore(database.pool, templatesRoot());
  const files = new ArtifactFiles(store, new MemoryBlobStore());
  const actor = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator", guildId: "guild_gone_meanwhile" });
  await assert.rejects(
    upsertNote(store, actor, { key: "gone-home.md", title: null, contentText: "x", searchText: null, startingAccess: [] }),
    { message: "unknown guild", status: 404 },
  );
  await assert.rejects(
    files.putFile(actor, { name: "gone-home.txt", description: "d", mime: "", bytes: Buffer.from("x") }),
    { message: "unknown guild", status: 404 },
  );
});

test("a guild's state lists what its page lists, homed or reached by rows, and reads the notes its rows reach", async () => {
  const store = artifactStore(database.pool, templatesRoot());
  const owner = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
  const write = async (key: string, home: string, access: { type: string; id: string; mode: string }) => {
    const created = await app.inject({
      method: "PUT",
      url: `/api/org/notes/${key}`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: key, home_guild_id: home, access },
    });
    assert.equal(created.statusCode, 200, created.body);
    return String(created.json().display_path);
  };
  const homedUnreached = await write("state-homed.md", openId, { type: "agent", id: keeperId, mode: "read" });
  const sharedIn = await write("state-shared.md", vaultId, { type: "guild", id: openId, mode: "read" });
  const elsewhere = await write("state-elsewhere.md", vaultId, { type: "guild", id: vaultId, mode: "read" });
  const listed = (await listStateArtifacts(store, owner, openId)).map((item) => item.display_path);
  assert.deepEqual([homedUnreached, sharedIn, elsewhere].map((path) => listed.includes(path)), [true, true, false]);
  const read = (await readStateNotes(store, owner, openId)).map((note) => note.href);
  assert.deepEqual([homedUnreached, sharedIn].map((path) => read.includes(path)), [false, true], "reading stays by rows");
});

test("a write or an upload whose home names an unknown or hidden guild is 404, and a home is never taken from an update", async () => {
  const hidden = await app.inject({
    method: "PUT",
    url: "/api/org/notes/planted.md",
    headers: { ...TEAMMATE, ...JSON_BODY },
    payload: { content: "x", home_guild_id: vaultId },
  });
  assert.equal(hidden.statusCode, 404, hidden.body);
  assert.deepEqual(hidden.json(), { detail: "unknown guild" });
  const unknown = await app.inject({
    method: "PUT",
    url: "/api/org/notes/planted.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "x", home_guild_id: "guild_missing" },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal((await app.inject({ method: "GET", url: "/api/org/notes/planted.md", headers: OWNER })).statusCode, 404);

  const hiddenUpload = await app.inject({
    method: "POST",
    url: "/api/org/files",
    headers: { ...TEAMMATE, ...BYTES, "x-filename": "planted.txt", "x-description": "d", "x-home-guild": vaultId },
    payload: Buffer.from("x"),
  });
  assert.equal(hiddenUpload.statusCode, 404, hiddenUpload.body);
  assert.deepEqual(hiddenUpload.json(), { detail: "unknown guild" });

  // an update keeps the note's home: moving a home is not possible
  const created = await app.inject({
    method: "PUT",
    url: "/api/org/notes/stays-home.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "first", home_guild_id: openId },
  });
  assert.equal(created.statusCode, 200, created.body);
  const noteId = String(created.json().id);
  const updated = await app.inject({
    method: "PUT",
    url: "/api/org/notes/stays-home.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "second", home_guild_id: vaultId },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(modesOf((await list(`/api/guilds/${openId}/notes`, OWNER)).own, [noteId]), [[noteId, "all_write"]]);
  assert.deepEqual(modesOf((await list(`/api/guilds/${vaultId}/notes`, OWNER)).own, [noteId]), []);
});

test("a file uploaded with a home lists in its home guild's own section, and one homed in a private guild is hidden from outside it", async () => {
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/org/files",
    headers: {
      ...OWNER,
      ...BYTES,
      "x-filename": "vault-ledger.csv",
      "x-description": "The ledger",
      "x-home-guild": vaultId,
      "x-access-type": "org",
      "x-access-id": "org_home",
      "x-access-mode": "read",
    },
    payload: Buffer.from("a,b"),
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const fileId = String(uploaded.json().id);
  const vaultPage = await list(`/api/guilds/${vaultId}/files`, OWNER);
  assert.deepEqual(vaultPage.own.filter((item) => item.id === fileId).map((item) => [item.home, item.viewer_mode]), [
    [{ id: vaultId, name: "vault" }, "all_read"],
  ]);
  assert.deepEqual(modesOf((await list(`/api/agents/${keeperId}/files`, OWNER)).own, [fileId]), [[fileId, "read"]]);
  assert.deepEqual(modesOf((await list(`/api/guilds/${openId}/files`, OWNER)).shared, [fileId]), [[fileId, "all_read"]]);
  assert.deepEqual(modesOf((await list(`/api/guilds/${openId}/files`, TEAMMATE)).shared, [fileId]), []);
  assert.equal((await app.inject({ method: "GET", url: `/api/files/${fileId}`, headers: TEAMMATE })).statusCode, 404);
  const memberFiles = (await app.inject({ method: "GET", url: "/api/org/files", headers: TEAMMATE })).json() as Listed[];
  assert.equal(memberFiles.some((item) => item.id === fileId), false);
});

test("an agent's embeddable notes are its page's two sections, each note with its text and the agent's mode", async () => {
  type Embeddable = Listed & { display_path: string; content: string };
  const sections = await list(`/api/org/embeddable-notes?agent_id=${encodeURIComponent(keeperId)}`, OWNER);
  const own = sections.own as Embeddable[];
  const shared = sections.shared as Embeddable[];
  const plan = own.find((item) => item.display_path === "org/org_home/vault-plan.md");
  assert.deepEqual([plan?.viewer_mode, plan?.content, plan?.home], ["read", "kept at home", { id: vaultId, name: "vault" }]);
  const reached = shared.find((item) => item.display_path === "org/org_home/open-greyed.md");
  assert.deepEqual([reached?.viewer_mode, reached?.content], ["read", "made on the open page"]);
  assert.equal(shared.find((item) => item.display_path === "org/org_home/stays-home.md")?.viewer_mode, "write");

  const hidden = await app.inject({
    method: "GET",
    url: `/api/org/embeddable-notes?agent_id=${encodeURIComponent(keeperId)}`,
    headers: TEAMMATE,
  });
  assert.equal(hidden.statusCode, 404, "an agent of a private guild the caller does not operate is not found");
  const flat = await app.inject({ method: "GET", url: "/api/org/embeddable-notes", headers: OWNER });
  assert.ok(Array.isArray(flat.json()), "without an agent the list stays flat");
});

test("replacing a note's or a file's access list tells the guilds that listed it, the guilds that list it now, and its home guild; a private home alone", async () => {
  const thirdId = await createGuild("third", "org");
  const note = await app.inject({
    method: "PUT",
    url: "/api/org/notes/moving.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "moves between guilds", home_guild_id: vaultId, access: { type: "guild", id: openId, mode: "read" } },
  });
  assert.equal(note.statusCode, 200, note.body);
  accessChanges.length = 0;
  const replaced = await app.inject({
    method: "PUT",
    url: `/api/notes/${String(note.json().id)}/access`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { subjects: [{ type: "guild", id: thirdId, mode: "write" }, { type: "org", id: "org_home", mode: "read" }] },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const change = { kind: "note", displayPath: "org/org_home/moving.md" };
  assert.deepEqual(accessChanges, [[vaultId, change]], "a note homed in a private guild is told to that guild alone, an organisation row or not");

  // A member outside the private guild replaces a list whose hidden row stays: the private guild is told too.
  const shared = await app.inject({
    method: "PUT",
    url: "/api/org/notes/shared-out.md",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content: "shared with the vault", home_guild_id: openId, access: { type: "guild", id: openId, mode: "write" } },
  });
  assert.equal(shared.statusCode, 200, shared.body);
  const sharedId = String(shared.json().id);
  const withVault = await app.inject({
    method: "PUT",
    url: `/api/notes/${sharedId}/access`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { subjects: [{ type: "guild", id: openId, mode: "write" }, { type: "guild", id: vaultId, mode: "read" }] },
  });
  assert.equal(withVault.statusCode, 200, withVault.body);
  accessChanges.length = 0;
  const memberReplaced = await app.inject({
    method: "PUT",
    url: `/api/notes/${sharedId}/access`,
    headers: { ...TEAMMATE, ...JSON_BODY },
    payload: { subjects: [{ type: "guild", id: openId, mode: "write" }, { type: "guild", id: thirdId, mode: "read" }] },
  });
  assert.equal(memberReplaced.statusCode, 200, memberReplaced.body);
  const sharedChange = { kind: "note", displayPath: "org/org_home/shared-out.md" };
  assert.deepEqual(accessChanges, [[openId, sharedChange], [vaultId, sharedChange], [thirdId, sharedChange]]);

  const file = await app.inject({
    method: "POST",
    url: "/api/org/files",
    headers: { ...OWNER, ...BYTES, "x-filename": "moving.txt", "x-description": "d", "x-home-guild": openId },
    payload: Buffer.from("x"),
  });
  assert.equal(file.statusCode, 201, file.body);
  accessChanges.length = 0;
  const fileReplaced = await app.inject({
    method: "PUT",
    url: `/api/files/${String(file.json().id)}/access`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { subjects: [{ type: "guild", id: thirdId, mode: "read" }] },
  });
  assert.equal(fileReplaced.statusCode, 200, fileReplaced.body);
  const fileChange = { kind: "file", displayPath: "org/org_home/files/moving.txt" };
  // the organisation row the upload started with put the file on every guild's page before the change
  assert.deepEqual(
    accessChanges.map(([guildId]) => guildId).sort(),
    [openId, vaultId, thirdId].sort(),
  );
  assert.ok(accessChanges.every(([, item]) => JSON.stringify(item) === JSON.stringify(fileChange)));
});
