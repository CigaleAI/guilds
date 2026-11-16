import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
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
import { GitServer } from "../helpers/git-server.js";
import { HANG, mcpLine, recordedEvents, runLine, stubCliSandbox, stubsRunning } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// A subscription agent on Cursor or Antigravity, which keep their vendor's own system prompt: it
// is created and kept only with a repository, and each turn, driven through the run API against
// the stand-in CLI, runs in that repository with the run's system prompt as a rules file in the
// home, the orchestrator's MCP server in the CLI's own configuration there, both gone when the
// turn ends, its events kept as the run's rows, and its session resumed.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const TOKEN = "glpat-rules-token";
const dbName = uniqueDbName("agent_platform_subscription_rules");
const timing = { ...harnessTurnTiming };

type MessageView = {
  payload: { role: string; content: string; tool_calls?: Array<{ id: string; function: { name: string } }> };
  metadata: Record<string, unknown>;
};

/** Each harness that reads the run's system prompt as rules: its CLI, its recorded turn, where it reads its rules and MCP server, and how it resumes. */
const HARNESSES = [
  {
    harness: "cursor",
    label: "Cursor",
    binary: "agent",
    recorded: "cursor",
    session: "6d1c0f3e-9b2a-4e57-8c41-2a7f5e9d0b13",
    rules: [".cursor", "rules", "guilds.mdc"],
    mcp: [".cursor", "mcp.json"],
    calls: ["read", "write", "shell"],
    prefix: "",
    resume: (session: string) => [`--resume=${session}`],
  },
  {
    harness: "antigravity",
    label: "Antigravity",
    binary: "agy",
    recorded: "antigravity",
    session: "d2a8e382-5989-4ac9-b319-5fcac6f49697",
    rules: [".gemini", "GEMINI.md"],
    mcp: [".gemini", "config", "mcp_config.json"],
    calls: ["run_command", "write_to_file", "run_command"],
    prefix: "mcp_guilds_",
    resume: (session: string) => ["--conversation", session],
  },
] as const;

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
let server: GitServer;
let guildId = "";
let mcpUrl = "";
let machineId = "";
// The agent's machine, made once the agent has its id, which names its home.
let stub: ReturnType<typeof stubCliSandbox> | null = null;

before(async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  server = new GitServer("oauth2", TOKEN);
  const host = await server.listen();
  server.createRepository("team/app.git");
  database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-rules-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub?.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const port = await freePort();
  mcpUrl = `http://127.0.0.1:${port}`;
  loop = generationLoop(
    db,
    {
      notes,
      workspaceRoot: tempDir("guilds-subscription-rules-ws-"),
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
  const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name: "rules" } });
  assert.equal(guild.statusCode, 201, guild.body);
  guildId = String(guild.json().id);
  const secret = await app.inject({ method: "POST", url: "/api/secrets", headers: HEADERS, payload: { name: "GIT_HOST_TOKEN", description: "git", value: TOKEN } });
  assert.equal(secret.statusCode, 201, secret.body);
  const added = await app.inject({
    method: "POST",
    url: `/api/guilds/${guildId}/repositories`,
    headers: HEADERS,
    payload: { name: "app", url: `${host}/team/app.git`, secret_id: String(secret.json().id), username: "oauth2" },
  });
  assert.equal(added.statusCode, 201, added.body);
  machineId = await codeDefaultMachine(app, HEADERS);
  await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["codex", "cursor", "antigravity"]]);
});

