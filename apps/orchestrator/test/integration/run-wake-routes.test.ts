import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import type { RunError } from "../../src/db/schema/index.js";
import { getPendingRunWake } from "../../src/db/wakes.js";
import { generationLive } from "../../src/generation/completion.js";
import type { RunEvent } from "../../src/generation/events.js";
import { generationLoop, type GenerationLoop } from "../../src/generation/index.js";
import type { ModelRequest } from "../../src/llm/completion.js";
import { newId } from "../../src/lib/ids.js";
import type { EventQueue } from "../../src/lib/event.js";
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

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const MINUTE = 60_000;

const dbName = uniqueDbName("agent_platform_run_wake_routes");
const previousStream = generationLive.streamCompletion;
/** The tool calls the model makes next, one per generation; it answers with text once a tool result comes back. */
const plannedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

let database: Database;
let app: FastifyInstance;
let loop: GenerationLoop;
let agentId: string;

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  generationLive.streamCompletion = async function* stream(request: ModelRequest) {
    const planned = request.messages.at(-1)?.role === "tool" ? undefined : plannedCalls.shift();
    if (planned === undefined) {
      yield ["done", completionReply("noted")];
      return;
    }
    yield ["done", completionCalling([toolCall(newId("call"), planned.name, planned.args)])];
  };
  database = await connect(await createIsolatedDatabase(dbName));
  await connectModelProvider(database.pool, "org_home", "deepinfra");
  const notes = new NotesStore(tempDir("guilds-wake-routes-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const root = tempDir("guilds-wake-routes-ws-");
  loop = generationLoop(database.pool, {
    mcp: mcpPool(database.pool),
    notes,
    workspaceRoot: root,
    sandboxes: new ExportSandboxes(root),
    artifacts: artifactStore(database.pool, notes.templates),
  });
  app = await buildApp(database, {
    db: database.pool,
    notes,
    scripts: agentScripts(database.pool),
    schedules: agentSchedules(database.pool),
    generation: loop,
  });
  const headers = { ...OWNER, "content-type": "application/json" };
  const guild = await app.inject({
    method: "POST",
    url: "/api/guilds",
    headers,
    payload: { name: "wake-routes" },
  });
  assert.equal(guild.statusCode, 201, guild.body);
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/agents`,
    headers,
    payload: { name: "sleeper", config: { model: TEST_MODEL, browser: false } },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  agentId = String(agent.json().id);
});

beforeEach(() => {
  plannedCalls.length = 0;
});

after(async () => {
  generationLive.streamCompletion = previousStream;
  await loop.close();
  await app.close();
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function newRun(): Promise<string> {
  return (await loop.runs.createRun(agentId, null)).id;
}

/** Sends a message the model answers by calling `name` once, and waits for the generation. */
async function callTool(
  runId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  plannedCalls.push({ name, args });
  await loop.addMessage(runId, `call ${name}`);
  await loop.generations.task(runId);
}

/** The `run.wake.changed` payloads the queue holds, in order; the queue is emptied. */
async function wakeChanges(queue: EventQueue<RunEvent>): Promise<Array<string | null>> {
  const changes: Array<string | null> = [];
  while (queue.size) {
    const [event, data] = await queue.get();
    if (event === "run.wake.changed") {
      const pending = data.pending_wake as { id?: string } | null;
      changes.push(pending?.id ?? null);
    }
  }
  return changes;
}

async function getRunView(runId: string) {
  const response = await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: OWNER });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

describe("a run's wake-up over HTTP", { concurrency: 1 }, () => {
  test("the run view carries the pending wake-up, and null without one", async () => {
    const runId = await newRun();
    assert.equal((await getRunView(runId)).pending_wake, null);
    await callTool(runId, "wake_after", { minutes: 15, message: "check the export" });
    const pending = await getPendingRunWake(database.pool, runId);
    assert.ok(pending);
    const view = await getRunView(runId);
    assert.deepEqual(Object.keys(view.pending_wake), ["id", "due_at", "message", "created_at"]);
    assert.equal(view.pending_wake.id, pending.id);
    assert.equal(view.pending_wake.message, "check the export");
    assert.equal(new Date(view.pending_wake.due_at).getTime(), new Date(pending.due_at).getTime());
    const listed = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/runs`,
      headers: OWNER,
    });
    assert.equal("pending_wake" in listed.json()[0], false, "run lists do not carry it");
  });

  test("DELETE /api/runs/:id/wake cancels it as the operator, then answers 404", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_after", { minutes: 15 });
    const pending = await getPendingRunWake(database.pool, runId);
    assert.ok(pending);
    const queue = loop.events.subscribe(runId);
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/runs/${runId}/wake`,
      headers: OWNER,
    });
    assert.equal(cancelled.statusCode, 204, cancelled.body);
    const row = await database.pool.query<{ cancel_reason: string }>(
      "SELECT cancel_reason FROM run_wakes WHERE id = $1",
      [pending.id],
    );
    assert.equal(row.rows[0]?.cancel_reason, "operator");
    assert.deepEqual(await wakeChanges(queue), [null]);
    loop.events.unsubscribe(runId, queue);
    assert.equal((await getRunView(runId)).pending_wake, null);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/runs/${runId}/wake`,
      headers: OWNER,
    });
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().detail, "no pending wake-up");
    const missing = await app.inject({
      method: "DELETE",
      url: `/api/runs/${newId("r")}/wake`,
      headers: OWNER,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().detail, "run not found");
  });

  test("another organisation's operator cannot cancel the wake-up", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_after", { minutes: 15 });
    const user = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { ...OWNER, "content-type": "application/json" },
      payload: { name: "stranger" },
    });
    assert.equal(user.statusCode, 201, user.body);
    const stranger = { "X-Guilds-User": String(user.json().id) };
    const refused = await app.inject({
      method: "DELETE",
      url: `/api/runs/${runId}/wake`,
      headers: stranger,
    });
    assert.equal(refused.statusCode, 404, refused.body);
    assert.ok(await getPendingRunWake(database.pool, runId), "the wake-up stays pending");
  });

  test("run.wake.changed follows each change: set, replaced, cancelled by the agent, and fired", async () => {
    const runId = await newRun();
    const queue = loop.events.subscribe(runId);
    await callTool(runId, "wake_after", { minutes: 5 });
    const first = await getPendingRunWake(database.pool, runId);
    await callTool(runId, "wake_after", { minutes: 1 });
    const second = await getPendingRunWake(database.pool, runId);
    await callTool(runId, "wake_cancel");
    await callTool(runId, "wake_after", { minutes: 1 });
    const third = await getPendingRunWake(database.pool, runId);
    assert.ok(first && second && third);
    assert.deepEqual(await wakeChanges(queue), [first.id, second.id, null, third.id]);
    await loop.runWakes.fireDueWakes(new Date(Date.now() + 2 * MINUTE));
    await loop.generations.task(runId);
    const events: string[] = [];
    while (queue.size) {
      const [event, data] = await queue.get();
      if (
        event === "run.wake.changed" ||
        (event === "message.committed" && JSON.stringify(data).includes('"source":"wake"'))
      ) {
        events.push(
          event === "run.wake.changed"
            ? `wake.changed ${JSON.stringify(data.pending_wake)}`
            : "wake message",
        );
      }
    }
    loop.events.unsubscribe(runId, queue);
    assert.deepEqual(events, ["wake message", "wake.changed null"]);
  });

  test("a run that ends on a cap publishes the cancelled wake-up", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_after", { minutes: 30 });
    const cap: RunError = {
      at: new Date().toISOString(),
      generation: 1,
      operation: "generation.max_tool_calls",
      error_type: "RunLimitError",
      message: "limit",
    };
    await database.pool.query("UPDATE runs SET errors = $2::jsonb WHERE id = $1", [
      runId,
      JSON.stringify([cap]),
    ]);
    await database.pool.query(
      "UPDATE run_wakes SET due_at = $2 WHERE run_id = $1 AND state = 'pending'",
      [runId, new Date(Date.now() - MINUTE).toISOString()],
    );
    const queue = loop.events.subscribe(runId);
    await loop.runWakes.fireDueWakes();
    assert.deepEqual(await wakeChanges(queue), [null]);
    loop.events.unsubscribe(runId, queue);
  });
});
