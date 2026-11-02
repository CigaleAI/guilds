import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations, createPool, repairMigrations } from "../../src/db/client.js";
import { reportPoolError } from "../../src/observability/runtime.js";
import { connect } from "../../src/seed/connect.js";
import { MigrationsNotApplied, committedMigrations } from "../../src/db/migrations.js";
import { orchestratorRoot } from "../../src/lib/paths.js";
import { tempDir } from "../helpers/env.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { agentConfig } from "../helpers/generation.js";

const migrationsFolder = path.join(orchestratorRoot(import.meta.url), "drizzle");
const freshDb = uniqueDbName("agent_platform_migrate_fresh");
const extensionDb = uniqueDbName("agent_platform_migrate_extension");
const driftDb = uniqueDbName("agent_platform_migrate_drift");
const cliDb = uniqueDbName("agent_platform_migrate_cli");
const accessDb = uniqueDbName("agent_platform_migrate_access");
const configDb = uniqueDbName("agent_platform_migrate_config");
const systemOneDb = uniqueDbName("agent_platform_migrate_system_one");
const browserConfigDb = uniqueDbName("agent_platform_migrate_browser_config");
const listOnlyDb = uniqueDbName("agent_platform_migrate_list_only");
const listOnlyPathsDb = uniqueDbName("agent_platform_migrate_list_only_paths");

after(async () => {
  await dropIsolatedDatabase(freshDb);
  await dropIsolatedDatabase(extensionDb);
  await dropIsolatedDatabase(driftDb);
  await dropIsolatedDatabase(cliDb);
  await dropIsolatedDatabase(accessDb);
  await dropIsolatedDatabase(systemOneDb);
  await dropIsolatedDatabase(browserConfigDb);
  await dropIsolatedDatabase(listOnlyDb);
  await dropIsolatedDatabase(listOnlyPathsDb);
});

test("each migration is recorded once however often the chain is applied", async () => {
  const pool = await createPool(await createIsolatedDatabase(freshDb), reportPoolError);
  try {
    await applyMigrations(pool);
    const first = await pool.query("SELECT hash FROM public.__drizzle_migrations ORDER BY created_at");
    assert.equal(first.rowCount, readMigrationFiles({ migrationsFolder }).length);
    await applyMigrations(pool);
    const second = await pool.query("SELECT hash FROM public.__drizzle_migrations ORDER BY created_at");
    assert.deepEqual(second.rows, first.rows);
  } finally {
    await pool.end();
  }
});

test("migrations are stamped in order and before now, so a database applies every later one", () => {
  // A database applies a migration only when its stamp is later than the last one it recorded.
  const stamps = readMigrationFiles({ migrationsFolder }).map((migration) => migration.folderMillis);
  assert.ok(stamps.length > 0);
  for (const [index, stamp] of stamps.entries()) {
    assert.ok(stamp < Date.now(), `migration ${index + 1} is stamped in the future`);
    if (index > 0) assert.ok(stamp > stamps[index - 1]!, `migration ${index + 1} is stamped before the one it follows`);
  }
});

/** A copy of the migrations folder whose journal ends just before `tag`, or one migration early without it. */
function chainBefore(tag?: string): string {
  const folder = path.join(tempDir("migrations-"), "drizzle");
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const end = tag === undefined ? journal.entries.length - 1 : journal.entries.findIndex((entry) => entry.tag === tag);
  assert.ok(end >= 0, `no migration ${tag}`);
  journal.entries = journal.entries.slice(0, end);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

test("a migration skipped behind a later recorded stamp fails boot by name, and repair applies it keeping the data", async () => {
  const pool = await createPool(await createIsolatedDatabase(driftDb), reportPoolError);
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: chainBefore(),
      migrationsSchema: "public",
      migrationsTable: "__drizzle_migrations",
    });
    const [before, last] = committedMigrations(migrationsFolder).slice(-2);
    // The second to last migration was applied from a draft stamped after the last one.
    await pool.query("UPDATE public.__drizzle_migrations SET created_at = $1 WHERE hash = $2", [last!.stamp + 1, before!.hash]);
    await pool.query("CREATE TABLE public.kept (value text)");
    await pool.query("INSERT INTO public.kept VALUES ('data')");

    await assert.rejects(applyMigrations(pool), (error: unknown) => {
      assert.ok(error instanceof MigrationsNotApplied);
      assert.deepEqual(error.tags, [last!.tag]);
      assert.match(error.message, /make migrate/);
      return true;
    });

    assert.deepEqual(await repairMigrations(pool), [before!.tag]);
    const recorded = await pool.query("SELECT hash FROM public.__drizzle_migrations");
    assert.equal(recorded.rowCount, committedMigrations(migrationsFolder).length);
    assert.equal((await pool.query("SELECT value FROM public.kept")).rows[0].value, "data");
    assert.deepEqual(await repairMigrations(pool), [], "a repaired database has nothing left to re-stamp");
  } finally {
    await pool.end();
  }
});

