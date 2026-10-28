import assert from "node:assert/strict";
import { after, test } from "node:test";
import { applyMigrations, createPool } from "../../src/db/client.js";
import { reportPoolError } from "../../src/observability/runtime.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { applySql, drizzleMigrationSql, dumpSchema, normalizeDump } from "../helpers/schema-dump.js";

// Optional drizzle SQL ↔ boot-migrator dump lock. Not part of the default
// suite: it needs matching pg_dump/server majors and does not exercise the
// hosted app or Cloud SQL. Run by changing skip → test when checking schema files.

const sqlDb = uniqueDbName("agent_platform_r1");
const migrateDb = uniqueDbName("agent_platform_r1");

after(async () => {
  await dropIsolatedDatabase(sqlDb);
  await dropIsolatedDatabase(migrateDb);
});

test.skip("normalized migrate dump matches applying drizzle SQL", async () => {
  await createIsolatedDatabase(sqlDb);
  applySql(sqlDb, drizzleMigrationSql());

  const migrateUrl = await createIsolatedDatabase(migrateDb);
  const pool = await createPool(migrateUrl, reportPoolError);
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }

  const fromSql = normalizeDump(dumpSchema(sqlDb));
  const fromMigrate = normalizeDump(dumpSchema(migrateDb));
  assert.equal(
    fromMigrate,
    fromSql,
    "drizzle migrate must match applying drizzle/*.sql after stripping SET GUCs and __drizzle_migrations",
  );
  assert.equal(fromSql.includes("agent_scripts"), false);
  assert.match(fromSql, /CREATE TABLE public\.guilds /);
  assert.match(fromSql, /CREATE TABLE public\.artifacts /);
  assert.match(fromSql, /CREATE TABLE public\.recipes /);
  assert.match(fromSql, /CREATE TABLE public\.builder_sessions /);
  assert.match(fromSql, /CREATE TABLE public\.signup_allowlist /);
});
