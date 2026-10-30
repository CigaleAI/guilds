import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeBinding } from "../../src/access/bindings.js";
import { addAgent } from "../../src/agents/service.js";
import { systemActor } from "../helpers/agents.js";
import { writeAgentTask } from "../../src/artifacts/task.js";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import { displayPathFor, ownerPrefix, recordDisplayPath } from "../../src/artifacts/paths.js";
import { getMcpServerBySlug } from "../../src/connectors/servers.js";
import { runItem } from "../../src/db/views.js";
import { mcpDatabase } from "../../src/mcp/database.js";
import type { RemoteCall } from "../../src/mcp/pool.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { StudioService } from "../../src/studio/index.js";
import type { StudioFocusRequest } from "../../src/studio/focus.js";
import { generationLive } from "../../src/studio/runner.js";
import { studioEditAccess, studioGetAgentAccess, studioGetScript } from "../../src/studio/access-tools.js";
import { studioEditCollection, studioGetCollection, studioListCollections } from "../../src/studio/collection-tools.js";
import { studioCallConnectionTool, studioRequestConnectionAccess } from "../../src/studio/connection-tools.js";
import {
  studioEditNote,
  studioFindArtifacts,
  studioGetArtifact,
  studioListFileChanges,
} from "../../src/studio/file-tools.js";
import {
  studioEditGuild,
  studioGetGuild,
  studioListGroupMessages,
  studioListGuilds,
} from "../../src/studio/guild-tools.js";
import {
  studioEditMemory,
  studioGetMemoryVersion,
  studioListMemoryRevisions,
} from "../../src/studio/memory-tools.js";
import { studioGetAgentContext, studioGetGuidelines } from "../../src/studio/prompt-tools.js";
import { studioEditRoutine, studioListRoutines } from "../../src/studio/routine-tools.js";
import { studioGetRun, studioListRuns } from "../../src/studio/run-tools.js";
import { studioCreateTaskDraft, studioListTaskRevisions } from "../../src/studio/task-tools.js";
import type { StudioToolCall, StudioToolDeps } from "../../src/studio/tools.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { newId } from "../../src/lib/ids.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionReply } from "../helpers/generation.js";
import { toolInvocation, toolFixture } from "../helpers/toolbox.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { listConfigChanges } from "../../src/db/config-changes.js";
import { userActor } from "../../src/lib/change-actor.js";
import { scheduleCreateCron, schedulePause } from "../../src/toolbox/schedule.js";
import { getGuild, insertGuild, updateGuild } from "../../src/db/guilds.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";
import { getAgentTask } from "../../src/db/agents.js";
import { postUserGroupMessage } from "../../src/db/group-chat.js";
import { connectMcp, replaceMcpTools } from "../../src/db/mcp.js";
import { createRun, createScheduleRun, getRun } from "../../src/db/runs.js";
import { insertIssue } from "../../src/db/issues.js";
import { getSchedule, listSchedules } from "../../src/db/schedules.js";
import { getConversationMessage, insertConversationMessage, listConversationMessages, nextConversationSeq } from "../../src/db/conversations.js";
import { getStudioDraft, getStudioSession } from "../../src/db/studio.js";
import { userRow } from "../helpers/users.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";
import { getByDisplayPath, writeNote } from "../../src/artifacts/notes.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { createCollection, describeCollection, updateCollection } from "../../src/artifacts/collections.js";
import { grantAccess, listAccess, reachOf } from "../../src/artifacts/access-lists.js";
import { addRecord, listRecords } from "../../src/artifacts/records.js";
import { getMemoryRow, writeMemory } from "../../src/artifacts/memory.js";

const TEST_ACTOR = userActor({ id: "user_operator", name: "operator" });

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

const dbName = uniqueDbName("agent_platform_studio");
const accessDbName = uniqueDbName("agent_platform_studio_access");
const evidenceDbName = uniqueDbName("agent_platform_studio_evidence");
const editsDbName = uniqueDbName("agent_platform_studio_edits");
const tablesDbName = uniqueDbName("agent_platform_studio_tables");
const narrowDbName = uniqueDbName("agent_platform_studio_narrow");
const routinesDbName = uniqueDbName("agent_platform_studio_routines");
const originalStream = generationLive.streamCompletion;

after(async () => {
  generationLive.streamCompletion = originalStream;
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(accessDbName);
  await dropIsolatedDatabase(evidenceDbName);
  await dropIsolatedDatabase(editsDbName);
  await dropIsolatedDatabase(tablesDbName);
  await dropIsolatedDatabase(narrowDbName);
  await dropIsolatedDatabase(routinesDbName);
});

