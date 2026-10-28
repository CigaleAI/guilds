import assert from "node:assert/strict";
import { after, test } from "node:test";
import { addAgent } from "../../src/agents/service.js";
import { systemActor } from "../helpers/agents.js";
import { agentActor } from "../../src/artifacts/actors.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import type { ActivityView } from "../../src/studio/activity.js";
import { StudioService } from "../../src/studio/index.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { userActor } from "../../src/lib/change-actor.js";
import { insertGuild } from "../../src/db/guilds.js";
import { postAgentGroupMessage, postUserGroupMessage } from "../../src/db/group-chat.js";
import {
  appendRunError,
  createGroupRun,
  createRun,
  createScheduleRun,
  insertMessage,
} from "../../src/db/runs.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";
import { writeNote } from "../../src/artifacts/service.js";

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

const HASHES = { systemPromptHash: "s", taskPromptHash: "t", memoryPromptHash: "m" };
const SNAPSHOT = runSnapshot(CONFIG);

const dbName = uniqueDbName("agent_platform_studio_activity");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("studio activity lists each wake with what started it and what it produced", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-studio-activity-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(scriptDatabase(db));
  const schedules = new Schedules(scheduleDatabase(db));
  const studio = new StudioService({ db, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });

  const now = new Date();
  await insertGuild(db,
    { guildId: "guild_act", name: "activity-guild", orgId: "org_home", about: "Activity" },
    now,
  );
  for (const [agentId, name] of [
    ["a_scout", "scout"],
    ["a_desk", "desk"],
  ] as const) {
    await addAgent(
      { db, notes, artifacts },
      { agent: { agentId, guildId: "guild_act", name, config: CONFIG, focus: "" }, task: "", placement: {} },
      systemActor("org_home", { guildId: "guild_act", agentId }),
      now,
    );
  }

  // The operator tags scout; scout's wake posts a row that tags desk.
  const first = await postUserGroupMessage(db,
    {
      guildId: "guild_act",
      content: "@scout go",
      taggedNames: ["scout"],
      taggedAgentIds: ["a_scout"],
      taggedUserIds: [],
      authorName: "operator",
      authorUserId: "user_operator",
    },
    now,
  );
  const firstSeq = Number(first?.seq);
  await createGroupRun(db,
    {
      runId: "r_scout",
      agentId: "a_scout",
      configSnapshot: SNAPSHOT,
      systemContent: "system prompt",
      taskContent: "task prompt",
      projected: [
        [
          { role: "user", content: "Group Chat info: {}" },
          { generation: 1, source: "group_chat", group_seq: firstSeq, you_were_tagged: true },
        ],
        [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_post",
                type: "function",
                function: { name: "group_post", arguments: "{}" },
              },
            ],
          },
          { generation: 1 },
        ],
      ],
      throughSeq: firstSeq,
      ...HASHES,
      runMetadata: {
        typesafe: { recipients: { source: "typesafe", names: ["scout"], choice: "scout", confidence: 0.9 } },
      },
    },
    now,
  );
  const second = await postAgentGroupMessage(db,
    {
      guildId: "guild_act",
      agentId: "a_scout",
      authorName: "scout",
      sourceRunId: "r_scout",
      content: "@desk leads ready",
      taggedNames: ["desk"],
      taggedAgentIds: ["a_desk"],
      taggedUserIds: [],
    },
    now,
  );
  const secondSeq = Number(second?.seq);
  await insertMessage(db,
    {
      runId: "r_scout",
      seq: 3,
      payload: {
        role: "tool",
        tool_call_id: "call_post",
        content: `posted id=${String(second?.id)} seq=${secondSeq}`,
      },
      metadata: {
        generation: 1,
        tool_name: "group_post",
        tool_call_id: "call_post",
        duration_ms: 12,
        error: null,
      },
    },
    now,
  );

  // desk's wake, which stores the row that woke it, writes a note, then runs out of tool calls without posting.
  await createGroupRun(db,
    {
      runId: "r_desk",
      agentId: "a_desk",
      configSnapshot: SNAPSHOT,
      systemContent: "system prompt",
      taskContent: "task prompt",
      projected: [
        [
          { role: "user", content: "Group Chat info: {}" },
          { generation: 1, source: "group_chat", group_seq: secondSeq, you_were_tagged: true },
        ],
      ],
      throughSeq: secondSeq,
      ...HASHES,
      wakeGroupMessageId: Number(second?.id),
    },
    now,
  );
  const deskActor = {
    ...agentActor({ orgId: "org_home", guildId: "guild_act", agentId: "a_desk", agentName: "desk", runId: "r_desk" }),
    toolCall: { id: "call_note", name: "note_write" },
  };
  await writeNote(artifacts, deskActor, { level: "agent", key: "leads.md", content: "- one\n", title: "Leads" });
  await appendRunError(
    db,
    "r_desk",
    { at: now.toISOString(), generation: 1, operation: "generation.max_tool_calls", error_type: "RunLimitError", message: "Tool call limit reached." },
    now,
  );

  // A routine wake for desk that changes nothing.
  const routine = await schedules.create(TEST_ACTOR, "a_desk", { cron: "0 * * * *" }, "Hourly check", "Check the leads.");
  const scheduleId = String(routine.id);
  await createScheduleRun(db,
    {
      runId: "r_tick",
      agentId: "a_desk",
      configSnapshot: SNAPSHOT,
      systemContent: "system prompt",
      taskContent: "task prompt",
      projected: [
        [
          { role: "user", content: "Schedule wake-up: {}" },
          { generation: 1, source: "schedule", schedule_id: scheduleId },
        ],
      ],
      ...HASHES,
      scheduleId,
    },
    now,
  );

  // The operator chats with scout directly.
  await createRun(db,
    {
      runId: "r_chat",
      agentId: "a_scout",
      configSnapshot: SNAPSHOT,
      systemContent: "system prompt",
      taskContent: "task prompt",
      userContent: "how are the leads?",
      ...HASHES,
      startedByUserId: "user_operator",
    },
    now,
  );

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
    assert.deepEqual(view.messages.map((row) => [row.seq, row.author_type, row.author_user_id, row.source_run_id]), [
      [firstSeq, "user", "user_operator", null],
      [secondSeq, "agent", null, "r_scout"],
    ]);

    const byRun = new Map(view.wakes.map((wake) => [wake.run_id, wake]));
    const scout = byRun.get("r_scout");
    assert.deepEqual(scout?.trigger, {
      type: "message",
      seq: firstSeq,
      through_seq: firstSeq,
      reason: "tag",
      routing: { source: "typesafe", choice: "scout", confidence: 0.9 },
      inferred: true,
    });
    assert.equal(scout?.outcome, "posted");
    assert.deepEqual(scout?.posts.map((post) => [post.seq, post.call_id]), [[secondSeq, "call_post"]]);
    assert.deepEqual(scout?.tool_calls.map((call) => [call.call_id, call.name, call.error, call.duration_ms]), [["call_post", "group_post", null, 12]]);
    assert.equal(scout?.tool_call_count, 1);
    assert.equal(scout?.opening, null);
    assert.equal(scout?.failed, false);

    const desk = byRun.get("r_desk");
    assert.equal(desk?.trigger.type === "message" && desk.trigger.seq, secondSeq);
    assert.equal(desk?.trigger.type === "message" && desk.trigger.inferred, false);
    assert.equal(desk?.outcome, "wrote");
    assert.equal(desk?.failed, true);
    assert.deepEqual(desk?.errors.map((error) => error.operation), ["generation.max_tool_calls"]);
    assert.deepEqual(desk?.writes.map((write) => [write.kind, write.target, write.call_id]), [["note", "leads.md", "call_note"]]);

    const chat = byRun.get("r_chat");
    assert.deepEqual(chat?.trigger, { type: "direct", user_id: "user_operator" });
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
