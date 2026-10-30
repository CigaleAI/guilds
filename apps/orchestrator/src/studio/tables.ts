import { createHash } from "node:crypto";
import { loadOperatorActor } from "../artifacts/actors.js";
import { ArtifactError } from "../artifacts/errors.js";
import { columnCatalog, describeColumn } from "../artifacts/columns.js";
import { listRecords } from "../artifacts/records.js";
import {
  applyCollectionStep,
  type CollectionLookup,
  type CollectionStep,
  guildTable,
  GuildTableBaseRefused,
  type GuildTableCreatePlan,
  type GuildTableCreateRequest,
  guildTableEditEffects,
  type GuildTableEditPlan,
  type GuildTableEditRequest,
  type GuildTableEffect,
  GuildTableNameTaken,
  type GuildTablePlan,
  type GuildTableRequest,
  type GuildTableShape,
  guildTables,
  OrgTableChangeRefused,
  type OrgTableRefusal,
  planGuildTableChange,
} from "../artifacts/guild-tables.js";
import {
  type GuildAccess,
  type GuildAccessProposal,
  isAgentRowMode,
  isGuildRowMode,
} from "../artifacts/access-lists.js";
import { effectiveAccess } from "../artifacts/access.js";
import type { AccessEntry, ArtifactActor } from "../artifacts/types.js";
import type { CollectionColumn } from "../db/schema/index.js";
import { isPlainRecord } from "../db/json.js";
import { argString } from "../toolbox/schema.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { editActionOf, type EditAction } from "./actions.js";
import type { CollectionTarget } from "./edit-request.js";
import type { EditDeps, EditScope } from "./edits.js";
import { editActor } from "./actor.js";
import { StudioConflictError, StudioUnprocessableError } from "./errors.js";
import { excerptBytes, wrapEvidence } from "./system.js";
import { getGuild } from "../db/guilds.js";
import { listAgents } from "../db/agents.js";

// Tables (collections) the coach reads and proposes to create, change, or
// delete. It reaches the tables the source guild's agents can be given: the
// guild's own, which it creates, edits, and deletes, and the organisation's,
// to which it only adds columns. On either it changes only the access rows of
// the source guild and its live members. Another guild's own tables are out of
// reach. Like every Studio edit, a proposal writes nothing until the
// operator applies it.

export const STUDIO_TABLE_TOOL = "studio_edit_collection";
export type TableAction = EditAction;

const RECENT_RECORDS = 5;

export function isTableTool(name: string): boolean {
  return name === STUDIO_TABLE_TOOL;
}

type Member = { id: string; name: string };

type Table = {
  id: string;
  name: string;
  purpose: string;
  displayPath: string;
  guildId: string | null;
  guildName: string | null;
  columns: CollectionColumn[];
  updatedAt: string;
  count: number;
  /** The table's whole access list. */
  entries: AccessEntry[];
  /** The rows that reach the source guild: its own and its live members', which Studio can change, and the organisation's, which it shows. */
  access: GuildAccess;
  /** Rows of other guilds and their agents: shown, never changed. */
  outside: string[];
};

/** A table as a proposal leaves it, or as it stands, with the owning guild's name and the rows outside the source guild. */
type Shape = GuildTableShape & { guildName: string | null; outside: string[] };

/**
 * A table proposal checked against the live organisation: what the operator
 * reviews (the table before and after, rendered as text, and what applying
 * does to its records and readers), the hashes that bind it, and the writes.
 */
export type TableReview = {
  action: TableAction;
  title: string;
  target: CollectionTarget;
  baseHash: string;
  proposedHash: string;
  live: string;
  proposed: string;
  effects: string[];
  plan: CollectionStep;
};

type TableContext = {
  deps: EditDeps;
  scope: EditScope;
  actor: ArtifactActor;
  guildName: string;
  members: Member[];
};

