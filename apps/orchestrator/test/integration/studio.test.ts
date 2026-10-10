import assert from "node:assert/strict";
import { after, test } from "node:test";
import { persistAgent } from "../../src/agents/persist.js";
import { agentActor, ArtifactStore, displayPathFor, operatorActor, ownerPrefix } from "../../src/artifacts/index.js";
import { DEFAULT_ARTIFACT_GRANTS } from "../../src/artifacts/types.js";
import { runItem } from "../../src/db/views.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { StudioService } from "../../src/studio/index.js";
import { generationLive } from "../../src/studio/runner.js";
import {
  studioCallConnectionTool,
  studioCreateCollection,
  studioDeleteCollection,
  studioEditArtifact,
  studioEditCollection,
  studioEditGuild,
  studioEditMemory,
  studioGetAgentAccess,
  studioGetArtifact,
  studioGetCollection,
  studioGetGuild,
  studioGetAgentContext,
  studioGetMemoryVersion,
  studioGetRun,
  studioGetScript,
  studioListCollections,
  studioListFileChanges,
  studioListMemoryRevisions,
  studioListRoutines,
  studioListRuns,
  studioRequestConnectionAccess,
  type StudioToolContext,
} from "../../src/studio/tools.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { newId } from "../../src/lib/ids.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionReply } from "../helpers/generation.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const AUTH = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const CONFIG = {
  model: TEST_MODEL,
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

const dbName = uniqueDbName("agent_platform_studio");
const accessDbName = uniqueDbName("agent_platform_studio_access");
const evidenceDbName = uniqueDbName("agent_platform_studio_evidence");
const editsDbName = uniqueDbName("agent_platform_studio_edits");
const tablesDbName = uniqueDbName("agent_platform_studio_tables");
const originalStream = generationLive.streamCompletion;

after(async () => {
  generationLive.streamCompletion = originalStream;
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(accessDbName);
  await dropIsolatedDatabase(evidenceDbName);
  await dropIsolatedDatabase(editsDbName);
  await dropIsolatedDatabase(tablesDbName);
});

