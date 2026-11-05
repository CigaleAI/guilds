import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { getRun, listMessages, mergeRunMetadata } from "../../src/db/runs.js";
import type { RunError } from "../../src/db/schema/index.js";
import { getPendingRunWake, setRunWake } from "../../src/db/wakes.js";
import { generationLive } from "../../src/generation/completion.js";
import { RunRequestError } from "../../src/generation/errors.js";
import { generationLoop, type GenerationLoop } from "../../src/generation/index.js";
import type { ModelRequest } from "../../src/llm/completion.js";
import { newId } from "../../src/lib/ids.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { connect } from "../../src/seed/connect.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionCalling, completionReply, toolCall } from "../helpers/generation.js";
import { ExportSandboxes } from "../helpers/live.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};
const MINUTE = 60_000;

const dbName = uniqueDbName("agent_platform_run_wake_firing");
const previousStream = generationLive.streamCompletion;
/** The last message of each model call, in order. */
const lastMessages: string[] = [];
/** How the model answers a call: a tool call while this is set, text otherwise. */
let callTool: string | null = null;

let database: Database;
let app: FastifyInstance;
let loop: GenerationLoop;
let guildId: string;
let agentId: string;

function workspace(): { notes: NotesStore; root: string } {
  return {
    notes: new NotesStore(tempDir("guilds-wake-fire-notes-"), templatesRoot()),
    root: tempDir("guilds-wake-fire-ws-"),
  };
}