test("an extension's migrations run after core's and before any seed", { timeout: 60_000 }, async () => {
  const order: string[] = [];
  const database = await connect(await createIsolatedDatabase(extensionDb), [
    {
      async migrate(pool) {
        const core = await pool.query("SELECT to_regclass('public.orgs') AS name");
        const seeded = await pool.query("SELECT count(*)::int AS count FROM public.connectors");
        order.push(`migrate: core tables ${core.rows[0].name === null ? "missing" : "present"}, ${seeded.rows[0].count} seeded rows`);
        await pool.query("CREATE TABLE public.extension_things (org_id text REFERENCES public.orgs (id))");
      },
      async seed(pool) {
        const mine = await pool.query("SELECT to_regclass('public.extension_things') AS name");
        const seeded = await pool.query("SELECT count(*)::int AS count FROM public.connectors");
        order.push(`seed: own table ${mine.rows[0].name === null ? "missing" : "present"}, core seeded ${seeded.rows[0].count > 0}`);
      },
    },
  ]);
  try {
    assert.deepEqual(order, ["migrate: core tables present, 0 seeded rows", "seed: own table present, core seeded true"]);
  } finally {
    await database.close();
  }
});

test("the native CLI migration drops the cli flag from recipe roles, keeping their order", async () => {
  const pool = await createPool(await createIsolatedDatabase(cliDb), reportPoolError);
  try {
    const folder = chainBefore("0007_native_cli");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const now = new Date().toISOString();
    await pool.query("INSERT INTO public.orgs (id, name, slug, created_at, updated_at) VALUES ('org_1', 'Org', 'org', $1, $1)", [now]);
    const body = {
      format: "guilds.recipe",
      roles: [
        { role: "lead", config: { model: "m", cli: false, browser: true } },
        { role: "coder", config: { coding: true, cli: true } },
        { role: "bare" },
      ],
    };
    await pool.query(
      `INSERT INTO public.recipes (id, org_id, name, body, source_kind, created_at, updated_at)
       VALUES ('rec_1', 'org_1', 'r', $1, 'file', $2, $2), ('rec_2', 'org_1', 'r2', '{"roles": []}', 'file', $2, $2)`,
      [JSON.stringify(body), now],
    );

    await applyMigrations(pool);
    const migrated = await pool.query("SELECT id, body FROM public.recipes ORDER BY id");
    assert.deepEqual(migrated.rows[0].body.roles, [
      { role: "lead", config: { model: "m", browser: true } },
      { role: "coder", config: { coding: true } },
      { role: "bare" },
    ]);
    assert.equal(migrated.rows[0].body.format, "guilds.recipe");
    assert.deepEqual(migrated.rows[1].body, { roles: [] });
  } finally {
    await pool.end();
  }
});

