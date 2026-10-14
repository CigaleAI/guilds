import { readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";

/**
 * Core's committed migrations, and the checks around applying them. The migrator applies a
 * migration only when its stamp is later than the last one the database recorded, and never
 * compares hashes: a database that recorded a migration under another stamp, such as a draft's,
 * skips every committed migration stamped before it, without an error.
 */

/** Core's migrations are recorded in this table, in schema `public`. */
export const MIGRATIONS_TABLE = "public.__drizzle_migrations";

export type CommittedMigration = { tag: string; hash: string; stamp: number };

/** Committed migrations the database has not recorded, by tag. */
export class MigrationsNotApplied extends Error {
  readonly tags: string[];

  constructor(tags: string[]) {
    super(
      `migrations ${tags.join(", ")} are not applied: the database recorded an earlier migration under a later ` +
        "stamp than the committed one, so they were skipped. On a development stack, `make migrate` re-stamps " +
        "the recorded migrations and applies them, keeping the data.",
    );
    this.name = "MigrationsNotApplied";
    this.tags = tags;
  }
}

/** The migrations in `folder` in journal order: each one's tag, the hash of its SQL, and its stamp. */
export function committedMigrations(folder: string): CommittedMigration[] {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return readMigrationFiles({ migrationsFolder: folder }).map((migration, index) => ({
    tag: journal.entries[index]?.tag ?? `#${index + 1}`,
    hash: migration.hash,
    stamp: migration.folderMillis,
  }));
}

async function recordedStamps(pool: pg.Pool): Promise<Map<string, number>> {
  const result = await pool.query(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE}`);
  return new Map(result.rows.map((row: { hash: string; created_at: string }) => [row.hash, Number(row.created_at)]));
}

/** Throws `MigrationsNotApplied` naming each committed migration the database has not recorded. */
export async function assertMigrationsApplied(pool: pg.Pool, folder: string): Promise<void> {
  const recorded = await recordedStamps(pool);
  const missing = committedMigrations(folder).filter((migration) => !recorded.has(migration.hash));
  if (missing.length) {
    throw new MigrationsNotApplied(missing.map((migration) => migration.tag));
  }
}

/**
 * Gives each recorded migration whose SQL is a committed one the committed stamp, so the
 * migrator applies every committed migration after it; returns the tags it re-stamped.
 */
export async function restampMigrations(pool: pg.Pool, folder: string): Promise<string[]> {
  const recorded = await recordedStamps(pool);
  const drifted = committedMigrations(folder).filter((migration) => {
    const stamp = recorded.get(migration.hash);
    return stamp !== undefined && stamp !== migration.stamp;
  });
  for (const migration of drifted) {
    await pool.query(`UPDATE ${MIGRATIONS_TABLE} SET created_at = $1 WHERE hash = $2`, [migration.stamp, migration.hash]);
  }
  return drifted.map((migration) => migration.tag);
}