after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await listener.close();
  await app.close();
  await loop.close();
  await server.close();
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function createAgent(name: string, config: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/guilds/${guildId}/agents`,
    headers: HEADERS,
    payload: { name, config: { model: null, ...config }, machine_id: machineId },
  });
}

async function reconfigure(agentId: string, config: Record<string, unknown>) {
  const current = (await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: HEADERS })).json();
  return app.inject({ method: "PUT", url: `/api/agents/${agentId}/config`, headers: HEADERS, payload: { config: { ...current.config, ...config } } });
}

async function settled(runId: string) {
  for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
    await sleep(25);
  }
  return (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
}

async function messages(runId: string): Promise<MessageView[]> {
  return (await app.inject({ method: "GET", url: `/api/runs/${runId}/messages`, headers: HEADERS })).json();
}

/** A new agent on `harness` working in `app`, with its machine's stand-in CLI replaying `lines`; its id. */
async function workingAgent(name: string, harness: (typeof HARNESSES)[number], lines: string[], config: Record<string, unknown> = {}): Promise<string> {
  const created = await createAgent(name, { harness: harness.harness, repositories: ["app"], ...config });
  assert.equal(created.statusCode, 201, created.body);
  const agentId = String(created.json().id);
  stub = stubCliSandbox(harness.binary, lines, { GIT_SSL_CAINFO: server.caFile }, agentId);
  answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "login" } });
  return agentId;
}

test("a subscription agent on Cursor or Antigravity is created, and kept, only with a repository", async () => {
  for (const { harness, label } of HARNESSES) {
    const refusal = new RegExp(`${label} runs a subscription agent only with a repository, since it keeps its own system prompt: pick a repository, or another harness`);
    const bare = await createAgent(`${harness}-bare`, { harness });
    assert.equal(bare.statusCode, 422, bare.body);
    assert.match(bare.json().detail, refusal);
    const working = await createAgent(`${harness}-working`, { harness, repositories: ["app"] });
    assert.equal(working.statusCode, 201, working.body);
    const emptied = await reconfigure(String(working.json().id), { repositories: [] });
    assert.equal(emptied.statusCode, 422, emptied.body);
    assert.match(emptied.json().detail, refusal, "removing its last repository is refused");
    const codex = await createAgent(`${harness}-codex`, { harness: "codex" });
    assert.equal(codex.statusCode, 201, codex.body);
    const switched = await reconfigure(String(codex.json().id), { harness });
    assert.equal(switched.statusCode, 422, switched.body);
    assert.match(switched.json().detail, refusal, "switching to it without a repository is refused");
    const moved = await reconfigure(String(codex.json().id), { harness, repositories: ["app"] });
    assert.equal(moved.statusCode, 200, moved.body);
  }
});

for (const harness of HARNESSES) {
  test(`a ${harness.label} subscription agent's turn runs in its repository with the run's prompt as a rule and the MCP server in the CLI's configuration, both gone after it, its events the run's rows, and its session resumed`, { timeout: 180_000 }, async () => {
    const recorded = recordedEvents(harness.recorded);
    const lines = [
      recorded[0]!,
      runLine("git", "status", "--porcelain"),
      mcpLine("initialize", { protocolVersion: "2025-11-25", capabilities: {} }, 1),
      mcpLine("tools/call", { name: "note_find", arguments: { query: "greeting" } }, 2),
      ...recorded.slice(1),
    ];
    const agentId = await workingAgent(`${harness.harness}-turns`, harness, lines);
    const started = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message: "Make the greeting name the guild." } });
    assert.equal(started.statusCode, 202, started.body);
    const runId = String(started.json().id);
    const run = await settled(runId);
    assert.deepEqual(run.errors, []);
    assert.ok(stub);
    const home = stub.sandbox.home;
    const [call] = stub.calls();
    assert.ok(call);
    assert.equal(call.cwd, realpathSync(path.join(home, "repos", "app")), "the turn starts in its one repository");
    assert.match(String(call.system_prompt), /Your harness's own system prompt stays in force\. These instructions\nreach you as rules beside it/);
    assert.match(String(call.system_prompt), /You work in the git repositories State `repositories` lists/);
    assert.ok(String(call.system_prompt).includes(`\`${harness.prefix}report_issue\``), "it names each tool as the CLI's model calls it");
    assert.equal(call.mcp_config?.mcpServers.guilds?.url, `${mcpUrl}/mcp/${agentId}`);
    const token = String(call.mcp_config?.mcpServers.guilds?.headers.Authorization).slice("Bearer ".length);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!call.argv.some((arg) => arg.includes(token)), "the token is on no command line");
    assert.equal(call.mcp_config_mode, 0o600);
    assert.equal(existsSync(path.join(home, ...harness.rules)), false, "the rules file went with the turn");
    assert.equal(existsSync(path.join(home, ...harness.mcp)), false, "so did the MCP configuration");
    assert.deepEqual(stub.mcpAnswers().map((answer) => [answer.method, answer.status]), [["initialize", 200], ["tools/call", 200]]);

    const rows = await messages(runId);
    const status = rows.find((row) => row.payload.content.startsWith("exit="));
    assert.match(String(status?.payload.content), /^exit=0\s*$/, "the rules file is not in the repository's git status");
    const own = rows.flatMap((row) => (row.metadata.from_harness === harness.harness ? (row.payload.tool_calls ?? []) : []));
    assert.deepEqual(own.map((item) => item.function.name), [...harness.calls]);
    assert.ok(own.every((item) => item.id.startsWith(`turn_1_${runId}.`)), "each call is named under its turn");
    const guildCalls = rows.filter((row) => row.payload.role === "tool" && row.metadata.from_harness === undefined);
    assert.deepEqual(guildCalls.map((row) => row.metadata.tool_name), ["note_find"], "the MCP call is the run's own row, the harness's events of it none");
    const reply = rows.at(-1);
    assert.match(String(reply?.payload.content), /Should the greeting also name the agent\?\s*$/);
    if (harness.harness === "antigravity") {
      assert.deepEqual(
        [reply?.metadata.usage, reply?.metadata.cost_usd, reply?.metadata.cost_source],
        [{ input_tokens: 4806, output_tokens: 140, cache_read_tokens: 400 }, 0, "subscription"],
        "the reply records the conversation's tokens, at no price",
      );
    } else {
      assert.equal(reply?.metadata.usage, undefined, "a turn whose CLI reports no tokens records none");
    }

    stub.replay(recorded);
    const next = await app.inject({ method: "POST", url: `/api/runs/${runId}/messages`, headers: HEADERS, payload: { content: "Yes, name the agent too." } });
    assert.equal(next.statusCode, 202, next.body);
    const resumed = await settled(runId);
    assert.deepEqual(resumed.errors, []);
    const second = stub.calls().at(-1);
    assert.ok(second);
    const resume = harness.resume(harness.session);
    const at = second.argv.indexOf(resume[0]!);
    assert.deepEqual(second.argv.slice(at, at + resume.length), resume, "the next turn resumes the session");
    if (harness.harness === "antigravity") {
      assert.equal(second.stdin, '{"event": "user", "message": {"content": "Yes, name the agent too."}}\n', "the prompt is one message on stdin");
    } else {
      assert.match(String(second.argv.at(-1)), /^Read your task in .+\.prompt\.md and follow it\.$/, "the command line names the prompt file");
    }
  });
}

