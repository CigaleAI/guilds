import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp, buildHarnessMcpApp } from "../../src/app.js";
import { attachmentService } from "../../src/attachments/store.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { getAgent } from "../../src/db/agents.js";
import { listRuns, type RunRow } from "../../src/db/runs.js";
import { generationLoop, LOOP_TIMINGS, type GenerationLoop } from "../../src/generation/index.js";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
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
import { HANG, mcpLine, RECORDED_SESSION, recordedEvents, stubCliSandbox, stubsRunning } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// Each way a run starts, driven through its edge for a Claude Code subscription agent against the
// stand-in CLI: an operator's message with an image, a group delivery, a routine's firing, a
// wake-up, and a resume, each one turn of the CLI given the orchestrator's MCP server.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_subscription_run_kinds");
const timing = { ...harnessTurnTiming };
const MINUTE = 60_000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-kinds-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  const attachments = attachmentService(db, new MemoryBlobStore());
  stub = stubCliSandbox("claude", recordedEvents("claude-code"));
  answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "secret" } });
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const port = await freePort();
  loop = generationLoop(
    db,
    {
      notes,
      workspaceRoot: tempDir("guilds-subscription-kinds-ws-"),
      harnessMcpUrl: `http://127.0.0.1:${port}`,
      sandboxes: sandboxes as unknown as GenerationSandboxes,
      mcp: mcpPool(db),
      artifacts,
      attachments,
    },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  app = await buildApp(database, {
    db,
    notes,
    artifacts,
    attachments,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    generation: loop,
  });
  listener = await buildHarnessMcpApp(loop.harnessMcp);
  await listener.listen({ host: "127.0.0.1", port });
  const machineId = await codeDefaultMachine(app, HEADERS);
  await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
});

after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await listener.close();
  await app.close();
  await loop.close();
  await database.close();
  await dropIsolatedDatabase(dbName);
});

const [INIT] = recordedEvents("claude-code");
const REPLY = recordedEvents("claude-code").slice(-2);

/** A new guild with one Claude Code subscription agent; their ids and the agent's name. */
async function subscriber(name: string): Promise<{ guildId: string; agentId: string; agentName: string }> {
  const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name } });
  assert.equal(guild.statusCode, 201, guild.body);
  const agentName = `${name}-agent`;
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/agents`,
    headers: HEADERS,
    payload: { name: agentName, config: { model: null, harness: "claude-code" } },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  return { guildId: String(guild.json().id), agentId: String(agent.json().id), agentName };
}

async function settled(runId: string) {
  for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
    await sleep(25);
  }
  return (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
}

/** The agent's runs of `kind`, once `ready` holds of them, the latest first. */
async function runsOf(agentId: string, kind: RunRow["kind"], ready: (runs: RunRow[]) => boolean): Promise<RunRow[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const runs = (await listRuns(database.pool, agentId)).filter((row) => row.kind === kind);
    if (ready(runs)) {
      return runs;
    }
    await sleep(25);
  }
  assert.fail(`no ${kind} run of ${agentId} became ready`);
}

/** Waits until the guild's chat delivers nothing more. */
async function chatIdle(guildId: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && loop.groupChat.isDispatching(guildId); attempt += 1) {
    await sleep(25);
  }
}

test("an image attached to a message reaches the harness as a file in the agent's home, named in its prompt", { timeout: 120_000 }, async () => {
  const { agentId } = await subscriber("kinds-image");
  stub.replay([INIT!, ...REPLY]);
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: { ...AUTH, "content-type": "application/octet-stream", "x-filename": "shot.png" },
    payload: PNG,
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const imageId = String(uploaded.json().id);
  const before = stub.calls().length;
  const created = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/runs`,
    headers: HEADERS,
    payload: { message: "What does this screenshot show?", attachment_ids: [imageId] },
  });
  assert.equal(created.statusCode, 202, created.body);
  const runId = String(created.json().id);
  const run = await settled(runId);
  assert.deepEqual(run.errors, []);
  const relative = `.runs/${runId}/attachments/${imageId}/shot.png`;
  assert.equal(stub.calls()[before]?.stdin, `What does this screenshot show?\nAttached image: /home/${agentId}/${relative}`);
  const agent = await getAgent(database.pool, agentId);
  const home = await loop.machines.agentWorkspace(agent);
  assert.deepEqual(readFileSync(path.join(home, ...relative.split("/"))), PNG, "the image's bytes are in the agent's home");
});

