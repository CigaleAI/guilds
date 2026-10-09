import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { orchestratorRoot } from "../lib/paths.js";
import { seedOperator } from "./seed/operator.js";
import { seedSystem } from "./seed/system.js";
import { installCodecs } from "./install-codecs.js";
import * as schema from "./schema/index.js";

const migrationsFolder = path.join(orchestratorRoot(import.meta.url), "drizzle");

export type Database = {
  pool: pg.Pool;
  drizzle: ReturnType<typeof drizzle<typeof schema>>;
  ping(): Promise<void>;
  close(): Promise<void>;
};

/**
 * What an edition adds to the database at boot: migrations of its own tables, applied after
 * core's, and a seed.
 */
export type DatabaseExtension = {
  migrate?(pool: pg.Pool): Promise<void>;
  seed?(pool: pg.Pool): Promise<void>;
};

export async function createPool(databaseUrl: string): Promise<pg.Pool> {
  installCodecs();
  return new pg.Pool({
    connectionString: databaseUrl,
    min: 1,
    max: 5,
  });
}

export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool, { schema });
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: "public",
    migrationsTable: "__drizzle_migrations",
  });
}

/**
 * Migrates and seeds: core's migrations, then each edition's; core's catalog, then each edition's
 * seed in order, then core's operator, which a box the seeds have populated does not get.
 */
export async function connect(
  databaseUrl: string,
  editions: readonly DatabaseExtension[] = [],
): Promise<Database> {
  const pool = await createPool(databaseUrl);
  await applyMigrations(pool);
  for (const edition of editions) {
    await edition.migrate?.(pool);
  }
  await seedSystem(pool);
  for (const edition of editions) {
    await edition.seed?.(pool);
  }
  await seedOperator(pool);
  const db = drizzle(pool, { schema });
  return {
    pool,
    drizzle: db,
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  };
}
