import { createHash } from "node:crypto";
import { loadOperatorActor } from "../artifacts/actors.js";
import { ArtifactError } from "../artifacts/errors.js";
import { columnCatalog, describeColumn, type ColumnChange } from "../artifacts/columns.js";
import { listRecords } from "../artifacts/records.js";
import {
  type AccessRowChange,
  applyCollectionStep,
  type CollectionLookup,
  type CollectionStep,
  guildTable,
  guildTables,
} from "../artifacts/guild-tables.js";
import { planCollection, planCollectionChange } from "../artifacts/collections.js";
import { effectiveAccess } from "../artifacts/access-lists.js";
import type { AccessEntry, AgentAccessMode, ArtifactActor } from "../artifacts/types.js";
import type { AccessMode, CollectionColumn } from "../db/schema/index.js";
import { argString } from "../toolbox/schema.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import type { EditAction } from "./actions.js";
import type { EditScope } from "./edits.js";
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
const GUILD_MODES = ["read", "write", "none"] as const;
const AGENT_MODES = ["read", "write", "none", "inherit"] as const;

export function isTableTool(name: string): boolean {
  return name === STUDIO_TABLE_TOOL;
}

type Member = { id: string; name: string };

/**
 * The rows that reach the source guild: its own row and its live members'
 * rows, which Studio can change, and the organisation's row, which it shows.
 */
type SourceAccess = { guild: AccessMode | null; org: AccessMode | null; agents: Map<string, AgentAccessMode> };

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
  access: SourceAccess;
  /** Rows of other guilds and their agents: shown, never changed. */
  outside: string[];
};

/** A table as a proposal leaves it, or as it stands. */
type Shape = {
  name: string;
  purpose: string;
  guildId: string | null;
  guildName: string | null;
  columns: CollectionColumn[];
  renamed: Array<{ from: string; to: string }>;
  access: SourceAccess;
  outside: string[];
};

/**
 * A table proposal checked against the live organisation: what the operator
 * reviews (the table before and after, rendered as text, and what applying
 * does to its records and readers), the hashes that bind it, and the writes.
 */
export type TableReview = {
  action: TableAction;
  title: string;
  target: Record<string, unknown>;
  baseHash: string;
  proposedHash: string;
  live: string;
  proposed: string;
  effects: string[];
  plan: CollectionStep;
};

type TableContext = {
  scope: EditScope;
  actor: ArtifactActor;
  guildName: string;
  members: Member[];
};

function tableFailure(error: unknown): never {
  if (error instanceof ArtifactError) {
    throw error.status === 409
      ? new StudioConflictError(error.message)
      : new StudioUnprocessableError(error.message);
  }
  throw error;
}

function valid<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    tableFailure(error);
  }
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The operator reading tables, without the private guilds they do not operate. */
async function tableActor(scope: EditScope): Promise<ArtifactActor> {
  return loadOperatorActor(scope.db, scope.user, { orgId: scope.orgId, guildId: scope.sourceGuildId });
}

