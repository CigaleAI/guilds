import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { instanceRedactions } from "../../src/connectors/instance.js";
import { connect } from "../../src/seed/connect.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { endpointManifest, fakeRegistry } from "../helpers/registry.js";
import { getMcpConnectionForOwner } from "../../src/db/mcp.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_HEADERS = { ...OWNER, "content-type": "application/json" };
const dbName = uniqueDbName("agent_platform_instance_connectors");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

type Status = {
  id: string;
  label: string;
  source: string;
  state: string;
  fields: Array<{ name: string; label: string; optional: boolean; secret: boolean; multiline: boolean; set: boolean }>;
  provides: { native_tools: string[]; connectors: string[] };
};

test("a connector's own key or OAuth client is an instance key the admin fills under connector:<slug>", { timeout: 90_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys({});
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const registry = fakeRegistry();
  const publish = (slug: string, extra: Record<string, unknown>) =>
    registry.connector(slug, "1.0.0", { "connector.json": JSON.stringify(endpointManifest(slug, extra)) });
  publish("acme", { display_name: "Acme", auth: { kind: "token", fields: [{ name: "api_key", label: "Acme key" }], instance: { own: true } } });
  publish("borrow", { auth: { kind: "token", instance: { integration: "web-search", field: "api_key" } } });
  publish("googly", { auth: { kind: "oauth", oauth: { strategy: "configured", provider: "google-connectors" } } });
  publish("portal", { display_name: "Portal", auth: { kind: "oauth", oauth: { strategy: "configured" } } });
  const notes = new NotesStore(tempDir("guilds-instance-connectors-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    registry: registry.client,
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  const install = (slug: string) =>
    app.inject({ method: "POST", url: "/api/admin/registry/connectors", headers: JSON_HEADERS, payload: { slug } });
  const instance = async (): Promise<Record<string, Status>> => {
    const response = await app.inject({ method: "GET", url: "/api/instance", headers: OWNER });
    assert.equal(response.statusCode, 200, response.body);
    return Object.fromEntries((response.json().integrations as Status[]).map((item) => [item.id, item]));
  };
  const putKey = (id: string, values: Record<string, string>) =>
    app.inject({ method: "PUT", url: `/api/admin/instance/keys/${id}`, headers: JSON_HEADERS, payload: { values } });
  const storedRows = async (id: string) =>
    (await database.pool.query("SELECT 1 FROM instance_keys WHERE integration = $1", [id])).rowCount ?? 0;
  const catalogItem = async (id: string) => {
    const response = await app.inject({ method: "GET", url: `/api/admin/mcp/servers/${id}`, headers: OWNER });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  };
  try {
    // An installed connector's own key is listed as an integration of its own, off until filled.
    const acme = await install("acme");
    assert.equal(acme.statusCode, 201, acme.body);
    assert.equal(acme.json().slug, "acme");
    const listed = (await instance())["connector:acme"];
    assert.ok(listed, "connector:acme is listed");
    assert.equal(listed.label, "Acme");
    assert.equal(listed.source, "store");
    assert.equal(listed.state, "off");
    assert.deepEqual(listed.fields, [{ name: "api_key", label: "Acme key", optional: false, secret: true, multiline: false, set: false }]);
    assert.deepEqual(listed.provides, { native_tools: [], connectors: ["acme"] });
    assert.equal(await getMcpConnectionForOwner(db, "mcp_acme", "platform", null), null);
    assert.deepEqual(instanceRedactions(), {});

    // Filling it connects the platform login and redacts the value from tool output.
    const wrongField = await putKey("connector:acme", { token: "k" });
    assert.equal(wrongField.statusCode, 400, wrongField.body);
    const stored = await putKey("connector:acme", { api_key: "acme-platform-key" });
    assert.equal(stored.statusCode, 200, stored.body);
    assert.equal(stored.json().integration.id, "connector:acme");
    assert.equal(stored.json().integration.state, "on");
    assert.equal(stored.body.includes("acme-platform-key"), false);
    const login = await getMcpConnectionForOwner(db, "mcp_acme", "platform", null);
    assert.equal(login?.status, "connected");
    assert.equal(login?.owner_scope, "platform");
    assert.deepEqual(instanceRedactions(), { platform_acme_api_key: "acme-platform-key" });
    assert.equal(await storedRows("connector:acme"), 1);
    assert.equal((await instance())["connector:acme"]?.state, "on");

    // Removing the connector takes its integration and its stored key away.
    const removed = await app.inject({ method: "DELETE", url: "/api/admin/registry/connectors/acme", headers: OWNER });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await instance())["connector:acme"], undefined);
    assert.equal(await storedRows("connector:acme"), 0);
    assert.deepEqual(instanceRedactions(), {});
    assert.equal((await putKey("connector:acme", { api_key: "k" })).statusCode, 404);

    // A package that reaches for the box's own wiring is refused.
    const borrow = await install("borrow");
    assert.equal(borrow.statusCode, 422, borrow.body);
    assert.match(String(borrow.json().detail), /asks for the box's web-search key/);
    const googly = await install("googly");
    assert.equal(googly.statusCode, 422, googly.body);
    assert.match(String(googly.json().detail), /signs in with the box's google-connectors client/);
    const after = await instance();
    assert.equal(after["connector:borrow"], undefined);
    assert.equal(after["connector:googly"], undefined);

    // A connector's own OAuth client: the catalog item stays unsupported until the client is filled.
    const portal = await install("portal");
    assert.equal(portal.statusCode, 201, portal.body);
    assert.equal(portal.json().oauth_setup_state, "unsupported");
    const portalClient = (await instance())["connector:portal"];
    assert.ok(portalClient, "connector:portal is listed");
    assert.equal(portalClient.label, "Portal OAuth client");
    assert.equal(portalClient.state, "off");
    assert.deepEqual(
      portalClient.fields.map((field) => [field.name, field.label, field.secret, field.set]),
      [
        ["client_id", "Client ID", false, false],
        ["client_secret", "Client secret", true, false],
      ],
    );
    assert.deepEqual(portalClient.provides.connectors, ["portal"]);
    assert.equal((await catalogItem("mcp_portal")).json().oauth_setup_state, "unsupported");
    const filled = await putKey("connector:portal", { client_id: "portal-id", client_secret: "portal-secret" });
    assert.equal(filled.statusCode, 200, filled.body);
    const configured = await catalogItem("mcp_portal");
    assert.equal(configured.json().oauth_setup_state, "configured");
    assert.equal(configured.body.includes("portal-secret"), false);
    assert.equal(await getMcpConnectionForOwner(db, "mcp_portal", "platform", null), null, "a client is not a platform login");

    // A hand-made server with a configured client of its own is listed the same way.
    const handy = await app.inject({
      method: "POST",
      url: "/api/admin/mcp/servers",
      headers: JSON_HEADERS,
      payload: { slug: "handy", display_name: "Handy", url: "https://mcp.handy.example.com/mcp", auth: "oauth", oauth_strategy: "configured" },
    });
    assert.equal(handy.statusCode, 201, handy.body);
    assert.equal(handy.json().oauth_setup_state, "unsupported");
    const handyId = String(handy.json().id);
    const handyClient = (await instance())["connector:handy"];
    assert.ok(handyClient, "connector:handy is listed");
    assert.equal(handyClient.label, "Handy OAuth client");
    assert.deepEqual(handyClient.provides.connectors, ["handy"]);
    assert.equal((await putKey("connector:handy", { client_id: "h-id", client_secret: "h-secret" })).statusCode, 200);
    assert.equal((await catalogItem(handyId)).json().oauth_setup_state, "configured");
    const dynamic = await app.inject({
      method: "POST",
      url: "/api/admin/mcp/servers",
      headers: JSON_HEADERS,
      payload: { slug: "plain", display_name: "Plain", url: "https://mcp.plain.example.com/mcp", auth: "oauth", oauth_strategy: "dynamic" },
    });
    assert.equal(dynamic.statusCode, 201, dynamic.body);
    assert.equal((await instance())["connector:plain"], undefined, "a dynamic client needs no instance key");
  } finally {
    setInstanceKeys({});
    await app.close();
    await database.close();
  }
});