test("studio sessions, inventory, drafts, and authorization", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const studio = new StudioService({
    db,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
  });
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts,
    schedules,
    studio,
  });

  const now = new Date();
  await insertGuild(db,
    {
      guildId: "guild_studio",
      name: "studio-guild",
      orgId: "org_home",
      about: "Optimize this guild",
      description: "Coordinate research and writing across the roster.\n",
    },
    now,
  );
  await insertGuild(db,
    { guildId: "guild_other", name: "other-guild", orgId: "org_home", about: "" },
    now,
  );
  await addAgent(
    { db, notes, artifacts },
    { agent: { agentId: "a_studio", guildId: "guild_studio", name: "writer", config: CONFIG, focus: "Write notes" }, task: "Write notes", placement: {} },
    systemActor("org_home", { guildId: "guild_studio", agentId: "a_studio" }),
    now,
  );
  await addAgent(
    { db, notes, artifacts },
    { agent: { agentId: "a_other", guildId: "guild_other", name: "outsider", config: CONFIG }, task: "", placement: {} },
    systemActor("org_home", { guildId: "guild_other", agentId: "a_other" }),
    now,
  );
  const teammate = await insertUser(db, { userId: "user_teammate", name: "teammate", image: null, email: "teammate@example.com" }, now);
  await insertMember(db, { org_id: "org_home", user_id: String(teammate.id), role: "member" }, now);

  generationLive.streamCompletion = async function* stream() {
    yield ["delta", "Looking at the standing task."];
    yield ["done", completionReply("The current task is short. I would keep the same purpose.")];
  };

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: {
        mode: "optimize",
        source_guild_id: "guild_studio",
        coach_config: { model: TEST_MODEL, temperature: 0.2 },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as {
      id: string;
      coach: { model: string };
      source_guild_id: string;
      source_guild: { about?: string; objective?: string };
    };
    assert.equal(session.source_guild_id, "guild_studio");
    assert.equal(session.coach.model, TEST_MODEL);
    assert.equal(session.source_guild.about, "Optimize this guild");
    assert.match(String(session.source_guild.objective ?? ""), /Coordinate research and writing/);

    const systemMessages = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
    });
    assert.equal(systemMessages.statusCode, 200);
    const systemRow = (systemMessages.json() as Array<{ payload: { role: string; content?: string } }>).find(
      (row) => row.payload.role === "system",
    );
    assert.ok(systemRow);
    assert.match(String(systemRow?.payload.content ?? ""), /source="guild.about"/);
    assert.match(String(systemRow?.payload.content ?? ""), /source="guild.objective"/);
    assert.match(String(systemRow?.payload.content ?? ""), /source="task.excerpt"/);
    assert.match(String(systemRow?.payload.content ?? ""), /Coordinate research and writing/);
    assert.match(String(systemRow?.payload.content ?? ""), /Write notes/);
    assert.match(String(systemRow?.payload.content ?? ""), /a_studio/);
    assert.match(String(systemRow?.payload.content ?? ""), /survey the whole guild/i);

    const denied = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": String(teammate.id).replace("user_", "missing_") },
      payload: {
        mode: "optimize",
        source_guild_id: "guild_studio",
        coach_config: { model: TEST_MODEL, temperature: 0.2 },
      },
    });
    assert.ok([401, 403, 404].includes(denied.statusCode));
    const wordedTemperature = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: {
        mode: "optimize",
        source_guild_id: "guild_studio",
        coach_config: { model: TEST_MODEL, temperature: "warm" },
      },
    });
    assert.equal(wordedTemperature.statusCode, 422, wordedTemperature.body);
    assert.deepEqual(wordedTemperature.json().detail[0].loc, ["body", "coach_config", "temperature"]);
    const unconnectedModel = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: {
        mode: "optimize",
        source_guild_id: "guild_studio",
        coach_config: { model: "xai/grok-4", temperature: 0.2 },
      },
    });
    assert.equal(unconnectedModel.statusCode, 422, unconnectedModel.body);
    assert.match(unconnectedModel.json().detail, /xai/i);

    const inventory = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/inventory`,
      headers: AUTH,
    });
    assert.equal(inventory.statusCode, 200);
    const agents = inventory.json() as Array<{ id: string }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.id, "a_studio");

    const target = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/target`,
      headers: AUTH,
      payload: { agent_id: "a_other" },
    });
    assert.equal(target.statusCode, 422);
    assert.deepEqual(target.json(), { detail: "agent is not in the source guild" });

    const setTarget = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/target`,
      headers: AUTH,
      payload: { agent_id: "a_studio" },
    });
    assert.equal(setTarget.statusCode, 200);
    const numberedTarget = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/target`,
      headers: AUTH,
      payload: { agent_id: 5 },
    });
    assert.equal(numberedTarget.statusCode, 422);
    assert.deepEqual(numberedTarget.json().detail[0].loc, ["body", "agent_id"]);

    const inspector = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/agents/a_studio`,
      headers: AUTH,
    });
    assert.equal(inspector.statusCode, 200);
    const inspect = inspector.json() as { task: { editable: boolean }; memory: { editable: boolean } };
    assert.equal(inspect.task.editable, true);
    assert.equal(inspect.memory.editable, false);

    const posted = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
      payload: { content: "What should change in the standing task?" },
    });
    assert.equal(posted.statusCode, 200);
    const numberedContent = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
      payload: { content: 5 },
    });
    assert.equal(numberedContent.statusCode, 422);
    assert.deepEqual(numberedContent.json().detail[0].loc, ["body", "content"]);
    await studio.runner.wait(session.id);

    const messages = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
    });
    assert.equal(messages.statusCode, 200);
    const rows = messages.json() as Array<{ payload: { role: string } }>;
    assert.ok(rows.some((row) => row.payload.role === "system"));
    assert.ok(rows.some((row) => row.payload.role === "user"));
    assert.ok(rows.some((row) => row.payload.role === "assistant"));

    const liveTask = await getAgentTask(db, "org_home", "a_studio");
    const createdDraft = await studioCreateTaskDraft.handler(
      {
        artifacts,
        db,
        schedules,
        drafts: studio.drafts,
        preview: studio.previewDeps(),
        notesSystemPath: notes.systemPath(),
      },
      {
        session: (await getStudioSession(db, session.id))!,
        user: userRow({ id: "user_operator", name: "operator" }),
        orgId: "org_home",
        sourceGuildId: "guild_studio",
        generation: 1,
      },
      {
        agent_id: "writer",
        proposed_content: "Write concise notes and stop when the artifact exists.\n",
        rationale: "The current task has no completion criteria.",
        evidence_refs: [],
      },
    );
    const draft = createdDraft.draft as Record<string, unknown>;
    assert.equal(draft.status, "draft");
    assert.equal(createdDraft.widget, "studio_task_draft");
    assert.equal(createdDraft.await_operator, true);
    assert.equal(createdDraft.draft_id, draft.id);
    assert.deepEqual(createdDraft.agent, { id: "a_studio", name: "writer" });
    assert.equal(draft.base_version, liveTask?.version);

    const numberedRevision = await app.inject({
      method: "POST",
      url: `/api/studio/drafts/${String(draft.id)}/revise`,
      headers: AUTH,
      payload: { proposed_content: 5 },
    });
    assert.equal(numberedRevision.statusCode, 422);
    assert.deepEqual(numberedRevision.json().detail[0].loc, ["body", "proposed_content"]);

    const published = await app.inject({
      method: "POST",
      url: `/api/studio/drafts/${String(draft.id)}/publish`,
      headers: AUTH,
    });
    assert.equal(published.statusCode, 200, published.body);
    const result = published.json() as { outcome: string };
    assert.equal(result.outcome, "published");

    const after = await getAgentTask(db, "org_home", "a_studio");
    assert.equal(after?.content_text, "Write concise notes and stop when the artifact exists.\n");

    const second = await studio.drafts.createFromTool(
      db,
      {
        session: (await getStudioSession(db, session.id))!,
        user: userRow({ id: "user_operator", name: "operator" }),
        orgId: "org_home",
        sourceGuildId: "guild_studio",
        generation: 1,
      },
      { agent_id: "writer", proposed_content: "Write notes.\n", rationale: "Shorter.", evidence_refs: [] },
    );
    const discarded = await app.inject({
      method: "POST",
      url: `/api/studio/drafts/${String(second.draft_id)}/discard`,
      headers: AUTH,
    });
    assert.equal(discarded.statusCode, 200, discarded.body);
    assert.equal((await getStudioDraft(db, String(second.draft_id)))?.discarded_by_user_id, "user_operator");

    const hostConflict = await app.inject({
      method: "PUT",
      url: "/api/agents/a_studio/notes/task.md",
      headers: AUTH,
      payload: { content: "host overwrite\n", expected_version: 1 },
    });
    assert.equal(hostConflict.statusCode, 409);

    const otherSession = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}`,
      headers: { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" },
    });
    assert.equal(otherSession.statusCode, 404);
    assert.deepEqual(otherSession.json(), { detail: "studio session not found" });

    const orphaned = await studio.drafts.createFromTool(
      db,
      {
        session: (await getStudioSession(db, session.id))!,
        user: userRow({ id: "user_operator", name: "operator" }),
        orgId: "org_home",
        sourceGuildId: "guild_studio",
        generation: 1,
      },
      {
        agent_id: "writer",
        proposed_content: "Write notes and name the artifact.\n",
        rationale: "Names the output.",
        evidence_refs: [],
      },
    );
    await db.query("UPDATE studio_sessions SET created_by_user_id = NULL WHERE id = $1", [session.id]);
    const recovered = await app.inject({
      method: "POST",
      url: `/api/studio/drafts/${String(orphaned.draft_id)}/publish`,
      headers: AUTH,
    });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal((recovered.json() as { outcome: string }).outcome, "published");
    assert.equal(
      (await getAgentTask(db, "org_home", "a_studio"))?.content_text,
      "Write notes and name the artifact.\n",
      "an organisation manager publishes a draft whose session's operator is gone",
    );
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio reads agent access, script source, and granted connections", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(accessDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-access-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const calls: Array<{ remote: string; args: Record<string, unknown> }> = [];
  const mcp = {
    database: mcpDatabase(db),
    async call(_connection: unknown, _server: unknown, call: RemoteCall) {
      calls.push({ remote: call.tool, args: call.arguments });
      return JSON.stringify({ remote: call.tool, echo: call.arguments, leaked: "notion-secret-token" });
    },
  };
  const studio = new StudioService({
    db,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
    mcp,
  });
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts,
    schedules,
    studio,
  });

  const now = new Date();
  await insertGuild(db,
    {
      guildId: "guild_access",
      name: "access-guild",
      orgId: "org_home",
      about: "Guild with a Notion login",
    },
    now,
  );
  await insertGuild(db,
    { guildId: "guild_far", name: "far-guild", orgId: "org_home", about: "" },
    now,
  );
  await addAgent(
    { db, notes, artifacts },
    { agent: { agentId: "a_access", guildId: "guild_access", name: "curator", config: CONFIG, focus: "Curate the database" }, task: "Curate the database", placement: {} },
    systemActor("org_home", { guildId: "guild_access", agentId: "a_access" }),
    now,
  );
  await scripts.create(
    operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_access",
      agentId: "a_access",
    }),
    "a_access",
    "tally",
    "Count rows",
    "print('tally')\n",
  );

  const server = await getMcpServerBySlug(db, "notion");
  assert.ok(server, "seeded Notion catalog row");
  const [ciphertext, nonce] = encryptPayload({ token: "notion-secret-token" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const connection = await connectMcp(db,
    {
      connectionId: newId("conn"),
      bindingId: newId("bind"),
      serverId: String(server.id),
      ownerScope: "org",
      ownerId: "org_home",
      ciphertext,
      nonce,
      status: "connected",
    },
    now,
  );
  await replaceMcpTools(db,
    String(connection.id),
    [
      { remote_name: "notion-search", namespaced_name: "notion_notion-search", description: "Search", input_schema: { type: "object" } },
      { remote_name: "notion-create-pages", namespaced_name: "notion_notion-create-pages", description: "Create", input_schema: { type: "object" } },
    ],
    now,
  );
  const [farCipher, farNonce] = encryptPayload({ token: "far-token" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const farConnection = await connectMcp(db,
    {
      connectionId: newId("conn"),
      bindingId: newId("bind"),
      serverId: String(server.id),
      ownerScope: "guild",
      ownerId: "guild_far",
      ciphertext: farCipher,
      nonce: farNonce,
      status: "connected",
    },
    now,
  );

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: {
        mode: "optimize",
        source_guild_id: "guild_access",
        coach_config: { model: TEST_MODEL, temperature: 0.2 },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string; granted_connection_ids: string[] };
    assert.deepEqual(session.granted_connection_ids, []);

    const toolDeps: StudioToolDeps = {
      artifacts,
      db,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
      mcp,
    };
    const toolContext = async (): Promise<StudioToolCall> => ({
      session: (await getStudioSession(db, session.id))!,
      user: userRow({ id: "user_operator", name: "operator" }),
      orgId: "org_home",
      sourceGuildId: "guild_access",
      generation: 1,
    });

    const access = (await studioGetAgentAccess.handler(toolDeps, await toolContext(), { agent_id: "curator" })) as {
      native_tools: string[];
      scripts: Array<{ name: string }>;
      connections: Array<{ id: string; studio_granted: boolean; studio_readable_tools: string[]; offered_tools: string[] }>;
    };
    assert.ok(access.native_tools.includes("note_get"));
    assert.deepEqual(access.scripts.map((row) => row.name), ["tally"]);
    const seen = access.connections.find((row) => row.id === String(connection.id));
    assert.ok(seen, JSON.stringify(access.connections));
    assert.equal(seen?.studio_granted, false);
    assert.deepEqual(seen?.studio_readable_tools, ["notion_notion-search"]);
    assert.ok(seen?.offered_tools.includes("notion_notion-search"));

    const script = (await studioGetScript.handler(toolDeps, await toolContext(), { agent_id: "a_access", name: "tally" })) as {
      name: string;
      content: string;
    };
    assert.equal(script.name, "tally");
    assert.match(script.content, /source="script"/);
    assert.match(script.content, /print\('tally'\)/);
    await assert.rejects(studioGetScript.handler(toolDeps, await toolContext(), { agent_id: "a_access" }), /\/name: Expected required property/);

    const blocked = (await studioCallConnectionTool.handler(toolDeps, await toolContext(), {
      connection_id: String(connection.id),
      tool: "notion-search",
      arguments: { query: "roadmap" },
    })) as { error?: string };
    assert.equal(blocked.error, "access_required");
    assert.equal(calls.length, 0);
    await assert.rejects(
      studioCallConnectionTool.handler(toolDeps, await toolContext(), { connection_id: String(connection.id), tool: "notion-search", arguments: ["roadmap"] }),
      /\/arguments: Expected object/,
    );
    await assert.rejects(
      studioRequestConnectionAccess.handler(toolDeps, await toolContext(), { connection_id: String(connection.id) }),
      /\/reason: Expected required property/,
    );
    const byAlias = (await studioGetAgentAccess.handler(toolDeps, await toolContext(), { agent: "curator" })) as { agent_id: string };
    assert.equal(byAlias.agent_id, "a_access");

    const requested = (await studioRequestConnectionAccess.handler(toolDeps, await toolContext(), {
      connection_id: String(connection.id),
      reason: "Check the roadmap database schema named in the task.",
    })) as { widget?: string; await_operator?: boolean; granted?: boolean };
    assert.equal(requested.widget, "studio_connection_access");
    assert.equal(requested.await_operator, true);
    assert.equal(requested.granted, false);

    const unreachable = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/connections/${String(farConnection.id)}`,
      headers: AUTH,
      payload: { granted: true },
    });
    assert.equal(unreachable.statusCode, 422, unreachable.body);
    const wordedGrant = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/connections/${String(connection.id)}`,
      headers: AUTH,
      payload: { granted: "no" },
    });
    assert.equal(wordedGrant.statusCode, 422);
    assert.deepEqual(wordedGrant.json().detail[0].loc, ["body", "granted"]);

    const granted = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/connections/${String(connection.id)}`,
      headers: AUTH,
      payload: { granted: true },
    });
    assert.equal(granted.statusCode, 200, granted.body);
    assert.deepEqual((granted.json() as { granted_connection_ids: string[] }).granted_connection_ids, [String(connection.id)]);

    const listed = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/connections`,
      headers: AUTH,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const rows = (listed.json() as { connections: Array<{ id: string; granted: boolean; readable_tools: string[] }> }).connections;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, String(connection.id));
    assert.equal(rows[0]?.granted, true);
    assert.deepEqual(rows[0]?.readable_tools, ["notion_notion-search"]);

    const alreadyGranted = (await studioRequestConnectionAccess.handler(toolDeps, await toolContext(), {
      connection_id: String(connection.id),
      reason: "again",
    })) as { granted?: boolean; widget?: string };
    assert.equal(alreadyGranted.granted, true);
    assert.equal(alreadyGranted.widget, undefined);

    const read = (await studioCallConnectionTool.handler(toolDeps, await toolContext(), {
      connection_id: String(connection.id),
      tool: "notion-search",
      arguments: { query: "roadmap" },
    })) as { tool: string; content: string };
    assert.equal(read.tool, "notion_notion-search");
    assert.deepEqual(calls, [{ remote: "notion-search", args: { query: "roadmap" } }]);
    assert.match(read.content, /source="connection_tool"/);
    assert.match(read.content, /"query":"roadmap"/);
    assert.doesNotMatch(read.content, /notion-secret-token/);
    assert.match(read.content, /\[REDACTED:mcp_/);

    await assert.rejects(
      studioCallConnectionTool.handler(toolDeps, await toolContext(), {
        connection_id: String(connection.id),
        tool: "notion-create-pages",
        arguments: {},
      }),
      /not read-only/,
    );
    assert.equal(calls.length, 1);

    const revoked = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/connections/${String(connection.id)}`,
      headers: AUTH,
      payload: { granted: false },
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.deepEqual((revoked.json() as { granted_connection_ids: string[] }).granted_connection_ids, []);
    const blockedAgain = (await studioCallConnectionTool.handler(toolDeps, await toolContext(), {
      connection_id: String(connection.id),
      tool: "notion-search",
      arguments: {},
    })) as { error?: string };
    assert.equal(blockedAgain.error, "access_required");

    // A login request is answered on its card: the answer and who gave it stay on the request.
    const logged = async (result: Record<string, unknown>): Promise<number> => {
      const seq = await nextConversationSeq(db, "studio", session.id);
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq,
          generation: 1,
          payload: { role: "tool", tool_call_id: `call_${seq}`, content: JSON.stringify(result) },
          metadata: { generation: 1, tool_name: "studio_request_connection_access" },
        },
        new Date(),
      );
      return seq;
    };
    const answer = (seq: number, decision: string) =>
      app.inject({ method: "POST", url: `/api/studio/sessions/${session.id}/logins/${seq}`, headers: AUTH, payload: { decision } });
    const declineSeq = await logged(requested);
    const declined = await answer(declineSeq, "decline");
    assert.equal(declined.statusCode, 200, declined.body);
    assert.deepEqual((declined.json() as { granted_connection_ids: string[] }).granted_connection_ids, []);
    const declinedMeta = (await getConversationMessage(db, "studio", session.id, declineSeq))?.metadata as Record<string, unknown>;
    assert.equal(declinedMeta.access_status, "declined");
    assert.equal(declinedMeta.resolved_by_user_id, "user_operator");
    const regranted = await answer(declineSeq, "grant");
    assert.equal(regranted.statusCode, 409);
    assert.deepEqual(regranted.json(), { detail: "login request is already declined" });
    const grantSeq = await logged(requested);
    assert.equal((await answer(grantSeq, "maybe")).statusCode, 422);
    const undecided = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/logins/${grantSeq}`,
      headers: AUTH,
      payload: {},
    });
    assert.equal(undecided.statusCode, 422);
    assert.deepEqual(undecided.json().detail[0].loc, ["body", "decision"]);
    const grantedByCard = await answer(grantSeq, "grant");
    assert.equal(grantedByCard.statusCode, 200, grantedByCard.body);
    assert.deepEqual((grantedByCard.json() as { granted_connection_ids: string[] }).granted_connection_ids, [String(connection.id)]);
    const grantedMeta = (await getConversationMessage(db, "studio", session.id, grantSeq))?.metadata as Record<string, unknown>;
    assert.equal(grantedMeta.access_status, "granted");
    const systemSeq = Number((await listConversationMessages(db, "studio", session.id))[0]?.seq);
    assert.equal((await answer(systemSeq, "grant")).statusCode, 404);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio inspects the effective prompt, memory timeline, routine runs, file changes, and focus pins", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(evidenceDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-evidence-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const studio = new StudioService({
    db,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
  });
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts,
    schedules,
    studio,
  });

  const now = new Date();
  await insertGuild(db,
    { guildId: "guild_ev", name: "evidence-guild", orgId: "org_home", about: "Evidence" },
    now,
  );
  await addAgent(
    { db, notes, artifacts },
    { agent: { agentId: "a_ev", guildId: "guild_ev", name: "curator", config: CONFIG, focus: "Keep the digest" }, task: "Keep the digest", placement: {} },
    systemActor("org_home", { guildId: "guild_ev", agentId: "a_ev" }),
    now,
  );
  const operator = operatorActor({
    orgId: "org_home",
    actorId: "user_operator",
    actorName: "operator",
    guildId: "guild_ev",
    agentId: "a_ev",
  });
  const { row: shared } = await writeNote(
    artifacts,
    operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_ev",
    }),
    { level: "guild", key: "house-rules.md", content: "Always cite the source.\n", title: "House rules" },
  );
  const sharedPath = `${ownerPrefix("org_home", "guild", "guild_ev")}${shared.key}`;
  await writeAgentTask(db, operator, "a_ev", `Curate the digest.\n\n![[${sharedPath}]]\n`);

  // A routine and one run it woke, then a memory written by that run.
  const routine = await schedules.create(TEST_ACTOR, "a_ev", { when: { cron: "0 9 * * 1" }, description: "Weekly digest", instruction: "Compile the weekly digest." });
  const scheduleId = String(routine.id);
  await createScheduleRun(db,
    {
      runId: "r_ev_wake",
      agentId: "a_ev",
      configSnapshot: runSnapshot(CONFIG),
      systemContent: "system prompt",
      taskContent: "task prompt",
      projected: [
        [
          { role: "user", content: "Schedule wake-up: {}" },
          { generation: 1, source: "schedule", schedule_id: scheduleId, instruction_hash: "h1" },
        ],
        [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_mem",
                type: "function",
                function: { name: "memory_write", arguments: "{}" },
              },
            ],
          },
          { generation: 1 },
        ],
        [
          { role: "tool", tool_call_id: "call_mem", content: "ok" },
          { generation: 1, tool_name: "memory_write", tool_call_id: "call_mem" },
        ],
      ],
      systemPromptHash: "s",
      taskPromptHash: "t",
      memoryPromptHash: "m",
      scheduleId,
      runMetadata: { instruction_hash: "h1" },
    },
    now,
  );
  await createRun(db,
    {
      runId: "r_ev_direct",
      agentId: "a_ev",
      configSnapshot: runSnapshot(CONFIG),
      systemContent: "system prompt",
      taskContent: "task prompt",
      userContent: "hello",
      systemPromptHash: "s",
      taskPromptHash: "t",
      memoryPromptHash: "m",
    },
    now,
  );
  const runActor = {
    ...agentActor({ orgId: "org_home", guildId: "guild_ev", agentId: "a_ev", agentName: "curator", runId: "r_ev_wake" }),
    toolCall: { id: "call_mem", name: "memory_write" },
  };
  await writeMemory(artifacts, operator, "a_ev", { content: "- be brief (operator)\n- nothing yet", detail: "user operator (Files pane)" });
  await writeMemory(artifacts, runActor, "a_ev", { content: "- be brief (operator)\n- digest lives in notes/digest.md\n- send Monday", detail: "run r_ev_wake (schedule wake-up: \"Compile the weekly digest.\")" });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_ev", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };

    // Effective prompt: embeds inlined, section hashes, comparison with the latest run.
    const inspector = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/agents/a_ev`, headers: AUTH });
    assert.equal(inspector.statusCode, 200, inspector.body);
    const inspect = inspector.json() as {
      effective_prompt: { content: string; task_content: string; sections: { task_hash: string }; latest_run: { id: string; task_match: boolean } | null };
      task: { effective_hash: string };
    };
    assert.match(inspect.effective_prompt.task_content, /Always cite the source/);
    assert.match(inspect.effective_prompt.content, /<task>[\s\S]*Always cite the source[\s\S]*<\/task>/);
    assert.match(inspect.effective_prompt.content, /<memory>[\s\S]*digest lives in notes[\s\S]*<\/memory>/);
    assert.equal(inspect.effective_prompt.sections.task_hash, inspect.task.effective_hash);
    assert.ok(inspect.effective_prompt.latest_run);
    assert.equal(inspect.effective_prompt.latest_run?.task_match, false);

    // Runs filtered by routine, and routine counts.
    const wakes = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/agents/a_ev/runs?schedule_id=${scheduleId}`,
      headers: AUTH,
    });
    assert.equal(wakes.statusCode, 200, wakes.body);
    const wakeRows = wakes.json() as Array<{ id: string; schedule_id: string; instruction_hash: string }>;
    assert.deepEqual(wakeRows.map((row) => row.id), ["r_ev_wake"]);
    assert.equal(wakeRows[0]?.schedule_id, scheduleId);
    assert.equal(wakeRows[0]?.instruction_hash, "h1");
    const routines = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/agents/a_ev/routines`, headers: AUTH });
    assert.equal(routines.statusCode, 200, routines.body);
    const routineRows = routines.json() as Array<{ id: string; run_count: number; latest_run: { id: string } | null }>;
    assert.equal(routineRows[0]?.run_count, 1);
    assert.equal(routineRows[0]?.latest_run?.id, "r_ev_wake");
    const wakeView = runItem((await getRun(db, "r_ev_wake"))!, false);
    assert.equal(wakeView.schedule_id, scheduleId);
    assert.equal(wakeView.instruction_hash, "h1");
    const directView = runItem((await getRun(db, "r_ev_direct"))!, false);
    assert.equal("schedule_id" in directView, false);

    // Memory timeline: three versions, the newest written by the wake run with its memory_write call.
    const timeline = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/agents/a_ev/memory-timeline`, headers: AUTH });
    assert.equal(timeline.statusCode, 200, timeline.body);
    const tl = timeline.json() as {
      entries: Array<{ index: number; revision_id: string | null; actor: { type: string; name: string }; run: { id: string; exists: boolean; kind: string; memory_write: { call_id: string } | null } | null; stats: { added: number; removed: number } }>;
    };
    assert.equal(tl.entries.length, 3);
    assert.equal(tl.entries[0]?.revision_id, null);
    assert.equal(tl.entries[0]?.actor.type, "run");
    assert.equal(tl.entries[0]?.run?.id, "r_ev_wake");
    assert.equal(tl.entries[0]?.run?.exists, true);
    assert.equal(tl.entries[0]?.run?.kind, "schedule");
    assert.equal(tl.entries[0]?.run?.memory_write?.call_id, "call_mem");
    assert.ok((tl.entries[0]?.stats.added ?? 0) > 0);
    assert.equal(tl.entries[1]?.actor.name, "operator");
    assert.equal(tl.entries[2]?.actor.type, "unknown");
    const middleRevision = String(tl.entries[1]?.revision_id);

    // File changes carry run facts; the latest endpoint labels several paths at once.
    const memoryPath = "org/org_home/agents/a_ev/memory.md";
    const changes = await app.inject({ method: "GET", url: `/api/file-changes?display_path=${encodeURIComponent(memoryPath)}`, headers: AUTH });
    assert.equal(changes.statusCode, 200, changes.body);
    const changeRows = changes.json() as Array<{ run: { id: string; kind: string; status: string; schedule_id: string } | null; tool: { call_id: string } | null }>;
    assert.equal(changeRows[0]?.run?.kind, "schedule");
    assert.equal(changeRows[0]?.run?.schedule_id, scheduleId);
    assert.equal(changeRows[0]?.tool?.call_id, "call_mem");
    const latest = await app.inject({
      method: "GET",
      url: `/api/file-changes/latest?display_paths=${encodeURIComponent(`${memoryPath},${sharedPath}`)}`,
      headers: AUTH,
    });
    assert.equal(latest.statusCode, 200, latest.body);
    const latestMap = latest.json() as Record<string, { actor: { type: string } }>;
    assert.equal(latestMap[memoryPath]?.actor.type, "run");
    assert.equal(latestMap[sharedPath]?.actor.type, "user");

    // Focus pins: each kind inserts an evidence row before the question; foreign ids are refused.
    const evidenceSession = (await getStudioSession(db, session.id))!;
    const toolDeps: StudioToolDeps = {
      artifacts,
      db,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    };
    const toolCtx = (): StudioToolCall => ({
      session: evidenceSession,
      user: userRow({ id: "user_operator", name: "operator" }),
      orgId: "org_home",
      sourceGuildId: "guild_ev",
      generation: 1,
    });
    const sessionRow = async () => (await getStudioSession(db, session.id))!;
    const issue = await insertIssue(db,
      {
        issueId: "iss_ev",
        guildId: "guild_ev",
        orgId: "org_home",
        agentId: "a_ev",
        agentName: "curator",
        runId: "r_ev_wake",
        kind: "api",
        severity: "high",
        summary: "Digest feed returned 401",
        detail: "The feed login expired while compiling the weekly digest.",
        toolName: "feed_fetch",
      },
      now,
    );
    const pins: StudioFocusRequest[] = [
      { kind: "run", run_id: "r_ev_wake", call_id: "call_mem" },
      { kind: "memory_version", agent_id: "a_ev", revision_id: middleRevision },
      { kind: "routine", agent_id: "a_ev", schedule_id: scheduleId },
      { kind: "file", display_path: sharedPath },
      { kind: "issue", issue_id: issue.id },
    ];
    for (const pin of pins) {
      const before = (await listConversationMessages(db, "studio", session.id)).length;
      await studio.postMessage(await sessionRow(), userRow({ id: "user_operator", name: "operator" }), `Question about ${String(pin.kind)}`, pin);
      await studio.runner.wait(session.id);
      const rows = await listConversationMessages(db, "studio", session.id);
      const focusRow = rows[before] as unknown as { payload: { role: string; content: string }; metadata: { source: string; focus: { kind: string; label: string } } };
      const question = rows[before + 1] as unknown as { payload: { content: string }; metadata: { source: string } };
      assert.equal(focusRow.metadata.source, "studio_focus");
      assert.equal(focusRow.metadata.focus.kind, pin.kind);
      assert.ok(focusRow.metadata.focus.label);
      assert.match(focusRow.payload.content, new RegExp(`source="studio.focus.${String(pin.kind)}"`));
      assert.equal(question.metadata.source, "ui");
      assert.equal(question.payload.content, `Question about ${String(pin.kind)}`);
    }
    const focusRows = (await listConversationMessages(db, "studio", session.id)).filter((row) => (row.metadata as { source?: string }).source === "studio_focus");
    assert.match(String((focusRows[0]?.payload as { content: string }).content), /memory_write/);
    assert.match(String((focusRows[1]?.payload as { content: string }).content), /Written by: user operator/);
    assert.match(String((focusRows[1]?.payload as { content: string }).content), /written_at="\d{4}-\d{2}-\d{2}T/);
    assert.match(String((focusRows[2]?.payload as { content: string }).content), /Compile the weekly digest/);
    assert.match(String((focusRows[3]?.payload as { content: string }).content), /Always cite the source/);
    const issuePin = focusRows[4] as unknown as { payload: { content: string }; metadata: { focus: { run_id: string; agent_id: string; issue_id: string } } };
    assert.match(issuePin.payload.content, /Digest feed returned 401/);
    assert.match(issuePin.payload.content, /studio_get_run\(run_id="r_ev_wake", tool_name="report_issue"\)/);
    assert.equal(issuePin.metadata.focus.issue_id, "iss_ev");
    assert.equal(issuePin.metadata.focus.run_id, "r_ev_wake");
    assert.equal(issuePin.metadata.focus.agent_id, "a_ev");

    await insertGuild(db,
      { guildId: "guild_far", name: "far-guild", orgId: "org_home", about: "" },
      now,
    );
    await addAgent(
      { db, notes, artifacts },
      { agent: { agentId: "a_far", guildId: "guild_far", name: "stranger", config: CONFIG }, task: "", placement: {} },
      systemActor("org_home", { guildId: "guild_far", agentId: "a_far" }),
      now,
    );
    await createRun(db,
      {
        runId: "r_far",
        agentId: "a_far",
        configSnapshot: runSnapshot(CONFIG),
        systemContent: "system",
        taskContent: "task",
        userContent: "hi",
        systemPromptHash: "s",
        taskPromptHash: "t",
        memoryPromptHash: "m",
      },
      now,
    );
    const foreign = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
      payload: { content: "Why?", focus: { kind: "run", run_id: "r_far" } },
    });
    assert.equal(foreign.statusCode, 422, foreign.body);
    await insertIssue(db,
      {
        issueId: "iss_far",
        guildId: "guild_far",
        orgId: "org_home",
        agentId: "a_far",
        agentName: "stranger",
        runId: "r_far",
        kind: "other",
        severity: "low",
        summary: "Elsewhere",
        detail: "Not this guild.",
        toolName: null,
      },
      now,
    );
    const foreignIssue = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
      payload: { content: "Why?", focus: { kind: "issue", issue_id: "iss_far" } },
    });
    assert.equal(foreignIssue.statusCode, 422, foreignIssue.body);
    const badKind = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
      payload: { content: "Why?", focus: { kind: "draft" } },
    });
    assert.equal(badKind.statusCode, 422, badKind.body);

    // A pinned question can start a new session that records its parent.
    const child = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_ev", coach_config: { model: TEST_MODEL, temperature: 0.2 }, parent_session_id: session.id },
    });
    assert.equal(child.statusCode, 200, child.body);
    assert.equal((child.json() as { parent_session_id: string }).parent_session_id, session.id);
    const orphanParent = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_ev", coach_config: { model: TEST_MODEL, temperature: 0.2 }, parent_session_id: "stu_missing" },
    });
    assert.equal(orphanParent.statusCode, 404);

    // Coach tools over the same evidence.
    const listed = await studioListMemoryRevisions.handler(toolDeps, toolCtx(), { agent_id: "curator" });
    const versions = listed.versions as Array<{ version_index: number; revision_id: string | null; run_id: string | null }>;
    assert.equal(versions.length, 3);
    assert.equal(versions[0]?.run_id, "r_ev_wake");
    const version = await studioGetMemoryVersion.handler(toolDeps, toolCtx(), { agent_id: "curator", revision_id: middleRevision });
    assert.match(String(version.content), /nothing yet/);
    assert.match(String(version.diff_from_previous), /be brief \(operator\)/);
    const liveVersion = await studioGetMemoryVersion.handler(toolDeps, toolCtx(), { agent_id: "curator" });
    assert.equal(liveVersion.live, true);
    assert.match(String(liveVersion.diff_from_previous), /\+ - send Monday/);
    const runList = await studioListRuns.handler(toolDeps, toolCtx(), { agent_id: "curator", schedule_id: scheduleId });
    assert.deepEqual((runList.runs as Array<{ id: string }>).map((row) => row.id), ["r_ev_wake"]);
    const routineList = await studioListRoutines.handler(toolDeps, toolCtx(), { agent_id: "curator" });
    assert.equal((routineList.routines as Array<{ run_count: number }>)[0]?.run_count, 1);
    const memoryCall = await studioGetRun.handler(toolDeps, toolCtx(), { run_id: "r_ev_wake", tool_name: "memory_write" });
    assert.equal(memoryCall.matched, 2);
    const fileChanges = await studioListFileChanges.handler(toolDeps, toolCtx(), { display_path: memoryPath });
    assert.equal((fileChanges.changes as Array<{ run: { id: string } | null }>)[0]?.run?.id, "r_ev_wake");
    await assert.rejects(studioListFileChanges.handler(toolDeps, toolCtx(), { display_path: "org/org_home/agents/a_far/memory.md" }), /not in the source guild/);
    const context = await studioGetAgentContext.handler(toolDeps, toolCtx(), { agent_id: "curator", sections: ["effective_prompt"] });
    assert.match(String((context.effective_prompt as { content: string }).content), /Always cite the source/);

    // Each tool decodes its arguments against its schema before it reads them.
    const byName = await studioListRuns.handler(toolDeps, toolCtx(), { agent_name: "curator", schedule_id: scheduleId, cursor: null });
    assert.deepEqual((byName.runs as Array<{ id: string }>).map((row) => row.id), ["r_ev_wake"]);
    const window = await studioGetRun.handler(toolDeps, toolCtx(), { run_id: "r_ev_wake", seq_start: 0, seq_end: 1 });
    assert.deepEqual((window.messages as Array<{ seq: number }>).map((row) => row.seq), [0, 1]);
    const paused = await studioListRoutines.handler(toolDeps, toolCtx(), { paused: true });
    assert.deepEqual(paused.routines, []);
    await assert.rejects(studioGetRun.handler(toolDeps, toolCtx(), { run_id: 5 }), /^StudioUnprocessableError: \/run_id: Expected string$/);
    await assert.rejects(studioListRoutines.handler(toolDeps, toolCtx(), { limit: "5" }), /\/limit: Expected integer/);
    await assert.rejects(studioGetAgentContext.handler(toolDeps, toolCtx(), { sections: ["task"] }), /\/agent_id: Expected required property/);
    await postUserGroupMessage(
      db,
      { guildId: "guild_ev", content: "Ship the digest on Monday.", taggedNames: [], taggedAgentIds: [], taggedUserIds: [], authorName: "operator", authorUserId: "user_operator" },
      now,
    );
    const fromOperator = await studioListGroupMessages.handler(toolDeps, toolCtx(), { author_handle: "operator", limit: 5 });
    assert.match(String((fromOperator.messages as Array<{ content: string }>)[0]?.content), /Ship the digest on Monday/);
    const fromAgents = await studioListGroupMessages.handler(toolDeps, toolCtx(), { author_type: "agent" });
    assert.deepEqual(fromAgents.messages, []);
    const taskRevisions = await studioListTaskRevisions.handler(toolDeps, toolCtx(), { agent: "curator", limit: 1 });
    assert.match(String((taskRevisions.revisions as Array<{ content: string }>)[0]?.content), /Keep the digest/);
    const oldest = await studioGetMemoryVersion.handler(toolDeps, toolCtx(), { agent_id: "curator", version_index: versions[2]?.version_index });
    assert.equal(oldest.version_index, versions[2]?.version_index);
    const firstPage = await studioListMemoryRevisions.handler(toolDeps, toolCtx(), { agent_id: "curator", limit: 1 });
    assert.equal((firstPage.versions as unknown[]).length, 1);
    assert.equal(firstPage.next_cursor, "1");
    await assert.rejects(studioGetMemoryVersion.handler(toolDeps, toolCtx(), { agent_id: "curator", version_index: "1" }), /\/version_index: Expected integer/);
    await assert.rejects(studioListGroupMessages.handler(toolDeps, toolCtx(), { author_type: 3 }), /\/author_type: Expected string/);
    const found = await studioFindArtifacts.handler(toolDeps, toolCtx(), { query: "cite", level: "guild", limit: 5 });
    assert.deepEqual((found.artifacts as Array<{ display_path: string }>).map((item) => item.display_path), [sharedPath]);
    const houseRules = await studioGetArtifact.handler(toolDeps, toolCtx(), { display_path: sharedPath, cursor: "0" });
    assert.match(String(houseRules.content), /Always cite the source/);
    const firstChange = await studioListFileChanges.handler(toolDeps, toolCtx(), { display_path: memoryPath, limit: 1 });
    assert.equal((firstChange.changes as unknown[]).length, 1);
    await assert.rejects(studioFindArtifacts.handler(toolDeps, toolCtx(), { query: ["cite"] }), /\/query: Expected string/);
    await assert.rejects(studioGetArtifact.handler(toolDeps, toolCtx(), {}), /\/display_path: Expected required property/);
    const guidelines = await studioGetGuidelines.handler(toolDeps, toolCtx(), {});
    assert.equal(guidelines.editable, false);
    assert.match(String(guidelines.content), /source="guidelines"/);
    await assert.rejects(
      studioCreateTaskDraft.handler(toolDeps, toolCtx(), { agent_id: "curator", proposed_content: "Curate.\n", rationale: "r", risks: "none" }),
      /\/risks: Expected array/,
    );
    await assert.rejects(studioListGuilds.handler(toolDeps, toolCtx(), { cursor: 0 }), /\/cursor: Expected string/);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio proposes memory, note, and guild edits that the operator applies or declines", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(editsDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-edits-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const studio = new StudioService({ db, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await insertGuild(db,
    {
      guildId: "guild_ed",
      name: "edit-guild",
      orgId: "org_home",
      about: "Old about",
      description: "Old description.\n",
    },
    now,
  );
  await addAgent(
    { db, notes, artifacts },
    { agent: { agentId: "a_ed", guildId: "guild_ed", name: "curator", config: CONFIG, focus: "Keep the digest" }, task: "Keep the digest", placement: {} },
    systemActor("org_home", { guildId: "guild_ed", agentId: "a_ed" }),
    now,
  );
  const operator = operatorActor({
    orgId: "org_home",
    actorId: "user_operator",
    actorName: "operator",
    guildId: "guild_ed",
    agentId: "a_ed",
  });
  await writeMemory(artifacts, operator, "a_ed", { content: "- be brief\n- digest in notes\n- nothing yet", detail: "seed" });
  const { row: note } = await writeNote(
    artifacts,
    operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_ed",
    }),
    { level: "guild", key: "house-rules.md", content: "Always cite.\n", title: "House rules" },
  );
  const notePath = `${ownerPrefix("org_home", "guild", "guild_ed")}${note.key}`;

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_ed", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };
    const toolDeps: StudioToolDeps = {
      artifacts,
      db,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    };
    const ctx = async (): Promise<StudioToolCall> => ({
      session: (await getStudioSession(db, session.id))!,
      user: userRow({ id: "user_operator", name: "operator" }),
      orgId: "org_home",
      sourceGuildId: "guild_ed",
      generation: 1,
    });
    // Store the call and its result the way the runner commits them.
    const commit = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>): Promise<number> => {
      const seq = await nextConversationSeq(db, "studio", session.id);
      const id = `call_${seq}`;
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq,
          generation: 1,
          payload: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          metadata: { generation: 1 },
        },
        new Date(),
      );
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq: seq + 1,
          generation: 1,
          payload: { role: "tool", tool_call_id: id, content: JSON.stringify({ tool_message_seq: seq + 1, ...result }) },
          metadata: { generation: 1, tool_name: name },
        },
        new Date(),
      );
      return seq + 1;
    };
    const resolve = (seq: number, decision: string) =>
      app.inject({ method: "POST", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH, payload: { decision } });

    // Guild: read the live text, propose, apply.
    const guild = (await studioGetGuild.handler(toolDeps, await ctx(), {})) as { about: string; description: string };
    assert.match(guild.about, /Old about/);
    assert.match(guild.description, /Old description/);
    const guildArgs = { description: "Coordinate the digest.", reason: "The description names no outcome." };
    const guildEdit = (await studioEditGuild.handler(toolDeps, await ctx(), guildArgs)) as {
      widget: string;
      await_operator: boolean;
      edit: { fields: string[] };
    };
    assert.equal(guildEdit.widget, "studio_edit_request");
    assert.equal(guildEdit.await_operator, true);
    assert.deepEqual(guildEdit.edit.fields, ["description"]);
    assert.equal(String((await getGuild(db, "guild_ed"))?.description).trim(), "Old description.");
    const guildSeq = await commit("studio_edit_guild", guildArgs, guildEdit);
    const guildView = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${guildSeq}`, headers: AUTH });
    assert.equal(guildView.statusCode, 200, guildView.body);
    const guildBody = guildView.json() as { status: string; stale: boolean; proposed: { about: string; description: string } };
    assert.equal(guildBody.status, "pending");
    assert.equal(guildBody.stale, false);
    assert.deepEqual(guildBody.proposed, { about: "Old about", description: "Coordinate the digest." });
    const applied = await resolve(guildSeq, "apply");
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal((applied.json() as { status: string }).status, "applied");
    const liveGuild = await getGuild(db, "guild_ed");
    assert.equal(liveGuild?.description, "Coordinate the digest.");
    assert.equal(liveGuild?.about, "Old about");
    assert.equal((await getStudioSession(db, session.id))?.source_guild_snapshot.objective, "Coordinate the digest.");
    const [guildChange] = await listConfigChanges(db, "org_home", { kind: "guild_text", id: "guild_ed" });
    assert.equal(guildChange?.summary, "Changed the description");
    assert.deepEqual(guildChange?.actor, { type: "user", id: "user_operator", name: "operator" });
    assert.deepEqual(guildChange?.studio, { session_id: session.id, seq: guildSeq });
    assert.equal((await resolve(guildSeq, "apply")).statusCode, 409);

    // Memory: a stale base_version is refused; a current one pauses, and apply writes as the operator.
    const memory = await getMemoryRow(artifacts, operator, "a_ed");
    await assert.rejects(
      studioEditMemory.handler(toolDeps, await ctx(), { agent_id: "curator", content: "x", base_version: Number(memory?.version) - 1, reason: "r" }),
      /stale/,
    );
    await assert.rejects(
      studioEditMemory.handler(toolDeps, await ctx(), { agent_id: "curator", content: "x", base_version: String(memory?.version), reason: "r" }),
      /\/base_version: Expected integer/,
    );
    await assert.rejects(studioEditGuild.handler(toolDeps, await ctx(), { about: "New about" }), /\/reason: Expected required property/);
    const memoryArgs = {
      agent_id: "curator",
      content: "- be brief\n- digest in notes/digest.md\n- nothing yet",
      base_version: Number(memory?.version),
      reason: "Memory names the wrong digest path.",
    };
    const memoryEdit = (await studioEditMemory.handler(toolDeps, await ctx(), memoryArgs)) as Record<string, unknown>;
    const memorySeq = await commit("studio_edit_memory", memoryArgs, memoryEdit);
    const memoryApplied = await resolve(memorySeq, "apply");
    assert.equal(memoryApplied.statusCode, 200, memoryApplied.body);
    assert.equal((memoryApplied.json() as { applied_version: number }).applied_version, Number(memory?.version) + 1);
    assert.match((await getMemoryRow(artifacts, operator, "a_ed"))?.content_text ?? "", /notes\/digest\.md/);
    const memoryPath = displayPathFor({ orgId: "org_home", level: "agent", ownerId: "a_ed", kind: "memory", path: "", key: "memory.md" });
    const memoryChanges = (await studioListFileChanges.handler(toolDeps, await ctx(), { display_path: memoryPath })) as {
      changes: Array<{ actor: { type: string; name: string }; tool: { name: string } | null; studio: unknown }>;
    };
    assert.equal(memoryChanges.changes[0]?.actor.type, "user");
    assert.deepEqual(memoryChanges.changes[0]?.studio, { session_id: session.id, seq: memorySeq });
    assert.equal(memoryChanges.changes[0]?.tool?.name, "studio_edit_memory");
    const revisions = (await studioListMemoryRevisions.handler(toolDeps, await ctx(), { agent_id: "a_ed" })) as { versions: unknown[] };
    assert.ok(revisions.versions.length >= 2);

    // Memory: an agent without a Memory row is edited from an empty Memory at version 0.
    await addAgent(
      { db, notes, artifacts },
      { agent: { agentId: "a_blank", guildId: "guild_ed", name: "blank", config: CONFIG, focus: "Start fresh" }, task: "Start fresh", placement: {} },
      systemActor("org_home", { guildId: "guild_ed", agentId: "a_blank" }),
      now,
    );
    await db.query("DELETE FROM artifacts WHERE agent_id = $1 AND kind = 'memory'", ["a_blank"]);
    const blankArgs = { agent_id: "blank", content: "- first entry", base_version: 0, reason: "Memory is empty." };
    const blankEdit = (await studioEditMemory.handler(toolDeps, await ctx(), blankArgs)) as { edit: { base_version: number } };
    assert.equal(blankEdit.edit.base_version, 0);
    const blankApplied = await resolve(await commit("studio_edit_memory", blankArgs, blankEdit), "apply");
    assert.equal(blankApplied.statusCode, 200, blankApplied.body);
    assert.equal((await getMemoryRow(artifacts, operator, "a_blank"))?.content_text, "- first entry");

    // Note: a proposal goes stale when the note changes underneath it; declining leaves the note alone.
    const noteArgs = { action: "edit", display_path: notePath, content: "Always cite the source URL.\n", base_version: note.version, reason: "Rule is vague." };
    const noteEdit = (await studioEditNote.handler(toolDeps, await ctx(), noteArgs)) as Record<string, unknown>;
    const noteSeq = await commit("studio_edit_note", noteArgs, noteEdit);
    await writeNote(
      artifacts,
      operatorActor({
        orgId: "org_home",
        actorId: "user_operator",
        actorName: "operator",
        guildId: "guild_ed",
      }),
      { level: "guild", key: "house-rules.md", content: "Always cite, twice.\n", title: "House rules" },
    );
    const staleView = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${noteSeq}`, headers: AUTH });
    assert.equal((staleView.json() as { stale: boolean }).stale, true);
    assert.equal((await resolve(noteSeq, "apply")).statusCode, 409);
    const declined = await resolve(noteSeq, "decline");
    assert.equal(declined.statusCode, 200, declined.body);
    assert.equal((declined.json() as { status: string }).status, "declined");
    const liveNote = await getByDisplayPath(artifacts, operator, notePath);
    assert.equal(liveNote.row?.content_text, "Always cite, twice.\n");

    // Note: a current proposal applies as the operator, at the next version, and keeps the note's title.
    const currentArgs = { ...noteArgs, base_version: liveNote.row?.version };
    const currentEdit = (await studioEditNote.handler(toolDeps, await ctx(), currentArgs)) as Record<string, unknown>;
    const currentApplied = await resolve(await commit("studio_edit_note", currentArgs, currentEdit), "apply");
    assert.equal(currentApplied.statusCode, 200, currentApplied.body);
    assert.equal((currentApplied.json() as { applied_version: number }).applied_version, Number(liveNote.row?.version) + 1);
    const appliedNote = await getByDisplayPath(artifacts, operator, notePath);
    assert.equal(appliedNote.row?.content_text, "Always cite the source URL.\n");
    assert.equal(appliedNote.row?.title, "House rules");

    // Memory is not a note, and a tool message that is not an edit request cannot be resolved.
    await assert.rejects(
      studioEditNote.handler(toolDeps, await ctx(), { action: "edit", display_path: memoryPath, content: "x", base_version: 1, reason: "r" }),
      /studio_edit_memory/,
    );
    assert.equal((await resolve(memorySeq - 1, "apply")).statusCode, 404);
    assert.equal((await resolve(memorySeq, "maybe")).statusCode, 422);
    const undecided = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/edits/${memorySeq}`,
      headers: AUTH,
      payload: {},
    });
    assert.equal(undecided.statusCode, 422);
    assert.deepEqual(undecided.json().detail[0].loc, ["body", "decision"]);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio proposes tables to create, change, and delete that the operator applies or declines", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(tablesDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-tables-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const studio = new StudioService({ db, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await insertGuild(db, { guildId: "guild_tb", name: "table-guild", orgId: "org_home" }, now);
  await insertGuild(db,
    {
      guildId: "guild_nb",
      name: "neighbour-guild",
      orgId: "org_home",
      about: "Closes the books.",
      visibility: "org",
      creatorUserId: null,
      description: "Writes the monthly report to the shared table.",
    },
    now,
  );
  await insertGuild(db,
    {
      guildId: "guild_pv",
      name: "private-guild",
      orgId: "org_home",
      about: "Unseen.",
      visibility: "private",
      creatorUserId: null,
      description: "Not for this operator.",
    },
    now,
  );
  for (const [agentId, guildId, name] of [
    ["a_scout", "guild_tb", "scout"],
    ["a_writer", "guild_tb", "writer"],
    ["a_nb", "guild_nb", "neighbour"],
    ["a_pv", "guild_pv", "hidden-agent"],
  ] as const) {
    await addAgent(
      { db, notes, artifacts },
      { agent: { agentId, guildId, name, config: CONFIG, focus: "Keep the tables" }, task: "Keep the tables", placement: {} },
      systemActor("org_home", { guildId, agentId }),
      now,
    );
  }
  const operator = operatorActor({
    orgId: "org_home",
    actorId: "user_operator",
    actorName: "operator",
  });
  const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, description: `The ${name}.`, ...extra });
  const shared = await createCollection(artifacts, operator, { name: "shared", purpose: "Shared facts.", columns: [column("fact", "text")] });
  await grantAccess(artifacts, operator, { kind: "collection", id: shared.id }, { type: "guild", id: "guild_nb", mode: "read" });
  await grantAccess(artifacts, operator, { kind: "collection", id: shared.id }, { type: "guild", id: "guild_pv", mode: "read" });
  await createCollection(artifacts, operator, {
    name: "their-queue",
    purpose: "The neighbour's queue.",
    columns: [column("item", "text")],
    guildId: "guild_nb",
  });
  const theirRecord = await addRecord(artifacts, operator, { collection: "their-queue", body: { item: "private work" } });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_tb", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };
    const toolDeps: StudioToolDeps = {
      artifacts,
      db,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    };
    const ctx = async (): Promise<StudioToolCall> => ({
      session: (await getStudioSession(db, session.id))!,
      user: userRow({ id: "user_operator", name: "operator" }),
      orgId: "org_home",
      sourceGuildId: "guild_tb",
      generation: 1,
    });
    const commit = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>): Promise<number> => {
      const seq = await nextConversationSeq(db, "studio", session.id);
      const id = `call_${seq}`;
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq,
          generation: 1,
          payload: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          metadata: { generation: 1 },
        },
        new Date(),
      );
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq: seq + 1,
          generation: 1,
          payload: { role: "tool", tool_call_id: id, content: JSON.stringify({ tool_message_seq: seq + 1, ...result }) },
          metadata: { generation: 1, tool_name: name },
        },
        new Date(),
      );
      return seq + 1;
    };
    const view = async (seq: number) =>
      (await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH })).json() as {
        status: string;
        stale: boolean;
        live: string | null;
        proposed: string | null;
        effects: string[];
        error?: string;
      };
    const resolve = (seq: number, decision: string) =>
      app.inject({ method: "POST", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH, payload: { decision } });
    type Widget = { widget: string; await_operator: boolean; edit: { kind: string; action: string; target: { collection_id: string | null }; effects: string[] } };

    // Other guilds: the ones the operator sees, with their about and description; a private guild they do not operate is left out.
    const guilds = (await studioListGuilds.handler(toolDeps, await ctx(), {})) as {
      guilds: Array<{ guild_id: string; about: string; description: string }>;
    };
    assert.deepEqual(guilds.guilds.map((item) => item.guild_id), ["guild_nb"]);
    assert.match(guilds.guilds[0]?.about ?? "", /Closes the books\./);
    assert.match(guilds.guilds[0]?.description ?? "", /trust="untrusted"[\s\S]*monthly report/);

    // The source guild's own tables and the organisation's are listed; another guild's own table is out of reach.
    const listed = (await studioListCollections.handler(toolDeps, await ctx(), {})) as {
      collections: Array<{ name: string; studio_can: string; guild_access: string | null }>;
    };
    assert.deepEqual(
      listed.collections.map((item) => [item.name, item.studio_can]),
      [["shared", "add_columns_and_access"]],
    );
    await assert.rejects(studioGetCollection.handler(toolDeps, await ctx(), { collection: "their-queue" }), /unknown table/);
    await assert.rejects(studioGetCollection.handler(toolDeps, await ctx(), { collection: 7 }), /\/collection: Expected string/);
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), { action: "create", name: "leads", purpose: "p", columns: "email", reason: "r" }),
      /\/columns: Expected array/,
    );
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), {
        action: "edit",
        collection: "their-queue",
        base_updated_at: "x",
        purpose: "Mine now.",
        reason: "r",
      }),
      /unknown table/,
    );
    await assert.rejects(studioEditCollection.handler(toolDeps, await ctx(), { action: "delete", collection: "their-queue", reason: "r" }), /unknown table/);
    const theirPath = recordDisplayPath("org_home", "their-queue", String(theirRecord.record.id));
    await assert.rejects(studioGetArtifact.handler(toolDeps, await ctx(), { display_path: theirPath }), /not in the source guild/);
    await assert.rejects(studioListFileChanges.handler(toolDeps, await ctx(), { display_path: theirPath }), /not in the source guild/);
    await assert.rejects(
      studioGetArtifact.handler(toolDeps, await ctx(), { display_path: String(shared.display_path) }),
      /studio_get_collection/,
    );

    // Create: nothing is written until the operator applies; the guild owns the table.
    const createArgs = {
      action: "create",
      name: "leads",
      purpose: "One lead per company the scout finds.",
      columns: [column("email", "text", { required: true, unique: true }), column("status", "text", { values: ["new", "won"] })],
      access: { agents: [{ agent_id: "writer", mode: "read" }] },
      reason: "Leads are copied between Tasks as prose.",
    };
    await assert.rejects(studioEditCollection.handler(toolDeps, await ctx(), { ...createArgs, name: "shared" }), /already exists/);
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), {
        ...createArgs,
        name: "Bad Name",
        scope: "everyone",
      }),
      /\/scope: Expected string to match/,
    );
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), {
        ...createArgs,
        name: "Bad Name",
        access: "everyone",
      }),
      /\/access: Expected object/,
    );
    const createWidget = (await studioEditCollection.handler(toolDeps, await ctx(), createArgs)) as Widget;
    assert.equal(createWidget.widget, "studio_edit_request");
    assert.equal(createWidget.await_operator, true);
    assert.equal(createWidget.edit.kind, "collection");
    assert.equal(createWidget.edit.action, "create");
    assert.match(createWidget.edit.effects[0] ?? "", /table-guild's own table/);
    assert.equal(await describeCollection(artifacts, operator, "leads"), null);
    const createSeq = await commit("studio_edit_collection", createArgs, createWidget as unknown as Record<string, unknown>);
    const createView = await view(createSeq);
    assert.equal(createView.stale, false);
    assert.equal(createView.live, "");
    assert.match(String(createView.proposed), /email \(text, required, unique\)/);
    assert.match(String(createView.proposed), /agent writer: read/);
    const applied = await resolve(createSeq, "apply");
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal((applied.json() as { status: string }).status, "applied");
    const leads = await describeCollection(artifacts, operator, "leads");
    assert.equal(leads?.guild_id, "guild_tb");
    const leadsAccess = await listAccess(artifacts, operator, { kind: "collection", id: String(leads?.id) });
    assert.deepEqual(
      leadsAccess.map((row) => [row.type, row.name, row.mode]),
      [
        ["guild", "table-guild", "write"],
        ["agent", "writer", "read"],
      ],
    );
    assert.equal((await resolve(createSeq, "apply")).statusCode, 409);

    // Read: the definition, who reaches it, and the latest records.
    await addRecord(artifacts, operator, { collection: "leads", body: { email: "a@example.com", status: "new" } });
    await addRecord(artifacts, operator, { collection: "leads", body: { email: "b@example.com", status: "won" } });
    const read = (await studioGetCollection.handler(toolDeps, await ctx(), { collection: "leads" })) as {
      updated_at: string;
      records: number;
      access: { org: string | null; own_table: boolean; agents: Array<{ name: string; effective: string | null }> };
      recent_records: string;
    };
    assert.equal(read.records, 2);
    assert.equal(read.access.own_table, true);
    assert.equal(read.access.org, null);
    assert.deepEqual(
      read.access.agents.map((row) => [row.name, row.effective]),
      [
        ["scout", "write"],
        ["writer", "read"],
      ],
    );
    assert.match(read.recent_records, /trust="untrusted"/);
    assert.match(read.recent_records, /b@example\.com/);

    // Edit: a stale base is refused; a rename moves values, a dropped column says how many records lose it.
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), { action: "edit", collection: "leads", base_updated_at: "1999-01-01T00:00:00Z", purpose: "x", reason: "r" }),
      /stale/,
    );
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), {
        action: "edit",
        collection: "leads",
        purpose: "x",
        access: { guild: "admin" },
        reason: "r",
      }),
      /\/access\/guild: Expected string to match/,
    );
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), { action: "edit", collection: "leads", base_updated_at: read.updated_at, reason: "r" }),
      /nothing to change/,
    );
    const editArgs = {
      action: "edit",
      collection: "leads",
      base_updated_at: read.updated_at,
      columns: [
        { ...column("contact", "text", { required: true, unique: true }), rename_from: "email" },
        column("score", "number"),
      ],
      access: { agents: [{ agent_id: "writer", mode: "inherit" }] },
      reason: "status is never read; score is.",
    };
    const editWidget = (await studioEditCollection.handler(toolDeps, await ctx(), editArgs)) as Widget;
    assert.ok(editWidget.edit.effects.includes("Drops status from 2 records."));
    assert.ok(editWidget.edit.effects.includes("Moves email to contact in 2 records."));
    const editSeq = await commit("studio_edit_collection", editArgs, editWidget as unknown as Record<string, unknown>);
    const editView = await view(editSeq);
    assert.equal(editView.stale, false);
    assert.match(String(editView.live), /status/);
    assert.match(String(editView.proposed), /contact .*\(renamed from email\)/);
    assert.equal((await resolve(editSeq, "apply")).statusCode, 200);
    const [accessChange, columnChange] = await listConfigChanges(db, "org_home", { kind: "collection", id: String(leads?.id) });
    assert.equal(accessChange?.summary, "Removed agent writer from the access of the table leads");
    assert.deepEqual(accessChange?.studio, { session_id: session.id, seq: editSeq });
    assert.equal(columnChange?.summary, "Renamed the column email to contact, removed the column status in leads");
    assert.deepEqual(columnChange?.studio, { session_id: session.id, seq: editSeq });
    const records = await listRecords(artifacts, operator, { collection: "leads" });
    assert.deepEqual(
      records.records.map((record) => [record.contact, record.status]),
      [
        ["a@example.com", undefined],
        ["b@example.com", undefined],
      ],
    );
    const afterEdit = await listAccess(artifacts, operator, { kind: "collection", id: String(leads?.id) });
    assert.equal(afterEdit.find((row) => row.name === "writer"), undefined);

    // A proposal goes stale when the table changes underneath it, and declining leaves the table alone.
    const current = (await studioGetCollection.handler(toolDeps, await ctx(), { collection: "leads" })) as { updated_at: string };
    const purposeArgs = { action: "edit", collection: "leads", base_updated_at: current.updated_at, purpose: "Leads worth a call.", reason: "Sharper." };
    const purposeWidget = (await studioEditCollection.handler(toolDeps, await ctx(), purposeArgs)) as Record<string, unknown>;
    const purposeSeq = await commit("studio_edit_collection", purposeArgs, purposeWidget);
    await updateCollection(artifacts, operator, String(leads?.id), { purpose: "Changed on the Tables page." });
    assert.equal((await view(purposeSeq)).stale, true);
    assert.equal((await resolve(purposeSeq, "apply")).statusCode, 409);
    assert.equal((await resolve(purposeSeq, "decline")).statusCode, 200);
    assert.equal((await describeCollection(artifacts, operator, "leads"))?.purpose, "Changed on the Tables page.");

    // An organisation table: the guild's row changes; rows outside the guild are shown, never changed,
    // and a private guild the operator does not operate is left out of them.
    const sharedRead = (await studioGetCollection.handler(toolDeps, await ctx(), { collection: "shared" })) as { updated_at: string; outside: string[]; studio_can: string };
    assert.deepEqual(sharedRead.outside, ["guild neighbour-guild read"]);
    assert.equal(sharedRead.studio_can, "add_columns_and_access");
    const grantArgs = { action: "edit", collection: "shared", base_updated_at: sharedRead.updated_at, access: { guild: "write" }, reason: "The scout records facts." };
    const grantWidget = (await studioEditCollection.handler(toolDeps, await ctx(), grantArgs)) as Record<string, unknown>;
    const grantSeq = await commit("studio_edit_collection", grantArgs, grantWidget);
    assert.equal((await resolve(grantSeq, "apply")).statusCode, 200);
    const sharedMode = async (guildId: string) =>
      (await reachOf(artifacts, operator, { type: "guild", id: guildId, guildId })).tables.find((row) => row.name === "shared")?.mode;
    assert.equal(await sharedMode("guild_tb"), "write");
    assert.equal(await sharedMode("guild_nb"), "read");

    // An organisation table takes new columns only: its name, purpose, and current columns stay, and it is not deleted here.
    const sharedNow = (await studioGetCollection.handler(toolDeps, await ctx(), { collection: "shared" })) as { updated_at: string };
    const orgEdit = { action: "edit", collection: "shared", base_updated_at: sharedNow.updated_at, reason: "r" };
    await assert.rejects(studioEditCollection.handler(toolDeps, await ctx(), { ...orgEdit, purpose: "Mine now." }), /organisation table/);
    await assert.rejects(studioEditCollection.handler(toolDeps, await ctx(), { ...orgEdit, name: "facts" }), /organisation table/);
    await assert.rejects(studioEditCollection.handler(toolDeps, await ctx(), { ...orgEdit, columns: [column("source", "text")] }), /keep fact/);
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), { ...orgEdit, columns: [column("fact", "number")] }),
      /keep fact unchanged/,
    );
    await assert.rejects(studioEditCollection.handler(toolDeps, await ctx(), { action: "delete", collection: "shared", reason: "r" }), /organisation table/);
    const addArgs = { ...orgEdit, columns: [column("fact", "text"), column("source", "text")], reason: "The scout cites where a fact came from." };
    const addWidget = (await studioEditCollection.handler(toolDeps, await ctx(), addArgs)) as Record<string, unknown>;
    const addSeq = await commit("studio_edit_collection", addArgs, addWidget);
    assert.equal((await resolve(addSeq, "apply")).statusCode, 200);
    assert.deepEqual(
      (await describeCollection(artifacts, operator, "shared"))?.columns.map((item) => item.name),
      ["fact", "source"],
    );
    const sharedAdded = (await studioGetCollection.handler(toolDeps, await ctx(), { collection: "shared" })) as { updated_at: string };
    await assert.rejects(
      studioEditCollection.handler(toolDeps, await ctx(), {
        ...orgEdit,
        base_updated_at: sharedAdded.updated_at,
        columns: [column("source", "text"), column("fact", "text")],
      }),
      /keep fact, source unchanged and in order/,
    );

    // Delete: the card names the records; apply removes the guild's own table.
    const deleteWidget = (await studioEditCollection.handler(toolDeps, await ctx(), { action: "delete", collection: "leads", reason: "Replaced." })) as Widget;
    assert.equal(deleteWidget.edit.action, "delete");
    assert.match(deleteWidget.edit.effects.join(" "), /2 records/);
    const deleteSeq = await commit("studio_edit_collection", { action: "delete", collection: "leads", reason: "Replaced." }, deleteWidget as unknown as Record<string, unknown>);
    const deleteView = await view(deleteSeq);
    assert.equal(deleteView.proposed, "");
    assert.match(String(deleteView.live), /leads · table-guild's own table/);
    assert.equal((await resolve(deleteSeq, "apply")).statusCode, 200);
    assert.equal(await describeCollection(artifacts, operator, "leads"), null);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio proposes notes to create and delete and narrows an agent's access", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(narrowDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-narrow-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const studio = new StudioService({ db, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await insertGuild(db, { guildId: "guild_nw", name: "narrow-guild", orgId: "org_home" }, now);
  const operator = operatorActor({
    orgId: "org_home",
    actorId: "user_operator",
    actorName: "operator",
    guildId: "guild_nw",
  });
  const { row: roles } = await writeNote(artifacts, operator, {
    level: "guild",
    key: "roles.md",
    content: "The scout finds candidates.\nThe archivist files them.\n",
    title: "Roles",
  });
  const rolesPath = `${ownerPrefix("org_home", "guild", "guild_nw")}${roles.key}`;
  for (const [agentId, name, task] of [
    ["a_sc", "scout", `Find candidates.\n\n![[${rolesPath}]]\n`],
    ["a_ar", "archivist", "File candidates."],
  ] as const) {
    await addAgent(
      { db, notes, artifacts },
      { agent: { agentId, guildId: "guild_nw", name, config: CONFIG, focus: `The ${name}` }, task: task, placement: {} },
      systemActor("org_home", { guildId: "guild_nw", agentId }),
      now,
    );
  }
  const server = await getMcpServerBySlug(db, "notion");
  assert.ok(server, "seeded Notion catalog row");
  const [ciphertext, nonce] = encryptPayload({ token: "notion-secret-token" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const connection = await connectMcp(db,
    {
      connectionId: newId("conn"),
      bindingId: newId("bind"),
      serverId: String(server.id),
      ownerScope: "org",
      ownerId: "org_home",
      ciphertext,
      nonce,
      status: "connected",
    },
    now,
  );
  await replaceMcpTools(db,
    String(connection.id),
    [
      { remote_name: "notion-search", namespaced_name: "notion_notion-search", description: "Search", input_schema: { type: "object" } },
      { remote_name: "notion-create-pages", namespaced_name: "notion_notion-create-pages", description: "Create", input_schema: { type: "object" } },
    ],
    now,
  );

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_nw", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };
    const toolDeps: StudioToolDeps = {
      artifacts,
      db,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    };
    const ctx = async (): Promise<StudioToolCall> => ({
      session: (await getStudioSession(db, session.id))!,
      user: userRow({ id: "user_operator", name: "operator" }),
      orgId: "org_home",
      sourceGuildId: "guild_nw",
      generation: 1,
    });
    const commit = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>): Promise<number> => {
      const seq = await nextConversationSeq(db, "studio", session.id);
      const id = `call_${seq}`;
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq,
          generation: 1,
          payload: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          metadata: { generation: 1 },
        },
        new Date(),
      );
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq: seq + 1,
          generation: 1,
          payload: { role: "tool", tool_call_id: id, content: JSON.stringify({ tool_message_seq: seq + 1, ...result }) },
          metadata: { generation: 1, tool_name: name },
        },
        new Date(),
      );
      return seq + 1;
    };
    const view = async (seq: number) =>
      (await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH })).json() as {
        status: string;
        stale: boolean;
        live: string;
        proposed: string;
        effects: string[];
        applied_version?: number;
      };
    const resolve = (seq: number, decision: string) =>
      app.inject({ method: "POST", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH, payload: { decision } });

    // Create: the scout's own playbook, at its level, written once the operator applies.
    const playbookPath = `${ownerPrefix("org_home", "agent", "a_sc")}playbook.md`;
    await assert.rejects(
      studioEditNote.handler(toolDeps, await ctx(), { action: "create", level: "agent", key: "playbook.md", content: "x", reason: "r" }),
      /agent_id/,
    );
    const createArgs = {
      action: "create",
      level: "agent",
      agent_id: "scout",
      key: "playbook.md",
      title: "Playbook",
      content: "A real candidate names its source.\n",
      reason: "The shared roles note carries the scout's rules for every reader.",
    };
    const createWidget = (await studioEditNote.handler(toolDeps, await ctx(), createArgs)) as {
      widget: string;
      edit: { kind: string; action: string; target: { display_path: string; agent_id: string } };
    };
    assert.equal(createWidget.widget, "studio_edit_request");
    assert.equal(createWidget.edit.kind, "note");
    assert.equal(createWidget.edit.action, "create");
    assert.equal(createWidget.edit.target.display_path, playbookPath);
    assert.equal(createWidget.edit.target.agent_id, "a_sc");
    const createSeq = await commit("studio_edit_note", createArgs, createWidget);
    const createView = await view(createSeq);
    assert.equal(createView.stale, false);
    assert.equal(createView.live, "");
    assert.equal(createView.proposed, "A real candidate names its source.\n");
    assert.ok(createView.effects.some((effect) => /Only scout reads it/.test(effect)), createView.effects.join(" | "));
    const createApplied = await resolve(createSeq, "apply");
    assert.equal(createApplied.statusCode, 200, createApplied.body);
    assert.equal((createApplied.json() as { applied_version: number }).applied_version, 1);
    assert.equal((await getByDisplayPath(artifacts, operator, playbookPath)).row?.content_text, "A real candidate names its source.\n");
    await assert.rejects(studioEditNote.handler(toolDeps, await ctx(), createArgs), /already exists/);

    // Delete: refused while a Task embeds the note, applied once none does.
    await assert.rejects(studioEditNote.handler(toolDeps, await ctx(), { action: "delete", display_path: rolesPath, base_version: 0, reason: "r" }), /stale/);
    const deleteArgs = { action: "delete", display_path: rolesPath, base_version: roles.version, reason: "Each role now has its own note." };
    const deleteWidget = (await studioEditNote.handler(toolDeps, await ctx(), deleteArgs)) as { edit: { action: string; effects: string[] } };
    assert.equal(deleteWidget.edit.action, "delete");
    assert.ok(deleteWidget.edit.effects.some((effect) => /scout embed it/.test(effect)), deleteWidget.edit.effects.join(" | "));
    const deleteSeq = await commit("studio_edit_note", deleteArgs, deleteWidget);
    assert.equal((await resolve(deleteSeq, "apply")).statusCode, 409);
    await writeAgentTask(db, operator, "a_sc", `Find candidates.\n\nnote_get ${playbookPath}\n`);
    const deleted = await resolve(deleteSeq, "apply");
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal((deleted.json() as { status: string }).status, "applied");
    const gone = await getByDisplayPath(artifacts, operator, rolesPath).catch(() => null);
    assert.ok(!gone?.row || gone.tombstone);

    // Access: the archivist loses tools it never calls; the card shows what changes.
    await assert.rejects(
      studioEditAccess.handler(toolDeps, await ctx(), { agent_id: "archivist", native_tools: { no_such_tool: "off" }, reason: "r" }),
      /unknown native tool/,
    );
    await assert.rejects(
      studioEditAccess.handler(toolDeps, await ctx(), { agent_id: "archivist", native_tools: { note_get: false }, reason: "r" }),
      /\/native_tools\/note_get: Expected string/,
    );
    await assert.rejects(
      studioEditAccess.handler(toolDeps, await ctx(), { agent_id: "archivist", connection_tools: { "other_tool": "off" }, reason: "r" }),
      /not a tool of archivist's connections/,
    );
    await assert.rejects(
      studioEditAccess.handler(toolDeps, await ctx(), { agent_id: "archivist", native_tools: { note_get: "inherit" }, reason: "r" }),
      /nothing to change/,
    );
    const accessArgs = {
      agent_id: "archivist",
      native_tools: { note_delete: "off", group_post: "off" },
      connection_tools: { "notion_notion-create-pages": "off" },
      reason: "The archivist's runs never call these.",
    };
    const accessWidget = (await studioEditAccess.handler(toolDeps, await ctx(), accessArgs)) as {
      edit: {
        kind: string;
        target: { agent_id: string };
        lines: { added: number; removed: number };
        changes: Array<{ kind: string; id: string; setting: string }>;
        widens: boolean;
      };
    };
    assert.equal(accessWidget.edit.kind, "access");
    assert.equal(accessWidget.edit.widens, false);
    assert.deepEqual(
      accessWidget.edit.changes.map((change) => `${change.kind}:${change.id}:${change.setting}`).sort(),
      ["mcp_tool:notion_notion-create-pages:off", "native_tool:group_post:off", "native_tool:note_delete:off"],
    );
    assert.equal(accessWidget.edit.target.agent_id, "a_ar");
    assert.deepEqual(accessWidget.edit.lines, { added: 3, removed: 3 });
    const accessSeq = await commit("studio_edit_access", accessArgs, accessWidget);
    const accessView = await view(accessSeq);
    assert.equal(accessView.stale, false);
    assert.match(accessView.live, /- note_delete: on\n/);
    assert.match(accessView.proposed, /- note_delete: off, set on this agent/);
    assert.match(accessView.proposed, /notion_notion-create-pages: off, set on this agent, changes data/);
    const accessApplied = await resolve(accessSeq, "apply");
    assert.equal(accessApplied.statusCode, 200, accessApplied.body);
    const appliedMeta = (await getConversationMessage(db, "studio", session.id, accessSeq))?.metadata as Record<string, unknown>;
    assert.equal(appliedMeta.resolved_by_user_id, "user_operator");
    const [accessChange] = await listConfigChanges(db, "org_home", { kind: "access", id: "note_delete" });
    assert.equal(accessChange?.agent_id, "a_ar");
    assert.equal(accessChange?.summary, "Turned off tool note_delete");
    assert.deepEqual(accessChange?.studio, { session_id: session.id, seq: accessSeq });
    const narrowed = (await studioGetAgentAccess.handler(toolDeps, await ctx(), { agent_id: "archivist" })) as {
      native_tools: string[];
      withheld_native_tools: string[];
      connections: Array<{ id: string; offered_tools: string[]; withheld_tools: string[] }>;
    };
    assert.equal(narrowed.native_tools.includes("note_delete"), false);
    assert.ok(narrowed.withheld_native_tools.includes("group_post"));
    const notion = narrowed.connections.find((row) => row.id === String(connection.id));
    assert.deepEqual(notion?.offered_tools, ["notion_notion-search"]);
    assert.deepEqual(notion?.withheld_tools, ["notion_notion-create-pages"]);
    const scout = (await studioGetAgentAccess.handler(toolDeps, await ctx(), { agent_id: "scout" })) as { native_tools: string[] };
    assert.ok(scout.native_tools.includes("note_delete"));

    // Giving a tool back that changes data says so; a binding moved since makes the request stale.
    const widenArgs = { agent_id: "archivist", connection_tools: { "notion_notion-create-pages": "inherit" }, reason: "It files pages after all." };
    const widenWidget = (await studioEditAccess.handler(toolDeps, await ctx(), widenArgs)) as { edit: { effects: string[]; widens: boolean } };
    assert.equal(widenWidget.edit.widens, true);
    assert.ok(
      widenWidget.edit.effects.some((effect) => /call notion_notion-create-pages, which can change data/.test(effect)),
      widenWidget.edit.effects.join(" | "),
    );
    const widenSeq = await commit("studio_edit_access", widenArgs, widenWidget);
    await writeBinding(db,
      {
        bindingId: newId("bind"),
        catalogKind: "native_tool",
        catalogId: "schedule_list",
        scope: "guild",
        scopeId: "guild_nw",
        enabled: false,
        connectionId: null,
      },
      new Date(),
      TEST_ACTOR,
    );
    assert.equal((await view(widenSeq)).stale, true);
    assert.equal((await resolve(widenSeq, "apply")).statusCode, 409);
    assert.equal((await resolve(widenSeq, "decline")).statusCode, 200);

    // A user who can no longer see the guild loses its sessions, edits included.
    await updateGuild(db, "guild_nw", new Date(), { visibility: "private" });
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${widenSeq}`, headers: AUTH })).statusCode,
      404,
    );
    assert.equal((await resolve(widenSeq, "apply")).statusCode, 404);
    const listed = await app.inject({ method: "GET", url: "/api/studio/sessions", headers: AUTH });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.body.includes(session.id), false);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio proposes routines to create, change, and delete that the operator applies or declines", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(routinesDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-routines-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const published: Array<{ guildId: string; action: string; scheduleId: string }> = [];
  const studio = new StudioService({
    db,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
    publishRoutinesChanged: async (guildId, change) => {
      published.push({ guildId, action: change.action, scheduleId: change.scheduleId });
    },
  });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await insertGuild(db, { guildId: "guild_rt", name: "routine-guild", orgId: "org_home" }, now);
  await addAgent(
    { db, notes, artifacts },
    { agent: { agentId: "a_wt", guildId: "guild_rt", name: "watcher", config: CONFIG, focus: "The watcher" }, task: "Watch the feed.", placement: {} },
    systemActor("org_home", { guildId: "guild_rt", agentId: "a_wt" }),
    now,
  );

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_rt", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };
    const toolDeps: StudioToolDeps = {
      artifacts,
      db,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    };
    const ctx = async (): Promise<StudioToolCall> => ({
      session: (await getStudioSession(db, session.id))!,
      user: userRow({ id: "user_operator", name: "operator" }),
      orgId: "org_home",
      sourceGuildId: "guild_rt",
      generation: 1,
    });
    const commit = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>): Promise<number> => {
      const seq = await nextConversationSeq(db, "studio", session.id);
      const id = `call_${seq}`;
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq,
          generation: 1,
          payload: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          metadata: { generation: 1 },
        },
        new Date(),
      );
      await insertConversationMessage(
        db,
        "studio",
        {
          session_id: session.id,
          seq: seq + 1,
          generation: 1,
          payload: { role: "tool", tool_call_id: id, content: JSON.stringify({ tool_message_seq: seq + 1, ...result }) },
          metadata: { generation: 1, tool_name: name },
        },
        new Date(),
      );
      return seq + 1;
    };
    const view = async (seq: number) =>
      (await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH })).json() as {
        status: string;
        stale: boolean;
        live: string;
        proposed: string;
        effects: string[];
        error?: string;
      };
    const resolve = (seq: number, decision: string) =>
      app.inject({ method: "POST", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH, payload: { decision } });

    // Create: refused without a timing or with a bad one; applied as the operator.
    await assert.rejects(
      studioEditRoutine.handler(toolDeps, await ctx(), {
        action: "create",
        agent_id: "watcher",
        window: { timezone: "Europe/Paris", start: "09:00", end: "18:00" },
        description: "d",
        instruction: "i",
        reason: "r",
      }),
      /\/window\/max_wakes: Expected required property/,
    );
    await assert.rejects(
      studioEditRoutine.handler(toolDeps, await ctx(), { action: "create", agent_id: "watcher", description: "d", instruction: "i", reason: "r" }),
      /exactly one of cron or window/,
    );
    await assert.rejects(
      studioEditRoutine.handler(toolDeps, await ctx(), { action: "create", agent_id: "watcher", cron: "* * * * *", description: "d", instruction: "i", reason: "r" }),
      /at least 5 minutes/,
    );
    await assert.rejects(
      studioEditRoutine.handler(toolDeps, await ctx(), { action: "create", agent_id: "watcher", cron: "0 9 * * *", instruction: "i", reason: "r" }),
      /description must be a string/,
    );
    await assert.rejects(
      studioEditRoutine.handler(toolDeps, await ctx(), { action: "create", agent_id: "nobody", cron: "0 9 * * *", description: "d", instruction: "i", reason: "r" }),
      /not in the source guild/,
    );
    const createArgs = {
      action: "create",
      agent_id: "watcher",
      cron: "0 9 * * 1",
      description: "Weekly feed sweep",
      instruction: "Sweep the feed for new items.",
      reason: "The watcher only runs when tagged, so the feed goes stale.",
    };
    const createWidget = (await studioEditRoutine.handler(toolDeps, await ctx(), createArgs)) as {
      widget: string;
      edit: { kind: string; action: string; target: { agent_id: string; schedule_id: string | null }; effects: string[] };
    };
    assert.equal(createWidget.widget, "studio_edit_request");
    assert.equal(createWidget.edit.kind, "routine");
    assert.equal(createWidget.edit.action, "create");
    assert.deepEqual(createWidget.edit.target, {
      agent_id: "a_wt",
      agent_name: "watcher",
      schedule_id: null,
      description: "Weekly feed sweep",
    });
    assert.deepEqual(await listSchedules(db, "a_wt"), []);
    const createSeq = await commit("studio_edit_routine", createArgs, createWidget);
    const createView = await view(createSeq);
    assert.equal(createView.stale, false);
    assert.equal(createView.live, "");
    assert.match(createView.proposed, /^agent: watcher\ndescription: Weekly feed sweep\ntiming: 0 9 \* \* 1 /);
    assert.match(createView.proposed, /state: active\ninstruction:\nSweep the feed for new items\.$/);
    assert.ok(createView.effects.some((effect) => /wakes watcher/.test(effect)), createView.effects.join(" | "));
    const createApplied = await resolve(createSeq, "apply");
    assert.equal(createApplied.statusCode, 200, createApplied.body);
    const [routine] = await listSchedules(db, "a_wt");
    assert.ok(routine);
    assert.equal(routine.cron, "0 9 * * 1");
    assert.equal(routine.instruction, "Sweep the feed for new items.");
    assert.equal(routine.paused, false);
    const scheduleId = String(routine.id);
    assert.deepEqual(published, [{ guildId: "guild_rt", action: "create", scheduleId }]);

    // Edit: nothing to change is refused; a routine changed since makes the request stale.
    await assert.rejects(
      studioEditRoutine.handler(toolDeps, await ctx(), { action: "edit", schedule_id: scheduleId, cron: "0 9 * * 1", reason: "r" }),
      /nothing to change/,
    );
    await assert.rejects(studioEditRoutine.handler(toolDeps, await ctx(), { action: "edit", schedule_id: "sch_none", paused: true, reason: "r" }), /unknown routine/);
    const staleArgs = { action: "edit", schedule_id: scheduleId, instruction: "Sweep and summarise.", reason: "Needs a summary." };
    const staleSeq = await commit("studio_edit_routine", staleArgs, await studioEditRoutine.handler(toolDeps, await ctx(), staleArgs));
    await schedules.setPaused(TEST_ACTOR, "a_wt", scheduleId, true);
    assert.equal((await view(staleSeq)).stale, true);
    assert.equal((await resolve(staleSeq, "apply")).statusCode, 409);
    assert.equal((await resolve(staleSeq, "decline")).statusCode, 200);

    const editArgs = {
      action: "edit",
      schedule_id: scheduleId,
      window: { timezone: "Europe/Paris", start: "09:00", end: "18:00", max_wakes: 3 },
      instruction: "Sweep the feed and post what is new.",
      paused: false,
      reason: "Fixed Monday sweeps miss midweek items.",
    };
    const editWidget = (await studioEditRoutine.handler(toolDeps, await ctx(), editArgs)) as {
      edit: { action: string; target: { schedule_id: string }; effects: string[] };
    };
    assert.equal(editWidget.edit.action, "edit");
    assert.equal(editWidget.edit.target.schedule_id, scheduleId);
    assert.ok(editWidget.edit.effects.some((effect) => /Resumes it/.test(effect)), editWidget.edit.effects.join(" | "));
    assert.ok(editWidget.edit.effects.some((effect) => /planned again/.test(effect)), editWidget.edit.effects.join(" | "));
    const editSeq = await commit("studio_edit_routine", editArgs, editWidget);
    const editView = await view(editSeq);
    assert.match(editView.live, /state: paused/);
    assert.match(editView.proposed, /timing: Up to 3 random wake-ups between 09:00 and 18:00 every day \(Europe\/Paris\)/);
    const editApplied = await resolve(editSeq, "apply");
    assert.equal(editApplied.statusCode, 200, editApplied.body);
    const edited = await getSchedule(db, "a_wt", scheduleId);
    assert.equal(edited?.cron, null);
    assert.equal(edited?.paused, false);
    assert.equal(edited?.description, "Weekly feed sweep");
    assert.equal(edited?.instruction, "Sweep the feed and post what is new.");

    // Delete: applied as the operator; the routine is gone.
    const deleteArgs = { action: "delete", schedule_id: scheduleId, reason: "The feed is now pushed to the watcher." };
    const deleteWidget = (await studioEditRoutine.handler(toolDeps, await ctx(), deleteArgs)) as { edit: { action: string } };
    assert.equal(deleteWidget.edit.action, "delete");
    const deleteSeq = await commit("studio_edit_routine", deleteArgs, deleteWidget);
    assert.equal((await view(deleteSeq)).proposed, "");
    const deleted = await resolve(deleteSeq, "apply");
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(await getSchedule(db, "a_wt", scheduleId), null);
    assert.deepEqual(
      published.map((change) => change.action),
      ["create", "edit", "delete"],
    );
    assert.equal((await resolve(deleteSeq, "apply")).statusCode, 409);

    // The routine's change log: who changed it, newest first, each Studio apply linked to its card.
    const history = await listConfigChanges(db, "org_home", { kind: "routine", id: scheduleId });
    assert.deepEqual(
      history.map((change) => [change.operation, change.actor.type, change.studio?.seq ?? null]),
      [
        ["delete", "user", deleteSeq],
        ["update", "user", editSeq],
        ["update", "user", null],
        ["create", "user", createSeq],
      ],
    );
    assert.equal(history[2]?.summary, 'Paused "Weekly feed sweep"');
    assert.ok(history.every((change) => change.agent_id === "a_wt"));

    // A routine an agent creates and pauses links to the run step that did it.
    await createRun(db,
      {
        runId: "r_wt",
        agentId: "a_wt",
        configSnapshot: runSnapshot(),
        systemContent: "system prompt",
        taskContent: "task prompt",
        userContent: null,
        systemPromptHash: "s",
        taskPromptHash: "t",
        memoryPromptHash: "m",
      },
      now,
    );
    const toolCtx = toolFixture({
      run_id: "r_wt",
      agent_id: "a_wt",
      guild_id: "guild_rt",
      sandbox: null,
      secrets: {},
      schedules,
      agent_name: "watcher",
    });
    const create = { cron: "0 7 * * *", description: "Morning check", instruction: "Check." };
    await scheduleCreateCron.handler(toolCtx.services, toolCtx.run, toolCtx.hooks, toolInvocation("schedule_create_cron", create, "call_create"));
    const [own] = await listSchedules(db, "a_wt");
    await schedulePause.handler(toolCtx.services, toolCtx.run, toolCtx.hooks, toolInvocation("schedule_pause", { schedule_id: String(own?.id) }, "call_pause"));
    const agentHistory = await listConfigChanges(db, "org_home", { kind: "routine", id: String(own?.id) });
    assert.deepEqual(
      agentHistory.map((change) => [change.operation, change.actor.type, change.actor.name, change.run_id, change.tool]),
      [
        ["update", "run", "watcher", "r_wt", { call_id: "call_pause", name: "schedule_pause" }],
        ["create", "run", "watcher", "r_wt", { call_id: "call_create", name: "schedule_create_cron" }],
      ],
    );
  } finally {
    await app.close();
    await database.close();
  }
});