test("the access-list migration moves table rows, gives live guild and org items their default rows, and drops note grants", async () => {
  const pool = await createPool(await createIsolatedDatabase(accessDb), reportPoolError);
  try {
    const folder = chainBefore("0012_artifact_access");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const now = new Date().toISOString();
    const by = "'user', 'user_1', 'operator'";
    await pool.query("INSERT INTO public.orgs (id, name, slug, created_at, updated_at) VALUES ('org_1', 'Org', 'org', $1, $1)", [now]);
    await pool.query(
      "INSERT INTO public.guilds (id, name, org_id, created_at, updated_at) VALUES ('guild_a', 'a', 'org_1', $1, $1), ('guild_b', 'b', 'org_1', $1, $1)",
      [now],
    );
    await pool.query(
      `INSERT INTO public.artifact_collections (id, org_id, guild_id, name, purpose, created_by_type, created_by_id, created_by_name, created_at, updated_at, deleted_at)
       VALUES ('acol_org', 'org_1', NULL, 'shared', 'p', ${by}, $1, $1, NULL),
              ('acol_own', 'org_1', 'guild_a', 'own', 'p', ${by}, $1, $1, NULL),
              ('acol_gone', 'org_1', 'guild_a', 'gone', 'p', ${by}, $1, $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO public.collection_access (id, org_id, collection_id, subject_type, subject_id, mode, created_by_type, created_by_id, created_by_name, created_at)
       VALUES ('cacc_1', 'org_1', 'acol_org', 'guild', 'guild_b', 'read', ${by}, $1),
              ('cacc_2', 'org_1', 'acol_gone', 'guild', 'guild_b', 'read', ${by}, $1)`,
      [now],
    );
    const note = (id: string, level: string, owner: string, guild: string | null, deleted: string | null) =>
      pool.query(
        `INSERT INTO public.artifacts (id, org_id, level, owner_id, guild_id, kind, key, content_text, content_hash,
                                       created_by_type, created_by_id, created_by_name, updated_by_type, updated_by_id, updated_by_name,
                                       created_at, updated_at, deleted_at)
         VALUES ($1, 'org_1', $2, $3, $4, 'note', $1 || '.md', 'x', 'h', ${by}, ${by}, $5, $5, $6)`,
        [id, level, owner, guild, now, deleted],
      );
    await note("art_guild", "guild", "guild_a", "guild_a", null);
    await note("art_org", "org", "org_1", null, null);
    await note("art_deleted", "guild", "guild_a", "guild_a", now);
    await pool.query(
      `INSERT INTO public.bindings (id, catalog_kind, catalog_id, scope, scope_id, org_id, enabled, created_at, updated_at)
       VALUES ('bind_1', 'artifact_grant', 'write_org', 'org', 'org_1', 'org_1', true, $1, $1)`,
      [now],
    );

    await applyMigrations(pool);
    const rows = await pool.query(
      `SELECT target_kind, target_id, subject_type, subject_id, mode FROM public.artifact_access ORDER BY target_kind, target_id, subject_id`,
    );
    assert.deepEqual(rows.rows, [
      { target_kind: "collection", target_id: "acol_org", subject_type: "guild", subject_id: "guild_b", mode: "read" },
      { target_kind: "collection", target_id: "acol_org", subject_type: "org", subject_id: "org_1", mode: "read" },
      { target_kind: "collection", target_id: "acol_own", subject_type: "guild", subject_id: "guild_a", mode: "write" },
      // a deleted guild note gets its guild's row from the list-only migration further down the chain
      { target_kind: "note", target_id: "art_deleted", subject_type: "guild", subject_id: "guild_a", mode: "write" },
      { target_kind: "note", target_id: "art_guild", subject_type: "guild", subject_id: "guild_a", mode: "write" },
      { target_kind: "note", target_id: "art_org", subject_type: "org", subject_id: "org_1", mode: "read" },
    ]);
    const stamps = await pool.query(
      `SELECT DISTINCT updated_by_name = created_by_name AND updated_at = created_at AS same FROM public.artifact_access`,
    );
    assert.deepEqual(stamps.rows, [{ same: true }]);
    assert.equal((await pool.query("SELECT to_regclass('public.collection_access') AS name")).rows[0].name, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.bindings")).rows[0].n, 0);
  } finally {
    await pool.end();
  }
});

test("the agent config migration gives a config each key it predates, keeping the values it has", async () => {
  const pool = await createPool(await createIsolatedDatabase(configDb), reportPoolError);
  try {
    const folder = chainBefore("0014_agent_config_keys");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const now = new Date().toISOString();
    await pool.query("INSERT INTO public.orgs (id, name, slug, created_at, updated_at) VALUES ('org_1', 'Org', 'org', $1, $1)", [now]);
    await pool.query("INSERT INTO public.guilds (id, name, org_id, created_at, updated_at) VALUES ('guild_1', 'g', 'org_1', $1, $1)", [now]);
    await pool.query(
      "INSERT INTO public.machines (id, org_id, name, box, created_at, updated_at) VALUES ('mach_1', 'org_1', 'default', 'standard', $1, $1)",
      [now],
    );
    const MODEL = "openrouter/openai/gpt-5.6-luna";
    const agent = (id: string, slot: number, config: Record<string, unknown>) =>
      pool.query(
        `INSERT INTO public.agents (id, guild_id, name, config, created_at, updated_at, org_id, task, task_hash, task_updated_at, machine_id, machine_slot)
         VALUES ($1, 'guild_1', $1, $2, $3, $3, 'org_1', '', '', $3, 'mach_1', $4)`,
        [id, JSON.stringify(config), now, slot],
      );
    await agent("old", 0, { model: MODEL, coding: true, harness: "codex", max_steps: 200 });
    const full = agentConfig({ model: MODEL, temperature: 0.5 });
    await agent("full", 1, full);

    await applyMigrations(pool);
    const rows = await pool.query<{ id: string; config: Record<string, unknown> }>("SELECT id, config FROM public.agents ORDER BY id");
    const byId = new Map(rows.rows.map((row) => [row.id, row.config]));
    assert.deepEqual(byId.get("old"), agentConfig({ model: MODEL, coding: true, harness: "codex", max_steps: 200 }));
    assert.deepEqual(byId.get("full"), full);
  } finally {
    await pool.end();
  }
});

test("the System One migration keeps a group routing key under the new id", async () => {
  const pool = await createPool(await createIsolatedDatabase(systemOneDb), reportPoolError);
  try {
    const folder = chainBefore("0017_system_one_key");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const now = new Date().toISOString();
    for (const integration of ["group-routing", "web-search"]) {
      await pool.query(
        `INSERT INTO public.instance_keys (integration, ciphertext, nonce, set_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, $4, $4)`,
        [integration, Buffer.from(`${integration}-ciphertext`), Buffer.from(`${integration}-nonce`), now],
      );
    }

    await applyMigrations(pool);
    const rows = await pool.query<{ integration: string; ciphertext: Buffer }>(
      "SELECT integration, ciphertext FROM public.instance_keys ORDER BY integration",
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.integration, row.ciphertext.toString()]),
      [
        ["system-one", "group-routing-ciphertext"],
        ["web-search", "web-search-ciphertext"],
      ],
    );
  } finally {
    await pool.end();
  }
});

