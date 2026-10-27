import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { buildApp } from "../../src/app.js";
import { connectorCommand } from "../../src/cli/connector.js";
import { getMcpServerBySlug } from "../../src/connectors/servers.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { RecipeApplyService } from "../../src/recipes/apply.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { linkedInNotionRecipe, operatorAuthor } from "../helpers/recipe-docs.js";
import { endpointManifest, fakeRegistry, registryKeys } from "../helpers/registry.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectorFiles } from "../../scripts/build-connector.js";
import { installedConnectors } from "../../src/connectors/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { McpError, McpPool, type McpDatabase } from "../../src/mcp/index.js";
import { syncCodeConnectors } from "../../src/registry/code.js";
import { updateConnector } from "../../src/db/connectors.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";
import { connectionRow } from "../helpers/servers.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const dbName = uniqueDbName("agent_platform_registry");
const codeDbName = uniqueDbName("agent_platform_registry_code");

after(async () => {
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(codeDbName);
});

test("the CLI, the admin routes, recipe import, and apply preview read the registry", { timeout: 90_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  try {
    const db = database.pool;
    const registry = fakeRegistry();
    registry.connector("acme", "1.0.0", { "acme/connector.json": JSON.stringify(endpointManifest("acme")) });
    registry.connector("shady", "0.1.0", { "connector.json": JSON.stringify(endpointManifest("shady")) }, false);
    registry.connector("tavily", "9.0.0", { "connector.json": JSON.stringify(endpointManifest("tavily")) });
    const cli = (...argv: string[]) => connectorCommand(argv, { db, client: registry.client });

    // CLI: install, list, update in place, refusals, remove.
    assert.deepEqual(await cli("install", "acme"), ["installed acme@1.0.0"]);
    const installed = await getMcpServerBySlug(db, "acme", null);
    assert.equal(installed?.source, "registry");
    assert.equal(installed?.version, "1.0.0");
    assert.equal(installed?.tool_prefix, "acme");
    await assert.rejects(() => cli("install", "acme"), /platform connector on this box/);
    await assert.rejects(() => cli("install", "tavily"), /platform's Web search connector/);
    await assert.rejects(() => cli("install", "shady"), /unverified; install it with --unverified/);
    assert.deepEqual(await cli("install", "shady", "--unverified"), ["installed shady@0.1.0 (unverified)"]);
    await assert.rejects(() => cli("install", "missing"), /no connector missing/);
    await assert.rejects(() => cli("remove", "tavily"), /core, not a registry install/);
    await assert.rejects(() => cli("frobnicate"), /usage: connector/);

    await updateConnector(db, String(installed!.id), { enabled: false }, new Date());
    assert.deepEqual(await cli("update"), ["up to date"]);
    registry.connector("acme", "1.1.0", {
      "connector.json": JSON.stringify(endpointManifest("acme", { description: "Acme's records, now with notes." })),
    });
    const listed = await cli("list");
    assert.ok(listed.includes("acme\tregistry\t1.0.0\toff\tverified\tupdate 1.1.0"));
    assert.ok(listed.some((line) => line.startsWith("tavily\tcore\t")));
    assert.deepEqual(await cli("update", "acme"), ["updated acme 1.0.0 -> 1.1.0"]);
    const updated = await getMcpServerBySlug(db, "acme", null);
    assert.equal(updated?.version, "1.1.0");
    assert.equal(updated?.enabled, false, "an update keeps the switch");
    assert.equal(updated?.description, "Acme's records, now with notes.");
    assert.deepEqual(await cli("remove", "shady"), ["removed shady"]);
    assert.equal(await getMcpServerBySlug(db, "shady", null), null);
    await assert.rejects(() => connectorCommand(["install", "acme"], { db, client: null }), /offline/);

    // Admin routes and recipe import over HTTP.
    const notes = new NotesStore(tempDir("guilds-registry-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const artifacts = new ArtifactStore(database.pool, templatesRoot());
    const scripts = new Scripts(scriptDatabase(db));
    const schedules = new Schedules(scheduleDatabase(db));
    const apply = new RecipeApplyService({ db, artifacts, notes, scripts, schedules, registry: registry.client });
    const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, apply, registry: registry.client });
    try {
      const view = await app.inject({ method: "GET", url: "/api/admin/registry", headers: AUTH });
      assert.equal(view.statusCode, 200);
      const acme = (view.json().connectors as Array<Record<string, unknown>>).find((row) => row.slug === "acme");
      assert.deepEqual(acme?.versions, ["1.1.0", "1.0.0"]);
      assert.deepEqual(acme?.installed, { source: "registry", version: "1.1.0" });

      registry.connector("crm", "2.0.0", { "connector.json": JSON.stringify(endpointManifest("crm")) });
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/registry/connectors",
        headers: AUTH,
        payload: { slug: "crm" },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().slug, "crm");
      const removed = await app.inject({ method: "DELETE", url: "/api/admin/registry/connectors/crm", headers: AUTH });
      assert.equal(removed.statusCode, 204);
      const refused = await app.inject({
        method: "POST",
        url: "/api/admin/registry/connectors",
        headers: AUTH,
        payload: { slug: "shady" },
      });
      assert.equal(refused.statusCode, 409);

      const outsider = await insertUser(db, { userId: "user_registry_other", name: "other", image: null, email: "other@example.com" }, new Date());
      await insertMember(db, "org_home", String(outsider.id), "member", new Date());
      const hidden = await app.inject({
        method: "GET",
        url: "/api/admin/registry",
        headers: { "X-Guilds-User": "user_registry_other", "X-Guilds-Org": "org_home" },
      });
      assert.equal(hidden.statusCode, 404);

      // A recipe from the registry lands in the organisation's library as a draft.
      const desk = linkedInNotionRecipe(operatorAuthor());
      registry.recipe("crm-desk", "1.0.0", desk);
      const offered = await app.inject({ method: "GET", url: "/api/recipes/registry", headers: AUTH });
      assert.deepEqual(
        (offered.json().recipes as Array<Record<string, unknown>>).map((row) => row.name),
        ["crm-desk"],
      );
      const imported = await app.inject({
        method: "POST",
        url: "/api/recipes/registry/import",
        headers: AUTH,
        payload: { name: "crm-desk" },
      });
      assert.equal(imported.statusCode, 201);
      assert.equal(imported.json().status, "draft");
      assert.equal(imported.json().name, desk.meta.name);

      // Apply preview lists what the box lacks: a registry connector, or a server the recipe carries.
      registry.connector("notion_crm", "1.0.0", { "connector.json": JSON.stringify(endpointManifest("notion_crm")) });
      const missing = linkedInNotionRecipe(operatorAuthor());
      for (const connection of missing.connections) {
        connection.server = "notion_crm";
      }
      const carried = linkedInNotionRecipe(operatorAuthor());
      for (const connection of carried.connections) {
        connection.server = "bridge";
        connection.manifest = endpointManifest("bridge") as never;
      }
      for (const [document, expected] of [
        [missing, { server: "notion_crm", from: "registry", version: "1.0.0", verified: true }],
        [
          carried,
          {
            server: "bridge",
            from: "recipe",
            display_name: "Acme bridge",
            description: "Acme's bridge records.",
            url: "https://mcp.bridge.example.com/mcp",
            auth: "token",
          },
        ],
      ] as const) {
        const row = await app.inject({ method: "POST", url: "/api/recipes/import", headers: AUTH, payload: { recipe: document } });
        assert.equal(row.statusCode, 201);
        const preview = await app.inject({
          method: "POST",
          url: `/api/recipes/${String(row.json().id)}/preview`,
          headers: AUTH,
          payload: {},
        });
        assert.equal(preview.statusCode, 200);
        assert.deepEqual(preview.json().installs, [expected]);
        const codes = (preview.json().findings as Array<{ code: string }>).map((item) => item.code);
        assert.ok(codes.includes(expected.from === "registry" ? "server.registry" : "server.organisation"));
      }
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
  }
});

test("code connectors install from a verified, signed index and swap in without a restart", { timeout: 90_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(codeDbName));
  const root = tempDir("guilds-connectors-");
  const tier = { CONNECTORS_CODE_TIER: "1", CONNECTORS_ROOT: root };
  const previous = { tier: process.env.CONNECTORS_CODE_TIER, root: process.env.CONNECTORS_ROOT };
  try {
    const db = database.pool;
    const keys = registryKeys();
    const files = Object.fromEntries(
      (await connectorFiles(fileURLToPath(new URL("../helpers/echo", import.meta.url)))).map(([name, body]) => [name, body]),
    );
    const louder = Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        name.endsWith("adapter.js") ? Buffer.from(body.toString().replace("echo: ", "ECHO: ")) : body,
      ]),
    );
    const signed = fakeRegistry({ signWith: keys.privateKey, verifyWith: keys.publicKey });
    signed.connector("echo", "1.0.0", files);
    signed.connector("shaky", "1.0.0", { ...files, "echo/connector.json": files["echo/connector.json"]!.toString().replace('"echo"', '"shaky"') }, false);
    const unsigned = fakeRegistry();
    unsigned.connector("echo", "1.0.0", files);
    const cli = (argv: string[], client = signed.client, env: NodeJS.ProcessEnv = tier) => connectorCommand(argv, { db, client, env });

    // Refusals: no tier, no verified signature, unverified code even with --unverified.
    await assert.rejects(() => cli(["install", "echo"], signed.client, { CONNECTORS_ROOT: root }), /only with CONNECTORS_CODE_TIER=1/);
    await assert.rejects(() => cli(["install", "echo"], unsigned.client), /only from an index REGISTRY_PUBLIC_KEY verifies/);
    await assert.rejects(() => cli(["install", "shaky", "--unverified"]), /code installs only when verified/);
    assert.equal(await getMcpServerBySlug(db, "echo", null), null);

    // A CLI install writes the version's folder; the running server serves it after a reload.
    assert.deepEqual(await cli(["install", "echo"]), [
      "installed echo@1.0.0; the running server serves its code after Admin → Reload connectors",
    ]);
    assert.ok(existsSync(path.join(root, "echo", "1.0.0", "adapter.js")));
    assert.deepEqual(await syncCodeConnectors(db, { CONNECTORS_ROOT: root }), { loaded: [], removed: [], failed: [] });
    process.env.CONNECTORS_CODE_TIER = "1";
    process.env.CONNECTORS_ROOT = root;
    const notes = new NotesStore(tempDir("guilds-registry-code-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const pool = new McpPool();
    const app = await buildApp(database, {
      db,
      notes,
      scripts: new Scripts(scriptDatabase(db)),
      schedules: new Schedules(scheduleDatabase(db)),
      registry: signed.client,
      mcp: pool,
    });
    try {
      const reloaded = await app.inject({ method: "POST", url: "/api/admin/registry/reload", headers: AUTH });
      assert.deepEqual(reloaded.json(), { loaded: ["echo"], removed: [], failed: [] });
      assert.equal(installedConnectors().bySlug("echo")?.folder, path.join(root, "echo", "1.0.0"));

      const server = (await getMcpServerBySlug(db, "echo", null))!;
      const [ciphertext, nonce] = encryptPayload({}, Buffer.from(HEX_MASTER_KEY, "hex"));
      const connection = connectionRow({ id: "conn_echo", mcp_server_id: server.id, owner_scope: "org", owner_id: "org_home", status: "connected", ciphertext, nonce });
      // The connection is not stored, so its tools are neither read nor written.
      const tools = { listMcpTools: async () => [], replaceMcpTools: async () => {} } as unknown as McpDatabase;
      assert.equal(await pool.call(tools, connection, server, "say", { text: "hi" }), "echo: hi");
      await assert.rejects(
        () => pool.call(tools, connection, server, "refuse", {}),
        (error: unknown) => error instanceof McpError && error.status === 422 && /echo refuses refuse/.test(error.message),
      );

      // An update over HTTP swaps the adapter in this process and keeps only the new folder.
      signed.connector("echo", "2.0.0", louder, true);
      signed.index.connectors.at(-1)!.experimental = true;
      const refused = await app.inject({ method: "POST", url: "/api/admin/registry/connectors/echo/update", headers: AUTH, payload: {} });
      assert.equal(refused.statusCode, 409);
      assert.match(refused.json().detail, /echo@2\.0\.0 is experimental/);
      const updated = await app.inject({
        method: "POST",
        url: "/api/admin/registry/connectors/echo/update",
        headers: AUTH,
        payload: { experimental: true },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(await pool.call(tools, connection, server, "say", { text: "hi" }), "ECHO: hi");
      assert.equal(existsSync(path.join(root, "echo", "1.0.0")), false);
      assert.equal((await getMcpServerBySlug(db, "echo", null))?.experimental, true);

      // Removing it takes it out of this process and off the disk.
      const removed = await app.inject({ method: "DELETE", url: "/api/admin/registry/connectors/echo", headers: AUTH });
      assert.equal(removed.statusCode, 204);
      assert.equal(installedConnectors().bySlug("echo"), null);
      assert.equal(existsSync(path.join(root, "echo")), false);
    } finally {
      await app.close();
    }
  } finally {
    for (const [name, value] of [["CONNECTORS_CODE_TIER", previous.tier], ["CONNECTORS_ROOT", previous.root]] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.close();
  }
});