test("a Cursor turn's Guilds calls past max_tool_calls stop it, and a turn past max_turn_minutes is stopped", { timeout: 120_000 }, async () => {
  const [cursor] = HARNESSES;
  const [init] = recordedEvents("cursor");
  const agentId = await workingAgent("cursor-limits", cursor, [
    init!,
    mcpLine("tools/call", { name: "note_find", arguments: { query: "a" } }, 1),
    mcpLine("tools/call", { name: "note_find", arguments: { query: "b" } }, 2),
    HANG,
  ], { max_tool_calls: 1, max_turn_minutes: 4 });
  const started = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message: "Look around." } });
  const capped = await settled(String(started.json().id));
  assert.equal(capped.errors.at(-1)?.operation, "generation.max_tool_calls");
  assert.ok(stub);
  assert.equal(stubsRunning(stub.bin), false, "the harness was stopped");
  assert.ok(!stub.calls()[0]?.argv.includes("--max-turns"), "Cursor takes no limit on its model calls");

  stub.replay([init!, HANG]);
  harnessTurnTiming.minuteMs = 100;
  try {
    const slow = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message: "Take your time." } });
    const timed = await settled(String(slow.json().id));
    assert.equal(timed.errors.at(-1)?.operation, "harness.timed_out");
    assert.match(String(timed.errors.at(-1)?.message), /^Cursor was stopped after 4 minutes\./);
    assert.equal(stubsRunning(stub.bin), false, "the harness was stopped");
  } finally {
    harnessTurnTiming.minuteMs = timing.minuteMs;
  }
});