/** An artifacts refusal as Studio reports it to the coach. */
function tableFailure(error: unknown): never {
  if (error instanceof GuildTableBaseRefused) {
    throw error.base === null
      ? new StudioUnprocessableError(
          "base_updated_at is required: the updated_at studio_get_collection returned",
        )
      : new StudioConflictError(
          `base_updated_at ${error.base} is stale; ${error.tableName} was updated at ${error.updatedAt}. Read it again with studio_get_collection and rebuild the edit.`,
        );
  }
  if (error instanceof OrgTableChangeRefused) {
    throw new StudioUnprocessableError(
      `${error.tableName} ${ORG_TABLE_LIMIT}${orgTableKept(error.refusal)}`,
    );
  }
  if (error instanceof ArtifactError) {
    throw error.status === 409
      ? new StudioConflictError(error.message)
      : new StudioUnprocessableError(error.message);
  }
  throw error;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The operator reading tables, without the private guilds they do not operate. */
async function tableActor(deps: EditDeps, scope: EditScope): Promise<ArtifactActor> {
  return loadOperatorActor(deps.db, scope.user, {
    orgId: scope.orgId,
    guildId: scope.sourceGuildId,
  });
}

async function tableContext(deps: EditDeps, scope: EditScope): Promise<TableContext> {
  const guild = await getGuild(deps.db, scope.sourceGuildId);
  const agents = await listAgents(deps.db, scope.sourceGuildId);
  return {
    deps,
    scope,
    actor: await tableActor(deps, scope),
    guildName: String(guild?.name ?? "this guild"),
    members: agents.map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

/** A table Studio reaches, the source guild's own or the organisation's, with the rows that reach the source guild. */
async function loadTable(tc: TableContext, lookup: CollectionLookup): Promise<Table | null> {
  const found = await guildTable(tc.deps.artifacts, tc.actor, tc.scope.sourceGuildId, lookup);
  if (!found) {
    return null;
  }
  const view = found.collection;
  const { access, outside } = sourceAccess(tc, found.access);
  return {
    id: view.id,
    name: view.name,
    purpose: view.purpose,
    displayPath: view.display_path,
    guildId: view.guild?.id ?? null,
    guildName: view.guild?.name ?? null,
    columns: view.columns,
    updatedAt: view.updated_at,
    count: view.count ?? 0,
    entries: found.access,
    access,
    outside,
  };
}

/** How the operator reads a row of another guild, or of one of its agents. */
function outsideRow(entry: AccessEntry): string {
  return entry.type === "guild" ? `guild ${entry.name} ${entry.mode}` : `agent ${entry.name} (${entry.guild_name}) ${entry.mode}`;
}

/** A table's access list split into the rows that reach the source guild and the rest. */
function sourceAccess(tc: TableContext, entries: AccessEntry[]): { access: GuildAccess; outside: string[] } {
  const source = tc.scope.sourceGuildId;
  const live = new Set(tc.members.map((member) => member.id));
  const access: GuildAccess = { guild: null, org: null, agents: new Map() };
  const outside: string[] = [];
  for (const entry of entries) {
    if (entry.type === "org") {
      access.org = entry.mode === "none" ? null : entry.mode;
    } else if (entry.guild_id !== source) {
      outside.push(outsideRow(entry));
    } else if (entry.type === "guild") {
      access.guild = entry.mode === "none" ? null : entry.mode;
    } else if (live.has(entry.id)) {
      access.agents.set(entry.id, entry.mode);
    }
  }
  return { access, outside };
}

/** What a proposal may change on a table: all of the source guild's own; columns added to the organisation's. */
type TableReach = "edit_or_delete" | "add_columns_and_access";

function reachOf(guildId: string | null): TableReach {
  return guildId === null ? "add_columns_and_access" : "edit_or_delete";
}

const ORG_TABLE_LIMIT =
  "is an organisation table: Studio adds columns to it and changes this guild's access; other changes are made on the Tables page";

/** What Studio tells the coach to keep on an organisation table, after what Studio may change on one. */
function orgTableKept(refusal: OrgTableRefusal): string {
  switch (refusal.kind) {
    case "delete":
    case "rename_or_repurpose":
      return "";
    case "drop_columns":
      return `; keep ${refusal.columns.join(", ")}`;
    case "change_columns":
      return `; keep ${refusal.columns.join(", ")} unchanged and in order`;
  }
}

function memberNamed(members: Member[], handle: string): Member | null {
  const needle = handle.trim();
  const lower = needle.toLowerCase();
  return (
    members.find((member) => member.id === needle) ??
    members.find((member) => member.name.toLowerCase() === lower) ??
    null
  );
}

/** The access rows a request names, each agent resolved to a live member of the source guild; no `access` names none. */
function parseAccessProposal(tc: TableContext, raw: unknown): GuildAccessProposal {
  if (raw === undefined || raw === null) {
    return { guild: null, agents: [] };
  }
  if (!isPlainRecord(raw)) {
    throw new StudioUnprocessableError("access must be an object with guild, agents, or both");
  }
  const unknownField = Object.keys(raw).find((key) => key !== "guild" && key !== "agents");
  if (unknownField !== undefined) {
    throw new StudioUnprocessableError(`access: unknown field "${unknownField}"`);
  }
  return { guild: parseGuildRow(raw.guild), agents: parseAgentRows(tc, raw.agents) };
}

/** The mode `access.guild` names for the source guild's row, or null when it is left out. */
function parseGuildRow(value: unknown): GuildAccessProposal["guild"] {
  if (value === undefined) {
    return null;
  }
  if (!isGuildRowMode(value)) {
    throw new StudioUnprocessableError("access.guild must be read, write, or none");
  }
  return value;
}

/** The rows `access.agents` names, each for a live member of the source guild named once. */
function parseAgentRows(tc: TableContext, value: unknown): GuildAccessProposal["agents"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StudioUnprocessableError("access.agents must be a list of { agent_id, mode }");
  }
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!isPlainRecord(item)) {
      throw new StudioUnprocessableError("access.agents must be a list of { agent_id, mode }");
    }
    const handle = String(item.agent_id ?? "");
    const member = memberNamed(tc.members, handle);
    if (!member) {
      throw new StudioUnprocessableError(`access.agents: ${handle || "agent_id"} is not a live agent of ${tc.guildName}`);
    }
    if (seen.has(member.id)) {
      throw new StudioUnprocessableError(`access.agents: ${member.name} is listed twice`);
    }
    seen.add(member.id);
    if (!isAgentRowMode(item.mode)) {
      throw new StudioUnprocessableError(`access.agents: ${member.name}: mode must be read, write, none, or inherit`);
    }
    return { id: member.id, mode: item.mode };
  });
}