async function tableContext(scope: EditScope): Promise<TableContext> {
  const guild = await getGuild(scope.db, scope.sourceGuildId);
  const agents = await listAgents(scope.db, scope.sourceGuildId);
  return {
    scope,
    actor: await tableActor(scope),
    guildName: String(guild?.name ?? "this guild"),
    members: agents.map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

/** A table Studio reaches, the source guild's own or the organisation's, with the rows that reach the source guild. */
async function loadTable(tc: TableContext, lookup: CollectionLookup): Promise<Table | null> {
  const found = await guildTable(tc.scope.artifacts, tc.actor, tc.scope.sourceGuildId, lookup);
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

/** A table's access list split into the rows that reach the source guild and the rest. */
function sourceAccess(tc: TableContext, entries: AccessEntry[]): { access: SourceAccess; outside: string[] } {
  const source = tc.scope.sourceGuildId;
  const live = new Set(tc.members.map((member) => member.id));
  const access: SourceAccess = { guild: null, org: null, agents: new Map() };
  const outside: string[] = [];
  for (const entry of entries) {
    if (entry.type === "org") {
      access.org = entry.mode === "none" ? null : entry.mode;
    } else if (entry.guild_id !== source) {
      outside.push(entry.type === "guild" ? `guild ${entry.name} ${entry.mode}` : `agent ${entry.name} (${entry.guild_name}) ${entry.mode}`);
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

/** An organisation table keeps its name, purpose, and every column as it is; new columns may join. */
function assertOrgTableEdit(
  table: Table,
  name: string,
  purpose: string,
  change: ColumnChange | null,
): void {
  if (table.guildId !== null) return;
  if (name !== table.name || purpose !== table.purpose) {
    throw new StudioUnprocessableError(`${table.name} ${ORG_TABLE_LIMIT}`);
  }
  if (!change) return;
  if (change.removed.length || change.renamed.length) {
    throw new StudioUnprocessableError(
      `${table.name} ${ORG_TABLE_LIMIT}; keep ${[...change.removed, ...change.renamed.map((item) => item.from)].join(", ")}`,
    );
  }
  const next = new Map(change.columns.map((column) => [column.name, column]));
  const kept = change.columns.filter((column) => table.columns.some((previous) => previous.name === column.name));
  const altered = table.columns.filter(
    (previous, index) =>
      JSON.stringify(next.get(previous.name)) !== JSON.stringify(previous) || kept[index]?.name !== previous.name,
  );
  if (altered.length) {
    throw new StudioUnprocessableError(
      `${table.name} ${ORG_TABLE_LIMIT}; keep ${altered.map((column) => column.name).join(", ")} unchanged and in order`,
    );
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

/** The access a proposal asks for: only the subjects it names change. */
function parseAccess(
  tc: TableContext,
  raw: unknown,
  base: SourceAccess,
): { access: SourceAccess; rowChanges: AccessRowChange[] } {
  const access: SourceAccess = { guild: base.guild, org: base.org, agents: new Map(base.agents) };
  const rowChanges: AccessRowChange[] = [];
  if (raw === undefined || raw === null) {
    return { access, rowChanges };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StudioUnprocessableError("access must be an object with guild, agents, or both");
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "guild" && key !== "agents") {
      throw new StudioUnprocessableError(`access: unknown field "${key}"`);
    }
  }
  if (body.guild !== undefined) {
    if (!(GUILD_MODES as readonly unknown[]).includes(body.guild)) {
      throw new StudioUnprocessableError("access.guild must be read, write, or none");
    }
    const mode = body.guild === "none" ? null : (body.guild as AccessMode);
    if (mode !== access.guild) {
      access.guild = mode;
      rowChanges.push({ type: "guild", id: tc.scope.sourceGuildId, mode });
    }
  }
  if (body.agents !== undefined) {
    if (!Array.isArray(body.agents)) {
      throw new StudioUnprocessableError("access.agents must be a list of { agent_id, mode }");
    }
    const seen = new Set<string>();
    for (const item of body.agents) {
      const entry =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      if (!entry) {
        throw new StudioUnprocessableError("access.agents must be a list of { agent_id, mode }");
      }
      const handle = String(entry.agent_id ?? "");
      const member = memberNamed(tc.members, handle);
      if (!member) {
        throw new StudioUnprocessableError(
          `access.agents: ${handle || "agent_id"} is not a live agent of ${tc.guildName}`,
        );
      }
      if (seen.has(member.id)) {
        throw new StudioUnprocessableError(`access.agents: ${member.name} is listed twice`);
      }
      seen.add(member.id);
      if (!(AGENT_MODES as readonly unknown[]).includes(entry.mode)) {
        throw new StudioUnprocessableError(
          `access.agents: ${member.name}: mode must be read, write, none, or inherit`,
        );
      }
      const mode = entry.mode === "inherit" ? null : (entry.mode as AgentAccessMode);
      if (mode !== (access.agents.get(member.id) ?? null)) {
        if (mode === null) access.agents.delete(member.id);
        else access.agents.set(member.id, mode);
        rowChanges.push({ type: "agent", id: member.id, mode });
      }
    }
  }
  return { access, rowChanges };
}

function accessKey(access: SourceAccess): unknown {
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

function editEffects(
  table: Table,
  shape: Shape,
  change: { renamed: Array<{ from: string; to: string }>; removed: string[] } | null,
): string[] {
  const effects: string[] = [];
  const records = plural(table.count, "record");
  if (shape.name !== table.name) {
    effects.push(
      `Renames the table from ${table.name} to ${shape.name}; Tasks, notes, and routines that name ${table.name} keep the old name until they change too.`,
    );
  }
  if (change) {
    for (const name of change.removed) effects.push(`Drops ${name} from ${records}.`);
    for (const item of change.renamed)
      effects.push(`Moves ${item.from} to ${item.to} in ${records}.`);
    const before = new Map(table.columns.map((column) => [column.name, column]));
    const fromOf = new Map(change.renamed.map((item) => [item.to, item.from]));
    for (const column of shape.columns) {
      const previous = before.get(fromOf.get(column.name) ?? column.name);
      if (!previous) {
        if (column.required && table.count) {
          effects.push(
            `Adds required ${column.name}; the ${records} without it report a warning on their next update.`,
          );
        }
        continue;
      }
      if (
        previous.type !== column.type ||
        JSON.stringify(previous.values ?? null) !== JSON.stringify(column.values ?? null)
      ) {
        effects.push(
          `Keeps stored ${column.name} values as they are; a record that no longer fits reports a warning on its next update.`,
        );
      }
      if (column.required && !previous.required && table.count) {
        effects.push(
          `Makes ${column.name} required; records without it report a warning on their next update.`,
        );
      }
      if (column.unique && !previous.unique) {
        effects.push(
          `Makes ${column.name} unique; applying fails while two records share a value.`,
        );
      }
    }
  }
  if (table.outside.length && (shape.name !== table.name || change)) {
    effects.push(`Reached outside this guild too: ${table.outside.join(", ")}.`);
  }
  return effects;
}

function targetOf(id: string | null, name: string, guildId: string | null, displayPath: string): Record<string, unknown> {
  return {
    collection_id: id,
    name,
    scope: guildId ? "guild" : "org",
    display_path: displayPath,
  };
}

/**
 * Checks what a table tool proposes against the live organisation. A request
 * (`recorded` null) names the table as the coach read it: an edit must carry
 * the `updated_at` it was built on and change something. A review finds the
 * table by the id its request recorded.
 */
export async function reviewTable(
  scope: EditScope,
  action: TableAction,
  args: Record<string, unknown>,
  recorded: Record<string, unknown> | null,
): Promise<TableReview> {
  const tc = await tableContext(scope);
  const requesting = recorded === null;

  if (action === "create") {
    const checked = valid(() =>
      planCollection(scope.orgId, { name: argString(args, "name"), purpose: argString(args, "purpose"), columns: args.columns }),
    );
    const { name, purpose, columns } = checked;
    const scopeArg = args.scope ?? "guild";
    if (scopeArg !== "guild" && scopeArg !== "org") {
      throw new StudioUnprocessableError("scope must be guild or org");
    }
    const guildId = scopeArg === "guild" ? scope.sourceGuildId : null;
    if (await loadTable(tc, { name })) {
      throw new StudioConflictError(
        `a table named ${name} already exists${requesting ? "; change it with studio_edit_collection action edit" : ""}`,
      );
    }
    const { access, rowChanges } = parseAccess(tc, args.access, {
      guild: guildId ? "write" : null,
      org: guildId ? null : "read",
      agents: new Map(),
    });
    const shape: Shape = {
      name,
      purpose,
      guildId,
      guildName: guildId ? tc.guildName : null,
      columns,
      renamed: [],
      access,
      outside: [],
    };
    return {
      action,
      title: `Create table ${name}`,
      target: targetOf(null, name, guildId, checked.href),
      baseHash: hashOf(["absent", name]),
      proposedHash: shapeHash(shape),
      live: "",
      proposed: render(tc, shape),
      effects: [
        guildId
          ? `Creates ${name} as ${tc.guildName}'s own table, reached through the access listed.`
          : `Creates ${name} as an organisation table that every agent of the organisation reads, reached further through the access listed.`,
      ],
      plan: { action, collection: { name, purpose, columns, guildId }, access: rowChanges },
    };
  }

  const table =
    recorded === null
      ? await loadTable(tc, { name: argString(args, "collection").trim() })
      : await loadTable(tc, { id: String(recorded.collection_id ?? "") });
  if (!table) {
    throw new StudioUnprocessableError(
      requesting
        ? `unknown table ${argString(args, "collection") || "(none named)"}; list the tables with studio_list_collections`
        : "the table no longer exists",
    );
  }
  const target = targetOf(table.id, table.name, table.guildId, table.displayPath);

  if (action === "delete") {
    if (table.guildId === null) {
      throw new StudioUnprocessableError(`${table.name} ${ORG_TABLE_LIMIT}`);
    }
    return {
      action,
      title: `Delete table ${table.name}`,
      target,
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
      plan: { action, id: table.id },
    };
  }

  if (requesting) {
    const base = argString(args, "base_updated_at").trim();
    if (!base) {
      throw new StudioUnprocessableError(
        "base_updated_at is required: the updated_at studio_get_collection returned",
      );
    }
    if (base !== table.updatedAt) {
      throw new StudioConflictError(
        `base_updated_at ${base} is stale; ${table.name} was updated at ${table.updatedAt}. Read it again with studio_get_collection and rebuild the edit.`,
      );
    }
  }
  const { name, purpose, columns: change } = valid(() =>
    planCollectionChange(table, {
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.purpose !== undefined ? { purpose: String(args.purpose) } : {}),
      ...(args.columns !== undefined ? { columns: args.columns } : {}),
    }),
  );
  assertOrgTableEdit(table, name, purpose, change);
  if (name !== table.name && (await loadTable(tc, { name }))) {
    throw new StudioConflictError(`a table named ${name} already exists`);
  }
  const { access, rowChanges } = parseAccess(tc, args.access, table.access);
  const shape: Shape = {
    ...shapeOf(table),
    name,
    purpose,
    columns: change ? change.columns : table.columns,
    renamed: change?.renamed ?? [],
    access,
  };
  const columnsChanged = JSON.stringify(shape.columns) !== JSON.stringify(table.columns);
  const definitionChanged = name !== table.name || purpose !== table.purpose || columnsChanged;
  if (requesting && !definitionChanged && !rowChanges.length) {
    throw new StudioUnprocessableError("the proposal matches the live table; nothing to change");
  }
  return {
    action,
    title: `Edit table ${table.name}`,
    target,
    baseHash: tableHash(table),
    proposedHash: shapeHash(shape),
    live: render(tc, shapeOf(table)),
    proposed: render(tc, shape),
    effects: editEffects(table, shape, columnsChanged ? change : null),
    plan: {
      action,
      id: table.id,
      changes: definitionChanged
        ? {
            ...(name !== table.name ? { name } : {}),
            ...(purpose !== table.purpose ? { purpose } : {}),
            ...(columnsChanged ? { columns: args.columns } : {}),
          }
        : null,
      access: rowChanges,
    },
  };
}

/** Writes a reviewed proposal as the operator: the table first, then each access row it changes. */
export async function applyTable(scope: EditScope, plan: CollectionStep): Promise<void> {
  try {
    await applyCollectionStep(scope.artifacts, editActor(scope), plan);
  } catch (error) {
    tableFailure(error);
  }
}

/** The tables Studio reaches: the source guild's own first, then the organisation's. */
export async function listTables(scope: EditScope): Promise<Array<Record<string, unknown>>> {
  const actor = await tableActor(scope);
  const tables = await guildTables(scope.artifacts, actor, scope.sourceGuildId);
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
export async function readTable(scope: EditScope, name: string): Promise<Record<string, unknown>> {
  const tc = await tableContext(scope);
  const table = await loadTable(tc, { name: name.trim() });
  if (!table) {
    throw new StudioUnprocessableError(
      `unknown table ${name || "(none named)"}; list the tables with studio_list_collections`,
    );
  }
  const recent = await listRecords(scope.artifacts, tc.actor, {
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
