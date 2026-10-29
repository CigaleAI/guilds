import assert from "node:assert/strict";
import { after, test } from "node:test";
import { addAgent } from "../../src/agents/service.js";
import { systemActor } from "../helpers/agents.js";
import { writeAgentTask } from "../../src/artifacts/task.js";
import { buildApp } from "../../src/app.js";
import { BuilderService } from "../../src/builder/index.js";
import { CapabilityService } from "../../src/capabilities/index.js";
import { generationLive } from "../../src/conversation/runner.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { addGuild } from "../../src/guilds/service.js";
import { recipeApply } from "../../src/recipes/apply.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionReply } from "../helpers/generation.js";
import { limitedPolicy } from "../helpers/policy.js";
import { huskLeadMatcherRecipe, linkedInNotionRecipe } from "../helpers/recipe-docs.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { getGuild, listGuilds } from "../../src/db/guilds.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";
import { getAgentTask, listAgents } from "../../src/db/agents.js";
import { listSchedules } from "../../src/db/schedules.js";
import { listBindingsCovering } from "../../src/db/bindings.js";
import { agentConfig } from "../helpers/generation.js";
import { grantAccess } from "../../src/artifacts/access-lists.js";
import { writeNote } from "../../src/artifacts/notes.js";
import { createCollection } from "../../src/artifacts/collections.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { operatorActor } from "../../src/artifacts/actors.js";

const AUTH = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const CONFIG = agentConfig({
  model: TEST_MODEL,
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
});

const dbName = uniqueDbName("agent_platform_builder");
const originalStream = generationLive.streamCompletion;

after(async () => {
  generationLive.streamCompletion = originalStream;
  await dropIsolatedDatabase(dbName);
});

