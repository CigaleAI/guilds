import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { applyMigrations, createPool, type Database } from "../db/client.js";
import * as schema from "../db/schema/index.js";
import { reportPoolError } from "../observability/runtime.js";
import { seedOperator } from "./operator.js";
import { seedSystem } from "./system.js";

/**
 * What an extension adds to the database at boot: migrations of its own tables, applied after
 * core's, and a seed.
 */
export type DatabaseExtension = {
  migrate?(pool: pg.Pool): Promise<void>;
  seed?(pool: pg.Pool): Promise<void>;
};

/**
 * Migrates and seeds: core's migrations, then each extension's; core's catalog, then each extension's
 * seed in order, then core's operator, which a box the seeds have populated does not get.
 */
export async function connect(
  databaseUrl: string,
  extensions: readonly DatabaseExtension[] = [],
): Promise<Database> {
  const pool = await createPool(databaseUrl, reportPoolError);
  await applyMigrations(pool);
  for (const extension of extensions) {
    await extension.migrate?.(pool);
  }
  await seedSystem(pool);
  for (const extension of extensions) {
    await extension.seed?.(pool);
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
