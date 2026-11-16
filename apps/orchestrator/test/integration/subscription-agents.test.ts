import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { installSubscriptionAgents } from "../../src/coding/harnesses.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { generationLoop, LOOP_TIMINGS } from "../../src/generation/index.js";
import { sleep } from "../../src/lib/event.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { HEX_MASTER_KEY, testEnv } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { connectModelProvider, TEST_MODEL } from "../helpers/models.js";
import { limitedPolicy } from "../helpers/policy.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const SUBSCRIPTION = { model: null, harness: "codex", harness_model: "gpt-6-luna", harness_effort: "high" };

const dbName = uniqueDbName("agent_platform_subscription_agents");

after(async () => {
  installSubscriptionAgents(false);
  await dropIsolatedDatabase(dbName);
});

test("a subscription agent is created, reconfigured, checked for readiness, and fails its runs at start", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  Object.assign(process.env, env);
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(db, notes.templates);
  const workspaceRoot = env.WORKSPACE_ROOT ?? "";
  const generation = generationLoop(
    db,
    { notes, workspaceRoot, harnessMcpUrl: "http://127.0.0.1:8090", sandboxes: new ExportSandboxes(workspaceRoot), mcp: mcpPool(db), artifacts },
    LOOP_TIMINGS,
  );
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: mcpPool(db),
    generation,
    policy: limitedPolicy({ maxCodingAgents: 1 }),
  });
  let guildId = "";
  let machineId = "";
  const createAgent = (name: string, config: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name, config, machine_id: machineId },
    });
  const reconfigure = (agentId: string, config: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/agents/${agentId}/config`, headers: JSON_AUTH, payload: { config } });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_AUTH, payload: { name: "subscription-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    guildId = String(guild.json().id);
    const machine = await app.inject({
      method: "POST",
      url: "/api/orgs/org_home/machines",
      headers: JSON_AUTH,
      payload: { name: "builder", box: "code" },
    });
    assert.equal(machine.statusCode, 201, machine.body);
    machineId = String(machine.json().id);
    const machines = await app.inject({ method: "GET", url: "/api/orgs/org_home/machines", headers: AUTH });
    const defaultMachineId = String(machines.json().find((item: { name: string }) => item.name === "default").id);

    // While the box turns subscription agents off, none is created and the catalog says so.
    installSubscriptionAgents(false);
    const offCatalog = await app.inject({ method: "GET", url: "/api/harnesses", headers: AUTH });
    assert.equal(offCatalog.json().subscription_agents, false);
    const refused = await createAgent("refused", SUBSCRIPTION);
    assert.equal(refused.statusCode, 422, refused.body);
    assert.match(refused.json().detail, /subscription agents are turned off on this box: give the agent a model on a key/);

    // With them on, an agent without a model runs on its harness: Claude Code or Codex.
    installSubscriptionAgents(true);
    const catalog = await app.inject({ method: "GET", url: "/api/harnesses", headers: AUTH });
    assert.equal(catalog.json().subscription_agents, true);
    assert.deepEqual(
      catalog.json().harnesses.filter((item: { subscription: boolean }) => item.subscription).map((item: { harness: string }) => item.harness),
      ["claude-code", "codex"],
    );
    const cursor = await createAgent("cursor", { model: null, harness: "cursor" });
    assert.equal(cursor.statusCode, 422, cursor.body);
    assert.match(cursor.json().detail, /Cursor cannot run a subscription agent: pick Claude Code or Codex/);
    const tuned = await createAgent("tuned", { ...SUBSCRIPTION, temperature: 0.3 });
    assert.equal(tuned.statusCode, 422, tuned.body);
    assert.match(tuned.json().detail, /a subscription agent takes no temperature/);

    // It needs a machine of the coding minimum whose image carries its harness.
    const standard = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name: "small", config: SUBSCRIPTION, machine_id: defaultMachineId },
    });
    assert.equal(standard.statusCode, 422, standard.body);
    assert.match(standard.json().detail, /a subscription agent needs a machine with at least 2 CPUs and 4 GiB; default has 1 CPU and 2 GiB/);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
    const uncarried = await createAgent("uncarried", SUBSCRIPTION);
    assert.equal(uncarried.statusCode, 422, uncarried.body);
    assert.match(uncarried.json().detail, /a subscription agent runs on Codex, which builder's image does not carry/);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code", "codex"]]);
    const created = await createAgent("subscriber", SUBSCRIPTION);
    assert.equal(created.statusCode, 201, created.body);
    const agentId = String(created.json().id);
    assert.equal(created.json().config.model, null);
    assert.equal(created.json().config.coding, false);
    assert.equal(created.json().config.harness, "codex");
    assert.equal(created.json().model_source, "subscription");
    // It holds one of the plan's coding agents, as a coding agent does.
    const second = await createAgent("second", SUBSCRIPTION);
    assert.equal(second.statusCode, 409, second.body);
    assert.match(second.json().detail, /limit reached: coding agents/);
    const listed = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/agents`, headers: AUTH });
    assert.deepEqual(
      listed.json().map((item: { name: string; model_source: string }) => [item.name, item.model_source]),
      [["subscriber", "subscription"]],
    );
    const plain = await createAgent("plain", { model: TEST_MODEL });
    assert.equal(plain.statusCode, 201, plain.body);
    const plainSwitched = await reconfigure(String(plain.json().id), { ...plain.json().config, ...SUBSCRIPTION });
    assert.equal(plainSwitched.statusCode, 409, plainSwitched.body);
    assert.match(plainSwitched.json().detail, /limit reached: coding agents/);

    // Its machine lists it on its subscription, and keeps the size it needs.
    const hosting = await app.inject({ method: "GET", url: "/api/orgs/org_home/machines", headers: AUTH });
    const builder = hosting.json().find((item: { id: string }) => item.id === machineId);
    assert.deepEqual(builder.agents.map((item: { name: string; model_source: string }) => [item.name, item.model_source]), [
      ["subscriber", "subscription"],
      ["plain", "key"],
    ]);
    assert.equal(builder.planned_cpu, 2.5);
    const shrunk = await app.inject({
      method: "PATCH",
      url: `/api/orgs/org_home/machines/${machineId}`,
      headers: JSON_AUTH,
      payload: { box: "standard" },
    });
    assert.equal(shrunk.statusCode, 409, shrunk.body);

    // Its harness, model, effort and credentials read as a coding agent's do.
    const harness = await app.inject({ method: "GET", url: `/api/agents/${agentId}/harness`, headers: AUTH });
    assert.equal(harness.statusCode, 200, harness.body);
    assert.equal(harness.json().harness, "codex");
    assert.equal(harness.json().harness_model, "gpt-6-luna");
    assert.equal(harness.json().harness_effort, "high");
    assert.equal(harness.json().repositories.length, 0);
    assert.ok(harness.json().harnesses.some((item: { harness: string }) => item.harness === "codex"));

    // A run of it fails at start, naming why.
    const run = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/runs`,
      headers: JSON_AUTH,
      payload: { message: "hello" },
    });
    assert.equal(run.statusCode, 202, run.body);
    const runId = String(run.json().id);
    let errors: Array<{ operation: string; message: string }> = [];
    for (let attempt = 0; attempt < 200 && errors.length === 0; attempt += 1) {
      await sleep(25);
      errors = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: AUTH })).json().errors;
    }
    assert.equal(errors.at(-1)?.operation, "subscription.not_runnable");
    assert.match(String(errors.at(-1)?.message), /Codex cannot run a subscription agent's turns yet: pick Claude Code/);
    const snapshot = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: AUTH })).json().config_snapshot;
    assert.equal(snapshot.model, null);
    assert.equal("model_source" in snapshot, false);

    // A subscription agent switches to a model on a key and back; off, the box keeps it on its subscription.
    const keyed = await reconfigure(agentId, { ...created.json().config, model: TEST_MODEL, harness: null, harness_model: null, harness_effort: null });
    assert.equal(keyed.statusCode, 200, keyed.body);
    assert.equal(keyed.json().config.model, TEST_MODEL);
    assert.equal(keyed.json().model_source, "key");
    const back = await reconfigure(agentId, { ...keyed.json().config, ...SUBSCRIPTION });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().model_source, "subscription");
    installSubscriptionAgents(false);
    const kept = await reconfigure(agentId, { ...back.json().config, harness_effort: "low" });
    assert.equal(kept.statusCode, 200, kept.body);
    assert.equal(kept.json().config.harness_effort, "low");
    const offKeyed = await reconfigure(agentId, { ...kept.json().config, model: TEST_MODEL, harness: null, harness_model: null, harness_effort: null });
    assert.equal(offKeyed.statusCode, 200, offKeyed.body);
    const offBack = await reconfigure(agentId, { ...offKeyed.json().config, ...SUBSCRIPTION });
    assert.equal(offBack.statusCode, 422, offBack.body);
    assert.match(offBack.json().detail, /subscription agents are turned off on this box/);
  } finally {
    installSubscriptionAgents(false);
    await app.close();
    await generation.close();
    await database.close();
  }
});
