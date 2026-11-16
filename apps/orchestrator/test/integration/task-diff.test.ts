import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/seed/connect.js";
import type { GenerationLoop } from "../../src/generation/index.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, testEnv } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { addTestAgent } from "../helpers/agents.js";
import { createRun, insertMessage } from "../../src/db/runs.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_task_diff");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an old code_task call of a run has no diff or log route", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  Object.assign(process.env, env);
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const diffs: Array<[string, string, string | null]> = [];
  // Only what the routes reach: the group-chat feed they observe, and the diffs the coding runs read from the machine.
  const generation = {
    groupChat: { observe: () => undefined },
    coding: {
      async runDiff(runId: string, repository: string, task: string | null = null) {
        diffs.push([runId, repository, task]);
        return { diff: "+print('hello, guild')\n", truncated: false };
      },
    },
  } as unknown as GenerationLoop;
  const app = await buildApp(database, {
    db,
    notes,
    artifacts: artifactStore(database.pool, notes.templates),
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: mcpPool(db),
    generation,
  });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_AUTH, payload: { name: "diff-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const now = new Date();
    await addTestAgent(db, "org_home",
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
    for (const view of ["diff", "log"]) {
      const asked = await app.inject({ method: "GET", url: `/api/runs/r_diff/tasks/call_done/${view}`, headers: AUTH });
      assert.equal(asked.statusCode, 404, view);
    }
    assert.deepEqual(diffs, [], "the machine is never woken for an old code_task call");
  } finally {
    await app.close();
    await database.close();
  }
});
