import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { getRun, listMessages, mergeRunMetadata } from "../../src/db/runs.js";
import { iso } from "../../src/db/views.js";
import { getPendingRunWake, markRunWakeFired, setRunWake } from "../../src/db/wakes.js";
import { generationLive } from "../../src/generation/completion.js";
import { generationLoop, type GenerationLoop } from "../../src/generation/index.js";
import type { ModelRequest } from "../../src/llm/completion.js";
import { newId } from "../../src/lib/ids.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { connect } from "../../src/seed/connect.js";
import { offeredToolNames } from "../../src/toolbox/offered.js";
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

const dbName = uniqueDbName("agent_platform_wake_tools");
const previousStream = generationLive.streamCompletion;
/** The tool calls the model makes next, one per generation; it answers with text once a tool result comes back. */
const plannedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
/** The tool names each model call was offered, and the last message it read. */
const requests: Array<{ tools: string[]; last: string }> = [];

let database: Database;
let app: FastifyInstance;
let loop: GenerationLoop;
let agentId: string;

function offeredNames(request: ModelRequest): string[] {
  return (request.tools ?? []).flatMap((tool) => {
    const name = (tool as { function?: { name?: string } }).function?.name;
    return name ? [name] : [];
  });
}

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  generationLive.streamCompletion = async function* stream(request: ModelRequest) {
    const last = request.messages.at(-1);
    requests.push({
      tools: offeredNames(request),
      last: typeof last?.content === "string" ? last.content : "",
    });
    const planned = last?.role === "tool" ? undefined : plannedCalls.shift();
    if (planned === undefined) {
      yield ["done", completionReply("noted")];
      return;
    }
    yield ["done", completionCalling([toolCall(newId("call"), planned.name, planned.args)])];
  };
  database = await connect(await createIsolatedDatabase(dbName));
  await connectModelProvider(database.pool, "org_home", "deepinfra");
  const notes = new NotesStore(tempDir("guilds-wake-tools-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const root = tempDir("guilds-wake-tools-ws-");
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
  const guild = await app.inject({
    method: "POST",
    url: "/api/guilds",
    headers: OWNER,
    payload: { name: "wake-tools" },
  });
  assert.equal(guild.statusCode, 201, guild.body);
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/agents`,
    headers: OWNER,
    payload: { name: "waiter", config: { model: TEST_MODEL, browser: false } },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  agentId = String(agent.json().id);
});

beforeEach(() => {
  plannedCalls.length = 0;
  requests.length = 0;
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

/** Sends `content` to the run with the model calling `name` once, and returns that call's tool result. */
async function callTool(
  runId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  plannedCalls.push({ name, args });
  await loop.addMessage(runId, `call ${name}`);
  await loop.generations.task(runId);
  const result = (await listMessages(database.pool, runId))
    .filter((row) => row.payload.role === "tool")
    .at(-1);
  assert.ok(result, `a ${name} result`);
  return result.payload.content.replace(/\n\nremaining_tool_calls: \d+$/, "");
}

async function fireWakes(runIds: string[], count: number, rootRunId: string): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const runId = runIds[index % runIds.length] ?? rootRunId;
    const wakeId = newId("wk");
    await setRunWake(
      database.pool,
      {
        wakeId,
        runId,
        rootRunId,
        agentId,
        dueAt: new Date(),
        message: null,
        setToolCallId: `call_${index}`,
      },
      new Date(),
    );
    await markRunWakeFired(database.pool, wakeId, new Date());
  }
}

async function setAccess(tool: string, enabled: boolean): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/bindings",
    headers: OWNER,
    payload: {
      catalog_kind: "native_tool",
      catalog_id: tool,
      scope: "agent",
      scope_id: agentId,
      enabled,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
}

describe("the wake-up tools", { concurrency: 1 }, () => {
  test("wake_after sets the run's wake-up with its trimmed note and says how many are left", async () => {
    const runId = await newRun();
    const before = Date.now();
    const result = await callTool(runId, "wake_after", {
      minutes: 10,
      message: "  check CI run 77 on the Actions tab  ",
    });
    const pending = await getPendingRunWake(database.pool, runId);
    assert.ok(pending);
    assert.equal(
      result,
      `set ${pending.id}, due ${iso(pending.due_at)}\nreplaced: none\nwake_ups_left: 9`,
    );
    assert.equal(pending.message, "check CI run 77 on the Actions tab");
    assert.equal(pending.root_run_id, runId);
    const due = new Date(pending.due_at).getTime();
    assert.ok(due >= before + 10 * MINUTE && due <= Date.now() + 10 * MINUTE);
    const call = (await listMessages(database.pool, runId)).find(
      (row) => row.payload.role === "tool",
    );
    assert.equal(pending.set_tool_call_id, call?.metadata.tool_call_id);
  });

  test("a second wake_after replaces the pending wake-up, and a blank note is none", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_after", { minutes: 5 });
    const first = await getPendingRunWake(database.pool, runId);
    const result = await callTool(runId, "wake_after", { minutes: 20, message: "   " });
    const second = await getPendingRunWake(database.pool, runId);
    assert.ok(first && second && first.id !== second.id);
    assert.match(result, new RegExp(`\nreplaced: ${first.id}\n`));
    assert.equal(second.message, null);
    const replaced = await database.pool.query<{ state: string; cancel_reason: string }>(
      "SELECT state, cancel_reason FROM run_wakes WHERE id = $1",
      [first.id],
    );
    assert.deepEqual(replaced.rows[0], { state: "cancelled", cancel_reason: "replaced" });
  });

  test("wake_cancel cancels the pending wake-up, then says there is none", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_after", { minutes: 5 });
    const pending = await getPendingRunWake(database.pool, runId);
    assert.ok(pending);
    assert.equal(await callTool(runId, "wake_cancel"), `cancelled ${pending.id}`);
    assert.equal(await getPendingRunWake(database.pool, runId), null);
    const cancelled = await database.pool.query<{ cancel_reason: string }>(
      "SELECT cancel_reason FROM run_wakes WHERE id = $1",
      [pending.id],
    );
    assert.equal(cancelled.rows[0]?.cancel_reason, "agent");
    assert.equal(await callTool(runId, "wake_cancel"), "no pending wake-up");
  });

  test("wake_after refuses a delay or a note out of bounds and sets nothing", async () => {
    const runId = await newRun();
    for (const minutes of [0, 361, 2.5, "10"]) {
      assert.match(
        await callTool(runId, "wake_after", { minutes }),
        /^ERROR: minutes must be a whole number from 1 to 360/,
      );
    }
    assert.match(await callTool(runId, "wake_after"), /^ERROR: minutes is required/);
    assert.match(
      await callTool(runId, "wake_after", { minutes: 5, message: "x".repeat(1001) }),
      /^ERROR: message must be at most 1000 characters/,
    );
    assert.equal(await getPendingRunWake(database.pool, runId), null);
  });

  test("the eleventh wake_after of a run with the default cap is refused, and the tenth leaves none", async () => {
    const runId = await newRun();
    await fireWakes([runId], 9, runId);
    assert.match(await callTool(runId, "wake_after", { minutes: 5 }), /\nwake_ups_left: 0$/);
    const tenth = await getPendingRunWake(database.pool, runId);
    assert.ok(tenth);
    await markRunWakeFired(database.pool, tenth.id, new Date());
    assert.equal(
      await callTool(runId, "wake_after", { minutes: 5 }),
      "ERROR: this run has no wake-ups left: it fired the 10 it may",
    );
    assert.equal(await getPendingRunWake(database.pool, runId), null);
  });

  test("the count carries across a hand-off: a continuation counts the chain's fired wake-ups", async () => {
    const first = await newRun();
    const second = await newRun();
    await mergeRunMetadata(database.pool, first, { continued_by_run_id: second }, new Date());
    await mergeRunMetadata(
      database.pool,
      second,
      { chain: { root_run_id: first, index: 2, previous_run_id: first } },
      new Date(),
    );
    await fireWakes([first, second], 10, first);
    assert.match(
      await callTool(second, "wake_after", { minutes: 5 }),
      /^ERROR: this run has no wake-ups left/,
    );
  });

  test("a wake-up set by the tool fires on the tick and opens the run's next generation", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_after", { minutes: 1, message: "check deploy 4812" });
    const pending = await getPendingRunWake(database.pool, runId);
    assert.ok(pending);
    requests.length = 0;
    await loop.wakes.fireDueWakes(new Date(Date.now() + 2 * MINUTE));
    await loop.generations.task(runId);
    const opened = (await listMessages(database.pool, runId)).find(
      (row) => row.metadata.source === "wake",
    );
    assert.equal(opened?.metadata.wake_id, pending.id);
    assert.match(opened?.payload.content ?? "", /"message": "check deploy 4812"/);
    assert.match(opened?.payload.content ?? "", /"wake_ups_left": 9/);
    assert.equal(requests[0]?.last, opened?.payload.content);
    assert.equal((await getRun(database.pool, runId))?.status, "active");
  });

  test("turning the tools off removes both from the next generation's offer and from new runs", async () => {
    const runId = await newRun();
    await callTool(runId, "wake_cancel");
    assert.ok(
      requests[0]?.tools.includes("wake_after") && requests[0].tools.includes("wake_cancel"),
    );
    await setAccess("wake_after", false);
    await setAccess("wake_cancel", false);
    try {
      requests.length = 0;
      plannedCalls.length = 0;
      await loop.addMessage(runId, "anything new?");
      await loop.generations.task(runId);
      assert.equal(
        requests[0]?.tools.some((name) => name.startsWith("wake_")),
        false,
      );
      const fresh = await newRun();
      const snapshot = (await getRun(database.pool, fresh))?.config_snapshot;
      assert.equal(
        snapshot?.tools.some((tool) => tool.function.name.startsWith("wake_")),
        false,
      );
    } finally {
      await setAccess("wake_after", true);
      await setAccess("wake_cancel", true);
    }
  });

  test("both tools are offered on direct, group chat, and routine runs", () => {
    const names = ["note_find", "wake_after", "wake_cancel"];
    for (const kind of [
      { schedules: true, direct: true },
      { schedules: true, direct: false },
      { schedules: false, direct: false },
    ]) {
      const offered = offeredToolNames(names, kind);
      assert.ok(
        offered.includes("wake_after") && offered.includes("wake_cancel"),
        JSON.stringify(kind),
      );
    }
  });
});
