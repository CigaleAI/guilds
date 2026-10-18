import assert from "node:assert/strict";
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
import { ExportSandboxes, openWs, startSandboxUpstream, wsRecv } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_cli");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "the CLI tab starts the terminal daemon and proxies it under its secret path",
  { timeout: 60_000 },
  async () => {
    const databaseUrl = await createIsolatedDatabase(dbName);
    const env = testEnv(databaseUrl);
    Object.assign(process.env, env);
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(databaseUrl);
    const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot());
    await notes.ensureSystemPrompt();
    const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
    const artifacts = new ArtifactStore(database.pool, notes.templates);
    const sandboxes = new ExportSandboxes(env.WORKSPACE_ROOT ?? "");
    const upstream = await startSandboxUpstream({ subprotocol: "tty" });
    sandboxes.cliBase = upstream.base;
    const secret = `/t/${sandboxes.cliToken}`;
    const generation = new GenerationLoop(repo, notes, env.WORKSPACE_ROOT ?? "", sandboxes, {
      mcp: new McpPool(),
      artifacts,
      idleTimeoutMs: 5 * 60 * 1000,
    });
    const app = await buildApp(database, {
      repo,
      notes,
      artifacts,
      scripts: new Scripts(repo),
      schedules: new Schedules(repo),
      masterKey: decodeMasterKey(HEX_MASTER_KEY),
      mcp: new McpPool(),
      generation,
    });
    try {
      const guild = await app.inject({
        method: "POST",
        url: "/api/guilds",
        headers: JSON_AUTH,
        payload: { name: "cli-desk" },
      });
      assert.equal(guild.statusCode, 201, guild.body);
      const guildId = String(guild.json().id);
      const created = await app.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/agents`,
        headers: JSON_AUTH,
        payload: { name: "cli-plain", config: { model: TEST_MODEL, browser: false } },
      });
      assert.equal(created.statusCode, 201, created.body);
      const agentId = String(created.json().id);
      const machineId = String(created.json().machine_id);

      const asleep = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/cli/tty/`,
        headers: AUTH,
      });
      assert.equal(asleep.statusCode, 503, asleep.body);
      assert.equal(asleep.json().detail, "sandbox is not running");

      const started = await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/cli`,
        headers: AUTH,
      });
      assert.equal(started.statusCode, 200, started.body);
      assert.deepEqual(started.json(), { status: "ready" });
      assert.ok(sandboxes.running.has(machineId));
      assert.deepEqual(sandboxes.browserStarts, []);
      assert.equal(sandboxes.cliStarts, 1);
      assert.ok(generation._idle_tasks.has(machineId));

      const page = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/cli/tty/`,
        headers: AUTH,
      });
      assert.equal(page.statusCode, 200, page.body);
      assert.equal(page.body, `GET ${secret}`, "the proxy prepends the daemon's secret path");
      assert.equal(page.headers["x-upstream"], "1");
      assert.equal(page.headers["cache-control"], "no-store");
      const token = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/cli/tty/token`,
        headers: AUTH,
      });
      assert.equal(token.statusCode, 200, token.body);
      assert.equal(token.body, `GET ${secret}/token`);
      assert.equal(sandboxes.cliStarts, 3, "each proxied request re-checks the daemon");

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const armed = generation._idle_tasks.get(machineId);
      const socket = await openWs(
        `ws://127.0.0.1:${port}/api/agents/${agentId}/cli/tty/ws`,
        AUTH,
        "tty",
      );
      try {
        assert.equal(socket.protocol, "tty");
        socket.send('{"AuthToken":"x","columns":80,"rows":24}');
        const echoed = await wsRecv(socket);
        assert.equal(echoed.text, 'echo-text:{"AuthToken":"x","columns":80,"rows":24}');
        for (let tries = 0; tries < 100 && generation._idle_tasks.get(machineId) === armed; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const restarted = generation._idle_tasks.get(machineId);
        assert.ok(restarted);
        assert.notEqual(restarted, armed, "operator input restarts the idle timer");
      } finally {
        socket.close();
      }

      const browserAgent = await app.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/agents`,
        headers: JSON_AUTH,
        payload: { name: "cli-browser", config: { model: TEST_MODEL, browser: true } },
      });
      assert.equal(browserAgent.statusCode, 201, browserAgent.body);
      const browserId = String(browserAgent.json().id);
      const startedBrowser = await app.inject({
        method: "POST",
        url: `/api/agents/${browserId}/cli`,
        headers: AUTH,
      });
      assert.equal(startedBrowser.statusCode, 200, startedBrowser.body);
      assert.deepEqual(sandboxes.browserStarts, [], "the CLI tab starts no Chrome");
      assert.equal(browserAgent.json().machine_id, machineId, "both agents share the organisation's machine");
    } finally {
      for (const id of [...generation._idle_tasks.keys()]) {
        generation._cancel_idle(id);
      }
      try {
        app.server.closeAllConnections();
      } catch {
        /* not listening */
      }
      await app.close();
      await generation.close();
      await database.close();
      await upstream.close();
    }
  },
);