function loopOn(notes: NotesStore, root: string, schedulerTickMs?: number): GenerationLoop {
  const services = {
    mcp: mcpPool(database.pool),
    notes,
    workspaceRoot: root,
    sandboxes: new ExportSandboxes(root),
    artifacts: artifactStore(database.pool, notes.templates),
  };
  return schedulerTickMs === undefined
    ? generationLoop(database.pool, services)
    : generationLoop(database.pool, services, { idleTimeoutMs: 0, schedulerTickMs });
}

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  generationLive.streamCompletion = async function* stream(request: ModelRequest) {
    const last = request.messages.at(-1);
    lastMessages.push(typeof last?.content === "string" ? last.content : "");
    if (callTool !== null && last?.role !== "tool") {
      yield ["done", completionCalling([toolCall(newId("call"), callTool)])];
      return;
    }
    yield ["done", completionReply("checked")];
  };
  database = await connect(await createIsolatedDatabase(dbName));
  await connectModelProvider(database.pool, "org_home", "deepinfra");
  const { notes, root } = workspace();
  await notes.ensureSystemPrompt();
  loop = loopOn(notes, root);
  app = await buildApp(database, {
    db: database.pool,
    notes,
    scripts: agentScripts(database.pool),
    schedules: agentSchedules(database.pool),
    generation: loop,
  });
  const guild = await app.inject({
    method: "POST",
    url: "/api/guilds",
    headers: OWNER,
    payload: { name: "wake-fire" },
  });
  assert.equal(guild.statusCode, 201, guild.body);
  guildId = String(guild.json().id);
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${guildId}/agents`,
    headers: OWNER,
    payload: { name: "waker", config: { model: TEST_MODEL, browser: false, max_tool_calls: 1 } },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  agentId = String(agent.json().id);
});

beforeEach(async () => {
  callTool = null;
  lastMessages.length = 0;
  await database.pool.query("DELETE FROM run_wakes");
});

after(async () => {
  generationLive.streamCompletion = previousStream;
  await loop.close();
  await app.close();
  await database.close();
  await dropIsolatedDatabase(dbName);
});

/** An idle direct run of the agent, then given `kind`, `status`, and `errors`. */
async function seedRun(kind: string, status: string, errors: RunError[] = []): Promise<string> {
  const created = await loop.runs.createRun(agentId, null);
  await database.pool.query(
    "UPDATE runs SET kind = $2, status = $3, errors = $4::jsonb, group_chat_through_seq = $5 WHERE id = $1",
    [created.id, kind, status, JSON.stringify(errors), kind === "group" ? 3 : null],
  );
  return created.id;
}

function capError(operation: string): RunError {
  return {
    at: new Date().toISOString(),
    generation: 1,
    operation,
    error_type: "RunLimitError",
    message: "limit",
  };
}

/** A pending wake-up of the run, due `minutes` from now (in the past when negative). */
async function setWake(runId: string, minutes: number, rootRunId = runId): Promise<string> {
  const wakeId = newId("wk");
  await setRunWake(
    database.pool,
    {
      wakeId,
      runId,
      rootRunId,
      agentId,
      dueAt: new Date(Date.now() + minutes * MINUTE),
      message: "check deploy 4812",
      setToolCallId: "call_set",
    },
    new Date(),
  );
  return wakeId;
}

async function wakeState(
  wakeId: string,
): Promise<{ run_id: string; state: string; cancel_reason: string | null }> {
  const result = await database.pool.query<{
    run_id: string;
    state: string;
    cancel_reason: string | null;
  }>("SELECT run_id, state, cancel_reason FROM run_wakes WHERE id = $1", [wakeId]);
  const row = result.rows[0];
  assert.ok(row, `wake-up ${wakeId}`);
  return row;
}

/** Fires the due wake-ups and waits for the generation the run's wake-up started. */
async function fire(runId: string): Promise<void> {
  await loop.runWakes.fireDueWakes();
  await loop.generations.task(runId);
}

async function wakeMessages(runId: string) {
  return (await listMessages(database.pool, runId)).filter((row) => row.metadata.source === "wake");
}

describe("firing run wake-ups", { concurrency: 1 }, () => {
  test("a due wake-up opens the next generation of an active run, which stays active", async () => {
    const runId = await seedRun("direct", "active");
    const wakeId = await setWake(runId, -1);
    const stream = loop.events.subscribe(runId);
    await fire(runId);
    const committed: unknown[] = [];
    while (stream.size) {
      const [event, data] = await stream.get();
      if (
        event === "message.committed" &&
        data.metadata &&
        (data.metadata as { source?: string }).source === "wake"
      ) {
        committed.push((data.metadata as { wake_id?: string }).wake_id);
      }
    }
    loop.events.unsubscribe(runId, stream);
    assert.deepEqual(committed, [wakeId], "the wake-up message is published to the run's stream");
    const [message] = await wakeMessages(runId);
    assert.ok(message);
    assert.equal(message.metadata.wake_id, wakeId);
    assert.equal(message.metadata.reopened_run, false);
    assert.equal(message.metadata.generation, 1);
    assert.ok(message.payload.content.startsWith("Wake-up: "));
    const info: unknown = JSON.parse(message.payload.content.slice("Wake-up: ".length));
    assert.deepEqual(Object.keys(info as object), [
      "id",
      "set_at",
      "due_at",
      "fired_at",
      "message",
      "wake_ups_left",
    ]);
    assert.equal((info as { wake_ups_left: number }).wake_ups_left, 9);
    assert.equal((info as { message: string }).message, "check deploy 4812");
    assert.equal(
      lastMessages.at(-1),
      message.payload.content,
      "the model reads the wake-up message last",
    );
    assert.equal((await wakeState(wakeId)).state, "fired");
    assert.equal((await getRun(database.pool, runId))?.status, "active");
  });

  test("a wake-up not yet due, or whose agent is busy, stays pending", async () => {
    const runId = await seedRun("direct", "active");
    const later = await setWake(runId, 10);
    await loop.runWakes.fireDueWakes();
    assert.equal((await wakeState(later)).state, "pending");
    await database.pool.query("DELETE FROM run_wakes");
    const due = await setWake(runId, -1);
    const busy = await seedRun("direct", "active");
    await loop.beginGeneration(busy, agentId);
    try {
      await loop.runWakes.fireDueWakes();
      assert.equal((await wakeState(due)).state, "pending");
    } finally {
      loop.endGeneration(busy);
    }
    await fire(runId);
    assert.equal((await wakeState(due)).state, "fired");
  });

  test("a completed group run reopens for the wake generation, completes again, and keeps the delivery cursor", async () => {
    const runId = await seedRun("group", "completed");
    await database.pool.query("UPDATE agents SET group_chat_delivered_through = 7 WHERE id = $1", [
      agentId,
    ]);
    const wakeId = await setWake(runId, -1);
    await fire(runId);
    const [message] = await wakeMessages(runId);
    assert.equal(message?.metadata.reopened_run, true);
    assert.equal(message?.metadata.wake_id, wakeId);
    const run = await getRun(database.pool, runId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.metadata.resumed_at, undefined, "a wake-up's reopen is not a resume");
    assert.equal(run?.metadata.wake_reopened_generation, message?.metadata.generation);
    const cursor = await database.pool.query<{ through: number }>(
      "SELECT group_chat_delivered_through AS through FROM agents WHERE id = $1",
      [agentId],
    );
    assert.equal(cursor.rows[0]?.through, 7);
    await assert.rejects(loop.addMessage(runId, "and now?"), RunRequestError);
  });

  test("a completed routine run, and a run completed because its model could not be called, wake and complete again", async () => {
    for (const [kind, errors] of [
      ["schedule", []],
      ["direct", [capError("generation.model_key")]],
    ] as const) {
      const runId = await seedRun(kind, "completed", [...errors]);
      await setWake(runId, -1);
      await fire(runId);
      assert.equal((await wakeMessages(runId)).length, 1, kind);
      assert.equal((await getRun(database.pool, runId))?.status, "completed", kind);
      await assert.rejects(loop.addMessage(runId, "and now?"), RunRequestError);
    }
  });

  test("the ticker cancels the wake-up of a run that ended on a terminal cap and records wake.cancelled", async () => {
    for (const cap of [
      "generation.max_tool_calls",
      "generation.max_input_tokens",
      "generation.max_chain",
    ]) {
      const runId = await seedRun("direct", "completed", [capError(cap)]);
      const wakeId = await setWake(runId, -1);
      await loop.runWakes.fireDueWakes();
      assert.deepEqual(await wakeState(wakeId), {
        run_id: runId,
        state: "cancelled",
        cancel_reason: "limit",
      });
      assert.equal((await wakeMessages(runId)).length, 0);
      const error = (await getRun(database.pool, runId))?.errors.at(-1);
      assert.equal(error?.operation, "wake.cancelled");
      assert.equal(error?.error_type, "WakeCancelled");
      assert.match(
        error?.message ?? "",
        new RegExp(`${wakeId} cancelled: the run ended on ${cap}`),
      );
    }
  });

  test("a run that ends on its tool-call cap cancels its pending wake-up as the run ends", async () => {
    const runId = await seedRun("direct", "active");
    const wakeId = await setWake(runId, 30);
    callTool = "note_lookup";
    const events = loop.events.subscribe(runId);
    await loop.addMessage(runId, "work until the cap");
    await loop.generations.task(runId);
    assert.deepEqual(await wakeState(wakeId), {
      run_id: runId,
      state: "cancelled",
      cancel_reason: "limit",
    });
    const run = await getRun(database.pool, runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(
      run?.errors.map((entry) => entry.operation),
      ["generation.max_tool_calls", "wake.cancelled"],
    );
    const published: string[] = [];
    while (events.size) {
      const [event, data] = await events.get();
      if (event === "run.error") {
        published.push(String(data.operation));
      }
    }
    loop.events.unsubscribe(runId, events);
    assert.deepEqual(published, ["generation.max_tool_calls", "wake.cancelled"]);
  });

  test("a wake-up left on a run that continued moves to the last run of the chain and fires there", async () => {
    const first = await seedRun("direct", "completed");
    const second = await seedRun("direct", "completed");
    const third = await seedRun("direct", "active");
    await mergeRunMetadata(database.pool, first, { continued_by_run_id: second }, new Date());
    await mergeRunMetadata(database.pool, second, { continued_by_run_id: third }, new Date());
    const wakeId = await setWake(first, -1);
    await fire(third);
    assert.equal((await wakeState(wakeId)).run_id, third);
    assert.equal((await wakeState(wakeId)).state, "fired");
    assert.equal((await wakeMessages(first)).length, 0);
    assert.equal((await wakeMessages(third))[0]?.metadata.wake_id, wakeId);
  });

  test("a wake-up left on a run that continued is replaced by the pending one of the chain's last run", async () => {
    const first = await seedRun("direct", "completed");
    const second = await seedRun("direct", "active");
    await mergeRunMetadata(database.pool, first, { continued_by_run_id: second }, new Date());
    const stale = await setWake(first, -2);
    const own = await setWake(second, 20, first);
    await loop.runWakes.fireDueWakes();
    assert.deepEqual(await wakeState(stale), {
      run_id: first,
      state: "cancelled",
      cancel_reason: "replaced",
    });
    assert.equal((await getPendingRunWake(database.pool, second))?.id, own);
  });

  test("the count of wake-ups left is taken across the chain against the run's own cap", async () => {
    const first = await seedRun("direct", "active");
    await setWake(first, -1);
    await fire(first);
    const second = await seedRun("direct", "active");
    await database.pool.query(
      "UPDATE runs SET config_snapshot = jsonb_set(config_snapshot, '{max_wake_ups}', '2') WHERE id = $1",
      [second],
    );
    await setWake(second, -1, first);
    await fire(second);
    const [message] = await wakeMessages(second);
    assert.match(message?.payload.content ?? "", /"wake_ups_left": 0/);
  });

  test("a loop that starts after a wake-up came due fires it on its first tick, before the due routines", async () => {
    const runId = await seedRun("direct", "active");
    const wakeId = await setWake(runId, -5);
    const scheduleId = newId("sch");
    await database.pool.query(
      `INSERT INTO schedules (id, agent_id, instruction, next_run_at, created_at, updated_at, cron)
       VALUES ($1, $2, 'look again', $3, $3, $3, '0 0 * * *')`,
      [scheduleId, agentId, new Date(Date.now() - MINUTE).toISOString()],
    );
    const { notes, root } = workspace();
    const restarted = loopOn(notes, root, 20);
    restarted.runs.startScheduler();
    try {
      for (let wait = 0; wait < 200; wait += 1) {
        const routines = await database.pool.query("SELECT id FROM runs WHERE schedule_id = $1", [
          scheduleId,
        ]);
        if ((await wakeState(wakeId)).state === "fired" && routines.rows.length) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await restarted.close();
    }
    const fired = await database.pool.query<{ fired_at: string }>(
      "SELECT fired_at FROM run_wakes WHERE id = $1",
      [wakeId],
    );
    const routine = await database.pool.query<{ created_at: string }>(
      "SELECT created_at FROM runs WHERE schedule_id = $1",
      [scheduleId],
    );
    const firedAt = fired.rows[0]?.fired_at;
    const routineAt = routine.rows[0]?.created_at;
    assert.ok(firedAt && routineAt, "both the wake-up and the routine fired");
    assert.ok(
      new Date(firedAt) < new Date(routineAt),
      "the wake-up fired before the routine woke the agent",
    );
    await database.pool.query("DELETE FROM schedules WHERE agent_id = $1", [agentId]);
  });
});
