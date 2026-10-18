import assert from "node:assert/strict";
import { after, test } from "node:test";
import { persistAgent } from "../../src/agents/persist.js";
import { agentActor, ArtifactStore } from "../../src/artifacts/index.js";
import { DEFAULT_ARTIFACT_GRANTS } from "../../src/artifacts/types.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import type { ActivityView } from "../../src/studio/activity.js";
import { StudioService } from "../../src/studio/index.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

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

const HASHES = { systemPromptHash: "s", taskPromptHash: "t", memoryPromptHash: "m" };
const SNAPSHOT = { ...CONFIG, tools: [], mcp: [] };

const dbName = uniqueDbName("agent_platform_studio_activity");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("studio activity lists each wake with what started it and what it produced", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-activity-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo);
  const studio = new StudioService({ repo, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { repo, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await repo.insertGuild("guild_act", "activity-guild", now, "org_home", "Activity");
  for (const [agentId, name] of [
    ["a_scout", "scout"],
    ["a_desk", "desk"],
  ] as const) {
    await persistAgent(repo, notes, {
      agentId,
      guildId: "guild_act",
      guildName: "activity-guild",
      orgSlug: "home",
      orgId: "org_home",
      name,
      focus: "",
      config: CONFIG,
      now,
      artifacts,
    });
  }

  // The operator tags scout; scout's wake posts a row that tags desk.
  const first = await repo.postUserGroupMessage("guild_act", "@scout go", ["scout"], ["a_scout"], [], now, { authorName: "operator" });
  const firstSeq = Number(first?.seq);
  await repo.createGroupRun(
    "r_scout",
    "a_scout",
    SNAPSHOT,
    "system prompt",
    "task prompt",
    [
      [{ role: "user", content: "Group Chat info: {}" }, { generation: 1, source: "group_chat", group_seq: firstSeq, you_were_tagged: true }],
      [
        { role: "assistant", content: "", tool_calls: [{ id: "call_post", type: "function", function: { name: "group_post", arguments: "{}" } }] },
        { generation: 1 },
      ],
    ],
    firstSeq,
    now,
    { ...HASHES, runMetadata: { typesafe: { recipients: { source: "typesafe", choice: "scout", confidence: 0.9 } } } },
  );
  const second = await repo.postAgentGroupMessage("guild_act", "a_scout", "scout", "r_scout", "@desk leads ready", ["desk"], ["a_desk"], [], now);
  const secondSeq = Number(second?.seq);
  await repo.insertMessage(
    "r_scout",
    3,
    { role: "tool", tool_call_id: "call_post", content: `posted id=${String(second?.id)} seq=${secondSeq}` },
    { generation: 1, tool_name: "group_post", tool_call_id: "call_post", duration_ms: 12, error: null },
    now,
  );

  // desk's wake writes a note, then runs out of tool calls without posting.
  await repo.createGroupRun(
    "r_desk",
    "a_desk",
    SNAPSHOT,
    "system prompt",
    "task prompt",
    [[{ role: "user", content: "Group Chat info: {}" }, { generation: 1, source: "group_chat", group_seq: secondSeq, you_were_tagged: true }]],
    secondSeq,
    now,
    HASHES,
  );
  const deskActor = {
    ...agentActor({ orgId: "org_home", guildId: "guild_act", agentId: "a_desk", agentName: "desk", grants: DEFAULT_ARTIFACT_GRANTS, runId: "r_desk" }),
    toolCall: { id: "call_note", name: "note_write" },
  };
  await artifacts.writeNote(deskActor, { level: "agent", key: "leads.md", content: "- one\n", title: "Leads" });
  await repo.appendRunError("r_desk", { at: now.toISOString(), operation: "generation.max_tool_calls", message: "Tool call limit reached." }, now);

  // A routine wake for desk that changes nothing.
  const routine = await schedules.create("a_desk", { cron: "0 * * * *" }, "Hourly check", "Check the leads.");
  const scheduleId = String(routine.id);
  await repo.createScheduleRun(
    "r_tick",
    "a_desk",
    SNAPSHOT,
    "system prompt",
    "task prompt",
    [[{ role: "user", content: "Schedule wake-up: {}" }, { generation: 1, source: "schedule", schedule_id: scheduleId }]],
    now,
    { ...HASHES, scheduleId },
  );

  // The operator chats with scout directly.
  await repo.createRun("r_chat", "a_scout", SNAPSHOT, "system prompt", "task prompt", "how are the leads?", now, HASHES);

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_act", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };

    const res = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/activity?hours=1`, headers: AUTH });
    assert.equal(res.statusCode, 200, res.body);
    const view = res.json() as ActivityView;
    assert.deepEqual(view.agents.map((agent) => agent.name).sort(), ["desk", "scout"]);
    assert.deepEqual(view.routines, [
      { id: scheduleId, agent_id: "a_desk", description: "Hourly check", label: "Every hour (UTC)", instruction: "Check the leads." },
    ]);
    assert.deepEqual(view.messages.map((row) => [row.seq, row.author_type, row.source_run_id]), [
      [firstSeq, "user", null],
      [secondSeq, "agent", "r_scout"],
    ]);

    const byRun = new Map(view.wakes.map((wake) => [wake.run_id, wake]));
    const scout = byRun.get("r_scout");
    assert.deepEqual(scout?.trigger, {
      type: "message",
      seq: firstSeq,
      through_seq: firstSeq,
      reason: "tag",
      routing: { source: "typesafe", choice: "scout", confidence: 0.9 },
    });
    assert.equal(scout?.outcome, "posted");
    assert.deepEqual(scout?.posts.map((post) => [post.seq, post.call_id]), [[secondSeq, "call_post"]]);
    assert.deepEqual(scout?.tool_calls.map((call) => [call.call_id, call.name, call.error, call.duration_ms]), [["call_post", "group_post", null, 12]]);
    assert.equal(scout?.tool_call_count, 1);
    assert.equal(scout?.opening, null);
    assert.equal(scout?.failed, false);

    const desk = byRun.get("r_desk");
    assert.equal(desk?.trigger.type === "message" && desk.trigger.seq, secondSeq);
    assert.equal(desk?.outcome, "wrote");
    assert.equal(desk?.failed, true);
    assert.deepEqual(desk?.errors.map((error) => error.operation), ["generation.max_tool_calls"]);
    assert.deepEqual(desk?.writes.map((write) => [write.kind, write.target, write.call_id]), [["note", "leads.md", "call_note"]]);

    const chat = byRun.get("r_chat");
    assert.deepEqual(chat?.trigger, { type: "direct" });
    assert.equal(chat?.opening, "how are the leads?");

    const tick = byRun.get("r_tick");
    assert.deepEqual(tick?.trigger, { type: "routine", schedule_id: scheduleId });
    assert.equal(tick?.outcome, "silent");

    const bad = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/activity?hours=soon`, headers: AUTH });
    assert.equal(bad.statusCode, 422, bad.body);

    const stranger = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/activity`,
      headers: { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_other" },
    });
    assert.notEqual(stranger.statusCode, 200);
  } finally {
    await app.close();
    await database.close();
  }
});