test("builder, apply, and LinkedIn to Notion", { timeout: 90_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-builder-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const caps = { maxAgents: 25 };
  const policy = limitedPolicy(caps);
  const capabilities = new CapabilityService(db, policy);
  const apply = recipeApply({ db, artifacts, notes, scripts, schedules, policy, registry: null });
  const builder = new BuilderService({ db, capabilities, apply, policy });
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts,
    schedules,
    capabilities,
    apply,
    builder,
  });

  generationLive.streamCompletion = async function* stream() {
    yield ["delta", "Grounding against the catalog."];
    yield ["done", completionReply("I will use a browser watcher and Notion, not a LinkedIn connector.")];
  };

  const now = new Date();
  const guildsBefore = await listGuilds(db, "org_home");

  try {
    const modelless = await app.inject({
      method: "POST",
      url: "/api/builder/sessions",
      headers: AUTH,
      payload: {},
    });
    assert.equal(modelless.statusCode, 422, modelless.body);
    assert.deepEqual(modelless.json(), { detail: "model is required" });
    const textTemperature = await app.inject({
      method: "POST",
      url: "/api/builder/sessions",
      headers: AUTH,
      payload: { model: TEST_MODEL, temperature: "hot" },
    });
    assert.equal(textTemperature.statusCode, 422, textTemperature.body);
    assert.deepEqual(textTemperature.json().detail[0].loc, ["body", "temperature"]);
    const created = await app.inject({
      method: "POST",
      url: "/api/builder/sessions",
      headers: AUTH,
      payload: { model: TEST_MODEL },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json();
    assert.ok(session.id);
    assert.ok(session.recipe_id);
    assert.equal(session.recipe.status, "draft");
    assert.equal(session.recipe.body_version, 1);
    const guildsAfterCreate = await listGuilds(db, "org_home");
    assert.equal(guildsAfterCreate.length, guildsBefore.length);
    const listedSessions = await app.inject({ method: "GET", url: "/api/builder/sessions", headers: AUTH });
    assert.equal(listedSessions.statusCode, 200, listedSessions.body);
    const listedRow = (listedSessions.json() as Array<Record<string, unknown>>).find((row) => row.id === session.id);
    assert.equal((listedRow?.recipe as { name?: string } | undefined)?.name, "Untitled guild");

    const teammate = await insertUser(db, {
        userId: "user_teammate_b",
        name: "teammate-b",
        image: null,
        email: "teammate-b@example.com",
      }, now);
    await insertMember(
      db,
      { org_id: "org_home", user_id: String(teammate.id), role: "member" },
      now,
    );
    const denied = await app.inject({
      method: "GET",
      url: `/api/builder/sessions/${session.id}`,
      headers: { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" },
    });
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(denied.json(), { detail: "builder session not found" });

    const stale = await app.inject({
      method: "PUT",
      url: `/api/builder/sessions/${session.id}/recipe`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { expected_body_version: 0, recipe: linkedInNotionRecipe() },
    });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), {
      detail: { message: "recipe body_version conflict", body_version: 1 },
    });
    const unversioned = await app.inject({
      method: "PUT",
      url: `/api/builder/sessions/${session.id}/recipe`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { recipe: linkedInNotionRecipe() },
    });
    assert.equal(unversioned.statusCode, 422, unversioned.body);
    assert.deepEqual(unversioned.json().detail[0].loc, ["body", "expected_body_version"]);

    const written = await app.inject({
      method: "PUT",
      url: `/api/builder/sessions/${session.id}/recipe`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { expected_body_version: 1, recipe: linkedInNotionRecipe() },
    });
    assert.equal(written.statusCode, 200, written.body);
    assert.equal(written.json().body_version, 2);

    const message = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${session.id}/messages`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { content: "Watch LinkedIn and write new interactors into Notion." },
    });
    assert.equal(message.statusCode, 200, message.body);
    await builder.runner.wait(session.id);
    const messages = await app.inject({
      method: "GET",
      url: `/api/builder/sessions/${session.id}/messages`,
      headers: AUTH,
    });
    assert.ok((messages.json() as unknown[]).length >= 2);
    const stored = await builder.messages(session);
    const system = stored[0]?.payload as { role: string; content: string };
    assert.equal(system.role, "system");
    assert.match(system.content, new RegExp(`"role": "${linkedInNotionRecipe().roles[0]?.role}"`));
    assert.match(system.content, /expected_body_version: 2/);
    assert.doesNotMatch(system.content, /tool_schemas|system_prompt_hash|Recipe write shape/);
    assert.equal((stored[0]?.metadata as { refreshed?: boolean }).refreshed, true);

    const previewDraft = await app.inject({
      method: "POST",
      url: `/api/recipes/${session.recipe_id}/preview`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(previewDraft.statusCode, 200, previewDraft.body);
    const previewBody = previewDraft.json();
    assert.equal((previewBody.errors as unknown[]).length, 0);
    assert.ok((previewBody.creates.agents as Array<{ task: string }>).every((item) => item.task.trim().length > 20));
    assert.equal((previewBody.creates.routines as unknown[]).length, 2);
    assert.ok((previewBody.creates.connections as Array<{ server: string }>).some((item) => item.server === "notion"));

    const published = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${session.id}/publish`,
      headers: AUTH,
    });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().status, "ready");

    const readyRow = await app.inject({
      method: "GET",
      url: `/api/recipes/${session.recipe_id}`,
      headers: AUTH,
    });
    assert.equal(readyRow.statusCode, 200, readyRow.body);
    const rewritten = await app.inject({
      method: "PUT",
      url: `/api/recipes/${session.recipe_id}`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {
        recipe: readyRow.json().body,
        expected_body_version: readyRow.json().body_version,
      },
    });
    assert.equal(rewritten.statusCode, 200, rewritten.body);
    assert.equal(rewritten.json().status, "draft");
    const midApply = await app.inject({
      method: "POST",
      url: `/api/recipes/${session.recipe_id}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(midApply.statusCode, 422, midApply.body);
    const republished = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${session.id}/publish`,
      headers: AUTH,
    });
    assert.equal(republished.statusCode, 200, republished.body);
    assert.equal(republished.json().status, "ready");

    const textNames = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${session.id}/deploy`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { names: "lead" },
    });
    assert.equal(textNames.statusCode, 422, textNames.body);
    assert.deepEqual(textNames.json().detail[0].loc, ["body", "names"]);

    caps.maxAgents = 1;
    const blocked = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${session.id}/deploy`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(blocked.statusCode, 422, blocked.body);
    assert.equal((await listGuilds(db, "org_home")).length, guildsBefore.length);
    caps.maxAgents = 10;

    const deployed = await app.inject({
      method: "POST",
      url: `/api/builder/sessions/${session.id}/deploy`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(deployed.statusCode, 200, deployed.body);
    const applyRow = deployed.json();
    assert.equal(applyRow.status, "checklist");
    assert.ok(applyRow.guild_id);
    const members = await listAgents(db, String(applyRow.guild_id));
    assert.equal(members.length, 2);
    for (const member of members) {
      const rows = await listSchedules(db, String(member.id));
      assert.ok(rows.length);
      assert.ok(rows.every((row) => row.paused === true));
      const task = (await getAgentTask(db, "org_home", String(member.id)))?.content_text ?? "";
      assert.ok(task.trim().length > 20, `${member.name} task`);
    }
    const orgBindings = await listBindingsCovering(db, { orgId: "org_home" });
    assert.equal(
      orgBindings.filter((row) => row.scope === "org" && row.catalog_kind === "mcp").length,
      0,
    );
    const deployedTables = await app.inject({ method: "GET", url: "/api/collections", headers: AUTH });
    assert.equal(deployedTables.statusCode, 200, deployedTables.body);
    const deployedRows = deployedTables.json() as Array<{ id: string; name: string }>;
    const tableNames = deployedRows.map((row) => row.name);
    assert.ok(tableNames.includes("seen-posts") && tableNames.includes("crm-queue"));
    assert.deepEqual(
      (applyRow.plan.collections as Array<{ name: string; action: string }>).map((row) => `${row.name}:${row.action}`).sort(),
      ["crm-queue:create", "seen-posts:create"],
    );
    const watcher = members.find((row) => row.name === "li-watcher");
    assert.ok(watcher);
    const accessModes = async (name: string) => {
      const table = deployedRows.find((row) => row.name === name);
      assert.ok(table);
      const response = await app.inject({ method: "GET", url: `/api/collections/${table.id}/access`, headers: AUTH });
      assert.equal(response.statusCode, 200, response.body);
      const subjects = (response.json() as { subjects: Array<{ type: string; id: string; mode: string }> }).subjects;
      const modeOf = (type: string, id: string) => subjects.find((row) => row.type === type && row.id === id)?.mode;
      return { guild: modeOf("guild", String(applyRow.guild_id)), watcher: modeOf("agent", String(watcher.id)) };
    };
    // The organisation's read row already gives the guild read on a new organisation table.
    assert.deepEqual(await accessModes("seen-posts"), { guild: undefined, watcher: "write" });
    assert.equal((await accessModes("crm-queue")).guild, "write");

    const abort = await app.inject({
      method: "POST",
      url: `/api/applies/${applyRow.id}/abort`,
      headers: AUTH,
    });
    assert.equal(abort.statusCode, 200, abort.body);
    assert.equal((await getGuild(db, String(applyRow.guild_id)))?.id, undefined);
    // Aborting an apply that created its guild also removes the tables it created.
    const abortedTables = await app.inject({ method: "GET", url: "/api/collections", headers: AUTH });
    const abortedNames = (abortedTables.json() as Array<{ name: string }>).map((row) => row.name);
    assert.equal(abortedNames.includes("seen-posts") || abortedNames.includes("crm-queue"), false);

    const huskImported = await app.inject({
      method: "POST",
      url: "/api/recipes/import",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { recipe: huskLeadMatcherRecipe() },
    });
    assert.equal(huskImported.statusCode, 201, huskImported.body);
    const huskId = huskImported.json().id;
    const huskPreview = await app.inject({
      method: "POST",
      url: `/api/recipes/${huskId}/preview`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(huskPreview.statusCode, 200, huskPreview.body);
    const huskPreviewBody = huskPreview.json() as {
      errors: Array<{ code?: string }>;
      unreviewed: string[];
      creates: {
        agents: Array<{ task: string }>;
        routines: Array<{ cron: string }>;
        connections: Array<{ server: string }>;
      };
    };
    assert.match(huskPreviewBody.creates.agents[0]?.task ?? "", /Match Cigale stories/);
    assert.equal(huskPreviewBody.creates.routines.length, 0);
    assert.equal(huskPreviewBody.creates.connections.length, 0);
    assert.ok(huskPreviewBody.unreviewed.length);
    const huskBlocked = await app.inject({
      method: "POST",
      url: `/api/recipes/${huskId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: "husk-lead-matcher" },
    });
    assert.equal(huskBlocked.statusCode, 422, huskBlocked.body);
    const huskPublished = await app.inject({
      method: "POST",
      url: `/api/recipes/${huskId}/publish`,
      headers: AUTH,
    });
    assert.equal(huskPublished.statusCode, 200, huskPublished.body);
    const huskApply = await app.inject({
      method: "POST",
      url: `/api/recipes/${huskId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: "husk-lead-matcher" },
    });
    assert.equal(huskApply.statusCode, 201, huskApply.body);
    const huskGuildId = String(huskApply.json().guild_id);
    const huskMembers = await listAgents(db, huskGuildId);
    assert.equal(huskMembers.length, 1);
    const huskSchedules = await listSchedules(db, String(huskMembers[0]?.id));
    assert.equal(huskSchedules.length, 0);
    const huskTask = (await getAgentTask(db, "org_home", String(huskMembers[0]?.id)))?.content_text ?? "";
    assert.match(huskTask, /Match Cigale stories/);
    const huskAbort = await app.inject({
      method: "POST",
      url: `/api/applies/${huskApply.json().id}/abort`,
      headers: AUTH,
    });
    assert.equal(huskAbort.statusCode, 200, huskAbort.body);

    await addGuild(
      { db, notes },
      {
        guild: { guildId: "guild_capture", name: "capture-src", orgId: "org_home", about: "source", creatorUserId: "user_operator" },
        orgSlug: "home",
      },
      now,
    );
    await addAgent(
      { db, notes, artifacts },
      { agent: { agentId: "a_capture", guildId: "guild_capture", name: "scout", config: CONFIG, focus: "Watch" }, task: "Watch", placement: {} },
      systemActor("org_home", { guildId: "guild_capture", agentId: "a_capture" }),
      now,
    );
    await writeAgentTask(db, operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_capture",
      agentId: "a_capture",
    }), "a_capture", "Ping @scout and keep @user.");
    const captureActor = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_capture",
    });
    await createCollection(artifacts, captureActor, {
      name: "capture-shared",
      purpose: "One record per lead the organisation shares.",
      columns: [{ name: "email", type: "text", description: "the lead's email", required: true, unique: true }],
    });
    const { row: glossary } = await writeNote(artifacts, captureActor, {
      level: "org",
      key: "capture-glossary.md",
      content: "Lead: a person worth a reply.\n",
    });
    await grantAccess(artifacts, captureActor, { kind: "note", id: String(glossary.id) }, { type: "guild", id: "guild_capture", mode: "write" });
    const captured = await app.inject({
      method: "POST",
      url: "/api/guilds/guild_capture/recipes",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { include_notes: ["capture-glossary.md"] },
    });
    assert.equal(captured.statusCode, 201, captured.body);
    const captureBody = JSON.stringify(captured.json());
    assert.equal(captureBody.includes("ciphertext"), false);
    assert.equal(captureBody.includes("oauth_client"), false);
    const capturedRecipe = captured.json().body as {
      version: number;
      roles: Array<{ task: { body: string } }>;
      collections: Array<{ name: string; scope: string; guild: string; writers: string[] }>;
      notes: Array<{ key: string; level: string; guild?: string; writers: string[] }>;
    };
    assert.equal(capturedRecipe.version, 2);
    assert.ok(capturedRecipe.roles[0]?.task.body.includes("@{scout}"));
    // An organisation table reached through the organisation's read row comes along at guild read.
    assert.deepEqual(
      capturedRecipe.collections.map(({ name, scope, guild, writers }) => ({ name, scope, guild, writers })),
      [{ name: "capture-shared", scope: "org", guild: "read", writers: [] }],
    );
    // An organisation note the guild writes keeps the guild's write.
    const capturedGlossary = capturedRecipe.notes.find((note) => note.key === "capture-glossary.md");
    assert.equal(capturedGlossary?.level, "org");
    assert.equal(capturedGlossary?.guild, "write");
    assert.deepEqual(capturedGlossary?.writers, []);

    const imported = await app.inject({
      method: "POST",
      url: "/api/recipes/import",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { recipe: linkedInNotionRecipe() },
    });
    assert.equal(imported.statusCode, 201, imported.body);
    const draftExport = await app.inject({
      method: "GET",
      url: `/api/recipes/${imported.json().id}/export`,
      headers: AUTH,
    });
    assert.equal(draftExport.statusCode, 409);
    assert.deepEqual(draftExport.json(), { detail: "export refused while draft" });
    const staleLibrary = await app.inject({
      method: "PUT",
      url: `/api/recipes/${imported.json().id}`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { expected_body_version: 0, recipe: linkedInNotionRecipe() },
    });
    assert.equal(staleLibrary.statusCode, 409, staleLibrary.body);
    assert.deepEqual(staleLibrary.json(), {
      detail: {
        message: "recipe body_version conflict",
        body_version: imported.json().body_version,
      },
    });

    const listed = await app.inject({ method: "GET", url: "/api/recipes", headers: AUTH });
    assert.ok((listed.json() as unknown[]).length >= 2);

    const search = await app.inject({
      method: "GET",
      url: "/api/builder/capabilities/search?q=notion",
      headers: AUTH,
    });
    assert.equal(search.statusCode, 200);
    assert.ok((search.json().hits as unknown[]).length >= 1);
  } finally {
    await app.close();
    await database.close();
  }
});