function accessKey(access: GuildAccess): unknown {
  return [access.guild, access.org, [...access.agents.entries()].sort(([a], [b]) => a.localeCompare(b))];
}

function tableHash(table: Table): string {
  return hashOf([
    "table",
    table.id,
    table.name,
    table.purpose,
    table.guildId,
    table.columns,
    accessKey(table.access),
  ]);
}

function shapeHash(shape: Shape): string {
  return hashOf([
    shape.name,
    shape.purpose,
    shape.guildId,
    shape.columns,
    shape.renamed,
    accessKey(shape.access),
  ]);
}

function shapeOf(table: Table): Shape {
  return {
    name: table.name,
    purpose: table.purpose,
    guildId: table.guildId,
    guildName: table.guildName,
    columns: table.columns,
    renamed: [],
    access: table.access,
    outside: table.outside,
  };
}

/** The table as the operator reads it in a diff: one line per column and per access row. */
function render(tc: TableContext, shape: Shape): string {
  const renamedFrom = new Map(shape.renamed.map((item) => [item.to, item.from]));
  const names = new Map(tc.members.map((member) => [member.id, member.name]));
  const agents = [...shape.access.agents.entries()]
    .map(([id, mode]) => `- agent ${names.get(id) ?? id}: ${mode}`)
    .sort();
  return [
    `${shape.name} · ${shape.guildId ? `${shape.guildName}'s own table` : "organisation table"}`,
    `purpose: ${shape.purpose}`,
    "",
    "columns",
    ...(shape.columns.length
      ? shape.columns.map((column) => {
          const from = renamedFrom.get(column.name);
          return `- ${describeColumn(column)}${from ? ` (renamed from ${from})` : ""}: ${column.description}`;
        })
      : ["- none"]),
    "",
    "access",
    ...(shape.access.org ? [`- organisation: ${shape.access.org}`] : []),
    `- guild ${tc.guildName}: ${shape.access.guild ?? "no row"}`,
    ...agents,
    ...(shape.outside.length ? [`- outside ${tc.guildName}: ${shape.outside.join(", ")}`] : []),
  ].join("\n");
}