test("the agent browser config migration gives a config the browser mode keys, keeping the values it has", async () => {
  const pool = await createPool(await createIsolatedDatabase(browserConfigDb), reportPoolError);
  try {
    const folder = chainBefore("0018_agent_browser_config");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const now = new Date().toISOString();
    await pool.query("INSERT INTO public.orgs (id, name, slug, created_at, updated_at) VALUES ('org_1', 'Org', 'org', $1, $1)", [now]);
    await pool.query("INSERT INTO public.guilds (id, name, org_id, created_at, updated_at) VALUES ('guild_1', 'g', 'org_1', $1, $1)", [now]);
    await pool.query(
      "INSERT INTO public.machines (id, org_id, name, box, created_at, updated_at) VALUES ('mach_1', 'org_1', 'default', 'standard', $1, $1)",
      [now],
    );
    const MODEL = "openrouter/openai/gpt-5.6-luna";
    const agent = (id: string, slot: number, config: Record<string, unknown>) =>
      pool.query(
        `INSERT INTO public.agents (id, guild_id, name, config, created_at, updated_at, org_id, task, task_hash, task_updated_at, machine_id, machine_slot)
         VALUES ($1, 'guild_1', $1, $2, $3, $3, 'org_1', '', '', $3, 'mach_1', $4)`,
        [id, JSON.stringify(config), now, slot],
      );
    const { browser_optimized: _optimized, browser_model: _model, ...older } = agentConfig({ model: MODEL, browser: true });
    await agent("old", 0, older);
    const optimized = agentConfig({ model: MODEL, browser: true, browser_optimized: true, browser_model: MODEL });
    await agent("optimized", 1, optimized);

    await applyMigrations(pool);
    const rows = await pool.query<{ id: string; config: Record<string, unknown> }>("SELECT id, config FROM public.agents ORDER BY id");
    const byId = new Map(rows.rows.map((row) => [row.id, row.config]));
    assert.deepEqual(byId.get("old"), agentConfig({ model: MODEL, browser: true }));
    assert.deepEqual(byId.get("optimized"), optimized);
  } finally {
    await pool.end();
  }
});

