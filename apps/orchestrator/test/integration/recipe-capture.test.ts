import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { recipeApply } from "../../src/recipes/apply.js";
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

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const TEAMMATE = { "X-Guilds-User": "user_teammate_capture", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_recipe_capture");

let app: FastifyInstance;
let closeDatabase: () => Promise<void>;
let deskId = "";
let vaultId = "";
const paths = { desk: "", vault: "", den: "" };

async function createGuild(name: string, visibility: "org" | "private"): Promise<string> {
  const guild = await app.inject({
    method: "POST",
    url: "/api/guilds",
    headers: { ...OWNER, ...JSON_BODY },
    payload: { name, visibility },
  });
  assert.equal(guild.statusCode, 201, guild.body);
  return String(guild.json().id);
}

/** Writes the organisation's note at `key`, written by the guild alone. */
async function writeGuildNote(guildId: string, key: string, content: string): Promise<string> {
  const note = await app.inject({
    method: "PUT",
    url: `/api/org/notes/${key}`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { content, access: { type: "guild", id: guildId, mode: "write" } },
  });
  assert.equal(note.statusCode, 200, note.body);
  return String(note.json().display_path);
}

/** The keys and bodies of the notes the teammate's capture of the desk carries when it names `includeNotes`. */
async function captureDesk(includeNotes: string[]): Promise<Array<{ key: string; body: string }>> {
  const captured = await app.inject({
    method: "POST",
    url: `/api/guilds/${deskId}/recipes`,
    headers: { ...TEAMMATE, ...JSON_BODY },
    payload: { include_notes: includeNotes },
  });
  assert.equal(captured.statusCode, 201, captured.body);
  const notes: Array<{ key: string; body: string }> = captured.json().body.notes;
  return notes.map(({ key, body }) => ({ key, body }));
}

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  closeDatabase = () => database.close();
  const notes = new NotesStore(tempDir("guilds-recipe-capture-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(db, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const apply = recipeApply({ db, artifacts, notes, scripts, schedules, registry: null });
  app = await buildApp(database, { db, notes, artifacts, scripts, schedules, apply });
  await insertUser(db, { userId: TEAMMATE["X-Guilds-User"], name: "teammate-capture", image: null, email: "capture@example.com" }, new Date());
  await insertMember(
    db,
    { org_id: "org_home", user_id: TEAMMATE["X-Guilds-User"], role: "member" },
    new Date(),
  );

  deskId = await createGuild("desk", "org");
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${deskId}/agents`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { name: "scout", config: { model: TEST_MODEL, browser: false } },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  paths.desk = await writeGuildNote(deskId, "rules.md", "desk rules");

  vaultId = await createGuild("vault", "private");
  const keeper = await app.inject({
    method: "POST",
    url: `/api/guilds/${vaultId}/agents`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { name: "keeper", config: { model: TEST_MODEL, browser: false } },
  });
  assert.equal(keeper.statusCode, 201, keeper.body);
  paths.vault = await writeGuildNote(vaultId, "plans.md", "kept in the vault");

  const denId = await createGuild("den", "private");
  paths.den = await writeGuildNote(denId, "den-plans.md", "kept in the den");
  const invited = await app.inject({
    method: "PUT",
    url: `/api/guilds/${denId}/operators/${TEAMMATE["X-Guilds-User"]}`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { role: "operator" },
  });
  assert.equal(invited.statusCode, 200, invited.body);
});

after(async () => {
  await app.close();
  await closeDatabase();
  await dropIsolatedDatabase(dbName);
});

test("a capture leaves out a note of a private guild the user does not operate, named by display path or by file name", async () => {
  assert.deepEqual(await captureDesk([paths.vault]), []);
  assert.deepEqual(await captureDesk(["plans.md"]), []);
});

test("a capture carries a note of a private guild the user operates", async () => {
  assert.deepEqual(await captureDesk([paths.den]), [{ key: "den-plans.md", body: "kept in the den" }]);
});

test("a capture carries the captured guild's own notes", async () => {
  assert.deepEqual(await captureDesk(["rules.md"]), [{ key: "rules.md", body: "desk rules" }]);
});

test("a recipe captured from a private guild is read, exported, and deleted only by a user who can see that guild", async () => {
  const captured = await app.inject({
    method: "POST",
    url: `/api/guilds/${vaultId}/recipes`,
    headers: { ...OWNER, ...JSON_BODY },
    payload: { include_notes: [paths.vault] },
  });
  assert.equal(captured.statusCode, 201, captured.body);
  const recipeId = String(captured.json().id);
  const listed = async (headers: Record<string, string>) =>
    ((await app.inject({ method: "GET", url: "/api/recipes", headers })).json() as Array<{ id: string }>).some((row) => row.id === recipeId);
  assert.equal(await listed(OWNER), true);
  assert.equal(await listed(TEAMMATE), false);
  // The owner's export of the draft goes past the guild's check to the draft's own refusal.
  for (const [url, ownerStatus] of [[`/api/recipes/${recipeId}`, 200], [`/api/recipes/${recipeId}/export`, 409]] as const) {
    assert.equal((await app.inject({ method: "GET", url, headers: OWNER })).statusCode, ownerStatus, url);
    assert.equal((await app.inject({ method: "GET", url, headers: TEAMMATE })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: "DELETE", url: `/api/recipes/${recipeId}`, headers: TEAMMATE })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/recipes/${recipeId}`, headers: OWNER })).statusCode, 200, "the refused delete left it");
});

test("a recipe is not previewed into a private guild the user does not operate", async () => {
  const captured = await app.inject({ method: "POST", url: `/api/guilds/${deskId}/recipes`, headers: { ...TEAMMATE, ...JSON_BODY }, payload: {} });
  assert.equal(captured.statusCode, 201, captured.body);
  const cellarId = await createGuild("cellar", "private");
  const preview = (headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/api/recipes/${String(captured.json().id)}/preview`,
      headers: { ...headers, ...JSON_BODY },
      payload: { guild_id: cellarId },
    });
  const refused = await preview(TEAMMATE);
  assert.equal(refused.statusCode, 404, refused.body);
  assert.match(refused.body, /destination guild not found/);
  const seen = await preview(OWNER);
  assert.equal(seen.statusCode, 200, seen.body);
  assert.equal(seen.json().guild_id, cellarId);
});
