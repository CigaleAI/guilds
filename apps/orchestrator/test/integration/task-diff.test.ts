import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/seed/connect.js";
import type { GenerationLoop } from "../../src/generation/index.js";
import { McpPool } from "../../src/mcp/index.js";
import { artifactStore } from "../../src/artifacts/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, testEnv } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { addAgent } from "../../src/agents/persist.js";
import { createRun, insertMessage } from "../../src/db/runs.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_task_diff");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a code_task's diff and log are read from its own checkpoints and log, and a call without them has none", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  Object.assign(process.env, env);
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const diffs: Array<[string, string, string | null]> = [];
  const logs: Array<[string, string, string]> = [];
  // Only what the routes reach: the group-chat feed they observe, and the diff and log the coding runs read from the machine.
  const generation = {
    groupChat: { observe: () => undefined },
    coding: {
      async runDiff(runId: string, repository: string, task: string | null = null) {
        diffs.push([runId, repository, task]);
        return { diff: "+print('hello, guild')\n", truncated: false };
      },
      async harnessLog(runId: string, callId: string, harness: string) {
        logs.push([runId, callId, harness]);
        return { lines: ["Bash: ls"], raw: '{"type":"init"}\n', bytes: 16 };
      },
    },
  } as unknown as GenerationLoop;
  const app = await buildApp(database, {
    db,
    notes,
    artifacts: artifactStore(database.pool, notes.templates),
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: new McpPool(),
    generation,
  });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_AUTH, payload: { name: "diff-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const now = new Date();
    await addAgent(db,
      {
        agentId: "a_diff",
        guildId: String(guild.json().id),
        name: "coder",
        config: agentConfig({ model: "openrouter/openai/gpt-5.6-luna" }),
      },
      now,
    );
    await createRun(db,
      {
        runId: "r_diff",
        agentId: "a_diff",
        configSnapshot: runSnapshot(),
        systemContent: "sys",
        taskContent: "task",
        userContent: null,
        systemPromptHash: "s",
        taskPromptHash: "t",
        memoryPromptHash: "m",
      },
      now,
    );
    const result = (callId: string, metadata: Record<string, unknown>, seq: number) =>
      insertMessage(db,
        {
          runId: "r_diff",
          seq,
          payload: { role: "tool", tool_call_id: callId, content: "done" },
          metadata: { tool_call_id: callId, ...metadata },
        },
        now,
      );
    await result(
      "call_done",
      {
        tool_name: "code_task",
        harness: "codex",
        repository: "app",
        end_sha: "b".repeat(40),
        log_path: ".runs/r_diff/call_done.harness.jsonl",
      },
      1,
    );
    await result("call_lost", { tool_name: "code_task", repository: "app", end_sha: null }, 2);
    await result("call_read", { tool_name: "file_read" }, 3);
    const diff = (callId: string) =>
      app.inject({ method: "GET", url: `/api/runs/r_diff/tasks/${callId}/diff`, headers: AUTH });

    const done = await diff("call_done");
    assert.equal(done.statusCode, 200, done.body);
    assert.deepEqual(done.json(), { repository: "app", diff: "+print('hello, guild')\n", truncated: false });
    assert.deepEqual(diffs, [["r_diff", "app", "call_done"]]);

    for (const callId of ["call_lost", "call_read", "call_missing"]) {
      const none = await diff(callId);
      assert.equal(none.statusCode, 404, callId);
      assert.match(none.body, /that call has no task diff/);
    }
    assert.equal(diffs.length, 1, "the machine is never woken for a call without a diff");

    const log = (callId: string) =>
      app.inject({ method: "GET", url: `/api/runs/r_diff/tasks/${callId}/log`, headers: AUTH });
    const kept = await log("call_done");
    assert.equal(kept.statusCode, 200, kept.body);
    assert.deepEqual(kept.json(), { lines: ["Bash: ls"], raw: '{"type":"init"}\n', bytes: 16 });
    assert.deepEqual(logs, [["r_diff", "call_done", "codex"]]);
    for (const callId of ["call_lost", "call_read", "call_missing"]) {
      const none = await log(callId);
      assert.equal(none.statusCode, 404, callId);
      assert.match(none.body, /that call has no harness log/);
    }
    assert.equal(logs.length, 1, "the machine is never woken for a call without a log");
  } finally {
    await app.close();
    await database.close();
  }
});
