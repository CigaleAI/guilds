import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { GenerationLoop } from "../../src/generation/index.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { McpPool } from "../../src/mcp/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, testEnv } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_machines");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an organisation's machines host its agents: placement, tiers, resizes, moves, and deletes", { timeout: 60_000 }, async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  Object.assign(process.env, env);
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, notes.templates);
  const workspaceRoot = env.WORKSPACE_ROOT ?? "";
  const sandboxes = new ExportSandboxes(workspaceRoot);
  const generation = new GenerationLoop(repo, notes, workspaceRoot, sandboxes, {
    mcp: new McpPool(),
    artifacts,
    idleTimeoutMs: 5 * 60 * 1000,
  });
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: new McpPool(),
    generation,
  });
  let guildId = "";
  const createAgent = (name: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: JSON_AUTH,
      payload: { name, config: { model: TEST_MODEL, ...config }, ...extra },
    });
  const machines = async () => {
    const listed = await app.inject({ method: "GET", url: "/api/orgs/org_home/machines", headers: AUTH });
    assert.equal(listed.statusCode, 200, listed.body);
    return listed.json() as Array<Record<string, unknown> & { agents: Array<{ name: string }> }>;
  };
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: JSON_AUTH, payload: { name: "machine-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    guildId = String(guild.json().id);

    // An organisation starts with one standard machine named default.
    const [first] = await machines();
    assert.equal(first?.name, "default");
    assert.equal(first?.box, "standard");
    assert.equal(first?.cpu, 1);
    assert.equal(first?.memory_mib, 2048);
    const defaultId = String(first?.id);

    // With one machine, an agent goes on it without naming it; its config has no box.
    const scripter = await createAgent("scripter", {});
    assert.equal(scripter.statusCode, 201, scripter.body);
    assert.equal(scripter.json().machine_id, defaultId);
    assert.deepEqual(scripter.json().machine, { id: defaultId, name: "default", box: "standard" });
    assert.equal("box" in scripter.json().config, false);
    assert.equal("box" in scripter.json(), false);
    const browser = await createAgent("browser", { browser: true });
    assert.equal(browser.statusCode, 201, browser.body);

    // A box in the config is refused, and coding needs a code or custom machine.
    const boxed = await createAgent("boxed", { box: "code" });
    assert.equal(boxed.statusCode, 422, boxed.body);
    assert.match(boxed.json().detail, /unknown keys: box/);
    const coder = await createAgent("coder", { coding: true, harness: "claude-code" });
    assert.equal(coder.statusCode, 422, coder.body);
    assert.match(coder.json().detail, /coding needs a code or custom machine/);

    // Owners and admins add machines; a name is unique, a custom one carries its size.
    const code = await app.inject({
      method: "POST",
      url: "/api/orgs/org_home/machines",
      headers: JSON_AUTH,
      payload: { name: "builder", box: "code" },
    });
    assert.equal(code.statusCode, 201, code.body);
    const codeId = String(code.json().id);
    assert.equal(code.json().memory_mib, 4096);
    const taken = await app.inject({
      method: "POST",
      url: "/api/orgs/org_home/machines",
      headers: JSON_AUTH,
      payload: { name: "builder" },
    });
    assert.equal(taken.statusCode, 409, taken.body);
    const unsized = await app.inject({
      method: "POST",
      url: "/api/orgs/org_home/machines",
      headers: JSON_AUTH,
      payload: { name: "sized", box: "custom" },
    });
    assert.equal(unsized.statusCode, 422, unsized.body);

    // With two machines, an agent names its machine.
    const unplaced = await createAgent("unplaced", {});
    assert.equal(unplaced.statusCode, 422, unplaced.body);
    assert.match(unplaced.json().detail, /machine_id is required/);
    const placed = await createAgent("coder", { coding: true, harness: "claude-code" }, { machine_id: codeId });
    assert.equal(placed.statusCode, 201, placed.body);
    assert.equal(placed.json().machine.name, "builder");
    assert.equal(placed.json().config.max_steps, 200, "a new coding agent takes the coding budgets");
    assert.equal("deprecated" in placed.json(), false);
    const coderId = String(placed.json().id);
    assert.equal((await machines()).find((item) => item.id === codeId)?.harnesses, null, "before its container first started");

    // A coding agent stored without a harness is not ready: it saves nothing until a harness is picked.
    await repo.pool.query(`UPDATE agents SET config = config - 'harness' WHERE id = $1`, [coderId]);
    const stripped = await app.inject({ method: "GET", url: `/api/agents/${coderId}`, headers: AUTH });
    assert.equal(stripped.statusCode, 200, stripped.body);
    assert.equal("deprecated" in stripped.json(), false);
    const unpicked = await app.inject({ method: "GET", url: `/api/agents/${coderId}/harness`, headers: AUTH });
    assert.equal(unpicked.json().harness, null);
    const unsaved = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...stripped.json().config, temperature: 0.5 } },
    });
    assert.equal(unsaved.statusCode, 422, unsaved.body);
    assert.match(unsaved.json().detail, /coding agents need a harness/);
    const picked = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...stripped.json().config, harness: "codex" } },
    });
    assert.equal(picked.statusCode, 200, picked.body);
    const status = await app.inject({ method: "GET", url: `/api/agents/${coderId}/harness`, headers: AUTH });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().harness, "codex");
    assert.equal(status.json().harness_model, null, "the subscription's default");
    assert.equal(status.json().machine_harnesses, null);
    assert.deepEqual(status.json().repositories, []);
    const pinned = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...picked.json().config, harness_model: "gpt-5-codex" } },
    });
    assert.equal(pinned.statusCode, 200, pinned.body);
    assert.equal(pinned.json().config.harness_model, "gpt-5-codex");
    const refused = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...picked.json().config, harness_model: "--settings" } },
    });
    assert.equal(refused.statusCode, 422, refused.body);
    const unknown = await app.inject({
      method: "POST",
      url: `/api/agents/${coderId}/harness/check`,
      headers: JSON_AUTH,
      payload: { harness: "pi" },
    });
    assert.equal(unknown.statusCode, 422, unknown.body);
    type Credential = {
      harness: string;
      secret: string | null;
      secret_source: string | null;
      secret_granted: boolean;
      secret_shadowed: boolean;
    };
    const credentials = (payload: { harnesses: Credential[] }) =>
      payload.harnesses.map((item) => [item.harness, item.secret, item.secret_source, item.secret_granted, item.secret_shadowed]);
    assert.deepEqual(credentials(status.json()), [
      ["claude-code", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", false, false],
      ["codex", null, null, false, false],
      ["cursor", "CURSOR_API_KEY", "CURSOR_API_KEY", false, false],
    ]);
    // An alias names the secret the harness's token variable reads.
    const aliased = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...picked.json().config, secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "MY_CLAUDE_TOKEN" } } },
    });
    assert.equal(aliased.statusCode, 200, aliased.body);
    assert.deepEqual(aliased.json().config.secret_aliases, { CLAUDE_CODE_OAUTH_TOKEN: "MY_CLAUDE_TOKEN" });
    const mapped = await app.inject({ method: "GET", url: `/api/agents/${coderId}/harness`, headers: AUTH });
    assert.deepEqual(credentials(mapped.json())[0], ["claude-code", "CLAUDE_CODE_OAUTH_TOKEN", "MY_CLAUDE_TOKEN", false, false]);
    const badAlias = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...picked.json().config, secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN" } } },
    });
    assert.equal(badAlias.statusCode, 422, badAlias.body);

    // The list carries each machine's agents and its planned memory.
    const listed = await machines();
    const byName = Object.fromEntries(listed.map((machine) => [String(machine.name), machine]));
    assert.deepEqual(byName.default?.agents.map((agent: { name: string }) => agent.name), ["scripter", "browser"]);
    assert.equal(byName.default?.planned_mib, 100 + 600);
    assert.equal(byName.builder?.planned_mib, 100 + 1536);

    // A standard tier is refused while a coding agent sits on the machine.
    const downgrade = await app.inject({
      method: "PATCH",
      url: `/api/orgs/org_home/machines/${codeId}`,
      headers: JSON_AUTH,
      payload: { box: "standard" },
    });
    assert.equal(downgrade.statusCode, 409, downgrade.body);

    // A running machine resized gets a new container; its directory stays.
    const started = await app.inject({ method: "POST", url: `/api/agents/${coderId}/cli`, headers: AUTH });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(sandboxes.running.get(codeId)?.memoryMib, 4096);
    const resized = await app.inject({
      method: "PATCH",
      url: `/api/orgs/org_home/machines/${codeId}`,
      headers: JSON_AUTH,
      payload: { box: "custom", cpu: 2.5, memory_mib: 6144 },
    });
    assert.equal(resized.statusCode, 200, resized.body);
    assert.equal(resized.json().cpu, 2.5);
    assert.deepEqual(sandboxes.destroyed, [codeId]);
    assert.ok(existsSync(path.join(workspaceRoot, codeId, coderId)));
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/orgs/org_home/machines/${codeId}`,
      headers: JSON_AUTH,
      payload: { name: "big-builder" },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual(sandboxes.destroyed, [codeId], "a rename keeps the container");

    // A coding agent cannot move to a standard machine; a plain one moves with its home.
    const blocked = await app.inject({
      method: "PUT",
      url: `/api/agents/${coderId}/machine`,
      headers: JSON_AUTH,
      payload: { machine_id: defaultId },
    });
    assert.equal(blocked.statusCode, 422, blocked.body);
    const scripterId = String(scripter.json().id);
    const home = path.join(workspaceRoot, defaultId, scripterId);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "notes.txt"), "keep");
    const moved = await app.inject({
      method: "PUT",
      url: `/api/agents/${scripterId}/machine`,
      headers: JSON_AUTH,
      payload: { machine_id: codeId },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().machine_id, codeId);
    assert.equal(readFileSync(path.join(workspaceRoot, codeId, scripterId, "notes.txt"), "utf8"), "keep");
    assert.equal(existsSync(home), false);

    // The settings save moves an agent too, checked against the machine it goes to.
    const detail = await app.inject({ method: "GET", url: `/api/agents/${scripterId}`, headers: AUTH });
    const codingThere = await app.inject({
      method: "PUT",
      url: `/api/agents/${scripterId}/config`,
      headers: JSON_AUTH,
      payload: { config: { ...detail.json().config, coding: true, harness: "claude-code" }, machine_id: defaultId },
    });
    assert.equal(codingThere.statusCode, 422, codingThere.body);
    const back = await app.inject({
      method: "PUT",
      url: `/api/agents/${scripterId}/config`,
      headers: JSON_AUTH,
      payload: { config: detail.json().config, machine_id: defaultId },
    });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().machine_id, defaultId);

    // A machine that hosts agents is not deleted; an empty one is, with its directory.
    const busy = await app.inject({ method: "DELETE", url: `/api/orgs/org_home/machines/${defaultId}`, headers: AUTH });
    assert.equal(busy.statusCode, 409, busy.body);
    const spare = await app.inject({
      method: "POST",
      url: "/api/orgs/org_home/machines",
      headers: JSON_AUTH,
      payload: { name: "spare" },
    });
    const spareId = String(spare.json().id);
    mkdirSync(path.join(workspaceRoot, spareId), { recursive: true });
    const gone = await app.inject({ method: "DELETE", url: `/api/orgs/org_home/machines/${spareId}`, headers: AUTH });
    assert.equal(gone.statusCode, 204, gone.body);
    assert.equal(existsSync(path.join(workspaceRoot, spareId)), false);

    // Usage shows the agent's home and its machine against their caps.
    const usage = await app.inject({ method: "GET", url: `/api/agents/${coderId}/usage`, headers: AUTH });
    assert.equal(usage.statusCode, 200, usage.body);
    assert.equal(usage.json().machine.id, codeId);
    assert.equal(usage.json().machine.max_workspace_mib, 10240);
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
