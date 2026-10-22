import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations, connect, createPool, repairMigrations } from "../../src/db/client.js";
import { MigrationsNotApplied, committedMigrations } from "../../src/db/migrations.js";
import { orchestratorRoot } from "../../src/lib/paths.js";
import { tempDir } from "../helpers/env.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const migrationsFolder = path.join(orchestratorRoot(import.meta.url), "drizzle");
const freshDb = uniqueDbName("agent_platform_migrate_fresh");
const editionDb = uniqueDbName("agent_platform_migrate_edition");
const driftDb = uniqueDbName("agent_platform_migrate_drift");
const cliDb = uniqueDbName("agent_platform_migrate_cli");
const accessDb = uniqueDbName("agent_platform_migrate_access");

after(async () => {
  await dropIsolatedDatabase(freshDb);
  await dropIsolatedDatabase(editionDb);
  await dropIsolatedDatabase(driftDb);
  await dropIsolatedDatabase(cliDb);
  await dropIsolatedDatabase(accessDb);
});

test("each migration is recorded once however often the chain is applied", async () => {
  const pool = await createPool(await createIsolatedDatabase(freshDb));
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
  const pool = await createPool(await createIsolatedDatabase(driftDb));
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

test("an edition's migrations run after core's and before any seed", { timeout: 60_000 }, async () => {
  const order: string[] = [];
  const database = await connect(await createIsolatedDatabase(editionDb), [
    {
      async migrate(pool) {
        const core = await pool.query("SELECT to_regclass('public.orgs') AS name");
        const seeded = await pool.query("SELECT count(*)::int AS count FROM public.connectors");
        order.push(`migrate: core tables ${core.rows[0].name === null ? "missing" : "present"}, ${seeded.rows[0].count} seeded rows`);
        await pool.query("CREATE TABLE public.edition_things (org_id text REFERENCES public.orgs (id))");
      },
      async seed(pool) {
        const mine = await pool.query("SELECT to_regclass('public.edition_things') AS name");
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
  const pool = await createPool(await createIsolatedDatabase(cliDb));
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
  const pool = await createPool(await createIsolatedDatabase(accessDb));
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
