import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { connectMcp, getMcpConnection } from "../../src/db/mcp.js";
import {
  callConnectionTool,
  lookupWithCredentials,
  lookupWithLogin,
  readConnectorLogo,
  saveConnectionSettings,
  type ConnectionServices,
} from "../../src/mcp/connections.js";
import type { McpPool } from "../../src/mcp/index.js";
import { ConnectionError } from "../../src/mcp/visibility.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_connections");
const HOME = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_HOME = { ...HOME, "content-type": "application/json" };

after(async () => {
  await dropIsolatedDatabase(dbName);
});

function refusedWith(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ConnectionError, String(error));
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  };
}

test(
  "an operator's logins answer for the pool, the request, and the owner",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-connections-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const masterKey = Buffer.from(HEX_MASTER_KEY, "hex");
    const app = await buildApp(database, {
      db,
      notes,
      scripts: new Scripts(scriptDatabase(db)),
      schedules: new Schedules(scheduleDatabase(db)),
      masterKey,
    });
    const pool = {
      lookup: async () => ["one"],
      lookupLogin: async () => ["two"],
      forget: () => {},
    } as unknown as McpPool;
    const withPool: ConnectionServices = { db, mcp: pool, masterKey };
    const withoutPool: ConnectionServices = { db, mcp: null, masterKey };

    try {
      const server = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/mcp/servers",
        headers: JSON_HOME,
        payload: { slug: "wiki", url: "https://mcp.wiki.example/mcp" },
      });
      assert.equal(server.statusCode, 201, server.body);
      const serverId = String(server.json().id);
      const created = await connectMcp(
        db,
        {
          connectionId: "conn_wiki",
          bindingId: "bind_wiki",
          serverId,
          ownerScope: "org",
          ownerId: "org_home",
          ciphertext: Buffer.from([]),
          nonce: Buffer.from([]),
        },
        new Date(),
      );
      const connectionId = created.id;
      const viewed = await app.inject({
        method: "GET",
        url: `/api/mcp/connections/${connectionId}`,
        headers: HOME,
      });
      assert.equal(viewed.statusCode, 200, viewed.body);
      assert.ok(Array.isArray(viewed.json().bindings));
      const listed = await app.inject({
        method: "GET",
        url: "/api/mcp/connections",
        headers: HOME,
      });
      assert.ok(listed.json().connections.some((row: { id: string }) => row.id === connectionId));
      const login = await getMcpConnection(db, connectionId);
      assert.ok(login);

      await assert.rejects(
        callConnectionTool(withoutPool, login, { tool: "search", arguments: {} }),
        refusedWith(409, /unavailable/),
      );
      await assert.rejects(
        callConnectionTool(withPool, login, { tool: " ", arguments: {} }),
        refusedWith(422, /tool/),
      );
      await assert.rejects(
        callConnectionTool(withPool, login, { tool: "search", arguments: [] }),
        refusedWith(422, /arguments/),
      );

      const lookup = { property: "space", q: "eng", credentials: { token: "sk-wiki" } };
      await assert.rejects(
        lookupWithCredentials(withPool, "org_home", "srv_missing", lookup),
        refusedWith(404, /server/),
      );
      await assert.rejects(
        lookupWithCredentials(withoutPool, "org_home", serverId, lookup),
        refusedWith(409, /lookups/),
      );
      await assert.rejects(
        lookupWithCredentials(withPool, "org_home", serverId, { ...lookup, q: " " }),
        refusedWith(422, /property and q/),
      );
      assert.deepEqual(await lookupWithCredentials(withPool, "org_home", serverId, lookup), {
        options: ["one"],
      });
      await assert.rejects(
        lookupWithLogin(withoutPool, login, lookup),
        refusedWith(409, /lookups/),
      );
      assert.deepEqual(await lookupWithLogin(withPool, login, lookup), { options: ["two"] });

      await assert.rejects(
        saveConnectionSettings(withPool, login, {}),
        refusedWith(422, /no settings/),
      );
      const platform = await connectMcp(
        db,
        {
          connectionId: "conn_platform",
          bindingId: "bind_platform",
          serverId,
          ownerScope: "platform",
          ownerId: null,
          ciphertext: Buffer.from([]),
          nonce: Buffer.from([]),
          oauthState: null,
          bind: false,
          status: "pending",
          accountHint: "",
        },
        new Date(),
      );
      await assert.rejects(
        saveConnectionSettings(withPool, platform, {}),
        refusedWith(400, /platform/),
      );
      const platformDelete = await app.inject({
        method: "DELETE",
        url: "/api/mcp/connections/conn_platform",
        headers: HOME,
      });
      assert.equal(platformDelete.statusCode, 400);

      const notGithub = await app.inject({
        method: "GET",
        url: `/api/mcp/connections/${connectionId}/github/repositories`,
        headers: HOME,
      });
      assert.equal(notGithub.statusCode, 422, "only a GitHub login reaches repositories");
      await assert.rejects(readConnectorLogo("srv_missing"), refusedWith(404, /logo/));
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/mcp/connections/${connectionId}`,
        headers: HOME,
      });
      assert.equal(removed.statusCode, 204);
      const gone = await app.inject({
        method: "GET",
        url: `/api/mcp/connections/${connectionId}`,
        headers: HOME,
      });
      assert.equal(gone.statusCode, 404);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
