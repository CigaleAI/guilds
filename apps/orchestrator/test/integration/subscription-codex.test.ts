import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp, buildHarnessMcpApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { installSubscriptionAgents } from "../../src/coding/harnesses.js";
import type { Database } from "../../src/db/client.js";
import { generationLoop, LOOP_TIMINGS, type GenerationLoop } from "../../src/generation/index.js";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import { sleep } from "../../src/lib/event.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { answerOps } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { FakeSandboxes } from "../helpers/generation.js";
import { HANG, mcpLine, recordedEvents, stubCliSandbox, stubsRunning } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// A Codex subscription agent's generations, driven through the run API: the stand-in CLI replays
// a recorded `codex exec --json` turn, and calls the orchestrator's MCP server on its own listener
// with the URL and token its turn's overrides and environment gave it.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_subscription_codex");
const timing = { ...harnessTurnTiming };

/** The thread of the recorded Codex turn, `harness/codex.jsonl`. */
const THREAD = "01a13707-f086-7261-8d15-5306e7a49a3c";

type MessageView = {
  seq: number;
  payload: { role: string; content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  metadata: Record<string, unknown>;
};

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === "object" && address !== null ? address.port : 0;
}

let database: Database;
let app: FastifyInstance;
let listener: FastifyInstance;
let loop: GenerationLoop;
let stub: ReturnType<typeof stubCliSandbox>;
let mcpUrl = "";

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  installSubscriptionAgents(true);
  database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-codex-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  stub = stubCliSandbox("codex", recordedEvents("codex"));
  answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "login" } });
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const port = await freePort();
  mcpUrl = `http://127.0.0.1:${port}`;
  loop = generationLoop(
    db,
    {
      notes,
      workspaceRoot: tempDir("guilds-subscription-codex-ws-"),
      harnessMcpUrl: mcpUrl,
      sandboxes: sandboxes as unknown as GenerationSandboxes,
      mcp: mcpPool(db),
      artifacts,
    },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  app = await buildApp(database, { db, notes, artifacts, scripts: agentScripts(db), schedules: agentSchedules(db), generation: loop });
  listener = await buildHarnessMcpApp(loop.harnessMcp);
  await listener.listen({ host: "127.0.0.1", port });
});