/** The sentence the operator reads for one effect of a table edit. */
function effectSentence(effect: GuildTableEffect): string {
  switch (effect.kind) {
    case "table_renamed":
      return `Renames the table from ${effect.from} to ${effect.to}; Tasks, notes, and routines that name ${effect.from} keep the old name until they change too.`;
    case "column_dropped":
      return `Drops ${effect.column} from ${plural(effect.records, "record")}.`;
    case "column_moved":
      return `Moves ${effect.from} to ${effect.to} in ${plural(effect.records, "record")}.`;
    case "required_column_added":
      return `Adds required ${effect.column}; the ${plural(effect.records, "record")} without it report a warning on their next update.`;
    case "column_retyped":
      return `Keeps stored ${effect.column} values as they are; a record that no longer fits reports a warning on its next update.`;
    case "column_made_required":
      return `Makes ${effect.column} required; records without it report a warning on their next update.`;
    case "column_made_unique":
      return `Makes ${effect.column} unique; applying fails while two records share a value.`;
    case "reached_outside_guild":
      return `Reached outside this guild too: ${effect.rows.map(outsideRow).join(", ")}.`;
  }
}

function targetOf(id: string | null, name: string, guildId: string | null, displayPath: string): CollectionTarget {
  return {
    collection_id: id,
    name,
    scope: guildId ? "guild" : "org",
    display_path: displayPath,
  };
}

/** A create read from its arguments: the table it defines for the source guild or the organisation, and the rows it proposes. */
async function createRequest(
  tc: TableContext,
  args: Record<string, unknown>,
): Promise<GuildTableCreateRequest> {
  const scopeArg = args.scope ?? "guild";
  if (scopeArg !== "guild" && scopeArg !== "org") {
    throw new StudioUnprocessableError("scope must be guild or org");
  }
  const name = argString(args, "name");
  return {
    action: "create",
    orgId: tc.scope.orgId,
    guildId: tc.scope.sourceGuildId,
    collection: {
      name,
      purpose: argString(args, "purpose"),
      columns: args.columns,
      guildId: scopeArg === "guild" ? tc.scope.sourceGuildId : null,
    },
    access: parseAccessProposal(tc, args.access),
    isNameTaken: (await loadTable(tc, { name })) !== null,
  };
}

/**
 * An edit of `table` read from its arguments: the definition change, the rows it proposes, and
 * where it stands. A request (`recorded` null) names the `updated_at` the coach read.
 */
