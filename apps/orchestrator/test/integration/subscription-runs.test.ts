import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { generationLoop, LOOP_TIMINGS } from "../../src/generation/index.js";
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
import { freePort, HANG, RECORDED_SESSION, recordedEvents, serveHarnessMcp, stubCliSandbox, stubsRunning } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_subscription_runs");
const timing = { ...harnessTurnTiming };

after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await dropIsolatedDatabase(dbName);
});

type MessageView = {
  seq: number;
  payload: { role: string; content: string; tool_calls?: Array<{ id: string; function: { name: string } }> };
  metadata: Record<string, unknown>;
};

test("a direct message to a Claude Code subscription agent runs a turn of its CLI, resumes it, and cancels it", { timeout: 120_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  const stub = stubCliSandbox("claude", recordedEvents("claude-code"));
  answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "secret" } });
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const port = await freePort();
  const loop = generationLoop(
    db,
    {
      notes,
      workspaceRoot: tempDir("guilds-subscription-ws-"),
      harnessMcpUrl: `http://127.0.0.1:${port}`,
      sandboxes: sandboxes as unknown as GenerationSandboxes,
      mcp: mcpPool(db),
      artifacts,
    },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  const listener = await serveHarnessMcp(loop, port);
  const published: string[] = [];
  const publish = loop.events.publish.bind(loop.events);
  loop.events.publish = async (runId, ...event) => {
    published.push(event[0]);
    await publish(runId, ...event);
  };
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    generation: loop,
  });
  const messages = async (runId: string): Promise<MessageView[]> =>
    (await app.inject({ method: "GET", url: `/api/runs/${runId}/messages`, headers: HEADERS })).json();
  const settled = async (runId: string) => {
    for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
      await sleep(25);
    }
    return (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
  };
  try {
    const machineId = await codeDefaultMachine(app, HEADERS);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name: "subscribers" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${String(guild.json().id)}/agents`,
      headers: HEADERS,
      payload: { name: "subscriber", config: { model: null, harness: "claude-code" }, machine_id: machineId },
    });
    assert.equal(agent.statusCode, 201, agent.body);

    // The opening message runs one turn of the CLI: its messages and tool calls are the run's rows.
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${String(agent.json().id)}/runs`,
      headers: HEADERS,
      payload: { message: "Make the greeting name the guild." },
    });
    assert.equal(created.statusCode, 202, created.body);
    const runId = String(created.json().id);
    const first = await settled(runId);
    assert.deepEqual(first.errors, []);
    assert.equal(first.config_snapshot.model, null);
    assert.ok(
      first.config_snapshot.tools.some((tool: { function: { name: string } }) => tool.function.name === "report_issue"),
      "the run offers its harness the Guilds tools, through the MCP server",
    );
    const rows = await messages(runId);
    assert.deepEqual(
      rows.map((row) => row.payload.role),
      ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"],
    );
    assert.equal(rows[2]?.payload.tool_calls?.[0]?.function.name, "Read");
    assert.equal(rows[3]?.metadata.from_harness, "claude-code");
    assert.match(rows.at(-1)!.payload.content, /Should the greeting also name the agent\?$/);
    assert.ok(published.includes("generation.started"));
    assert.equal(published.filter((name) => name === "message.committed").length, 7);
    assert.ok(published.includes("generation.finished"));
    const [call] = stub.calls();
    assert.ok(call);
    assert.equal(call.system_prompt, rows[0]?.payload.content, "the run's composed system prompt replaces Claude Code's own");
    assert.ok(call.system_prompt?.includes("`mcp__guilds__report_issue`"), "it names each tool as Claude Code calls it");
    assert.ok(call.system_prompt?.includes("$GUILDS_PORTS"));
    assert.equal(call.stdin, "Make the greeting name the guild.");
    assert.ok(!call.argv.includes("--resume"));
    assert.equal(call.argv[call.argv.indexOf("--max-turns") + 1], String(first.config_snapshot.max_steps), "the turn makes at most max_steps model calls");

    // The next message resumes the session the first turn reported.
    const next = await app.inject({ method: "POST", url: `/api/runs/${runId}/messages`, headers: HEADERS, payload: { content: "Yes, name the agent too." } });
    assert.equal(next.statusCode, 202, next.body);
    await settled(runId);
    const second = stub.calls()[1];
    assert.ok(second);
    assert.deepEqual(second.argv.slice(-2), ["--resume", RECORDED_SESSION]);
    assert.equal(second.stdin, "Yes, name the agent too.");

    // A cancel stops the CLI mid-tool, and its call gets the interrupted result.
    stub.replay([...recordedEvents("claude-code").slice(0, 2), HANG]);
    const before = (await messages(runId)).length;
    const third = await app.inject({ method: "POST", url: `/api/runs/${runId}/messages`, headers: HEADERS, payload: { content: "Once more." } });
    assert.equal(third.statusCode, 202, third.body);
    for (let attempt = 0; attempt < 400 && (await messages(runId)).length < before + 2; attempt += 1) {
      await sleep(25);
    }
    const cancelled = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel`, headers: AUTH });
    assert.equal(cancelled.statusCode, 202, cancelled.body);
    assert.equal(stubsRunning(stub.bin), false);
    const after = await messages(runId);
    assert.equal(after.at(-1)?.payload.role, "tool");
    assert.equal(after.at(-1)?.payload.content, "ERROR: execution interrupted");
    assert.equal(after.at(-1)?.metadata.from_harness, "claude-code");
    assert.equal(cancelled.json().errors.at(-1)?.operation, "generation.cancelled");
  } finally {
    await app.close();
    await listener.close();
    await loop.close();
    await database.close();
  }
});