after(async () => {
  installSubscriptionAgents(false);
  Object.assign(harnessTurnTiming, timing);
  await listener.close();
  await app.close();
  await loop.close();
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function messages(runId: string): Promise<MessageView[]> {
  return (await app.inject({ method: "GET", url: `/api/runs/${runId}/messages`, headers: HEADERS })).json();
}

async function settled(runId: string) {
  for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
    await sleep(25);
  }
  return (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
}

/** A new guild with one Codex subscription agent whose config adds `config`; the agent's id. */
async function subscriber(name: string, config: Record<string, unknown> = {}): Promise<string> {
  const machineId = await codeDefaultMachine(app, HEADERS);
  await database.pool.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["codex"]]);
  const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name } });
  assert.equal(guild.statusCode, 201, guild.body);
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/agents`,
    headers: HEADERS,
    payload: { name: `${name}-agent`, config: { model: null, harness: "codex", ...config }, machine_id: machineId },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  return String(agent.json().id);
}

/** Opens a run of the agent with `message`; its id. */
async function startRun(agentId: string, message: string): Promise<string> {
  const created = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message } });
  assert.equal(created.statusCode, 202, created.body);
  return String(created.json().id);
}

const RECORDED = recordedEvents("codex");

test("a direct message to a Codex subscription agent runs a turn of codex exec, its items the run's rows, and resumes its thread", { timeout: 120_000 }, async () => {
  const agentId = await subscriber("codex-turns");
  stub.replay(RECORDED);
  const runId = await startRun(agentId, "Make the greeting name the guild.");
  const first = await settled(runId);
  assert.deepEqual(first.errors, []);
  const rows = await messages(runId);
  assert.deepEqual(
    rows.map((row) => row.payload.role),
    ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"],
  );
  const calls = rows.flatMap((row) => row.payload.tool_calls ?? []);
  assert.deepEqual(calls.map((call) => call.function.name), ["command_execution", "file_change", "command_execution"]);
  assert.ok(calls.every((call) => call.id.startsWith("turn_1_") && /\.item_\d+$/.test(call.id)), "each call is named under its turn");
  assert.equal(rows[3]?.payload.content, "print('hello')\n");
  assert.equal(rows[5]?.metadata.tool_name, "file_change", "a patch Codex reports only once applied is kept with its call");
  for (const row of rows.slice(2)) {
    assert.equal(row.metadata.from_harness, "codex");
  }
  assert.match(rows.at(-1)!.payload.content, /Should the greeting also name the agent\?$/);
  const [call] = stub.calls();
  assert.ok(call);
  assert.equal(call.argv[1], "exec");
  assert.equal(call.system_prompt, rows[0]?.payload.content, "the run's composed system prompt replaces Codex's instructions");
  assert.ok(call.system_prompt?.includes("`mcp__guilds__report_issue`"), "it names each tool as Codex's model calls it");
  assert.equal(call.stdin, "Make the greeting name the guild.");
  assert.ok(!call.argv.includes("resume"));
  assert.ok(!call.argv.includes("--max-turns"), "Codex takes no limit on its model calls");
  assert.equal(call.mcp_config?.mcpServers.guilds?.url, `${mcpUrl}/mcp/${agentId}`);

  assert.deepEqual(
    [rows.at(-1)?.metadata.usage, rows.at(-1)?.metadata.cost_source],
    [{ input_tokens: 9120, output_tokens: 212, cache_read_tokens: 4096 }, "subscription"],
    "the reply records the turn's usage, on the subscription",
  );

  // The next turn's usage is what the thread's total holds past the first turn's.
  const thread = { type: "turn.completed", usage: { input_tokens: 15000, cached_input_tokens: 6000, output_tokens: 300 } };
  stub.replay([...RECORDED.slice(0, -1), JSON.stringify(thread)]);
  const next = await app.inject({ method: "POST", url: `/api/runs/${runId}/messages`, headers: HEADERS, payload: { content: "Yes, name the agent too." } });
  assert.equal(next.statusCode, 202, next.body);
  await settled(runId);
  const resumed = await messages(runId);
  assert.deepEqual(resumed.at(-1)?.metadata.usage, { input_tokens: 5880, output_tokens: 88, cache_read_tokens: 1904 });
  const usage = (await app.inject({ method: "GET", url: `/api/agents/${agentId}/usage`, headers: HEADERS })).json();
  assert.deepEqual(
    [usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cost_usd, usage.calls],
    [15000, 300, 6000, 0, 2],
    "the agent's usage counts each turn's tokens, at no cost",
  );
  const second = stub.calls().at(-1);
  assert.ok(second);
  assert.deepEqual(second.argv.slice(1, 3), ["exec", "resume"]);
  assert.deepEqual(second.argv.slice(-2), [THREAD, "-"]);
  assert.equal(second.stdin, "Yes, name the agent too.");
  const again = (await messages(runId)).flatMap((row) => row.payload.tool_calls ?? []).map((item) => item.id);
  assert.equal(new Set(again).size, again.length, "Codex's item ids, numbered afresh each turn, name distinct calls of the run");
});

test("a Codex turn calls its Guilds tools on the MCP server under the token of its environment, and obeys max_tool_calls", { timeout: 120_000 }, async () => {
  const agentId = await subscriber("codex-mcp", { max_tool_calls: 2 });
  stub.replay([
    RECORDED[0]!,
    mcpLine("initialize", { protocolVersion: "2025-06-18", capabilities: {} }, 1),
    mcpLine("tools/call", { name: "note_find", arguments: { query: "greeting" } }, 2),
    mcpLine("tools/call", { name: "note_find", arguments: { query: "guild" } }, 3),
    mcpLine("tools/call", { name: "note_find", arguments: { query: "again" } }, 4),
    HANG,
  ]);
  const before = stub.mcpAnswers().length;
  const runId = await startRun(agentId, "Look around.");
  const run = await settled(runId);
  assert.equal(run.errors.at(-1)?.operation, "generation.max_tool_calls");
  assert.equal(run.status, "completed");
  assert.equal(stubsRunning(stub.bin), false, "the harness was stopped");
  const answers = stub.mcpAnswers().slice(before);
  assert.deepEqual(answers.map((answer) => [answer.method, answer.status]), [
    ["initialize", 200],
    ["tools/call", 200],
    ["tools/call", 200],
    ["tools/call", 200],
  ]);
  assert.deepEqual(answers.at(-1)?.answer?.result, { content: [{ type: "text", text: "Tool call limit reached. Start a new run to continue." }], isError: true });
  const rows = await messages(runId);
  const tools = rows.filter((row) => row.payload.role === "tool");
  assert.equal(tools.length, 2, "the refused call made no row");
  assert.ok(tools.every((row) => row.metadata.from_harness === undefined), "the calls are the run's own, not the harness's");
  assert.ok(!rows.some((row) => JSON.stringify(row.payload).includes("item_mcp_")), "the harness's own events for them make no row");
  const call = stub.calls().at(-1);
  assert.ok(call);
  const token = String(call.mcp_config?.mcpServers.guilds?.headers.Authorization).slice("Bearer ".length);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!call.argv.some((arg) => arg.includes(token)), "the token is on no command line");
});

test("a Codex turn past its agent's max_turn_minutes is stopped and ends the generation with harness.timed_out", { timeout: 120_000 }, async () => {
  const agentId = await subscriber("codex-minutes", { max_turn_minutes: 4 });
  const agent = (await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: HEADERS })).json();
  assert.equal(agent.config.max_turn_minutes, 4);
  stub.replay([RECORDED[0]!, HANG]);
  harnessTurnTiming.minuteMs = 100;
  try {
    const started = Date.now();
    const runId = await startRun(agentId, "Take your time.");
    const run = await settled(runId);
    assert.ok(Date.now() - started >= 400, "the turn ran its four minutes");
    assert.equal(run.config_snapshot.max_turn_minutes, 4);
    assert.equal(run.errors.at(-1)?.operation, "harness.timed_out");
    assert.match(String(run.errors.at(-1)?.message), /^Codex was stopped after 4 minutes\./);
    assert.equal(stubsRunning(stub.bin), false, "the harness was stopped");
  } finally {
    harnessTurnTiming.minuteMs = timing.minuteMs;
  }
});
