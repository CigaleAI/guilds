import { createHash } from "node:crypto";
import {
  ArtifactError,
  collectionDisplayPath,
  columnCatalog,
  describeColumn,
  parseColumnChange,
  parseColumns,
  resolveAccess,
  validateCollectionName,
  validatePurpose,
  type AccessMode,
  type AgentAccessMode,
  type ArtifactActor,
  type CollectionColumn,
} from "../artifacts/index.js";
import { argString } from "../toolbox/schema.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import type { EditAction } from "./actions.js";
import type { EditScope } from "./edits.js";
import { editActor } from "./actor.js";
import { StudioConflictError, StudioUnprocessableError } from "./errors.js";
import { excerptBytes, wrapEvidence } from "./system.js";

// Tables (collections) the coach reads and proposes to create, change, or
// delete. It changes the source guild's own tables and the organisation's,
// and only the grants of the source guild and its live members. Like every
// Studio edit, a proposal writes nothing until the operator applies it.

export const STUDIO_TABLE_TOOL = "studio_edit_collection";
export type TableAction = EditAction;

const RECENT_RECORDS = 5;
const GUILD_MODES = ["read", "write", "none"] as const;
const AGENT_MODES = ["read", "write", "none", "inherit"] as const;

export function isTableTool(name: string): boolean {
  return name === STUDIO_TABLE_TOOL;
}

type Member = { id: string; name: string };

/** The grants Studio can change: the source guild's base mode and its live members' own rows. */
type SourceAccess = { guild: AccessMode | null; agents: Map<string, AgentAccessMode> };

type Grant = { subject: "guild" | "agent"; id: string; mode: AccessMode | AgentAccessMode | null };