test("a group delivery runs a new session on the chat's latest messages, and the agent posts with group_post", { timeout: 120_000 }, async () => {
  const { guildId, agentId, agentName } = await subscriber("kinds-group");
  stub.replay([INIT!, mcpLine("tools/call", { name: "group_post", arguments: { content: "The digest is posted." } }, 1), ...REPLY]);
  const before = stub.calls().length;
  const posted = await app.inject({
    method: "POST",
    url: `/api/guilds/${guildId}/group-chat/messages`,
    headers: HEADERS,
    payload: { content: `@${agentName} post the weekly digest` },
  });
  assert.equal(posted.statusCode, 202, posted.body);
  const [delivered] = await runsOf(agentId, "group", (runs) => runs.some((row) => row.status === "completed"));
  await chatIdle(guildId);
  assert.ok(delivered);
  assert.deepEqual(delivered.errors, []);
  const call = stub.calls()[before];
  assert.match(String(call?.stdin), /^Group Chat info: /);
  assert.match(String(call?.stdin), /post the weekly digest/);
  assert.ok(!call?.argv.includes("--resume"), "a new run starts a new session");
  const chat = (await app.inject({ method: "GET", url: `/api/guilds/${guildId}/group-chat/messages`, headers: HEADERS })).json();
  const reply = JSON.stringify(chat);
  assert.match(reply, /The digest is posted\./, "the agent's post reached the chat through the MCP server");
  assert.ok(
    (chat.messages ?? chat).some((message: { author_type: string; content: string }) => message.author_type === "agent" && message.content === "The digest is posted."),
  );

  // Resumed, the one-shot run takes a message, which resumes the delivery's session.
  stub.replay([INIT!, ...REPLY]);
  const resumed = await app.inject({ method: "POST", url: `/api/runs/${delivered.id}/resume`, headers: AUTH });
  assert.equal(resumed.statusCode, 200, resumed.body);
  const followed = await app.inject({ method: "POST", url: `/api/runs/${delivered.id}/messages`, headers: HEADERS, payload: { content: "Add last week's numbers." } });
  assert.equal(followed.statusCode, 202, followed.body);
  await settled(delivered.id);
  const resume = stub.calls().at(-1);
  assert.deepEqual(resume?.argv.slice(-2), ["--resume", RECORDED_SESSION]);
  assert.equal(resume?.stdin, "Add last week's numbers.");
});

test("an interrupting post stops the agent's harness turn, and the chat delivers to it again", { timeout: 120_000 }, async () => {
  const { guildId, agentId, agentName } = await subscriber("kinds-interrupt");
  stub.replay([INIT!, HANG]);
  const posted = await app.inject({
    method: "POST",
    url: `/api/guilds/${guildId}/group-chat/messages`,
    headers: HEADERS,
    payload: { content: `@${agentName} research the market` },
  });
  assert.equal(posted.statusCode, 202, posted.body);
  // The run keeps the session once a poll read the CLI's first event, which the CLI prints after
  // it recorded its start and read its events: the next start is the interrupting one.
  const [running] = await runsOf(
    agentId,
    "group",
    (runs) => runs.length === 1 && runs[0]?.metadata.harness_turn?.session_id === RECORDED_SESSION && stubsRunning(stub.bin),
  );
  assert.ok(running);
  stub.replay([INIT!, ...REPLY]);
  const before = stub.calls().length;
  const interrupt = await app.inject({
    method: "POST",
    url: `/api/guilds/${guildId}/group-chat/messages`,
    headers: HEADERS,
    payload: { content: `@${agentName} stop, research the competitors instead`, interrupt: true },
  });
  assert.equal(interrupt.statusCode, 202, interrupt.body);
  const runs = await runsOf(agentId, "group", (rows) => rows.length === 2 && rows.every((row) => row.status === "completed"));
  await chatIdle(guildId);
  const stopped = runs.find((row) => row.id === running.id);
  assert.equal(stopped?.errors.at(-1)?.operation, "generation.cancelled");
  assert.match(String(stub.calls()[before]?.stdin), /research the competitors instead/);
});

test("a routine's firing runs a new session on its instruction, and the run completes", { timeout: 120_000 }, async () => {
  const { agentId } = await subscriber("kinds-routine");
  const routine = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/schedules`,
    headers: HEADERS,
    payload: { description: "Weekly digest", instruction: "Write the weekly digest from the notes.", cron: "0 9 * * 1" },
  });
  assert.equal(routine.statusCode, 201, routine.body);
  stub.replay([INIT!, ...REPLY]);
  const before = stub.calls().length;
  await loop.runs.fireDueSchedules(new Date(Date.now() + 8 * 24 * 60 * MINUTE));
  const [fired] = await runsOf(agentId, "schedule", (runs) => runs.length === 1);
  assert.ok(fired);
  const run = await settled(fired.id);
  assert.deepEqual(run.errors, []);
  assert.equal(run.status, "completed");
  const call = stub.calls()[before];
  assert.match(String(call?.stdin), /^Schedule wake-up: /);
  assert.match(String(call?.stdin), /Write the weekly digest from the notes\./);
  assert.ok(!call?.argv.includes("--resume"), "a new run starts a new session");
});

test("a wake-up the harness sets through the MCP server fires the run's next turn, which resumes its session", { timeout: 120_000 }, async () => {
  const { agentId } = await subscriber("kinds-wake");
  stub.replay([INIT!, mcpLine("tools/call", { name: "wake_after", arguments: { minutes: 5, message: "check the build" } }, 1), ...REPLY]);
  const created = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message: "Start the build, then come back to it." } });
  assert.equal(created.statusCode, 202, created.body);
  const runId = String(created.json().id);
  const first = await settled(runId);
  assert.deepEqual(first.errors, []);
  assert.ok(first.pending_wake, "the call set the run's wake-up");
  stub.replay([INIT!, ...REPLY]);
  const before = stub.calls().length;
  await loop.runWakes.fireDueWakes(new Date(Date.now() + 10 * MINUTE));
  for (let attempt = 0; attempt < 400 && stub.calls().length === before; attempt += 1) {
    await sleep(25);
  }
  const woken = await settled(runId);
  assert.deepEqual(woken.errors, []);
  assert.equal(woken.pending_wake, null);
  const call = stub.calls()[before];
  assert.match(String(call?.stdin), /^Wake-up: /);
  assert.match(String(call?.stdin), /check the build/);
  assert.deepEqual(call?.argv.slice(-2), ["--resume", RECORDED_SESSION]);
});
