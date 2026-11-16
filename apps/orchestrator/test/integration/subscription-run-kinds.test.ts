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
import { recordedEvents, stubCliSandbox } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// Each way a run starts, driven through its edge for a Claude Code subscription agent against the
// stand-in CLI, each one turn of the CLI given the orchestrator's MCP server.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_subscription_run_kinds");
const timing = { ...harnessTurnTiming };
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
