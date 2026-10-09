import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { orchestratorRoot } from "../../src/lib/paths.js";
import { decryptPayload, encryptPayload } from "../../src/credentials/crypto.js";
import { applyMigrations, createPool } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { seedOperator } from "../../src/db/seed/operator.js";
import { projectConnectors, seedSystem, syncInstanceLogins } from "../../src/db/seed/system.js";
import { installedConnectors } from "../../src/connectors/index.js";
import { seedTest } from "../../src/db/seed/test.js";
import { newId } from "../../src/lib/ids.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { classifySeed, loadSeedManifest } from "../helpers/seed-classify.js";

const dbName = uniqueDbName("agent_platform_r1");
const searchDbName = uniqueDbName("agent_platform_r1_search");
const upgradeDbName = uniqueDbName("agent_platform_r1_connectors");
const settingsDbName = uniqueDbName("agent_platform_r1_settings");
const migrationsFolder = path.join(orchestratorRoot(import.meta.url), "drizzle");

after(async () => {
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(searchDbName);
  await dropIsolatedDatabase(upgradeDbName);
  await dropIsolatedDatabase(settingsDbName);
});

/** A copy of the migrations folder that stops before `tag`, so a database can be built at that point. */
function migrationsBefore(tag: string): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), "guilds-migrations-"));
  mkdirSync(path.join(folder, "meta"));
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === tag);
  const kept = journal.entries.slice(0, cut);
  for (const entry of kept) {
    copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

test("system and operator seeds match the classified manifest and stay semantic-stable", async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const pool = await createPool(databaseUrl);
  try {
    await applyMigrations(pool);
    await seedSystem(pool);
    await seedOperator(pool);
    await seedTest(pool);
    const manifest = loadSeedManifest();
    const first = await classifySeed(pool);
    assert.deepEqual(first.connectors, manifest.system.connectors);
    assert.deepEqual(
      first.platform_native_tool_bindings,
      manifest.system.platform_native_tool_bindings,
    );
    assert.deepEqual(first.users, manifest.operator.users);
    assert.deepEqual(first.orgs, manifest.operator.orgs);
    assert.deepEqual(first.org_members, manifest.operator.org_members);
    assert.equal(first.bash_absent, manifest.system.bash_absent);
    assert.deepEqual(first.constants.expected_mcp_slugs, manifest.system.expected_mcp_slugs);
    assert.deepEqual(
      first.constants.expected_platform_native_tools,
      manifest.system.expected_platform_native_tools,
    );
    assert.deepEqual(first.constants.native_tools_constant, manifest.system.native_tools_constant);
    assert.deepEqual(first.row_counts, manifest.row_counts);

    await seedSystem(pool);
    await seedOperator(pool);
    const second = await classifySeed(pool);
    assert.deepEqual(second, first);
  } finally {
    await pool.end();
  }
});

test("web search moves to the Tavily connector, keeping its switches, with a platform login on the instance key", { timeout: 60_000 }, async () => {
  const pool = await createPool(await createIsolatedDatabase(searchDbName));
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: migrationsBefore("0007_connector_calls"),
      migrationsSchema: "public",
      migrationsTable: "__drizzle_migrations",
    });
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    await seedOperator(pool);
    const now = new Date();
    const repo = new Repositories(pool);
    await repo.upsertBinding(newId("bind"), "native_tool", "tavily_search", "platform", null, true, null, now);
    await repo.upsertBinding(newId("bind"), "native_tool", "tavily_search", "org", "org_home", false, null, now);

    await applyMigrations(pool);

    const moved = await pool.query(
      `SELECT catalog_kind, scope, enabled FROM bindings WHERE catalog_id = 'tavily_search' ORDER BY scope`,
    );
    assert.deepEqual(moved.rows, [
      { catalog_kind: "mcp_tool", scope: "org", enabled: false },
      { catalog_kind: "mcp_tool", scope: "platform", enabled: true },
    ]);

    await projectConnectors(pool, now);
    const tavily = installedConnectors().bySlug("tavily")!;
    await syncInstanceLogins(pool, now, {});
    assert.equal(await repo.getMcpConnectionForOwner(tavily.id, "platform", null), null);

    await syncInstanceLogins(pool, now, { TAVILY_API_KEY: "tvly-instance" });
    const login = await repo.getMcpConnectionForOwner(tavily.id, "platform", null);
    assert.equal(login?.status, "connected");
    assert.deepEqual(decryptPayload(login!.ciphertext as Buffer, login!.nonce as Buffer, Buffer.from(HEX_MASTER_KEY, "hex")), {});
    const platform = await pool.query(
      `SELECT enabled FROM bindings WHERE catalog_kind = 'mcp' AND catalog_id = $1 AND scope = 'platform'`,
      [tavily.id],
    );
    assert.deepEqual(platform.rows, [{ enabled: true }]);

    await syncInstanceLogins(pool, now, {});
    assert.equal((await repo.getMcpConnectionForOwner(tavily.id, "platform", null))?.status, "disconnected");
    await syncInstanceLogins(pool, now, { TAVILY_API_KEY: "tvly-instance" });
    assert.equal((await repo.getMcpConnectionForOwner(tavily.id, "platform", null))?.status, "connected");
  } finally {
    await pool.end();
  }
});

