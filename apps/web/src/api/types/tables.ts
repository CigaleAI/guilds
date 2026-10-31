/**
 * Shapes of the orchestrator's JSON API for tables, as the app reads them. Timestamps are ISO-8601
 * in UTC.
 */

export type ColumnType = "text" | "number" | "boolean" | "datetime" | "array";

/** One column of a database: its type, whether it is required or unique, and its allowed values. */
export type Column = {
  name: string;
  type: ColumnType;
  description: string;
  required: boolean;
  unique: boolean;
  /** Allowed values, for text and array columns. */
  values?: string[];
};

/**
 * A database: records with typed columns, placed in a guild or at the organisation. Its access list
 * says who reaches it. A Task embeds one as `![[org/<org_id>/collections/<name>]]`.
 */
export type Collection = {
  id: string;
  name: string;
  purpose: string;
  columns: Column[];
  display_path: string;
  scope: "org" | "guild";
  guild: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
  /** Live records. */
  count?: number;
};

/** A record: its id, its column values, and who last wrote it. */
export type CollectionRecord = {
  id: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  version: number;
  display_path: string;
  [column: string]: unknown;
};

export type RecordsPage = { total: number; records: CollectionRecord[]; columns: Column[] };

/** A record's changed values; null clears one. */
export type RecordUpdate = { recordId: number; body: Record<string, unknown> };

/** How a records view asks: a ranked search, or exact filters with an order and a page. */
export type RecordsQuery = {
  query?: string;
  where?: Record<string, unknown>;
  order?: { column: string; direction: "asc" | "desc" };
  limit: number;
  offset: number;
};

/** A column as a database definition sends it; `rename_from` renames a current column. */
export type ColumnInput = Column & { rename_from?: string };

export type DatabaseInput = {
  name: string;
  purpose: string;
  columns: ColumnInput[];
  guild_id: string | null;
};
