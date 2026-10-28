import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { installConnectors, installedConnectors } from "../../src/connectors/index.js";
import { projectConnectors } from "../../src/seed/system.js";
import { QUOTES } from "../helpers/quotes.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { connect } from "../../src/seed/connect.js";
import { McpPool } from "../../src/mcp/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home", "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_connector_settings");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a login waits for its settings, looks them up, and connects once they are saved", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  installConnectors([QUOTES]);
  const database = await connect(await createIsolatedDatabase(dbName));
  await projectConnectors(database.pool);
  const notes = new NotesStore(tempDir("guilds-settings-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const mcp = new McpPool();
  const validated: unknown[] = [];
  mcp.connectors = installedConnectors().withAdapter("quotes", {
    async validate(creds, ctx) {
      if (creds.token !== "qk") {
        throw new ConnectorError("invalid key", 401);
      }
      validated.push(ctx.settings);
      const symbols = Array.isArray(ctx.settings.symbols) ? ctx.settings.symbols : [];
      return symbols.length ? `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}` : "";
    },
    async lookup(property, query, creds) {
      assert.equal(property, "symbols");
      assert.equal(creds.token, "qk");
      return [{ value: { id: query, name: query }, label: query }];
    },
  });
  const app = await buildApp(database, {
    db,
    notes,
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
    mcp,
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  try {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: AUTH,
      payload: { mcp_server_id: "mcp_quotes", owner_scope: "org", owner_id: "org_home", token: "bad" },
    });
    assert.equal(rejected.statusCode, 422);

    const created = await app.inject({
      method: "POST",
      url: "/api/mcp/connections",
      headers: AUTH,
      payload: { mcp_server_id: "mcp_quotes", owner_scope: "org", owner_id: "org_home", token: "qk" },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().status, "pending");
    assert.equal(created.json().needs_settings, true);
    const id = String(created.json().id);

    const access = await app.inject({ method: "GET", url: "/api/access", headers: AUTH });
    const card = (access.json().mcp as Array<Record<string, unknown>>).find((row) => row.slug === "quotes");
    assert.equal(card?.needs_settings, true);
    assert.deepEqual((card?.settings_schema as { required: string[] }).required, ["symbols"]);

    const before = await app.inject({
      method: "POST",
      url: "/api/mcp/servers/mcp_quotes/lookup",
      headers: AUTH,
      payload: { property: "symbols", q: "solana", credentials: { token: "qk" } },
    });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().options[0].value.id, "solana");

    const found = await app.inject({
      method: "GET",
      url: `/api/mcp/connections/${id}/lookup?property=symbols&q=bitcoin`,
      headers: AUTH,
    });
    assert.equal(found.statusCode, 200, found.body);
    const symbol = found.json().options[0].value;

    const invalid = await app.inject({
      method: "PUT",
      url: `/api/mcp/connections/${id}/settings`,
      headers: AUTH,
      payload: { settings: { symbols: [] } },
    });
    assert.equal(invalid.statusCode, 422);

    const saved = await app.inject({
      method: "PUT",
      url: `/api/mcp/connections/${id}/settings`,
      headers: AUTH,
      payload: { settings: { symbols: [symbol] } },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().status, "connected");
    assert.equal(saved.json().needs_settings, false);
    assert.equal(saved.json().account_hint, "1 symbol");
    assert.deepEqual(saved.json().settings, { symbols: [symbol] });
    assert.deepEqual(validated.at(-1), { symbols: [symbol] });

    const noSettings = await app.inject({
      method: "PUT",
      url: `/api/mcp/connections/${id}/settings`,
      headers: AUTH,
      payload: { settings: {} },
    });
    assert.equal(noSettings.statusCode, 422);
  } finally {
    await app.close();
    await database.close();
  }
});