test("studio sessions, inventory, drafts, and authorization", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const studio = new StudioService({
    repo,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
  });
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts,
    schedules,
    studio,
  });

  const now = new Date();
  await repo.insertGuild(
    "guild_studio",
    "studio-guild",
    now,
    "org_home",
    "Optimize this guild",
    undefined,
    undefined,
    undefined,
    "Coordinate research and writing across the roster.\n",
  );
  await repo.insertGuild("guild_other", "other-guild", now, "org_home", "");
  await persistAgent(repo, notes, {
    agentId: "a_studio",
    guildId: "guild_studio",
    guildName: "studio-guild",
    orgSlug: "home",
    orgId: "org_home",
    name: "writer",
    focus: "Write notes",
    config: CONFIG,
    now,
    artifacts,
  });
  await persistAgent(repo, notes, {
    agentId: "a_other",
    guildId: "guild_other",
    guildName: "other-guild",
    orgSlug: "home",
    orgId: "org_home",
    name: "outsider",
    config: CONFIG,
    now,
    artifacts,
  });
  const teammate = await repo.insertUser("user_teammate", "teammate", now, null, "teammate@example.com");
  await repo.insertMember("org_home", String(teammate.id), "member", now);

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

    const setTarget = await app.inject({
      method: "PUT",
      url: `/api/studio/sessions/${session.id}/target`,
      headers: AUTH,
      payload: { agent_id: "a_studio" },
    });
    assert.equal(setTarget.statusCode, 200);

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

    const liveTask = await repo.getAgentTask("org_home", "a_studio");
    const createdDraft = await studio.drafts.createFromTool(
      {
        session: (await studio.store.getSession(session.id)) as Record<string, unknown>,
        user: { id: "user_operator", name: "operator" },
        orgId: "org_home",
        sourceGuildId: "guild_studio",
        targetAgentId: null,
        generation: 1,
        store: studio.store,
        artifacts,
        repo,
        schedules,
        drafts: studio.drafts,
        preview: studio.previewDeps(),
        notesSystemPath: notes.systemPath(),
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
    assert.equal(draft.base_version, liveTask?.version);

    const published = await app.inject({
      method: "POST",
      url: `/api/studio/drafts/${String(draft.id)}/publish`,
      headers: AUTH,
    });
    assert.equal(published.statusCode, 200, published.body);
    const result = published.json() as { outcome: string };
    assert.equal(result.outcome, "published");

    const after = await repo.getAgentTask("org_home", "a_studio");
    assert.equal(after?.content_text, "Write concise notes and stop when the artifact exists.\n");

    const hostConflict = await app.inject({
      method: "PUT",
      url: "/api/agents/a_studio/files/task.md",
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
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio reads agent access, script source, and granted connections", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(accessDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-access-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const calls: Array<{ remote: string; args: Record<string, unknown> }> = [];
  const mcp = {
    async call(
      _db: Repositories,
      _connection: Record<string, unknown>,
      _server: Record<string, unknown>,
      remoteName: string,
      arguments_: Record<string, unknown>,
    ) {
      calls.push({ remote: remoteName, args: arguments_ });
      return JSON.stringify({ remote: remoteName, echo: arguments_, leaked: "notion-secret-token" });
    },
  };
  const studio = new StudioService({
    repo,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
    mcp,
  });
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts,
    schedules,
    studio,
  });

  const now = new Date();
  await repo.insertGuild("guild_access", "access-guild", now, "org_home", "Guild with a Notion login");
  await repo.insertGuild("guild_far", "far-guild", now, "org_home", "");
  await persistAgent(repo, notes, {
    agentId: "a_access",
    guildId: "guild_access",
    guildName: "access-guild",
    orgSlug: "home",
    orgId: "org_home",
    name: "curator",
    focus: "Curate the database",
    config: CONFIG,
    now,
    artifacts,
  });
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

  const server = await repo.getMcpServerBySlug("notion");
  assert.ok(server, "seeded Notion catalog row");
  const [ciphertext, nonce] = encryptPayload({ token: "notion-secret-token" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const connection = await repo.connectMcp(
    newId("conn"),
    newId("bind"),
    String(server.id),
    "org",
    "org_home",
    ciphertext,
    nonce,
    now,
    { status: "connected" },
  );
  await repo.replaceMcpTools(
    String(connection.id),
    [
      { remote_name: "notion-search", namespaced_name: "notion_notion-search", description: "Search", input_schema: { type: "object" } },
      { remote_name: "notion-create-pages", namespaced_name: "notion_notion-create-pages", description: "Create", input_schema: { type: "object" } },
    ],
    now,
  );
  const [farCipher, farNonce] = encryptPayload({ token: "far-token" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const farConnection = await repo.connectMcp(
    newId("conn"),
    newId("bind"),
    String(server.id),
    "guild",
    "guild_far",
    farCipher,
    farNonce,
    now,
    { status: "connected" },
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

    const toolContext = async (): Promise<StudioToolContext> => ({
      session: (await studio.store.getSession(session.id)) as Record<string, unknown>,
      user: { id: "user_operator", name: "operator" },
      orgId: "org_home",
      sourceGuildId: "guild_access",
      targetAgentId: null,
      generation: 1,
      store: studio.store,
      artifacts,
      repo,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
      mcp,
    });

    const access = (await studioGetAgentAccess.handler(await toolContext(), { agent_id: "curator" })) as {
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

    const script = (await studioGetScript.handler(await toolContext(), { agent_id: "a_access", name: "tally" })) as {
      name: string;
      content: string;
    };
    assert.equal(script.name, "tally");
    assert.match(script.content, /source="script"/);
    assert.match(script.content, /print\('tally'\)/);

    const blocked = (await studioCallConnectionTool.handler(await toolContext(), {
      connection_id: String(connection.id),
      tool: "notion-search",
      arguments: { query: "roadmap" },
    })) as { error?: string };
    assert.equal(blocked.error, "access_required");
    assert.equal(calls.length, 0);

    const requested = (await studioRequestConnectionAccess.handler(await toolContext(), {
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

    const alreadyGranted = (await studioRequestConnectionAccess.handler(await toolContext(), {
      connection_id: String(connection.id),
      reason: "again",
    })) as { granted?: boolean; widget?: string };
    assert.equal(alreadyGranted.granted, true);
    assert.equal(alreadyGranted.widget, undefined);

    const read = (await studioCallConnectionTool.handler(await toolContext(), {
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
      studioCallConnectionTool.handler(await toolContext(), {
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
    const blockedAgain = (await studioCallConnectionTool.handler(await toolContext(), {
      connection_id: String(connection.id),
      tool: "notion-search",
      arguments: {},
    })) as { error?: string };
    assert.equal(blockedAgain.error, "access_required");
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio inspects the effective prompt, memory timeline, routine runs, file changes, and focus pins", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(evidenceDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-evidence-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const studio = new StudioService({
    repo,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
  });
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts,
    schedules,
    studio,
  });

  const now = new Date();
  await repo.insertGuild("guild_ev", "evidence-guild", now, "org_home", "Evidence");
  await persistAgent(repo, notes, {
    agentId: "a_ev",
    guildId: "guild_ev",
    guildName: "evidence-guild",
    orgSlug: "home",
    orgId: "org_home",
    name: "curator",
    focus: "Keep the digest",
    config: CONFIG,
    now,
    artifacts,
  });
  const operator = artifacts.operatorContext("org_home", "user_operator", "operator", {
    guildId: "guild_ev",
    agentId: "a_ev",
  });
  const shared = await artifacts.writeNote(
    artifacts.operatorContext("org_home", "user_operator", "operator", { guildId: "guild_ev" }),
    { level: "guild", key: "house-rules.md", content: "Always cite the source.\n", title: "House rules" },
  );
  const sharedPath = `${ownerPrefix("org_home", "guild", "guild_ev")}${shared.key}`;
  await repo.writeAgentTask(operator, "a_ev", `Curate the digest.\n\n![[${sharedPath}]]\n`);

  // A routine and one run it woke, then a memory written by that run.
  const routine = await schedules.create("a_ev", { cron: "0 9 * * 1" }, "Weekly digest", "Compile the weekly digest.");
  const scheduleId = String(routine.id);
  await repo.createScheduleRun(
    "r_ev_wake",
    "a_ev",
    { ...CONFIG, tools: [], mcp: [] },
    "system prompt",
    "task prompt",
    [
      [
        { role: "user", content: "Schedule wake-up: {}" },
        { generation: 1, source: "schedule", schedule_id: scheduleId, instruction_hash: "h1" },
      ],
      [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_mem", type: "function", function: { name: "memory_write", arguments: "{}" } }],
        },
        { generation: 1 },
      ],
      [{ role: "tool", tool_call_id: "call_mem", content: "ok" }, { generation: 1, tool_name: "memory_write", tool_call_id: "call_mem" }],
    ],
    now,
    { systemPromptHash: "s", taskPromptHash: "t", memoryPromptHash: "m", scheduleId, runMetadata: { instruction_hash: "h1" } },
  );
  await repo.createRun("r_ev_direct", "a_ev", { ...CONFIG, tools: [], mcp: [] }, "system prompt", "task prompt", "hello", now, {
    systemPromptHash: "s",
    taskPromptHash: "t",
    memoryPromptHash: "m",
  });
  const runActor = {
    ...agentActor({ orgId: "org_home", guildId: "guild_ev", agentId: "a_ev", agentName: "curator", grants: DEFAULT_ARTIFACT_GRANTS, runId: "r_ev_wake" }),
    toolCall: { id: "call_mem", name: "memory_write" },
  };
  await artifacts.writeMemory(operator, "a_ev", "- be brief (operator)\n- nothing yet", "user operator (Files pane)");
  await artifacts.writeMemory(runActor, "a_ev", "- be brief (operator)\n- digest lives in notes/digest.md\n- send Monday", "run r_ev_wake (schedule wake-up: \"Compile the weekly digest.\")");

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
    const wakeView = runItem((await repo.getRun("r_ev_wake")) as Record<string, unknown>, { generating: false });
    assert.equal(wakeView.schedule_id, scheduleId);
    assert.equal(wakeView.instruction_hash, "h1");
    const directView = runItem((await repo.getRun("r_ev_direct")) as Record<string, unknown>, { generating: false });
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
    const toolCtx = (): StudioToolContext => ({
      session: { id: session.id, org_id: "org_home", source_guild_id: "guild_ev" },
      user: { id: "user_operator", name: "operator" },
      orgId: "org_home",
      sourceGuildId: "guild_ev",
      targetAgentId: null,
      generation: 1,
      store: studio.store,
      artifacts,
      repo,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    });
    const sessionRow = () => studio.store.getSession(session.id) as Promise<Record<string, unknown>>;
    const issue = await repo.insertIssue(
      "iss_ev",
      "guild_ev",
      "org_home",
      "a_ev",
      "curator",
      "r_ev_wake",
      "api",
      "high",
      "Digest feed returned 401",
      "The feed login expired while compiling the weekly digest.",
      "feed_fetch",
      now,
    );
    const pins: Array<Record<string, unknown>> = [
      { kind: "run", run_id: "r_ev_wake", call_id: "call_mem" },
      { kind: "memory_version", agent_id: "a_ev", revision_id: middleRevision },
      { kind: "routine", agent_id: "a_ev", schedule_id: scheduleId },
      { kind: "file", display_path: sharedPath },
      { kind: "issue", issue_id: issue.id },
    ];
    for (const pin of pins) {
      const before = (await studio.store.listMessages(session.id)).length;
      await studio.postMessage(await sessionRow(), { id: "user_operator", name: "operator" }, `Question about ${String(pin.kind)}`, pin);
      await studio.runner.wait(session.id);
      const rows = await studio.store.listMessages(session.id);
      const focusRow = rows[before] as { payload: { role: string; content: string }; metadata: { source: string; focus: { kind: string; label: string } } };
      const question = rows[before + 1] as { payload: { content: string }; metadata: { source: string } };
      assert.equal(focusRow.metadata.source, "studio_focus");
      assert.equal(focusRow.metadata.focus.kind, pin.kind);
      assert.ok(focusRow.metadata.focus.label);
      assert.match(focusRow.payload.content, new RegExp(`source="studio.focus.${String(pin.kind)}"`));
      assert.equal(question.metadata.source, "ui");
      assert.equal(question.payload.content, `Question about ${String(pin.kind)}`);
    }
    const focusRows = (await studio.store.listMessages(session.id)).filter((row) => (row.metadata as { source?: string }).source === "studio_focus");
    assert.match(String((focusRows[0]?.payload as { content: string }).content), /memory_write/);
    assert.match(String((focusRows[1]?.payload as { content: string }).content), /Written by: user operator/);
    assert.match(String((focusRows[1]?.payload as { content: string }).content), /written_at="\d{4}-\d{2}-\d{2}T/);
    assert.match(String((focusRows[2]?.payload as { content: string }).content), /Compile the weekly digest/);
    assert.match(String((focusRows[3]?.payload as { content: string }).content), /Always cite the source/);
    const issuePin = focusRows[4] as { payload: { content: string }; metadata: { focus: { run_id: string; agent_id: string; issue_id: string } } };
    assert.match(issuePin.payload.content, /Digest feed returned 401/);
    assert.match(issuePin.payload.content, /studio_get_run\(run_id="r_ev_wake", tool_name="report_issue"\)/);
    assert.equal(issuePin.metadata.focus.issue_id, "iss_ev");
    assert.equal(issuePin.metadata.focus.run_id, "r_ev_wake");
    assert.equal(issuePin.metadata.focus.agent_id, "a_ev");

    await repo.insertGuild("guild_far", "far-guild", now, "org_home", "");
    await persistAgent(repo, notes, {
      agentId: "a_far",
      guildId: "guild_far",
      guildName: "far-guild",
      orgSlug: "home",
      orgId: "org_home",
      name: "stranger",
      config: CONFIG,
      now,
      artifacts,
    });
    await repo.createRun("r_far", "a_far", { ...CONFIG, tools: [], mcp: [] }, "system", "task", "hi", now, {
      systemPromptHash: "s",
      taskPromptHash: "t",
      memoryPromptHash: "m",
    });
    const foreign = await app.inject({
      method: "POST",
      url: `/api/studio/sessions/${session.id}/messages`,
      headers: AUTH,
      payload: { content: "Why?", focus: { kind: "run", run_id: "r_far" } },
    });
    assert.equal(foreign.statusCode, 422, foreign.body);
    await repo.insertIssue("iss_far", "guild_far", "org_home", "a_far", "stranger", "r_far", "other", "low", "Elsewhere", "Not this guild.", null, now);
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
    const listed = await studioListMemoryRevisions.handler(toolCtx(), { agent_id: "curator" });
    const versions = listed.versions as Array<{ version_index: number; revision_id: string | null; run_id: string | null }>;
    assert.equal(versions.length, 3);
    assert.equal(versions[0]?.run_id, "r_ev_wake");
    const version = await studioGetMemoryVersion.handler(toolCtx(), { agent_id: "curator", revision_id: middleRevision });
    assert.match(String(version.content), /nothing yet/);
    assert.match(String(version.diff_from_previous), /be brief \(operator\)/);
    const liveVersion = await studioGetMemoryVersion.handler(toolCtx(), { agent_id: "curator" });
    assert.equal(liveVersion.live, true);
    assert.match(String(liveVersion.diff_from_previous), /\+ - send Monday/);
    const runList = await studioListRuns.handler(toolCtx(), { agent_id: "curator", schedule_id: scheduleId });
    assert.deepEqual((runList.runs as Array<{ id: string }>).map((row) => row.id), ["r_ev_wake"]);
    const routineList = await studioListRoutines.handler(toolCtx(), { agent_id: "curator" });
    assert.equal((routineList.routines as Array<{ run_count: number }>)[0]?.run_count, 1);
    const memoryCall = await studioGetRun.handler(toolCtx(), { run_id: "r_ev_wake", tool_name: "memory_write" });
    assert.equal(memoryCall.matched, 2);
    const fileChanges = await studioListFileChanges.handler(toolCtx(), { display_path: memoryPath });
    assert.equal((fileChanges.changes as Array<{ run: { id: string } | null }>)[0]?.run?.id, "r_ev_wake");
    await assert.rejects(studioListFileChanges.handler(toolCtx(), { display_path: "org/org_home/agents/a_far/memory.md" }), /not in the source guild/);
    const context = await studioGetAgentContext.handler(toolCtx(), { agent_id: "curator", sections: ["effective_prompt"] });
    assert.match(String((context.effective_prompt as { content: string }).content), /Always cite the source/);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio proposes memory, note, and guild edits that the operator applies or declines", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(editsDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-edits-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const studio = new StudioService({ repo, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { repo, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await repo.insertGuild(
    "guild_ed",
    "edit-guild",
    now,
    "org_home",
    "Old about",
    undefined,
    undefined,
    undefined,
    "Old description.\n",
  );
  await persistAgent(repo, notes, {
    agentId: "a_ed",
    guildId: "guild_ed",
    guildName: "edit-guild",
    orgSlug: "home",
    orgId: "org_home",
    name: "curator",
    focus: "Keep the digest",
    config: CONFIG,
    now,
    artifacts,
  });
  const operator = artifacts.operatorContext("org_home", "user_operator", "operator", { guildId: "guild_ed", agentId: "a_ed" });
  await artifacts.writeMemory(operator, "a_ed", "- be brief\n- digest in notes\n- nothing yet", "seed");
  const note = await artifacts.writeNote(
    artifacts.operatorContext("org_home", "user_operator", "operator", { guildId: "guild_ed" }),
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
    const ctx = async (): Promise<StudioToolContext> => ({
      session: (await studio.store.getSession(session.id)) as Record<string, unknown>,
      user: { id: "user_operator", name: "operator" },
      orgId: "org_home",
      sourceGuildId: "guild_ed",
      targetAgentId: null,
      generation: 1,
      store: studio.store,
      artifacts,
      repo,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    });
    // Store the call and its result the way the runner commits them.
    const commit = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>): Promise<number> => {
      const seq = await studio.store.nextSeq(session.id);
      const id = `call_${seq}`;
      await studio.store.insertMessage(
        session.id,
        seq,
        1,
        { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        { generation: 1 },
        new Date(),
      );
      await studio.store.insertMessage(
        session.id,
        seq + 1,
        1,
        { role: "tool", tool_call_id: id, content: JSON.stringify({ tool_message_seq: seq + 1, ...result }) },
        { generation: 1, tool_name: name },
        new Date(),
      );
      return seq + 1;
    };
    const resolve = (seq: number, decision: string) =>
      app.inject({ method: "POST", url: `/api/studio/sessions/${session.id}/edits/${seq}`, headers: AUTH, payload: { decision } });

    // Guild: read the live text, propose, apply.
    const guild = (await studioGetGuild.handler(await ctx(), {})) as { about: string; description: string };
    assert.match(guild.about, /Old about/);
    assert.match(guild.description, /Old description/);
    const guildArgs = { description: "Coordinate the digest.", reason: "The description names no outcome." };
    const guildEdit = (await studioEditGuild.handler(await ctx(), guildArgs)) as {
      widget: string;
      await_operator: boolean;
      edit: { fields: string[] };
    };
    assert.equal(guildEdit.widget, "studio_edit_request");
    assert.equal(guildEdit.await_operator, true);
    assert.deepEqual(guildEdit.edit.fields, ["description"]);
    assert.equal(String((await repo.getGuild("guild_ed"))?.description).trim(), "Old description.");
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
    const liveGuild = await repo.getGuild("guild_ed");
    assert.equal(liveGuild?.description, "Coordinate the digest.");
    assert.equal(liveGuild?.about, "Old about");
    const snapshot = (await studio.store.getSession(session.id))?.source_guild_snapshot as { objective?: string };
    assert.equal(snapshot.objective, "Coordinate the digest.");
    assert.equal((await resolve(guildSeq, "apply")).statusCode, 409);

    // Memory: a stale base_version is refused; a current one pauses, and apply writes as the operator.
    const memory = await artifacts.getMemoryRow(operator, "a_ed");
    await assert.rejects(
      studioEditMemory.handler(await ctx(), { agent_id: "curator", content: "x", base_version: Number(memory?.version) - 1, reason: "r" }),
      /stale/,
    );
    const memoryArgs = {
      agent_id: "curator",
      content: "- be brief\n- digest in notes/digest.md\n- nothing yet",
      base_version: Number(memory?.version),
      reason: "Memory names the wrong digest path.",
    };
    const memoryEdit = (await studioEditMemory.handler(await ctx(), memoryArgs)) as Record<string, unknown>;
    const memorySeq = await commit("studio_edit_memory", memoryArgs, memoryEdit);
    const memoryApplied = await resolve(memorySeq, "apply");
    assert.equal(memoryApplied.statusCode, 200, memoryApplied.body);
    assert.equal((memoryApplied.json() as { applied_version: number }).applied_version, Number(memory?.version) + 1);
    assert.match(await artifacts.readMemory(operator, "a_ed"), /notes\/digest\.md/);
    const memoryPath = displayPathFor({ orgId: "org_home", level: "agent", ownerId: "a_ed", kind: "memory", path: "", key: "memory.md" });
    const memoryChanges = (await studioListFileChanges.handler(await ctx(), { display_path: memoryPath })) as {
      changes: Array<{ actor: { type: string; name: string }; tool: { name: string } | null }>;
    };
    assert.equal(memoryChanges.changes[0]?.actor.type, "user");
    assert.equal(memoryChanges.changes[0]?.tool?.name, "studio_edit_memory");
    const revisions = (await studioListMemoryRevisions.handler(await ctx(), { agent_id: "a_ed" })) as { versions: unknown[] };
    assert.ok(revisions.versions.length >= 2);

    // Note: a proposal goes stale when the note changes underneath it; declining leaves the note alone.
    const noteArgs = { display_path: notePath, content: "Always cite the source URL.\n", base_version: note.version, reason: "Rule is vague." };
    const noteEdit = (await studioEditArtifact.handler(await ctx(), noteArgs)) as Record<string, unknown>;
    const noteSeq = await commit("studio_edit_artifact", noteArgs, noteEdit);
    await artifacts.writeNote(
      artifacts.operatorContext("org_home", "user_operator", "operator", { guildId: "guild_ed" }),
      { level: "guild", key: "house-rules.md", content: "Always cite, twice.\n", title: "House rules" },
    );
    const staleView = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/edits/${noteSeq}`, headers: AUTH });
    assert.equal((staleView.json() as { stale: boolean }).stale, true);
    assert.equal((await resolve(noteSeq, "apply")).statusCode, 409);
    const declined = await resolve(noteSeq, "decline");
    assert.equal(declined.statusCode, 200, declined.body);
    assert.equal((declined.json() as { status: string }).status, "declined");
    const liveNote = await artifacts.getByDisplayPath(operator, notePath);
    assert.equal(liveNote.row?.content_text, "Always cite, twice.\n");

    // Memory is not a note, and a tool message that is not an edit request cannot be resolved.
    await assert.rejects(
      studioEditArtifact.handler(await ctx(), { display_path: memoryPath, content: "x", base_version: 1, reason: "r" }),
      /studio_edit_memory/,
    );
    assert.equal((await resolve(memorySeq - 1, "apply")).statusCode, 404);
    assert.equal((await resolve(memorySeq, "maybe")).statusCode, 422);
  } finally {
    await app.close();
    await database.close();
  }
});

test("studio proposes tables to create, change, and delete that the operator applies or declines", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(tablesDbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-tables-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const studio = new StudioService({ repo, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { repo, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await repo.insertGuild("guild_tb", "table-guild", now, "org_home");
  await repo.insertGuild("guild_nb", "neighbour-guild", now, "org_home");
  for (const [agentId, guildId, guildName, name] of [
    ["a_scout", "guild_tb", "table-guild", "scout"],
    ["a_writer", "guild_tb", "table-guild", "writer"],
    ["a_nb", "guild_nb", "neighbour-guild", "neighbour"],
  ] as const) {
    await persistAgent(repo, notes, {
      agentId,
      guildId,
      guildName,
      orgSlug: "home",
      orgId: "org_home",
      name,
      focus: "Keep the tables",
      config: CONFIG,
      now,
      artifacts,
    });
  }
  const operator = artifacts.operatorContext("org_home", "user_operator", "operator");
  const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, description: `The ${name}.`, ...extra });
  const shared = await artifacts.createCollection(operator, { name: "shared", purpose: "Shared facts.", columns: [column("fact", "text")] });
  await artifacts.setAccess(operator, { collectionId: shared.id, subjectType: "guild", subjectId: "guild_nb", mode: "read" });
  await artifacts.createCollection(operator, {
    name: "their-queue",
    purpose: "The neighbour's queue.",
    columns: [column("item", "text")],
    guildId: "guild_nb",
  });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_tb", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };
    const ctx = async (): Promise<StudioToolContext> => ({
      session: (await studio.store.getSession(session.id)) as Record<string, unknown>,
      user: { id: "user_operator", name: "operator" },
      orgId: "org_home",
      sourceGuildId: "guild_tb",
      targetAgentId: null,
      generation: 1,
      store: studio.store,
      artifacts,
      repo,
      schedules,
      drafts: studio.drafts,
      preview: studio.previewDeps(),
      notesSystemPath: notes.systemPath(),
    });
    const commit = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>): Promise<number> => {
      const seq = await studio.store.nextSeq(session.id);
      const id = `call_${seq}`;
      await studio.store.insertMessage(
        session.id,
        seq,
        1,
        { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        { generation: 1 },
        new Date(),
      );
      await studio.store.insertMessage(
        session.id,
        seq + 1,
        1,
        { role: "tool", tool_call_id: id, content: JSON.stringify({ tool_message_seq: seq + 1, ...result }) },
        { generation: 1, tool_name: name },
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

    // Every table is listed, the source guild's own first; another guild's table is read-only here.
    const listed = (await studioListCollections.handler(await ctx(), {})) as {
      collections: Array<{ name: string; changeable: boolean; guild_access: string | null }>;
    };
    assert.deepEqual(
      listed.collections.map((item) => [item.name, item.changeable]),
      [
        ["shared", true],
        ["their-queue", false],
      ],
    );
    await assert.rejects(
      studioEditCollection.handler(await ctx(), {
        collection: "their-queue",
        base_updated_at: "x",
        purpose: "Mine now.",
        reason: "r",
      }),
      /belongs to guild neighbour-guild/,
    );
    await assert.rejects(studioDeleteCollection.handler(await ctx(), { collection: "their-queue", reason: "r" }), /belongs to guild/);
    await assert.rejects(
      studioGetArtifact.handler(await ctx(), { display_path: String(shared.display_path) }),
      /studio_get_collection/,
    );

    // Create: nothing is written until the operator applies; the guild owns the table.
    const createArgs = {
      name: "leads",
      purpose: "One lead per company the scout finds.",
      columns: [column("email", "text", { required: true, unique: true }), column("status", "text", { values: ["new", "won"] })],
      access: { agents: [{ agent_id: "writer", mode: "read" }] },
      reason: "Leads are copied between Tasks as prose.",
    };
    await assert.rejects(
      studioCreateCollection.handler(await ctx(), { ...createArgs, access: { guild: "read" } }),
      /own table/,
    );
    await assert.rejects(studioCreateCollection.handler(await ctx(), { ...createArgs, name: "shared" }), /already exists/);
    const createWidget = (await studioCreateCollection.handler(await ctx(), createArgs)) as Widget;
    assert.equal(createWidget.widget, "studio_edit_request");
    assert.equal(createWidget.await_operator, true);
    assert.equal(createWidget.edit.kind, "collection");
    assert.equal(createWidget.edit.action, "create");
    assert.match(createWidget.edit.effects[0] ?? "", /table-guild's own table/);
    assert.equal(await artifacts.describeCollection(operator, "leads"), null);
    const createSeq = await commit("studio_create_collection", createArgs, createWidget as unknown as Record<string, unknown>);
    const createView = await view(createSeq);
    assert.equal(createView.stale, false);
    assert.equal(createView.live, "");
    assert.match(String(createView.proposed), /email \(text, required, unique\)/);
    assert.match(String(createView.proposed), /agent writer: read/);
    const applied = await resolve(createSeq, "apply");
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal((applied.json() as { status: string }).status, "applied");
    const leads = await artifacts.describeCollection(operator, "leads");
    assert.equal(leads?.guild_id, "guild_tb");
    const leadsAccess = await artifacts.listAccess(operator, String(leads?.id));
    assert.equal(leadsAccess.agents.find((row) => row.name === "writer")?.effective, "read");
    assert.equal((await resolve(createSeq, "apply")).statusCode, 409);

    // Read: the definition, who reaches it, and the latest records.
    await artifacts.addRecord(operator, { collection: "leads", body: { email: "a@example.com", status: "new" } });
    await artifacts.addRecord(operator, { collection: "leads", body: { email: "b@example.com", status: "won" } });
    const read = (await studioGetCollection.handler(await ctx(), { collection: "leads" })) as {
      updated_at: string;
      records: number;
      access: { own_table: boolean; agents: Array<{ name: string; effective: string | null }> };
      recent_records: string;
    };
    assert.equal(read.records, 2);
    assert.equal(read.access.own_table, true);
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
      studioEditCollection.handler(await ctx(), { collection: "leads", base_updated_at: "1999-01-01T00:00:00Z", purpose: "x", reason: "r" }),
      /stale/,
    );
    await assert.rejects(
      studioEditCollection.handler(await ctx(), { collection: "leads", base_updated_at: read.updated_at, reason: "r" }),
      /nothing to change/,
    );
    const editArgs = {
      collection: "leads",
      base_updated_at: read.updated_at,
      columns: [
        { ...column("contact", "text", { required: true, unique: true }), rename_from: "email" },
        column("score", "number"),
      ],
      access: { agents: [{ agent_id: "writer", mode: "inherit" }] },
      reason: "status is never read; score is.",
    };
    const editWidget = (await studioEditCollection.handler(await ctx(), editArgs)) as Widget;
    assert.ok(editWidget.edit.effects.includes("Drops status from 2 records."));
    assert.ok(editWidget.edit.effects.includes("Moves email to contact in 2 records."));
    const editSeq = await commit("studio_edit_collection", editArgs, editWidget as unknown as Record<string, unknown>);
    const editView = await view(editSeq);
    assert.equal(editView.stale, false);
    assert.match(String(editView.live), /status/);
    assert.match(String(editView.proposed), /contact .*\(renamed from email\)/);
    assert.equal((await resolve(editSeq, "apply")).statusCode, 200);
    const records = await artifacts.listRecords(operator, { collection: "leads" });
    assert.deepEqual(
      records.records.map((record) => [record.contact, record.status]),
      [
        ["a@example.com", undefined],
        ["b@example.com", undefined],
      ],
    );
    const afterEdit = await artifacts.listAccess(operator, String(leads?.id));
    assert.equal(afterEdit.agents.find((row) => row.name === "writer")?.agent_mode, null);

    // A proposal goes stale when the table changes underneath it, and declining leaves the table alone.
    const current = (await studioGetCollection.handler(await ctx(), { collection: "leads" })) as { updated_at: string };
    const purposeArgs = { collection: "leads", base_updated_at: current.updated_at, purpose: "Leads worth a call.", reason: "Sharper." };
    const purposeWidget = (await studioEditCollection.handler(await ctx(), purposeArgs)) as Record<string, unknown>;
    const purposeSeq = await commit("studio_edit_collection", purposeArgs, purposeWidget);
    await artifacts.updateCollection(operator, String(leads?.id), { purpose: "Changed on the Databases page." });
    assert.equal((await view(purposeSeq)).stale, true);
    assert.equal((await resolve(purposeSeq, "apply")).statusCode, 409);
    assert.equal((await resolve(purposeSeq, "decline")).statusCode, 200);
    assert.equal((await artifacts.describeCollection(operator, "leads"))?.purpose, "Changed on the Databases page.");

    // An organisation table: the guild's grant changes; grants outside the guild are shown, never changed.
    const sharedRead = (await studioGetCollection.handler(await ctx(), { collection: "shared" })) as { updated_at: string; outside: string[] };
    assert.deepEqual(sharedRead.outside, ["guild neighbour-guild read"]);
    const grantArgs = { collection: "shared", base_updated_at: sharedRead.updated_at, access: { guild: "write" }, reason: "The scout records facts." };
    const grantWidget = (await studioEditCollection.handler(await ctx(), grantArgs)) as Record<string, unknown>;
    const grantSeq = await commit("studio_edit_collection", grantArgs, grantWidget);
    assert.equal((await resolve(grantSeq, "apply")).statusCode, 200);
    const guildAccess = await artifacts.accessForGuild(operator, "guild_tb");
    assert.equal(guildAccess.find((row) => row.name === "shared")?.mode, "write");
    assert.equal((await artifacts.accessForGuild(operator, "guild_nb")).find((row) => row.name === "shared")?.mode, "read");

    // Delete: the card names the records and the readers outside the guild; apply removes the table.
    const deleteWidget = (await studioDeleteCollection.handler(await ctx(), { collection: "shared", reason: "Replaced." })) as Widget;
    assert.equal(deleteWidget.edit.action, "delete");
    assert.match(deleteWidget.edit.effects.join(" "), /neighbour-guild read/);
    const deleteSeq = await commit("studio_delete_collection", { collection: "shared", reason: "Replaced." }, deleteWidget as unknown as Record<string, unknown>);
    const deleteView = await view(deleteSeq);
    assert.equal(deleteView.proposed, "");
    assert.match(String(deleteView.live), /shared · organisation table/);
    assert.equal((await resolve(deleteSeq, "apply")).statusCode, 200);
    assert.equal(await artifacts.describeCollection(operator, "shared"), null);
  } finally {
    await app.close();
    await database.close();
  }
});
