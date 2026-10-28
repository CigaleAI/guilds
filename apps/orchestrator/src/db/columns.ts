import { getTableColumns, type InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** A column of `table`: a schema key is its column's name in the database. */
export type ColumnName<T extends PgTable> = keyof InferSelectModel<T> & string;

function qualified(names: readonly string[], alias: string | undefined): string {
  return names.map((name) => (alias ? `${alias}.${name}` : name)).join(", ");
}

/** A SELECT list of every column of `table`, each qualified by `alias` when one is given. */
export function tableColumns(table: PgTable, alias?: string): string {
  return qualified(
    Object.values(getTableColumns(table)).map((column) => column.name),
    alias,
  );
}

/** A SELECT list of `columns` of `table`, each qualified by `alias` when one is given. */
export function pickColumns<T extends PgTable>(
  _table: T,
  columns: readonly ColumnName<T>[],
  alias?: string,
): string {
  return qualified(columns, alias);
}

/**
 * The `SET` assignments for the fields of `patch` that `columns` lists, numbered from parameter
 * `first`, and their values: a date as its stamp, an object or array as jsonb.
 */
export function patchAssignments(
  patch: Readonly<Record<string, unknown>>,
  columns: readonly string[],
  first: number,
): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const column of columns) {
    if (!(column in patch)) {
      continue;
    }
    const value = patch[column];
    const json = value !== null && typeof value === "object" && !(value instanceof Date);
    sets.push(`${column} = $${first + values.length}${json ? "::jsonb" : ""}`);
    values.push(value instanceof Date ? value.toISOString() : json ? JSON.stringify(value) : value);
  }
  return { sets, values };
}

/** The organisation, guild, and agent owner columns of a row owned at `ownerScope` by `ownerId`. */
export function ownerRefs(
  ownerScope: string,
  ownerId: string | null | undefined,
): [string | null, string | null, string | null] {
  if (ownerScope === "platform") {
    return [null, null, null];
  }
  if (ownerScope === "org") {
    return [ownerId ?? null, null, null];
  }
  if (ownerScope === "guild") {
    return [null, ownerId ?? null, null];
  }
  return [null, null, ownerId ?? null];
}