type Table = {
  id: string;
  name: string;
  purpose: string;
  guildId: string | null;
  guildName: string | null;
  columns: CollectionColumn[];
  updatedAt: string;
  count: number;
  access: SourceAccess;
  /** Grants held outside the source guild: shown, never changed. */
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

type TablePlan =
  | {
      action: "create";
      name: string;
      purpose: string;
      columns: CollectionColumn[];
      guildId: string | null;
      grants: Grant[];
    }
  | {
      action: "edit";
      id: string;
      definition: { name?: string; purpose?: string; columns?: unknown } | null;
      grants: Grant[];
    }
  | { action: "delete"; id: string };

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
  plan: TablePlan;
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

async function tableContext(scope: EditScope): Promise<TableContext> {
  const guild = await scope.repo.getGuild(scope.sourceGuildId);
  const agents = await scope.repo.listAgents(scope.sourceGuildId);
  return {
    scope,
    actor: scope.artifacts.operatorContext(
      scope.orgId,
      String(scope.user.id),
      String(scope.user.name ?? "operator"),
      {
        guildId: scope.sourceGuildId,
      },
    ),
    guildName: String(guild?.name ?? "this guild"),
    members: agents.map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

async function loadTable(
  tc: TableContext,
  ref: { id: string } | { name: string },
): Promise<Table | null> {
  let id: string;
  if ("name" in ref) {
    const described = await tc.scope.artifacts.describeCollection(tc.actor, ref.name);
    if (!described) return null;
    id = described.id;
  } else {
    id = ref.id;
  }
  let view;
  let access;
  try {
    view = await tc.scope.artifacts.getCollection(tc.actor, id);
    access = await tc.scope.artifacts.listAccess(tc.actor, id);
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) return null;
    throw error;
  }
  const source = tc.scope.sourceGuildId;
  const live = new Set(tc.members.map((member) => member.id));
  const agents = new Map<string, AgentAccessMode>();
  const outside: string[] = [];
  if (!view.guild) {
    for (const row of access.guilds) {
      if (row.id !== source) outside.push(`guild ${row.name} ${row.mode}`);
    }
  }
  for (const row of access.agents) {
    if (row.agent_mode === null) continue;
    if (row.guild_id !== source) {
      outside.push(`agent ${row.name} (${row.guild_name}) ${row.agent_mode}`);
    } else if (live.has(row.id)) {
      agents.set(row.id, row.agent_mode);
    }
  }
  const own = view.guild?.id === source;
  return {
    id: view.id,
    name: view.name,
    purpose: view.purpose,
    guildId: view.guild?.id ?? null,
    guildName: view.guild?.name ?? null,
    columns: view.columns,
    updatedAt: view.updated_at,
    count: view.count ?? 0,
    access: {
      guild: own ? "write" : (access.guilds.find((row) => row.id === source)?.mode ?? null),
      agents,
    },
    outside,
  };
}

function changeable(tc: TableContext, table: Table): boolean {
  return table.guildId === null || table.guildId === tc.scope.sourceGuildId;
}

function assertChangeable(tc: TableContext, table: Table): void {
  if (!changeable(tc, table)) {
    throw new StudioUnprocessableError(
      `${table.name} belongs to guild ${table.guildName}; change it from that guild's Studio or the Tables page`,
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
  ownTable: boolean,
  tableName: string,
): { access: SourceAccess; grants: Grant[] } {
  const access: SourceAccess = { guild: base.guild, agents: new Map(base.agents) };
  const grants: Grant[] = [];
  if (raw === undefined || raw === null) {
    return { access, grants };
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
    if (ownTable) {
      throw new StudioUnprocessableError(
        `${tableName} is ${tc.guildName}'s own table: every member writes it and it takes no guild grant; hold a member back with an agents entry`,
      );
    }
    if (!(GUILD_MODES as readonly unknown[]).includes(body.guild)) {
      throw new StudioUnprocessableError("access.guild must be read, write, or none");
    }
    const mode = body.guild === "none" ? null : (body.guild as AccessMode);
    if (mode !== access.guild) {
      access.guild = mode;
      grants.push({ subject: "guild", id: tc.scope.sourceGuildId, mode });
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
        grants.push({ subject: "agent", id: member.id, mode });
      }
    }
  }
  return { access, grants };
}

function accessKey(access: SourceAccess): unknown {
  return [access.guild, [...access.agents.entries()].sort(([a], [b]) => a.localeCompare(b))];
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

/** The table as the operator reads it in a diff: one line per column and per grant. */
function render(tc: TableContext, shape: Shape): string {
  const renamedFrom = new Map(shape.renamed.map((item) => [item.to, item.from]));
  const names = new Map(tc.members.map((member) => [member.id, member.name]));
  const own = shape.guildId === tc.scope.sourceGuildId;
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
    `- guild ${tc.guildName}: ${own ? "write, its own table" : (shape.access.guild ?? "no grant")}`,
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

function targetOf(
  tc: TableContext,
  id: string | null,
  name: string,
  guildId: string | null,
): Record<string, unknown> {
  return {
    collection_id: id,
    name,
    scope: guildId ? "guild" : "org",
    display_path: collectionDisplayPath(tc.scope.orgId, name),
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
    const name = valid(() => validateCollectionName(argString(args, "name")));
    const purpose = valid(() => validatePurpose(argString(args, "purpose")));
    const columns = valid(() => parseColumns(args.columns ?? []));
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
    const { access, grants } = parseAccess(
      tc,
      args.access,
      { guild: guildId ? "write" : null, agents: new Map() },
      guildId !== null,
      name,
    );
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
    const reached =
      access.guild !== null || [...access.agents.values()].some((mode) => mode !== "none");
    return {
      action,
      title: `Create table ${name}`,
      target: targetOf(tc, null, name, guildId),
      baseHash: hashOf(["absent", name]),
      proposedHash: shapeHash(shape),
      live: "",
      proposed: render(tc, shape),
      effects: [
        guildId
          ? `Creates ${name} as ${tc.guildName}'s own table: every member reads and writes it.`
          : reached
            ? `Creates ${name} as an organisation table, reached through the grants listed.`
            : `Creates ${name} as an organisation table that no agent reaches until it is granted.`,
      ],
      plan: { action, name, purpose, columns, guildId, grants },
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
  assertChangeable(tc, table);
  const target = targetOf(tc, table.id, table.name, table.guildId);

  if (action === "delete") {
    return {
      action,
      title: `Delete table ${table.name}`,
      target,
      baseHash: tableHash(table),
      proposedHash: hashOf(["delete", table.id]),
      live: render(tc, shapeOf(table)),
      proposed: "",
      effects: [
        `Deletes ${table.name} with its ${plural(table.count, "record")}; its grants go with it and no agent reaches it again.`,
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
  const name =
    args.name === undefined ? table.name : valid(() => validateCollectionName(String(args.name)));
  const purpose =
    args.purpose === undefined ? table.purpose : valid(() => validatePurpose(String(args.purpose)));
  const change =
    args.columns === undefined ? null : valid(() => parseColumnChange(table.columns, args.columns));
  if (name !== table.name && (await loadTable(tc, { name }))) {
    throw new StudioConflictError(`a table named ${name} already exists`);
  }
  const { access, grants } = parseAccess(
    tc,
    args.access,
    table.access,
    table.guildId !== null,
    table.name,
  );
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
  if (requesting && !definitionChanged && !grants.length) {
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
      definition: definitionChanged
        ? {
            ...(name !== table.name ? { name } : {}),
            ...(purpose !== table.purpose ? { purpose } : {}),
            ...(columnsChanged ? { columns: args.columns } : {}),
          }
        : null,
      grants,
    },
  };
}

/** Writes a reviewed proposal as the operator: the table first, then each grant it changes. */
export async function applyTable(scope: EditScope, plan: TablePlan): Promise<void> {
  const actor = editActor(scope);
  try {
    if (plan.action === "delete") {
      await scope.artifacts.deleteCollection(actor, plan.id);
      return;
    }
    let id = plan.action === "edit" ? plan.id : "";
    if (plan.action === "create") {
      const created = await scope.artifacts.createCollection(actor, {
        name: plan.name,
        purpose: plan.purpose,
        columns: plan.columns,
        guildId: plan.guildId,
      });
      id = created.id;
    } else if (plan.definition) {
      await scope.artifacts.updateCollection(actor, id, plan.definition);
    }
    for (const grant of plan.grants) {
      await scope.artifacts.setAccess(actor, {
        collectionId: id,
        subjectType: grant.subject,
        subjectId: grant.id,
        mode: grant.mode,
      });
    }
  } catch (error) {
    tableFailure(error);
  }
}

/** Every live table in the organisation: the source guild's own first, then the organisation's, then other guilds'. */
export async function listTables(scope: EditScope): Promise<Array<Record<string, unknown>>> {
  const actor = scope.artifacts.operatorContext(
    scope.orgId,
    String(scope.user.id),
    String(scope.user.name ?? "operator"),
    {
      guildId: scope.sourceGuildId,
    },
  );
  const views = await scope.artifacts.listCollections(actor, { counts: true });
  const modes = new Map(
    (await scope.artifacts.accessForGuild(actor, scope.sourceGuildId)).map((row) => [
      row.collection_id,
      row.mode,
    ]),
  );
  const rank = (guildId: string | undefined) =>
    guildId === scope.sourceGuildId ? 0 : guildId ? 2 : 1;
  return views
    .sort((a, b) => rank(a.guild?.id) - rank(b.guild?.id) || a.name.localeCompare(b.name))
    .map((view) => ({
      name: view.name,
      display_path: view.display_path,
      purpose: view.purpose,
      owner: view.guild ? `guild ${view.guild.name}` : "organisation",
      records: view.count ?? 0,
      columns: view.columns.map((column) => column.name),
      guild_access: modes.get(view.id) ?? null,
      changeable: !view.guild || view.guild.id === scope.sourceGuildId,
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
  const displayPath = collectionDisplayPath(scope.orgId, table.name);
  const recent = await scope.artifacts.listRecords(tc.actor, {
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
    display_path: displayPath,
    purpose: table.purpose,
    owner: table.guildId ? `guild ${table.guildName}` : "organisation",
    records: table.count,
    updated_at: table.updatedAt,
    changeable: changeable(tc, table),
    columns: columnCatalog(table.columns),
    access: {
      guild: table.access.guild,
      own_table: table.guildId === scope.sourceGuildId,
      agents: tc.members.map((member) => {
        const own = table.access.agents.get(member.id) ?? null;
        return {
          agent_id: member.id,
          name: member.name,
          own,
          effective: resolveAccess(table.access.guild, own),
        };
      }),
    },
    outside: table.outside,
    recent_records: wrapEvidence({
      source: "collection_records",
      coordinates: {
        display_path: displayPath,
        shown: recent.records.length,
        truncated: body.truncated || null,
      },
      body: body.text || "(no records)",
    }),
  };
}