test("the connectors migration keeps every connection, binding, and admin edit", { timeout: 60_000 }, async () => {
  const pool = await createPool(await createIsolatedDatabase(upgradeDbName));
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: migrationsBefore("0004_connectors"),
      migrationsSchema: "public",
      migrationsTable: "__drizzle_migrations",
    });
    await seedOperator(pool);
    const stamp = new Date().toISOString();
    await pool.query(
      `INSERT INTO mcp_servers (
         id, slug, display_name, transport, config, auth, description, limitations, setup_hint,
         publication_state, tool_prefix, oauth_strategy, copy_source, created_at, updated_at
       ) VALUES
         ('mcp_notion', 'notion', 'Notion', 'http',
          '{"url":"https://mcp.notion.com/mcp","oauth_client":{"client_id":"keep-me"}}'::jsonb, 'oauth',
          'Admin Notion copy', 'Admin limits', NULL, 'published', 'notion', 'dynamic', 'admin', $1, $1),
         ('mcp_acme', 'acme-crm', 'Acme CRM', 'http', '{"url":"https://mcp.acme.example/mcp"}'::jsonb, 'token',
          'Acme records.', NULL, 'Paste a key.', 'disabled', 'acmecrm', 'none', 'admin', $1, $1)`,
      [stamp],
    );
    await pool.query(
      `INSERT INTO mcp_catalog_tools (
         id, mcp_server_id, remote_name, namespaced_name, description, input_schema,
         source, publication_state, default_enabled, created_at, updated_at
       ) VALUES
         ('mct_notion_search', 'mcp_notion', 'notion-search', 'notion_notion-search', 'Search pages',
          '{"type":"object"}'::jsonb, 'runtime_candidate', 'published', TRUE, $1, $1),
         ('mct_notion_fetch', 'mcp_notion', 'notion-fetch', 'notion_notion-fetch', 'Fetch',
          '{"type":"object"}'::jsonb, 'runtime_candidate', 'draft', FALSE, $1, $1),
         ('mct_acme_find', 'mcp_acme', 'find', 'acmecrm_find', 'Find a record',
          '{"type":"object"}'::jsonb, 'admin', 'published', FALSE, $1, $1)`,
      [stamp],
    );
    const [ciphertext, nonce] = encryptPayload({ token: "acme-key" }, Buffer.from(HEX_MASTER_KEY, "hex"));
    await pool.query(
      `INSERT INTO mcp_connections (
         id, mcp_server_id, owner_scope, owner_id, org_id, account_hint, ciphertext, nonce,
         status, created_at, updated_at, rotated_at
       ) VALUES ('conn_acme', 'mcp_acme', 'org', 'org_home', 'org_home', 'acme', $1, $2, 'connected', $3, $3, $3)`,
      [ciphertext, nonce, stamp],
    );
    await pool.query(
      `INSERT INTO mcp_tools (
         id, connection_id, mcp_server_id, catalog_tool_id, remote_name, namespaced_name,
         description, input_schema, listed_at
       ) VALUES ('tool_acme', 'conn_acme', 'mcp_acme', 'mct_acme_find', 'find', 'acmecrm_find', 'Find', '{}'::jsonb, $1)`,
      [stamp],
    );
    await pool.query(
      `INSERT INTO bindings (id, catalog_kind, catalog_id, scope, scope_id, enabled, connection_id, created_at, updated_at)
       VALUES ('bind_acme', 'mcp', 'mcp_acme', 'org', 'org_home', TRUE, 'conn_acme', $1, $1),
              ('bind_find', 'mcp_tool', 'acmecrm_find', 'org', 'org_home', FALSE, NULL, $1, $1)`,
      [stamp],
    );

    await applyMigrations(pool);
    await seedSystem(pool);

    const repo = new Repositories(pool);
    const notion = await repo.getMcpServer("mcp_notion");
    assert.equal(notion?.source, "core");
    assert.equal(notion?.description, "Admin Notion copy");
    assert.equal(notion?.limitations, "Admin limits");
    assert.notEqual((notion?.upstream as { description: string }).description, "Admin Notion copy");
    assert.equal((notion?.config as { oauth_client?: { client_id: string } }).oauth_client?.client_id, "keep-me");
    assert.deepEqual((notion?.overrides as { tools: unknown }).tools, { "notion-search": { default: true } });

    const acme = await repo.getMcpServer("mcp_acme");
    assert.equal(acme?.slug, "acme_crm");
    assert.equal(acme?.tool_prefix, "acmecrm");
    assert.equal(acme?.source, "local");
    assert.equal(acme?.enabled, false);
    assert.equal(acme?.setup_hint, "Paste a key.");
    assert.deepEqual((acme?.config as { url: string }).url, "https://mcp.acme.example/mcp");
    assert.deepEqual(
      (acme?.manifest as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ["find"],
    );
    assert.deepEqual((acme?.overrides as { tools: unknown }).tools, { find: { default: false } });

    assert.equal((await repo.getMcpConnection("conn_acme"))?.status, "connected");
    assert.deepEqual(
      (await repo.listMcpTools("conn_acme")).map((row) => row.namespaced_name),
      ["acmecrm_find"],
    );
    const bindings = await pool.query(`SELECT id FROM bindings WHERE id IN ('bind_acme', 'bind_find') ORDER BY id`);
    assert.deepEqual(bindings.rows, [{ id: "bind_acme" }, { id: "bind_find" }]);
    const dropped = await pool.query(
      `SELECT to_regclass('public.mcp_servers') AS servers, to_regclass('public.mcp_catalog_tools') AS tools`,
    );
    assert.deepEqual(dropped.rows, [{ servers: null, tools: null }]);
  } finally {
    await pool.end();
  }
});

