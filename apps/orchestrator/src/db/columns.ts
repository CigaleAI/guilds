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
