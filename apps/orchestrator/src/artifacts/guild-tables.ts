// The tables a guild's agents are given, the guild's own and the organisation's, each with its
// access list, the rules a guild's request to change one follows, the steps the operator applies
// to them, and what an edit does to their records and readers.
import {
  grantAccess,
  type GuildAccess,
  type GuildAccessProposal,
  listAccess,
  planGuildAccess,
} from "./access-lists.js";
import {
  type CheckedCollectionChange,
  createCollection,
  deleteCollection,
  describeCollection,
  getCollection,
  listCollections,
  listCollectionsWithCounts,
  planCollection,
  planCollectionChange,
  updateCollection,
  type CollectionChanges,
  type NewCollection,
} from "./collections.js";
import type { ColumnChange } from "./columns.js";
import { ArtifactError } from "./errors.js";
import type { AccessRowChange } from "./grants.js";
import type { ArtifactStore, CollectionView } from "./store.js";
import type { AccessEntry, ArtifactActor } from "./types.js";
import type { CollectionColumn } from "../db/schema/index.js";

/** A collection as the operator reads it, with its access list. */
export type CollectionAccess = { collection: CollectionView; access: AccessEntry[] };

/** A collection named by its id or by its name. */
export type CollectionLookup = { id: string } | { name: string };

/** Whether a collection is one a guild's agents are given in the guild's own right: the guild's own, or the organisation's. */
function isGuildOrOrgTable(collection: CollectionView, guildId: string): boolean {
  return !collection.guild || collection.guild.id === guildId;
}