test("login settings take pinned coins, picked repositories, and a Drive folder", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = await createPool(await createIsolatedDatabase(settingsDbName));
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: migrationsBefore("0005_connection_settings"),
      migrationsSchema: "public",
      migrationsTable: "__drizzle_migrations",
    });
    await projectConnectors(pool);
    await seedOperator(pool);
    const stamp = new Date().toISOString();
    const key = Buffer.from(HEX_MASTER_KEY, "hex");
    const coins = [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin" }];
    const repositories = [{ name: "shop", url: "https://github.com/acme/shop", default_branch: "main" }];
    const insert = async (id: string, server: string, payload: Record<string, unknown>, extra: string, values: unknown[]) => {
      const [ciphertext, nonce] = encryptPayload(payload, key);
      await pool.query(
        `INSERT INTO mcp_connections (
           id, mcp_server_id, owner_scope, owner_id, org_id, account_hint, ciphertext, nonce,
           status, created_at, updated_at, rotated_at${extra ? `, ${extra}` : ""}
         ) VALUES ($1, $2, 'org', 'org_home', 'org_home', '', $3, $4, 'connected', $5, $5, $5${values.map((_, index) => `, $${index + 6}`).join("")})`,
        [id, server, ciphertext, nonce, stamp, ...values],
      );
    };
    // Pinned prices is a registry connector: its row is the one a registry install writes.
    await pool.query(
      `INSERT INTO connectors (
         id, slug, tool_prefix, owner_org_id, manifest, source, version, verified, publisher, enabled,
         oauth_client, overrides, installed_at, updated_at
       ) VALUES ('mcp_pinned_prices', 'pinned_prices', 'pinned_prices', NULL, $1::jsonb, 'registry', '1.0.0', TRUE,
         'guilds', TRUE, NULL, '{}'::jsonb, $2, $2)`,
      [JSON.stringify({ slug: "pinned_prices", display_name: "Pinned prices", auth: { kind: "token" }, description: "" }), stamp],
    );
    await insert("conn_pins", "mcp_pinned_prices", { token: "cg" }, "pinned_prices", [JSON.stringify(coins)]);
    await insert("conn_github", "mcp_github", { installation_id: 7 }, "github_repositories", [JSON.stringify(repositories)]);
    await insert(
      "conn_drive",
      "mcp_drive",
      { access_token: "ya29", drive_folder_id: "fold_1", drive_folder_name: "Agents" },
      "",
      [],
    );

    await applyMigrations(pool);
    await seedSystem(pool);

    const repo = new Repositories(pool);
    assert.deepEqual((await repo.getMcpConnection("conn_pins"))?.settings, { coins });
    assert.deepEqual((await repo.getMcpConnection("conn_github"))?.settings, { repositories });
    const drive = await repo.getMcpConnection("conn_drive");
    assert.deepEqual(drive?.settings, { folder_id: "fold_1" });
    assert.deepEqual(decryptPayload(drive?.ciphertext as Buffer, drive?.nonce as Buffer, key), { access_token: "ya29" });
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'mcp_connections' AND column_name IN ('pinned_prices', 'github_repositories')`,
    );
    assert.equal(columns.rowCount, 0);
  } finally {
    await pool.end();
  }
});
