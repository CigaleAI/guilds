import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations, connect, createPool } from "../../src/db/client.js";
import { orchestratorRoot } from "../../src/lib/paths.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const migrationsFolder = path.join(orchestratorRoot(import.meta.url), "drizzle");
const freshDb = uniqueDbName("agent_platform_migrate_fresh");
const editionDb = uniqueDbName("agent_platform_migrate_edition");

after(async () => {
  await dropIsolatedDatabase(freshDb);
  await dropIsolatedDatabase(editionDb);
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