async function editRequest(
  tc: TableContext,
  table: Table,
  args: Record<string, unknown>,
  recorded: CollectionTarget | null,
): Promise<GuildTableEditRequest<Table>> {
  return {
    action: "edit",
    guildId: tc.scope.sourceGuildId,
    table,
    changes: {
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.purpose !== undefined ? { purpose: String(args.purpose) } : {}),
      ...(args.columns !== undefined ? { columns: args.columns } : {}),
    },
    access: parseAccessProposal(tc, args.access),
    isNameTaken:
      args.name !== undefined && (await loadTable(tc, { name: String(args.name) })) !== null,
    origin:
      recorded === null
        ? { kind: "new", baseUpdatedAt: argString(args, "base_updated_at").trim() || null }
        : { kind: "stored" },
  };
}

/**
 * What a table tool asks, read from its arguments. A request (`recorded` null) names the table as
 * the coach read it; a review finds it by the id its request recorded.
 */
async function tableRequest(
  tc: TableContext,
  action: TableAction,
  args: Record<string, unknown>,
  recorded: CollectionTarget | null,
): Promise<GuildTableRequest<Table>> {
  if (action === "create") {
    return createRequest(tc, args);
  }
  const table =
    recorded === null
      ? await loadTable(tc, { name: argString(args, "collection").trim() })
      : await loadTable(tc, { id: recorded.collection_id ?? "" });
  if (!table) {
    throw new StudioUnprocessableError(
      recorded === null
        ? `unknown table ${argString(args, "collection") || "(none named)"}; list the tables with studio_list_collections`
        : "the table no longer exists",
    );
  }
  return action === "delete" ? { action, table } : editRequest(tc, table, args, recorded);
}

function createReview(tc: TableContext, plan: GuildTableCreatePlan): TableReview {
  const { name, guildId } = plan.shape;
  const shape: Shape = { ...plan.shape, guildName: guildId ? tc.guildName : null, outside: [] };
  return {
    action: "create",
    title: `Create table ${name}`,
    target: targetOf(null, name, guildId, plan.href),
    baseHash: hashOf(["absent", name]),
    proposedHash: shapeHash(shape),
    live: "",
    proposed: render(tc, shape),
    effects: [
      guildId
        ? `Creates ${name} as ${tc.guildName}'s own table, reached through the access listed.`
        : `Creates ${name} as an organisation table that every agent of the organisation reads, reached further through the access listed.`,
    ],
    plan: plan.step,
  };
}

function editReview(tc: TableContext, plan: GuildTableEditPlan<Table>): TableReview {
  const { table } = plan;
  const shape: Shape = { ...shapeOf(table), ...plan.shape };
  return {
    action: "edit",
    title: `Edit table ${table.name}`,
    target: targetOf(table.id, table.name, table.guildId, table.displayPath),
    baseHash: tableHash(table),
    proposedHash: shapeHash(shape),
    live: render(tc, shapeOf(table)),
    proposed: render(tc, shape),
    effects: guildTableEditEffects(table, tc.scope.sourceGuildId, {
      name: shape.name,
      columns: plan.columnChange,
    }).map(effectSentence),
    plan: plan.step,
  };
}

function deleteReview(tc: TableContext, table: Table, step: CollectionStep): TableReview {
  return {
    action: "delete",
    title: `Delete table ${table.name}`,
    target: targetOf(table.id, table.name, table.guildId, table.displayPath),
    baseHash: tableHash(table),
    proposedHash: hashOf(["delete", table.id]),
    live: render(tc, shapeOf(table)),
    proposed: "",
    effects: [
      `Deletes ${table.name} with its ${plural(table.count, "record")}; its access list goes with it and no agent reaches it again.`,
      ...(table.outside.length
        ? [`Reached outside this guild too: ${table.outside.join(", ")}.`]
        : []),
    ],
    plan: step,
  };
}

/**
 * Checks the change a table tool's `action` proposes against the live organisation with
 * `planGuildTableChange`, and renders it for the operator. A request (`recorded` null) to create a table whose name is taken
 * is pointed at an edit instead.
 */
