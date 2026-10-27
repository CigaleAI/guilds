import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { applyMigrations, createPool } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// Row types are derived from src/db/schema, so it must describe the tables the migrations create.

type Column = { type: string; notNull: boolean };

const dbName = uniqueDbName("agent_platform_schema_mirror");
const migrated = new Map<string, Map<string, Column>>();

function declaredTables(): Map<string, Map<string, Column>> {
  const tables = new Map<string, Map<string, Column>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }
    const config = getTableConfig(value);
    const columns = new Map<string, Column>();
    for (const column of config.columns) {
      columns.set(column.name, { type: column.getSQLType(), notNull: column.notNull });
    }
    tables.set(config.name, columns);
  }
  return tables;
}

before(async () => {
  const url = await createIsolatedDatabase(dbName);
  const pool = await createPool(url);
  try {
    await applyMigrations(pool);
    const result = await pool.query<{ table: string; column: string; type: string; not_null: boolean }>(
      `SELECT c.relname AS table, a.attname AS column,
              format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND c.relname <> '__drizzle_migrations'`,
    );
    for (const row of result.rows) {
      const columns = migrated.get(row.table) ?? new Map<string, Column>();
      columns.set(row.column, { type: row.type, notNull: row.not_null });
      migrated.set(row.table, columns);
    }
  } finally {
    await pool.end();
  }
});

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("the schema declares every table the migrations create, and no other", () => {
  assert.deepEqual([...declaredTables().keys()].sort(), [...migrated.keys()].sort());
});

test("every schema key is its column's name, as raw query rows carry it", () => {
  const renamed: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }
    for (const [key, column] of Object.entries(getTableColumns(value))) {
      if (key !== column.name) {
        renamed.push(`${getTableConfig(value).name}.${key} names ${column.name}`);
      }
    }
  }
  assert.deepEqual(renamed, []);
});

test("every declared column has the migrated column's type and nullability", () => {
  const mismatches: string[] = [];
  for (const [table, columns] of declaredTables()) {
    const actual = migrated.get(table) ?? new Map<string, Column>();
    for (const name of new Set([...columns.keys(), ...actual.keys()])) {
      const declared = columns.get(name);
      const real = actual.get(name);
      if (JSON.stringify(declared) !== JSON.stringify(real)) {
        mismatches.push(`${table}.${name}: declared ${JSON.stringify(declared)}, migrated ${JSON.stringify(real)}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
});