test("the list-only migration gives agent items their row, renames names several owners held, and rewrites every link to a moved item", async () => {
  const pool = await createPool(await createIsolatedDatabase(listOnlyDb), reportPoolError);
  try {
    const folder = chainBefore("0020_access_list_only");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const by = "'user', 'user_1', 'operator'";
    await pool.query("INSERT INTO public.orgs (id, name, slug, created_at, updated_at) VALUES ('org_1', 'Org', 'org', $1, $1)", [at(0)]);
    await pool.query(
      "INSERT INTO public.guilds (id, name, org_id, created_at, updated_at) VALUES ('guild_a', 'Desk A!', 'org_1', $1, $1), ('guild_b', 'b', 'org_1', $1, $1)",
      [at(0)],
    );
    await pool.query(
      "INSERT INTO public.machines (id, org_id, name, box, created_at, updated_at) VALUES ('mach_1', 'org_1', 'default', 'standard', $1, $1)",
      [at(0)],
    );
    const config = JSON.stringify(agentConfig({ model: "openrouter/openai/gpt-5.6-luna" }));
    const task = "Follow ![[org/org_1/guilds/guild_a/plan.md]], keep org/org_1/agents/a_1/memory.md.\n";
    await pool.query(
      `INSERT INTO public.agents (id, guild_id, name, config, created_at, updated_at, org_id, task, task_hash, task_updated_at, machine_id, machine_slot)
       VALUES ('a_1', 'guild_a', 'scout', $1, $2, $2, 'org_1', $3, 'stale', $2, 'mach_1', 0),
              ('a_2', 'guild_b', 'writer', $1, $2, $2, 'org_1', '', '', $2, 'mach_1', 1)`,
      [config, at(0), task],
    );
    await pool.query(
      `INSERT INTO public.task_revisions (id, org_id, agent_id, version, content_text, replaced_at, replaced_by_type, replaced_by_id, replaced_by_name, created_at)
       VALUES ('trev_1', 'org_1', 'a_1', 1, 'Read ![[org/org_1/agents/a_2/mine.md]]', $1, ${by}, $1)`,
      [at(0)],
    );
    const item = (row: { id: string; level: string; owner: string; kind: string; path: string; key: string; text: string | null; minute: number; deleted?: boolean }) => {
      const guild = row.level === "guild" ? row.owner : row.level === "agent" ? (row.owner === "a_1" ? "guild_a" : "guild_b") : null;
      const agent = row.level === "agent" ? row.owner : null;
      const file = row.kind === "file";
      return pool.query(
        `INSERT INTO public.artifacts (id, org_id, level, owner_id, guild_id, agent_id, kind, path, key, title, content_text, search_text,
                                       mime, bytes, content_hash, created_by_type, created_by_id, created_by_name,
                                       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at, deleted_at)
         VALUES ($1, 'org_1', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'h', ${by}, ${by}, $14, $14, $15)`,
        [
          row.id, row.level, row.owner, guild, agent, row.kind, row.path, row.key,
          file ? "A file" : null, row.text, file ? `${row.key} A file` : row.key,
          file ? "text/csv" : null, file ? 3 : null, at(row.minute), row.deleted ? at(row.minute) : null,
        ],
      );
    };
    await item({ id: "art_org_plan", level: "org", owner: "org_1", kind: "note", path: "", key: "plan.md", text: "org", minute: 1 });
    await item({ id: "art_guild_plan", level: "guild", owner: "guild_a", kind: "note", path: "", key: "plan.md", text: "guild", minute: 2 });
    await item({ id: "art_agent_plan", level: "agent", owner: "a_1", kind: "note", path: "", key: "plan.md", text: "agent", minute: 3 });
    await item({ id: "art_taken", level: "org", owner: "org_1", kind: "note", path: "", key: "scout-plan.md", text: "taken", minute: 4 });
    await item({
      id: "art_mine",
      level: "agent",
      owner: "a_2",
      kind: "note",
      path: "",
      key: "mine.md",
      text: "See ![[org/org_1/guilds/guild_a/plan.md]] and org/org_1/agents/a_1/plan.md.",
      minute: 5,
    });
    await item({ id: "art_gone", level: "agent", owner: "a_2", kind: "note", path: "", key: "gone.md", text: "gone", minute: 6, deleted: true });
    await item({ id: "art_gone_guild", level: "guild", owner: "guild_a", kind: "file", path: "files", key: "gone.csv", text: null, minute: 6, deleted: true });
    await item({ id: "art_gone_org", level: "org", owner: "org_1", kind: "note", path: "", key: "gone-org.md", text: "gone", minute: 6, deleted: true });
    await item({ id: "art_data", level: "agent", owner: "a_1", kind: "file", path: "files", key: "data.csv", text: null, minute: 7 });
    await item({ id: "art_memory", level: "agent", owner: "a_1", kind: "memory", path: "", key: "memory.md", text: "Mine is org/org_1/agents/a_2/mine.md", minute: 8 });
    await pool.query(
      `INSERT INTO public.artifact_access (id, org_id, target_kind, target_id, subject_type, subject_id, mode,
                                           created_by_type, created_by_id, created_by_name, created_at,
                                           updated_by_type, updated_by_id, updated_by_name, updated_at)
       VALUES ('aacc_guild', 'org_1', 'note', 'art_guild_plan', 'guild', 'guild_a', 'write', ${by}, $1, ${by}, $1)`,
      [at(2)],
    );
    await pool.query(
      `INSERT INTO public.file_changes (id, org_id, artifact_id, display_path, operation, version, actor_type, actor_id, actor_name, created_at)
       VALUES ('fchg_1', 'org_1', 'art_guild_plan', 'org/org_1/guilds/guild_a/plan.md', 'create', 1, 'user', 'user_1', 'operator', $1)`,
      [at(2)],
    );
    const recipe = {
      notes: [
        { id: "k", level: "agent", role: "scout", key: "k.md", body: "Kept.", kind: "seed", writers: [] },
        { id: "g", level: "guild", key: "g.md", body: "Shared.", kind: "seed", writers: [] },
        { id: "o", level: "org", key: "o.md", body: "Read.", kind: "seed", writers: ["writer"] },
      ],
      roles: [{ role: "scout", task: { body: "![[guild/g.md]] then note_get agent/scout/k.md, not catalog/guild/x.md" } }],
    };
    await pool.query(
      `INSERT INTO public.recipes (id, org_id, name, body, source_kind, created_at, updated_at) VALUES ('rcp_1', 'org_1', 'desk', $1, 'file', $2, $2)`,
      [JSON.stringify(recipe), at(0)],
    );

    await applyMigrations(pool);

    const access = await pool.query(
      `SELECT target_kind, target_id, subject_type, subject_id, mode FROM public.artifact_access ORDER BY target_id COLLATE "C"`,
    );
    assert.deepEqual(access.rows, [
      { target_kind: "note", target_id: "art_agent_plan", subject_type: "agent", subject_id: "a_1", mode: "write" },
      { target_kind: "file", target_id: "art_data", subject_type: "agent", subject_id: "a_1", mode: "write" },
      // a tombstone keeps a row for its former guild or agent; an organisation tombstone needs none
      { target_kind: "note", target_id: "art_gone", subject_type: "agent", subject_id: "a_2", mode: "write" },
      { target_kind: "file", target_id: "art_gone_guild", subject_type: "guild", subject_id: "guild_a", mode: "write" },
      { target_kind: "note", target_id: "art_guild_plan", subject_type: "guild", subject_id: "guild_a", mode: "write" },
      { target_kind: "note", target_id: "art_mine", subject_type: "agent", subject_id: "a_2", mode: "write" },
    ]);
    const keys = await pool.query<{ id: string; key: string; agent_id: string | null; search_text: string | null }>(
      "SELECT id, key, agent_id, search_text FROM public.artifacts ORDER BY id",
    );
    const byId = new Map(keys.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("art_org_plan")?.key, "plan.md", "the oldest keeps its name");
    assert.equal(byId.get("art_guild_plan")?.key, "desk-a-plan.md");
    assert.equal(byId.get("art_guild_plan")?.search_text, "desk-a-plan.md");
    assert.equal(byId.get("art_agent_plan")?.key, "scout-2-plan.md", "a taken prefixed name is numbered");
    assert.equal(byId.get("art_data")?.agent_id, null);
    assert.equal(byId.get("art_mine")?.agent_id, null);
    assert.equal(byId.get("art_memory")?.agent_id, "a_1", "Memory stays its agent's");
    const renames = await pool.query(
      "SELECT artifact_id, old_display_path, new_display_path FROM public.artifact_renames ORDER BY artifact_id COLLATE \"C\"",
    );
    assert.deepEqual(renames.rows, [
      { artifact_id: "art_agent_plan", old_display_path: "org/org_1/agents/a_1/plan.md", new_display_path: "org/org_1/scout-2-plan.md" },
      { artifact_id: "art_guild_plan", old_display_path: "org/org_1/guilds/guild_a/plan.md", new_display_path: "org/org_1/desk-a-plan.md" },
    ]);

    const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const agent = (await pool.query<{ task: string; task_hash: string }>("SELECT task, task_hash FROM public.agents WHERE id = 'a_1'")).rows[0];
    assert.equal(agent?.task, "Follow ![[org/org_1/desk-a-plan.md]], keep org/org_1/agents/a_1/memory.md.\n");
    assert.equal(agent?.task_hash, sha256(agent?.task ?? ""));
    const revision = await pool.query<{ content_text: string }>("SELECT content_text FROM public.task_revisions WHERE id = 'trev_1'");
    assert.equal(revision.rows[0]?.content_text, "Read ![[org/org_1/mine.md]]");
    const texts = await pool.query<{ id: string; content_text: string; content_hash: string }>(
      "SELECT id, content_text, content_hash FROM public.artifacts WHERE id IN ('art_mine', 'art_memory') ORDER BY id",
    );
    assert.deepEqual(
      texts.rows.map((row) => [row.id, row.content_text, row.content_hash === sha256(row.content_text)]),
      [
        ["art_memory", "Mine is org/org_1/mine.md", true],
        ["art_mine", "See ![[org/org_1/desk-a-plan.md]] and org/org_1/scout-2-plan.md.", true],
      ],
    );
    const history = await pool.query<{ display_path: string }>("SELECT display_path FROM public.file_changes WHERE id = 'fchg_1'");
    assert.equal(history.rows[0]?.display_path, "org/org_1/desk-a-plan.md");

    const body = (await pool.query<{ body: typeof recipe }>("SELECT body FROM public.recipes WHERE id = 'rcp_1'")).rows[0]?.body;
    assert.deepEqual(body?.notes, [
      { id: "k", key: "k.md", body: "Kept.", kind: "seed", writers: ["scout"] },
      { id: "g", key: "g.md", body: "Shared.", kind: "seed", writers: [], guild: "write" },
      { id: "o", key: "o.md", body: "Read.", kind: "seed", writers: ["writer"], guild: "read", org: "read" },
    ]);
    assert.equal(body?.roles[0]?.task.body, "![[org/g.md]] then note_get org/k.md, not catalog/guild/x.md");

    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'artifacts' AND column_name IN ('level', 'owner_id', 'guild_id')",
    );
    assert.deepEqual(columns.rows, []);
    await assert.rejects(
      pool.query(
        `INSERT INTO public.artifacts (id, org_id, kind, path, key, content_text, content_hash, created_by_type, created_by_id, created_by_name,
                                       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at)
         VALUES ('art_twin', 'org_1', 'note', '', 'plan.md', 'x', 'h', ${by}, ${by}, $1, $1)`,
        [at(9)],
      ),
      /artifacts_natural_key/,
      "a note name is unique in its organisation",
    );
  } finally {
    await pool.end();
  }
});

