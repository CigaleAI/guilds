import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { orchestratorRoot } from "../lib/paths.js";
import { installCodecs } from "./install-codecs.js";
import { assertMigrationsApplied, restampMigrations } from "./migrations.js";
import * as schema from "./schema/index.js";

const migrationsFolder = path.join(orchestratorRoot(import.meta.url), "drizzle");

export type Database = {
  pool: pg.Pool;
  drizzle: ReturnType<typeof drizzle<typeof schema>>;
  ping(): Promise<void>;
  close(): Promise<void>;
};

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The pool: TCP keepalive on each connection, a connection that does not finish its handshake
 * in 10 seconds fails, and one that fails while idle goes to `onIdleError` instead of crashing the
 * process.
 */
export async function createPool(
  databaseUrl: string,
  onIdleError: (error: Error) => void,
): Promise<pg.Pool> {
  installCodecs();
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    min: 1,
    max: 5,
    keepAlive: true,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  pool.on("error", onIdleError);
  return pool;
}

/** Applies core's committed migrations; throws `MigrationsNotApplied` when one was skipped. */
export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool, { schema });
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: "public",
    migrationsTable: "__drizzle_migrations",
  });
  await assertMigrationsApplied(pool, migrationsFolder);
}

/**
 * Re-stamps the recorded migrations with their committed stamps, then applies core's
 * migrations; returns the tags it re-stamped. For a development database that recorded a
 * draft's stamp.
 */
export async function repairMigrations(pool: pg.Pool): Promise<string[]> {
  const restamped = await restampMigrations(pool, migrationsFolder);
  await applyMigrations(pool);
  return restamped;
}