/** The guild's own collections and the organisation's, of those `listCollections` gives the actor. */
export async function listGuildCollections(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<CollectionView[]> {
  return (await listCollections(store, actor)).filter((collection) => isGuildOrOrgTable(collection, guildId));
}

/**
 * The guild's own tables and the organisation's, as the operator `actor` sees them, each with its
 * live record count and its access list.
 */
export async function guildTables(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<CollectionAccess[]> {
  const tables: CollectionAccess[] = [];
  for (const collection of await listCollectionsWithCounts(store, actor)) {
    if (isGuildOrOrgTable(collection, guildId)) {
      tables.push({ collection, access: await listAccess(store, actor, { kind: "collection", id: collection.id }) });
    }
  }
  return tables;
}

/**
 * One of `guildTables`, with its live record count and its access list. Null when the lookup names
 * no live collection the operator `actor` sees, or another guild's own table.
 */
export async function guildTable(
  store: ArtifactStore,
  actor: ArtifactActor,
  guildId: string,
  lookup: CollectionLookup,
): Promise<CollectionAccess | null> {
  const described = "name" in lookup ? await describeCollection(store, actor, lookup.name) : null;
  const id = "name" in lookup ? described?.id : lookup.id;
  if (id === undefined) {
    return null;
  }
  let table: CollectionAccess;
  try {
    table = {
      collection: await getCollection(store, actor, id),
      access: await listAccess(store, actor, { kind: "collection", id }),
    };
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) {
      return null;
    }
    throw error;
  }
  return isGuildOrOrgTable(table.collection, guildId) ? table : null;
}

/** One change to a collection as the operator applies it: a create or an edit with the access rows it then sets, or a delete. */
export type CollectionStep =
  | { action: "create"; collection: NewCollection; access: AccessRowChange[] }
  | { action: "edit"; id: string; changes: CollectionChanges | null; access: AccessRowChange[] }
  | { action: "delete"; id: string };

/** Applies a step as the operator: the collection first, created, changed or deleted, then each access row in order. */
export async function applyCollectionStep(store: ArtifactStore, actor: ArtifactActor, step: CollectionStep): Promise<void> {
  if (step.action === "delete") {
    await deleteCollection(store, actor, step.id);
    return;
  }
  const id = step.action === "create" ? (await createCollection(store, actor, step.collection)).id : step.id;
  if (step.action === "edit" && step.changes) {
    await updateCollection(store, actor, id, step.changes);
  }
  for (const row of step.access) {
    await grantAccess(store, actor, { kind: "collection", id }, row);
  }
}

/**
 * A guild's own table or the organisation's as a guild's request finds it: its id and definition,
 * its live `updated_at`, and the rows of its access list that reach the guild. `guildId` is the
 * guild that owns it, null for an organisation table.
 */
export type GuildTableLive = {
  id: string;
  name: string;
  purpose: string;
  guildId: string | null;
  columns: CollectionColumn[];
  updatedAt: string;
  access: GuildAccess;
};

/** A table as a request leaves it: its definition, the columns it moves, and the rows of its access list that reach the guild. */
export type GuildTableShape = {
  name: string;
  purpose: string;
  guildId: string | null;
  columns: CollectionColumn[];
  renamed: ColumnChange["renamed"];
  access: GuildAccess;
};

/**
 * Where a request stands. A new one is checked against the live table and names the `updated_at`
 * it read the table at, null when it names none. A stored proposal under review was checked when
 * it was made.
 */
export type GuildTableRequestOrigin =
  { kind: "new"; baseUpdatedAt: string | null } | { kind: "stored" };

/**
 * A request of guild `guildId` to create a table in organisation `orgId`: the table as defined, the
 * rows it proposes for the guild and its agents, and whether a table in the guild's reach already
 * holds the name it gives.
 */
export type GuildTableCreateRequest = {
  action: "create";
  orgId: string;
  guildId: string;
  collection: Required<Omit<NewCollection, "access">>;
  access: GuildAccessProposal;
  isNameTaken: boolean;
};

/**
 * A request of guild `guildId` to change `table`: the definition change, the rows it proposes for
 * the guild and its agents, whether a table in the guild's reach already holds the name it gives,
 * and where it stands.
 */
export type GuildTableEditRequest<T extends GuildTableLive> = {
  action: "edit";
  guildId: string;
  table: T;
  changes: CollectionChanges;
  access: GuildAccessProposal;
  isNameTaken: boolean;
  origin: GuildTableRequestOrigin;
};

/** A request to create a table, to change one, or to delete one. */
export type GuildTableRequest<T extends GuildTableLive> =
  GuildTableCreateRequest | GuildTableEditRequest<T> | { action: "delete"; table: T };

/** A create as planned: the table it makes, the display path it takes, and the step that writes it. */
export type GuildTableCreatePlan = {
  action: "create";
  shape: GuildTableShape;
  href: string;
  step: Extract<CollectionStep, { action: "create" }>;
};

/** An edit of `table` as planned: the table it leaves, its column change, null when the columns stay, and the step that writes it. */
export type GuildTableEditPlan<T extends GuildTableLive> = {
  action: "edit";
  table: T;
  shape: GuildTableShape;
  columnChange: ColumnChange | null;
  step: Extract<CollectionStep, { action: "edit" }>;
};

/** A request as planned; a delete plans only the step that writes it. */
export type GuildTablePlan<T extends GuildTableLive> =
  | GuildTableCreatePlan
  | GuildTableEditPlan<T>
  | { action: "delete"; table: T; step: Extract<CollectionStep, { action: "delete" }> };

/** A request refused because a table in the guild's reach already holds the name it gives. */
export class GuildTableNameTaken extends ArtifactError {
  constructor(name: string) {
    super(`a table named ${name} already exists`, 409);
    this.name = "GuildTableNameTaken";
  }
}

/**
 * A new edit request refused for the `updated_at` it is based on: 422 when it names none, 409
 * when `base` is not the table's live `updatedAt`.
 */
export class GuildTableBaseRefused extends ArtifactError {
  base: string | null;
  tableName: string;
  updatedAt: string;

  constructor(table: Pick<GuildTableLive, "name" | "updatedAt">, base: string | null) {
    super(
      base === null
        ? "an edit names the updated_at of the table it was built on"
        : `${base} is stale; ${table.name} was updated at ${table.updatedAt}`,
      base === null ? 422 : 409,
    );
    this.name = "GuildTableBaseRefused";
    this.base = base;
    this.tableName = table.name;
    this.updatedAt = table.updatedAt;
  }
}

/**
 * What a request would do to an organisation table that a guild does not: delete it, change its
 * name or purpose, drop or rename the columns `columns` names, or change or move them.
 */
export type OrgTableRefusal =
  | { kind: "delete" }
  | { kind: "rename_or_repurpose" }
  | { kind: "drop_columns"; columns: string[] }
  | { kind: "change_columns"; columns: string[] };

/** A request refused because it changes organisation table `tableName` beyond adding columns and access rows. */
export class OrgTableChangeRefused extends ArtifactError {
  tableName: string;
  refusal: OrgTableRefusal;

  constructor(tableName: string, refusal: OrgTableRefusal) {
    super(
      `${tableName} is an organisation table: a guild adds columns to it and changes its own access`,
      422,
    );
    this.name = "OrgTableChangeRefused";
    this.tableName = tableName;
    this.refusal = refusal;
  }
}

/**
 * Checks a guild's request against the table as it stands and plans it. A table's name is unique
 * among the tables in the guild's reach. An organisation table is not deleted from a guild, and
 * keeps its name, its purpose and every column it has, unchanged and in order; new columns may
 * join. A new edit request is based on the table's live `updated_at` and changes its definition or
 * one of its access rows. ArtifactError on the first rule the request breaks.
 */
export function planGuildTableChange<T extends GuildTableLive>(
  request: GuildTableRequest<T>,
): GuildTablePlan<T> {
  switch (request.action) {
    case "create":
      return planGuildTableCreate(request);
    case "edit":
      return planGuildTableEdit(request);
    case "delete":
      if (request.table.guildId === null) {
        throw new OrgTableChangeRefused(request.table.name, { kind: "delete" });
      }
      return {
        action: "delete",
        table: request.table,
        step: { action: "delete", id: request.table.id },
      };
  }
}

/** A create's name, purpose and columns checked, then its name, then the rows it starts with: the owning guild's at write, else the organisation's at read, with the proposal's on top. */
function planGuildTableCreate(request: GuildTableCreateRequest): GuildTableCreatePlan {
  const { name, purpose, columns, href } = planCollection(request.orgId, request.collection);
  if (request.isNameTaken) {
    throw new GuildTableNameTaken(name);
  }
  const guildId = request.collection.guildId;
  const { access, rowChanges } = planGuildAccess(
    { guild: guildId ? "write" : null, org: guildId ? null : "read", agents: new Map() },
    request.guildId,
    request.access,
  );
  return {
    action: "create",
    shape: { name, purpose, guildId, columns, renamed: [], access },
    href,
    step: { action: "create", collection: { name, purpose, columns, guildId }, access: rowChanges },
  };
}

/** An edit checked in order: its base, its name, purpose and columns, what an organisation table keeps, its name, and that a new request changes something. */
function planGuildTableEdit<T extends GuildTableLive>(
  request: GuildTableEditRequest<T>,
): GuildTableEditPlan<T> {
  const { table } = request;
  assertCurrentBase(table, request.origin);
  const checked = planCollectionChange(table, request.changes);
  assertOrgTableKept(table, checked);
  if (checked.name !== table.name && request.isNameTaken) {
    throw new GuildTableNameTaken(checked.name);
  }
  const { access, rowChanges } = planGuildAccess(table.access, request.guildId, request.access);
  const change = checked.columns;
  const columns = change ? change.columns : table.columns;
  const columnChange = JSON.stringify(columns) !== JSON.stringify(table.columns) ? change : null;
  const shape: GuildTableShape = {
    name: checked.name,
    purpose: checked.purpose,
    guildId: table.guildId,
    columns,
    renamed: change?.renamed ?? [],
    access,
  };
  const changes = definitionChanges(
    table,
    shape,
    columnChange ? request.changes.columns : undefined,
  );
  if (request.origin.kind === "new" && !changes && !rowChanges.length) {
    throw new ArtifactError("the proposal matches the live table; nothing to change", 422);
  }
  return {
    action: "edit",
    table,
    shape,
    columnChange,
    step: { action: "edit", id: table.id, changes, access: rowChanges },
  };
}

/** Refuses a new request that is not based on the table's live `updated_at`. */
function assertCurrentBase(table: GuildTableLive, origin: GuildTableRequestOrigin): void {
  if (origin.kind === "new" && origin.baseUpdatedAt !== table.updatedAt) {
    throw new GuildTableBaseRefused(table, origin.baseUpdatedAt);
  }
}

/** Refuses a change to an organisation table other than new columns: it keeps its name, its purpose, and every column it has, unchanged and in order. */
function assertOrgTableKept(table: GuildTableLive, checked: CheckedCollectionChange): void {
  if (table.guildId !== null) return;
  if (checked.name !== table.name || checked.purpose !== table.purpose) {
    throw new OrgTableChangeRefused(table.name, { kind: "rename_or_repurpose" });
  }
  const change = checked.columns;
  if (!change) return;
  if (change.removed.length || change.renamed.length) {
    throw new OrgTableChangeRefused(table.name, {
      kind: "drop_columns",
      columns: [...change.removed, ...change.renamed.map((item) => item.from)],
    });
  }
  const next = new Map(change.columns.map((column) => [column.name, column]));
  const kept = change.columns.filter((column) =>
    table.columns.some((previous) => previous.name === column.name),
  );
  const altered = table.columns.filter(
    (previous, index) =>
      JSON.stringify(next.get(previous.name)) !== JSON.stringify(previous) ||
      kept[index]?.name !== previous.name,
  );
  if (altered.length) {
    throw new OrgTableChangeRefused(table.name, {
      kind: "change_columns",
      columns: altered.map((column) => column.name),
    });
  }
}

/** What an edit writes to a table's definition: the name and purpose it changes, and `columns` when it changes them. Null when it changes none. */
function definitionChanges(
  table: GuildTableLive,
  shape: GuildTableShape,
  columns: unknown,
): CollectionChanges | null {
  const changes: CollectionChanges = {
    ...(shape.name !== table.name ? { name: shape.name } : {}),
    ...(shape.purpose !== table.purpose ? { purpose: shape.purpose } : {}),
    ...(columns !== undefined ? { columns } : {}),
  };
  return Object.keys(changes).length ? changes : null;
}

/** A guild table as an edit finds it: its name, its columns, its live record count, and its access list. */
export type GuildTableBefore = { name: string; columns: CollectionColumn[]; count: number; entries: AccessEntry[] };

/** What an edit leaves of a guild table: its name, and the change to its columns, null when they stay as they are. */
export type GuildTableEdit = { name: string; columns: ColumnChange | null };

/** One thing applying an edit does to a guild table's records or readers. `records` is the table's live record count. */
export type GuildTableEffect =
  | { kind: "table_renamed"; from: string; to: string }
  | { kind: "column_dropped"; column: string; records: number }
  | { kind: "column_moved"; from: string; to: string; records: number }
  | { kind: "required_column_added"; column: string; records: number }
  | { kind: "column_retyped"; column: string }
  | { kind: "column_made_required"; column: string }
  | { kind: "column_made_unique"; column: string }
  | { kind: "reached_outside_guild"; rows: AccessEntry[] };

/**
 * What applying `edit` does to a table of guild `guildId`, in order: a rename, then what the column
 * change does to its records, then the rows of other guilds and their agents that reach the table,
 * when its name or its columns change.
 */
export function guildTableEditEffects(table: GuildTableBefore, guildId: string, edit: GuildTableEdit): GuildTableEffect[] {
  const renamed = edit.name !== table.name;
  const outside = table.entries.filter((entry) => entry.type !== "org" && entry.guild_id !== guildId);
  const effects: GuildTableEffect[] = renamed ? [{ kind: "table_renamed", from: table.name, to: edit.name }] : [];
  if (edit.columns) {
    effects.push(...columnChangeEffects(table, edit.columns));
  }
  if (outside.length && (renamed || edit.columns)) {
    effects.push({ kind: "reached_outside_guild", rows: outside });
  }
  return effects;
}

/** What a column change does to a table's records: its dropped and moved columns, then each column it adds or keeps. */
function columnChangeEffects(table: GuildTableBefore, change: ColumnChange): GuildTableEffect[] {
  const records = table.count;
  const before = new Map(table.columns.map((column) => [column.name, column]));
  const fromOf = new Map(change.renamed.map((item) => [item.to, item.from]));
  return [
    ...change.removed.map((column): GuildTableEffect => ({ kind: "column_dropped", column, records })),
    ...change.renamed.map((item): GuildTableEffect => ({ kind: "column_moved", from: item.from, to: item.to, records })),
    ...change.columns.flatMap((column) => {
      const previous = before.get(fromOf.get(column.name) ?? column.name);
      return previous ? keptColumnEffects(previous, column, records) : addedColumnEffects(column, records);
    }),
  ];
}

/** A column the change adds reaches the stored records only when it is required. */
function addedColumnEffects(column: CollectionColumn, records: number): GuildTableEffect[] {
  return column.required && records ? [{ kind: "required_column_added", column: column.name, records }] : [];
}

/** What a kept column's new definition does to the stored records: a retype keeps their values; a new requirement or uniqueness checks them. */
function keptColumnEffects(previous: CollectionColumn, column: CollectionColumn, records: number): GuildTableEffect[] {
  const effects: GuildTableEffect[] = [];
  if (isRetyped(previous, column)) {
    effects.push({ kind: "column_retyped", column: column.name });
  }
  if (column.required && !previous.required && records) {
    effects.push({ kind: "column_made_required", column: column.name });
  }
  if (column.unique && !previous.unique) {
    effects.push({ kind: "column_made_unique", column: column.name });
  }
  return effects;
}

/** Whether a column's type or its allowed values change. */
function isRetyped(previous: CollectionColumn, column: CollectionColumn): boolean {
  return previous.type !== column.type || JSON.stringify(previous.values ?? null) !== JSON.stringify(column.values ?? null);
}