test("the list-only migration rewrites each moved path once and only where it is a whole path", async () => {
  const pool = await createPool(await createIsolatedDatabase(listOnlyPathsDb), reportPoolError);
  try {
    const folder = chainBefore("0020_access_list_only");
    await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: "public", migrationsTable: "__drizzle_migrations" });
    const at = (minutes: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + minutes * 60_000).toISOString();
    const by = "'user', 'user_1', 'operator'";
    await pool.query("INSERT INTO public.orgs (id, name, slug, created_at, updated_at) VALUES ('org_1', 'Org', 'org', $1, $1)", [at(0)]);
    await pool.query("INSERT INTO public.guilds (id, name, org_id, created_at, updated_at) VALUES ('guild_a', 'desk', 'org_1', $1, $1)", [at(0)]);
    await pool.query(
      "INSERT INTO public.machines (id, org_id, name, box, created_at, updated_at) VALUES ('mach_1', 'org_1', 'default', 'standard', $1, $1)",
      [at(0)],
    );
    const named = "Read org/org_1/agents/a_1/plan.md first.";
    await pool.query(
      `INSERT INTO public.agents (id, guild_id, name, config, created_at, updated_at, org_id, task, task_hash, task_updated_at, machine_id, machine_slot,
                                  focus, wake_triggers)
       VALUES ('a_1', 'guild_a', 'scout', $1, $2, $2, 'org_1', '', '', $2, 'mach_1', 0, $3, $3)`,
      [JSON.stringify(agentConfig({ model: "openrouter/openai/gpt-5.6-luna" })), at(0), named],
    );
    await pool.query("UPDATE public.guilds SET about = $1, description = $1 WHERE id = 'guild_a'", [named]);
    await pool.query(
      `INSERT INTO public.schedules (id, agent_id, instruction, description, cron, next_run_at, created_at, updated_at)
       VALUES ('sch_1', 'a_1', $1, $1, '0 9 * * 1', $2, $2, $2)`,
      [named, at(0)],
    );
    const item = (id: string, level: "agent" | "org", kind: "note" | "file", key: string, minute: number, text: string | null) =>
      pool.query(
        `INSERT INTO public.artifacts (id, org_id, level, owner_id, guild_id, agent_id, kind, path, key, title, content_text, search_text,
                                       mime, bytes, content_hash, created_by_type, created_by_id, created_by_name,
                                       updated_by_type, updated_by_id, updated_by_name, created_at, updated_at)
         VALUES ($1, 'org_1', $2, $3, $4, $5, $6, $7, $8, $9, $10, $8, $11, $12, 'h', ${by}, ${by}, $13, $13)`,
        [
          id, level, level === "agent" ? "a_1" : "org_1", level === "agent" ? "guild_a" : null, level === "agent" ? "a_1" : null,
          kind, kind === "file" ? "files" : "", key, kind === "file" ? "A file" : null, text,
          kind === "file" ? "text/csv" : null, kind === "file" ? 3 : null, at(minute),
        ],
      );
    // The agent's plan is the older, so the organisation's, younger, is the one renamed.
    await item("art_agent_plan", "agent", "note", "plan.md", 1, "agent");
    await item("art_org_plan", "org", "note", "plan.md", 2, "org");
    await item("art_csv", "agent", "file", "a.csv", 3, null);
    await item("art_gz", "org", "file", "a.csv.gz", 4, null);
    await item(
      "art_links",
      "org",
      "note",
      "links.md",
      5,
      "A ![[org/org_1/agents/a_1/plan.md]] B ![[org/org_1/plan.md]] C org/org_1/agents/a_1/files/a.csv. " +
        "Keep org/org_1/agents/a_1/files/a.csv.gz and org/org_1/files/a.csv.gz. End org/org_1/plan.md.",
    );
    const recipe = {
      notes: [
        { id: "g", level: "guild", key: "plan.md", body: "Plan.", kind: "seed", writers: [] },
        { id: "k", level: "agent", role: "scout", key: "k.md", body: "Kept.", kind: "seed", writers: [] },
      ],
      roles: [{ role: "scout", task: { body: "Steps:\nguild/plan.md\tthen agent/scout/k.md" } }],
    };
    await pool.query(
      `INSERT INTO public.recipes (id, org_id, name, body, source_kind, created_at, updated_at) VALUES ('rcp_1', 'org_1', 'desk', $1, 'file', $2, $2)`,
      [JSON.stringify(recipe), at(0)],
    );
    const colliding = {
      notes: [
        { id: "s", level: "agent", role: "scout", key: "log.md", body: "Scout.", kind: "seed", writers: [] },
        { id: "w", level: "agent", role: "writer", key: "log.md", body: "Writer.", kind: "seed", writers: [] },
        { id: "g", level: "guild", key: "log.md", body: "Guild.", kind: "seed", writers: [] },
        { id: "o", level: "org", key: "log.md", body: "Org.", kind: "seed", writers: [] },
      ],
      roles: [{ role: "writer", task: { body: "![[agent/writer/log.md]] ![[agent/scout/log.md]] guild/log.md org/log.md", embeds: ["agent/writer/log.md"] } }],
    };
    await pool.query(
      `INSERT INTO public.recipes (id, org_id, name, body, source_kind, created_at, updated_at) VALUES ('rcp_2', 'org_1', 'logs', $1, 'file', $2, $2)`,
      [JSON.stringify(colliding), at(0)],
    );

    await applyMigrations(pool);

    const logs = (await pool.query<{ body: { notes: Array<{ id: string; key: string }>; roles: Array<{ task: { body: string; embeds: string[] } }> } }>(
      "SELECT body FROM public.recipes WHERE id = 'rcp_2'",
    )).rows[0]?.body;
    assert.deepEqual(logs?.notes.map((note) => [note.id, note.key]), [
      ["s", "log.md"],
      ["w", "writer-log.md"],
      ["g", "guild-log.md"],
      ["o", "org-log.md"],
    ]);
    assert.equal(logs?.roles[0]?.task.body, "![[org/writer-log.md]] ![[org/log.md]] org/guild-log.md org/org-log.md");
    assert.deepEqual(logs?.roles[0]?.task.embeds, ["org/writer-log.md"]);

    const keys = await pool.query<{ id: string; key: string }>("SELECT id, key FROM public.artifacts WHERE id IN ('art_agent_plan', 'art_org_plan')");
    assert.deepEqual(Object.fromEntries(keys.rows.map((row) => [row.id, row.key])), { art_agent_plan: "plan.md", art_org_plan: "org-plan.md" });
    const links = await pool.query<{ content_text: string }>("SELECT content_text FROM public.artifacts WHERE id = 'art_links'");
    assert.equal(
      links.rows[0]?.content_text,
      "A ![[org/org_1/plan.md]] B ![[org/org_1/org-plan.md]] C org/org_1/files/a.csv. " +
        "Keep org/org_1/agents/a_1/files/a.csv.gz and org/org_1/files/a.csv.gz. End org/org_1/org-plan.md.",
    );
    const body = (await pool.query<{ body: { roles: Array<{ task: { body: string } }> } }>("SELECT body FROM public.recipes WHERE id = 'rcp_1'")).rows[0]?.body;
    assert.equal(body?.roles[0]?.task.body, "Steps:\norg/plan.md\tthen org/k.md");
    const moved = "Read org/org_1/plan.md first.";
    assert.deepEqual(
      (await pool.query("SELECT focus, wake_triggers FROM public.agents WHERE id = 'a_1'")).rows[0],
      { focus: moved, wake_triggers: moved },
    );
    assert.deepEqual((await pool.query("SELECT about, description FROM public.guilds WHERE id = 'guild_a'")).rows[0], { about: moved, description: moved });
    assert.deepEqual(
      (await pool.query("SELECT instruction, description FROM public.schedules WHERE id = 'sch_1'")).rows[0],
      { instruction: moved, description: moved },
    );
  } finally {
    await pool.end();
  }
});
