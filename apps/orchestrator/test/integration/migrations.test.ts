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

after(async () => {
  await dropIsolatedDatabase(freshDb);
  await dropIsolatedDatabase(editionDb);
  await dropIsolatedDatabase(driftDb);
  await dropIsolatedDatabase(cliDb);
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