export async function reviewTable(
  deps: EditDeps,
  scope: EditScope,
  args: Record<string, unknown>,
  recorded: CollectionTarget | null,
): Promise<TableReview> {
  const action = editActionOf(args);
  const tc = await tableContext(deps, scope);
  const request = await tableRequest(tc, action, args, recorded);
  let plan: GuildTablePlan<Table>;
  try {
    plan = planGuildTableChange(request);
  } catch (error) {
    if (error instanceof GuildTableNameTaken && request.action === "create" && recorded === null) {
      throw new StudioConflictError(
        `${error.message}; change it with studio_edit_collection action edit`,
      );
    }
    tableFailure(error);
  }
  switch (plan.action) {
    case "create":
      return createReview(tc, plan);
    case "edit":
      return editReview(tc, plan);
    case "delete":
      return deleteReview(tc, plan.table, plan.step);
  }
}

/** Writes a reviewed proposal as the operator: the table first, then each access row it changes. */
export async function applyTable(
  deps: EditDeps,
  scope: EditScope,
  plan: CollectionStep,
): Promise<void> {
  try {
    await applyCollectionStep(deps.artifacts, editActor(scope), plan);
  } catch (error) {
    tableFailure(error);
  }
}

/** The tables Studio reaches: the source guild's own first, then the organisation's. */
export async function listTables(
  deps: EditDeps,
  scope: EditScope,
): Promise<Array<Record<string, unknown>>> {
  const actor = await tableActor(deps, scope);
  const tables = await guildTables(deps.artifacts, actor, scope.sourceGuildId);
  return tables
    .sort((a, b) => Number(!a.collection.guild) - Number(!b.collection.guild) || a.collection.name.localeCompare(b.collection.name))
    .map(({ collection: view, access }) => ({
      name: view.name,
      display_path: view.display_path,
      purpose: view.purpose,
      owner: view.guild ? `guild ${view.guild.name}` : "organisation",
      records: view.count ?? 0,
      columns: view.columns.map((column) => column.name),
      guild_access: effectiveAccess(access, { guildId: scope.sourceGuildId, agentId: null }),
      studio_can: reachOf(view.guild?.id ?? null),
    }));
}

/** One table in full: columns, who in the source guild reaches it, and its latest records as evidence. */
export async function readTable(
  deps: EditDeps,
  scope: EditScope,
  name: string,
): Promise<Record<string, unknown>> {
  const tc = await tableContext(deps, scope);
  const table = await loadTable(tc, { name: name.trim() });
  if (!table) {
    throw new StudioUnprocessableError(
      `unknown table ${name || "(none named)"}; list the tables with studio_list_collections`,
    );
  }
  const recent = await listRecords(deps.artifacts, tc.actor, {
    collection: table.name,
    order: { column: "updated_at", direction: "desc" },
    limit: RECENT_RECORDS,
  });
  const body = excerptBytes(
    recent.records.map((record) => JSON.stringify(record)).join("\n"),
    STUDIO_TOOL_RESULT_MAX_BYTES / 2,
  );
  return {
    name: table.name,
    display_path: table.displayPath,
    purpose: table.purpose,
    owner: table.guildId ? `guild ${table.guildName}` : "organisation",
    records: table.count,
    updated_at: table.updatedAt,
    studio_can: reachOf(table.guildId),
    columns: columnCatalog(table.columns),
    access: {
      org: table.access.org,
      guild: table.access.guild,
      own_table: table.guildId === scope.sourceGuildId,
      agents: tc.members.map((member) => ({
        agent_id: member.id,
        name: member.name,
        own: table.access.agents.get(member.id) ?? null,
        effective: effectiveAccess(table.entries, { guildId: scope.sourceGuildId, agentId: member.id }),
      })),
    },
    outside: table.outside,
    recent_records: wrapEvidence({
      source: "collection_records",
      coordinates: {
        display_path: table.displayPath,
        shown: recent.records.length,
        truncated: body.truncated || null,
      },
      body: body.text || "(no records)",
    }),
  };
}
