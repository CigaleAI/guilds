import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { generationLoop } from "../../src/generation/index.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { connect } from "../../src/seed/connect.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const READER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const OWNER = { ...READER, "content-type": "application/json" };
const CODER = { model: TEST_MODEL, browser: false, coding: true, harness: "claude-code" };

const dbName = uniqueDbName("agent_platform_agent_repositories");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "a coding agent picks the repositories it works on among those it can use, keeps one it can no longer use, and loses one its guild removes",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-agent-repositories-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    await connectModelProvider(db, "org_home", "deepinfra");
    const artifacts = artifactStore(db, notes.templates);
    const workspaceRoot = tempDir("guilds-agent-repositories-workspaces-");
    const generation = generationLoop(db, {
      mcp: mcpPool(db),
      notes,
      workspaceRoot,
      sandboxes: new ExportSandboxes(workspaceRoot),
      artifacts,
    });
    generation.generateInBackground = () => undefined;
    const app = await buildApp(database, {
      db,
      notes,
      artifacts,
      scripts: agentScripts(db),
      schedules: agentSchedules(db),
      generation,
    });

    try {
      await codeDefaultMachine(app, OWNER);
      const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "repos" } });
      assert.equal(guild.statusCode, 201, guild.body);
      const guildId = String(guild.json().id);
      const addRepository = async (guild: string, name: string) => {
        const added = await app.inject({
          method: "POST",
          url: `/api/guilds/${guild}/repositories`,
          headers: OWNER,
          payload: { name, url: `https://git.example.com/team/${name}.git` },
        });
        assert.equal(added.statusCode, 201, added.body);
        return String(added.json().id);
      };
      const shopId = await addRepository(guildId, "shop");
      await addRepository(guildId, "docs");
      await addRepository(guildId, "site");
      const create = (name: string, config: Record<string, unknown>, guild = guildId) =>
        app.inject({ method: "POST", url: `/api/guilds/${guild}/agents`, headers: OWNER, payload: { name, config } });

      const outside = await create("stray", { ...CODER, repositories: ["shop", "billing"] });
      assert.equal(outside.statusCode, 422, outside.body);
      assert.match(outside.body, /the agent cannot use billing/);
      const plain = await create("plain", { model: TEST_MODEL, browser: false, repositories: ["shop"] });
      assert.equal(plain.statusCode, 422, plain.body);
      assert.match(plain.body, /repositories are only for coding agents/);
      const twice = await create("twice", { ...CODER, repositories: ["shop", "shop"] });
      assert.equal(twice.statusCode, 422, twice.body);

      const created = await create("coder", { ...CODER, repositories: ["site", "shop"] });
      assert.equal(created.statusCode, 201, created.body);
      assert.deepEqual(created.json().config.repositories, ["site", "shop"]);
      const agentId = String(created.json().id);
      const harness = async () => {
        const view = await app.inject({ method: "GET", url: `/api/agents/${agentId}/harness`, headers: OWNER });
        assert.equal(view.statusCode, 200, view.body);
        return view.json() as { repositories: string[]; usable_repositories: string[] };
      };
      assert.deepEqual(await harness(), {
        ...(await harness()),
        repositories: ["site", "shop"],
        usable_repositories: ["docs", "shop", "site"],
      });

      const reconfigure = (repositories: string[]) =>
        app.inject({
          method: "PUT",
          url: `/api/agents/${agentId}/config`,
          headers: OWNER,
          payload: { config: { ...CODER, repositories } },
        });
      const widened = await reconfigure(["site", "shop", "docs"]);
      assert.equal(widened.statusCode, 200, widened.body);
      assert.deepEqual(widened.json().config.repositories, ["site", "shop", "docs"]);
      const unknown = await reconfigure(["site", "wiki"]);
      assert.equal(unknown.statusCode, 422, unknown.body);
      assert.match(unknown.body, /the agent cannot use wiki/);

      // A repository the agent picks that goes from the guild by another path stays picked.
      await db.query("DELETE FROM guild_repositories WHERE guild_id = $1 AND name = 'docs'", [guildId]);
      assert.deepEqual((await harness()).repositories, ["site", "shop"], "a run clones only what the agent can still use");
      const kept = await reconfigure(["shop", "docs"]);
      assert.equal(kept.statusCode, 200, kept.body);
      assert.deepEqual(kept.json().config.repositories, ["shop", "docs"]);

      // Removing a repository from the guild unpicks it from each of its agents, and from no other guild's.
      const reviewer = await create("reviewer", { ...CODER, repositories: ["shop", "site"] });
      assert.equal(reviewer.statusCode, 201, reviewer.body);
      const other = await app.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "other" } });
      assert.equal(other.statusCode, 201, other.body);
      const otherId = String(other.json().id);
      await addRepository(otherId, "shop");
      const outsider = await create("outsider", { ...CODER, repositories: ["shop"] }, otherId);
      assert.equal(outsider.statusCode, 201, outsider.body);
      const removed = await app.inject({ method: "DELETE", url: `/api/guilds/${guildId}/repositories/${shopId}`, headers: READER });
      assert.equal(removed.statusCode, 204, removed.body);
      const picksOf = async (id: string) =>
        (await app.inject({ method: "GET", url: `/api/agents/${id}`, headers: OWNER })).json().config.repositories;
      assert.deepEqual(await picksOf(agentId), ["docs"], "a gone pick the removal does not name stays");
      assert.deepEqual(await picksOf(String(reviewer.json().id)), ["site"]);
      assert.deepEqual(await picksOf(String(outsider.json().id)), ["shop"]);

      // An agent that still reaches the name through its GitHub login keeps it when the guild's row goes.
      const otherShop = await app.inject({ method: "GET", url: `/api/guilds/${otherId}/repositories`, headers: READER });
      const otherShopId = String(otherShop.json().repositories[0]?.id);
      await db.query(
        `INSERT INTO mcp_connections (id, mcp_server_id, owner_scope, owner_id, status, settings, account_hint, ciphertext, nonce, created_at, updated_at, rotated_at)
         VALUES ('conn_other', 'mcp_github', 'guild', $1, 'connected', $2, 'acme', '\\x00', '\\x00', now(), now(), now())`,
        [otherId, JSON.stringify({ repositories: [{ name: "shop", url: "https://github.com/acme/shop", default_branch: "main" }] })],
      );
      const rowGone = await app.inject({ method: "DELETE", url: `/api/guilds/${otherId}/repositories/${otherShopId}`, headers: READER });
      assert.equal(rowGone.statusCode, 204, rowGone.body);
      assert.deepEqual(await picksOf(String(outsider.json().id)), ["shop"]);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
