import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp, buildHarnessMcpApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
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

// A Claude Code subscription agent's generation, driven through the run API, with the stand-in CLI
// calling the orchestrator's MCP server on its own listener through the configuration file and
// token its turn was given.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_subscription_mcp");
const timing = { ...harnessTurnTiming };

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
  database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-mcp-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  stub = stubCliSandbox("claude", recordedEvents("claude-code"));
  answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "secret" } });
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
      workspaceRoot: tempDir("guilds-subscription-mcp-ws-"),
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

/** A new guild with one Claude Code subscription agent whose config adds `config`; their ids. */
async function subscriber(name: string, config: Record<string, unknown> = {}): Promise<{ guildId: string; agentId: string }> {
  const machineId = await codeDefaultMachine(app, HEADERS);
  await database.pool.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
  const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name } });
  assert.equal(guild.statusCode, 201, guild.body);
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/agents`,
    headers: HEADERS,
    payload: { name: `${name}-agent`, config: { model: null, harness: "claude-code", ...config }, machine_id: machineId },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  return { guildId: String(guild.json().id), agentId: String(agent.json().id) };
}

/** Opens a run of the agent with `message`; its id. */
async function startRun(agentId: string, message: string): Promise<string> {
  const created = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message } });
  assert.equal(created.statusCode, 202, created.body);
  return String(created.json().id);
}

const [INIT] = recordedEvents("claude-code");
const REPLY = recordedEvents("claude-code").slice(-2);

test("a subscription agent's harness calls its Guilds tools on the MCP server, kept as the run's own tool calls", { timeout: 120_000 }, async () => {
  const { guildId, agentId } = await subscriber("mcp-tools");
  stub.replay([
    INIT!,
    mcpLine("initialize", { protocolVersion: "2025-11-25", capabilities: {} }, 1),
    mcpLine("tools/list", {}, 2),
    mcpLine("tools/call", { name: "note_write", arguments: { key: "findings.md", content: "The greeting names the guild." } }, 3),
    mcpLine("tools/call", { name: "group_post", arguments: { content: "Greeting updated." } }, 4),
    mcpLine("tools/call", { name: "shell", arguments: { command: "id" } }, 5),
    JSON.stringify({ stub: "show_mcp_config" }),
    ...REPLY,
  ]);
  const before = stub.mcpAnswers().length;
  const runId = await startRun(agentId, "Record what you found and tell the guild.");
  const run = await settled(runId);
  assert.deepEqual(run.errors, []);

  const offered: string[] = run.config_snapshot.tools.map((tool: { function: { name: string } }) => tool.function.name);
  assert.ok(offered.includes("note_write") && offered.includes("group_post") && offered.includes("report_issue"), "the snapshot records the offer");
  for (const sandboxTool of ["shell", "shell_status", "file_read", "code_search", "code_task"]) {
    assert.ok(!offered.includes(sandboxTool), sandboxTool);
  }

  const answers = stub.mcpAnswers().slice(before);
  assert.deepEqual(answers.map((answer) => [answer.method, answer.status]), [
    ["initialize", 200],
    ["tools/list", 200],
    ["tools/call", 200],
    ["tools/call", 200],
    ["tools/call", 200],
  ]);
  assert.equal((answers[0]?.answer?.result?.serverInfo as { name: string }).name, "guilds");
  const listed = (answers[1]?.answer?.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.deepEqual(new Set(listed), new Set(offered), "the server lists the run's offer");
  assert.deepEqual(answers[4]?.answer?.error, { code: -32602, message: "unknown tool shell" });

  const rows = await messages(runId);
  const calls = rows.filter((row) => row.payload.tool_calls?.some((call) => call.id.startsWith("mcp_")));
  assert.deepEqual(calls.map((row) => row.payload.tool_calls?.[0]?.function.name), ["note_write", "group_post"]);
  for (const row of calls) {
    assert.equal(row.metadata.from_harness, undefined, "a Guilds tool row, not the harness's");
    const result = rows.find((other) => other.seq === row.seq + 1);
    assert.equal(result?.payload.role, "tool", "the call's result follows it");
    assert.match(String(result?.payload.content), /remaining_tool_calls: \d+$/);
  }
  assert.ok(!rows.some((row) => JSON.stringify(row.payload).includes("toolu_mcp_")), "the harness's own events for those calls make no row");
  assert.ok(rows.at(-1)?.payload.role === "assistant");

  const notes = (await app.inject({ method: "GET", url: `/api/agents/${agentId}/notes`, headers: HEADERS })).json();
  assert.match(JSON.stringify(notes), /findings\.md/, "the note was written");
  const chat = (await app.inject({ method: "GET", url: `/api/guilds/${guildId}/group-chat/messages`, headers: HEADERS })).json();
  assert.match(JSON.stringify(chat), /Greeting updated\./, "the post reached the guild's chat");

  const call = stub.calls().at(-1);
  assert.ok(call?.mcp_config);
  const server = call.mcp_config.mcpServers.guilds;
  assert.equal(server?.url, `${mcpUrl}/mcp/${agentId}`);
  const authorization = String(server?.headers.Authorization);
  assert.match(authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
  assert.equal(call.mcp_config_mode, 0o600);
  assert.ok(!call.argv.some((arg) => arg.includes(authorization.slice(7))), "the token is on no command line");
  const configFile = call.argv[call.argv.indexOf("--mcp-config") + 1]!;
  assert.equal(existsSync(path.join(configFile)), false, "the configuration file went with the turn");
  const shown = rows.find((row) => row.payload.content.includes("mcpServers"));
  assert.ok(shown, "the harness printed its configuration");
  assert.ok(!shown.payload.content.includes(authorization.slice(7)), "the run's rows never show the token");
  assert.match(shown.payload.content, /\[REDACTED:HARNESS_MCP_TOKEN\]/);
  const revoked = await fetch(`${mcpUrl}/mcp/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(revoked.status, 401, "the token went with the generation");
});

