import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { applyMigrations } from "../../src/db/client.js";
import { generationLoop, LOOP_TIMINGS } from "../../src/generation/index.js";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import { sleep } from "../../src/lib/event.js";
import { orchestratorRoot } from "../../src/lib/paths.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { answerOps } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { FakeSandboxes, runSnapshot } from "../helpers/generation.js";
import { freePort, recordedEvents, serveHarnessMcp, stubCliSandbox } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { connectModelProvider, TEST_MODEL } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_coding_agent_migration");
const timing = { ...harnessTurnTiming };

after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await dropIsolatedDatabase(dbName);
});

const SUBSCRIPTION_ONLY = "0032_subscription_agents_only";

/** When the subscription-only migration is stamped, as the migrations' journal records it. */
function subscriptionOnlyStamp(): number {
  const journal = path.join(orchestratorRoot(import.meta.url), "drizzle", "meta", "_journal.json");
  const { entries } = JSON.parse(readFileSync(journal, "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const entry = entries.find((item) => item.tag === SUBSCRIPTION_ONLY);
  assert.ok(entry, `no migration ${SUBSCRIPTION_ONLY}`);
  return entry.when;
}

/**
 * Puts the database back as it stood before the subscription-only migration: the wake-up's chain
 * column and its index, and no record of it or of a later migration, so the next boot applies them.
 */
async function rewindSubscriptionOnlyMigration(pool: Parameters<typeof applyMigrations>[0]): Promise<void> {
  await pool.query("DROP INDEX public.run_wakes_by_run");
  await pool.query("ALTER TABLE public.run_wakes ADD COLUMN root_run_id text");
  await pool.query("CREATE INDEX run_wakes_by_root ON public.run_wakes USING btree (root_run_id, state)");
  await pool.query("DELETE FROM public.__drizzle_migrations WHERE created_at >= $1", [subscriptionOnlyStamp()]);
}

type MessageView = { seq: number; payload: { role: string; tool_calls?: Array<{ function: { name: string } }> }; metadata: Record<string, unknown> };

test("a coding agent migrated to a subscription agent runs a turn of its CLI, and its old run still opens", { timeout: 120_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const notes = new NotesStore(tempDir("guilds-coding-migration-notes-"), templatesRoot());
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
      workspaceRoot: tempDir("guilds-coding-migration-ws-"),
      harnessMcpUrl: `http://127.0.0.1:${port}`,
      sandboxes: sandboxes as unknown as GenerationSandboxes,
      mcp: mcpPool(db),
      artifacts,
    },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  const listener = await serveHarnessMcp(loop, port);
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    generation: loop,
  });
  const settled = async (runId: string) => {
    for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
      await sleep(25);
    }
    return (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
  };
  try {
    const machineId = await codeDefaultMachine(app, HEADERS);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name: "coders" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const created = await app.inject({
      method: "POST",
      url: `/api/guilds/${String(guild.json().id)}/agents`,
      headers: HEADERS,
      payload: { name: "coder", config: { model: TEST_MODEL, temperature: 0.4 }, machine_id: machineId },
    });
    assert.equal(created.statusCode, 201, created.body);
    const agentId = String(created.json().id);

    // The agent as a coding agent stored it, with a run it made through `code_task`.
    await rewindSubscriptionOnlyMigration(db);
    await db.query(
      `UPDATE agents SET config = config || '{"coding": true, "harness": "claude-code", "max_steps": 200}'::jsonb WHERE id = $1`,
      [agentId],
    );
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO runs (id, agent_id, status, config_snapshot, metadata, created_at, updated_at, org_id)
       VALUES ('run_old', $1, 'completed', $2, $3, $4, $4, 'org_home')`,
      [
        agentId,
        JSON.stringify({ ...runSnapshot(), coding: true, harness: "claude-code" }),
        JSON.stringify({ repos: [{ repository: "site", files_changed: 1 }], continued_by_run_id: "run_next" }),
        now,
      ],
    );
    const message = (seq: number, payload: Record<string, unknown>, metadata: Record<string, unknown>) =>
      db.query("INSERT INTO messages (run_id, seq, payload, metadata, created_at) VALUES ('run_old', $1, $2, $3, $4)", [
        seq,
        JSON.stringify(payload),
        JSON.stringify(metadata),
        now,
      ]);
    await message(0, { role: "system", content: "Guidelines" }, { source: "system" });
    await message(1, { role: "user", content: "Carry on from the hand-off." }, { generation: 1, source: "continuation", previous_run_id: "run_prev" });
    await message(
      2,
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "code_task", arguments: "{}" } }] },
      { generation: 1 },
    );
    await message(
      3,
      { role: "tool", tool_call_id: "call_1", content: "Changed the greeting." },
      { generation: 1, tool_name: "code_task", truncated: false, harness: "claude-code", repository: "site", files_changed: 1, start_sha: "a", end_sha: "b" },
    );
    await applyMigrations(db);

    // The agent is a subscription agent on the harness it delegated to.
    const agent = await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: HEADERS });
    assert.equal(agent.statusCode, 200, agent.body);
    assert.equal(agent.json().model_source, "subscription");
    assert.equal(agent.json().config.model, null);
    assert.equal(agent.json().config.harness, "claude-code");
    assert.equal(agent.json().config.temperature, 1, "its model-loop settings take their defaults");
    assert.equal(agent.json().config.max_steps, 200);
    assert.equal("coding" in agent.json().config, false);

    // Its old run opens with every message, its code_task call among them.
    const old = await app.inject({ method: "GET", url: "/api/runs/run_old", headers: HEADERS });
    assert.equal(old.statusCode, 200, old.body);
    assert.equal(old.json().config_snapshot.model, runSnapshot().model, "the run keeps the model it ran on");
    assert.equal("coding" in old.json().config_snapshot, false);
    const oldMessages = await app.inject({ method: "GET", url: "/api/runs/run_old/messages", headers: HEADERS });
    assert.equal(oldMessages.statusCode, 200, oldMessages.body);
    const rows = oldMessages.json() as MessageView[];
    assert.deepEqual(rows.map((row) => row.payload.role), ["system", "user", "assistant", "tool"]);
    assert.equal(rows[1]?.metadata.source, "system");
    assert.equal(rows[2]?.payload.tool_calls?.[0]?.function.name, "code_task");
    assert.deepEqual(rows[3]?.metadata, { generation: 1, tool_name: "code_task", truncated: false });

    // A message to it runs one turn of its CLI.
    const run = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/runs`,
      headers: HEADERS,
      payload: { message: "Make the greeting name the guild." },
    });
    assert.equal(run.statusCode, 202, run.body);
    const turn = await settled(String(run.json().id));
    assert.deepEqual(turn.errors, []);
    assert.equal(turn.config_snapshot.model, null);
    assert.equal(stub.calls().length, 1);
    const turnRows = (await app.inject({ method: "GET", url: `/api/runs/${String(run.json().id)}/messages`, headers: HEADERS })).json() as MessageView[];
    assert.ok(turnRows.some((row) => row.metadata.from_harness === "claude-code"));
  } finally {
    await app.close();
    await listener.close();
    await loop.close();
    await database.close();
  }
});