test("a call past max_tool_calls is refused with the limit message, and the generation ends on generation.max_tool_calls", { timeout: 120_000 }, async () => {
  const { agentId } = await subscriber("mcp-limit", { max_tool_calls: 2 });
  stub.replay([
    INIT!,
    mcpLine("tools/call", { name: "note_find", arguments: { query: "greeting" } }, 1),
    mcpLine("tools/call", { name: "note_find", arguments: { query: "guild" } }, 2),
    mcpLine("tools/call", { name: "note_find", arguments: { query: "again" } }, 3),
    HANG,
  ]);
  const before = stub.mcpAnswers().length;
  const runId = await startRun(agentId, "Look around.");
  const run = await settled(runId);
  assert.equal(run.errors.at(-1)?.operation, "generation.max_tool_calls");
  assert.equal(run.status, "completed");
  assert.equal(stubsRunning(stub.bin), false, "the harness was stopped");
  const refused = stub.mcpAnswers().slice(before).at(-1);
  assert.deepEqual(refused?.answer?.result, { content: [{ type: "text", text: "Tool call limit reached. Start a new run to continue." }], isError: true });
  const rows = await messages(runId);
  assert.equal(rows.filter((row) => row.payload.role === "tool").length, 2, "the refused call made no row");
  assert.match(String(rows.filter((row) => row.payload.role === "tool").at(-1)?.payload.content), /remaining_tool_calls: 0$/);
});

test("a call that files a blocking issue ends the generation as blocked, and stops the harness", { timeout: 120_000 }, async () => {
  const { agentId } = await subscriber("mcp-blocked");
  stub.replay([
    INIT!,
    mcpLine("tools/call", { name: "report_issue", arguments: { summary: "Login refused", detail: "The login errored.", kind: "tool_failure", severity: "blocking" } }, 1),
    HANG,
  ]);
  const runId = await startRun(agentId, "Try the login.");
  const run = await settled(runId);
  assert.equal(run.errors.at(-1)?.operation, "generation.blocked", JSON.stringify(run.errors));
  assert.equal(stubsRunning(stub.bin), false, "the harness was stopped");
  const rows = await messages(runId);
  const result = rows.find((row) => row.payload.role === "tool" && row.metadata.tool_name === "report_issue");
  assert.ok(typeof result?.metadata.blocking_issue_id === "string");
});
