import type { ArtifactActor } from "../artifacts/types.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { Queryable } from "../db/pg.js";
import {
  listItemChanges,
  listWindowConfigChanges,
  listWindowFileChanges,
  listWindowReadCalls,
  listWindowRuns,
  type ItemChangeRow,
} from "../db/state.js";
import type { ActivityWindow } from "./activity.js";
import { StudioError, StudioUnprocessableError } from "./errors.js";
import {
  changeActor,
  changeEvents,
  changeLink,
  counts,
  readEvents,
  stateRows,
  tallyBy,
  type StateEvent,
  type StateItem,
  type StateKind,
  type StateRow,
} from "./state-list.js";
import { listAgents } from "../db/agents.js";
import { listStateArtifacts } from "../artifacts/notes.js";
import { listCollectionsWithCounts } from "../artifacts/collections.js";

// The loaders behind Studio's State list: the items a guild's state holds,
// read with the operator's own permissions so the list never shows what the
// viewer cannot open, and the change and read rows of a window.

export type StateDeps = { db: Queryable; artifacts: ArtifactStore };

// The tools whose arguments name the item they read.
const READ_TOOLS = ["note_get", "file_fetch", "record_list", "record_search", "script_run"];

export const STATE_HISTORY_PAGE = 50;

/** The tables of the guild's state: its own and the organisation's. */
async function stateTables(deps: StateDeps, actor: ArtifactActor, guildId: string): Promise<StateItem[]> {
  const tables = await listCollectionsWithCounts(deps.artifacts, actor);
  return tables
    .filter((table) => table.scope === "org" || table.guild?.id === guildId)
    .map((table) => ({
      display_path: table.display_path,
      kind: "table",
      level: table.scope === "org" ? "org" : "guild",
      owner_id: table.guild?.id ?? actor.orgId,
      title: table.name,
      size: table.count ?? 0,
      version: null,
      created_by: "",
      created_at: table.created_at,
      collection_id: table.id,
      note_id: null,
    }));
}

/** Every item of the guild's state the actor can open. */
export async function loadStateItems(
  deps: StateDeps,
  actor: ArtifactActor,
  guild: { guildId: string; agentIds: string[] },
): Promise<StateItem[]> {
  const files = await listStateArtifacts(deps.artifacts, actor, guild);
  const tables = await stateTables(deps, actor, guild.guildId);
  return [...files.map((file) => ({ ...file, collection_id: null })), ...tables];
}

type StateScope = { actor: ArtifactActor; guildId: string; window: ActivityWindow };

/** The items and every change and read of them in the window. */
async function loadStateEvents(deps: StateDeps, scope: StateScope): Promise<{ items: StateItem[]; events: StateEvent[] }> {
  const agentRows = await listAgents(deps.db, scope.guildId);
  const agents = new Map(agentRows.map((agent) => [String(agent.id), String(agent.name)]));
  const items = await loadStateItems(deps, scope.actor, { guildId: scope.guildId, agentIds: [...agents.keys()] });
  const scripts = items.filter((item) => item.kind === "script").map((item) => item.title);
  const [files, configs, runs, calls] = await Promise.all([
    listWindowFileChanges(deps.db, scope.actor.orgId, scope.window),
    listWindowConfigChanges(deps.db, scope.actor.orgId, scope.window),
    listWindowRuns(deps.db, scope.guildId, scope.window),
    listWindowReadCalls(deps.db, scope.guildId, { window: scope.window, tools: [...READ_TOOLS, ...scripts] }),
  ]);
  const context = { items, agents };
  return { items, events: [...changeEvents(files, configs, context), ...readEvents(runs, calls, context)] };
}

const STATE_KINDS: readonly StateKind[] = ["note", "memory", "script", "file", "table"];

/** A kind filter from the query: one of the item kinds, or none. */
export function parseStateKind(value: string | undefined): StateKind | null {
  if (value === undefined || value === "") return null;
  const kind = STATE_KINDS.find((entry) => entry === value);
  if (!kind) throw new StudioUnprocessableError("kind must be note, memory, script, file, or table");
  return kind;
}

/** The State list: every item with its changes and reads in the window, narrowed as asked. */
export async function loadStateList(
  deps: StateDeps,
  scope: StateScope,
  filter: { kind: StateKind | null; agentId: string | null },
): Promise<{ since: string; until: string; items: StateRow[] }> {
  const { items, events } = await loadStateEvents(deps, scope);
  return {
    since: scope.window.since.toISOString(),
    until: scope.window.until.toISOString(),
    items: stateRows(items, events, filter),
  };
}

/** One item's numbers in the window: who changes it how, and who reads it how. */
export async function loadStateItem(
  deps: StateDeps,
  scope: StateScope,
  path: string,
): Promise<{ item: StateRow; changes: ReturnType<typeof tallyBy>; reads: ReturnType<typeof tallyBy> }> {
  const { items, events } = await loadStateEvents(deps, scope);
  const item = items.find((entry) => entry.display_path === path);
  if (!item) throw new StudioError(404, "item not found");
  const own = events.filter((event) => event.path === path && counts(event.actor));
  return {
    item: stateRows([item], events, { kind: null, agentId: null })[0] as StateRow,
    changes: tallyBy(own.filter((event) => event.what === "change")),
    reads: tallyBy(own.filter((event) => event.what === "read")),
  };
}

/** A history page cursor names the last entry shown: its time and id. */
export function parseHistoryCursor(cursor: string | null): { at: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.slice(0, cursor.indexOf("~"));
  const id = cursor.slice(cursor.indexOf("~") + 1);
  if (!cursor.includes("~") || !id || Number.isNaN(new Date(at).getTime())) {
    throw new StudioUnprocessableError("cursor is not one this route returned");
  }
  return { at, id };
}

const OPERATIONS = ["create", "update", "delete"];

/** An operation filter from the query: create, update, delete, or none. */
export function parseOperation(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!OPERATIONS.includes(value)) throw new StudioUnprocessableError("op must be create, update, or delete");
  return value;
}

/** One item's history, a page at a time, each entry with the step or coach message that made it. */
export async function loadStateHistory(
  deps: StateDeps,
  scope: { actor: ArtifactActor; guildId: string },
  request: { path: string; op: string | null; cursor: string | null },
): Promise<{ history: Array<Record<string, unknown>>; next_cursor: string | null }> {
  const agentRows = await listAgents(deps.db, scope.guildId);
  const agents = new Map(agentRows.map((agent) => [String(agent.id), String(agent.name)]));
  const items = await loadStateItems(deps, scope.actor, { guildId: scope.guildId, agentIds: [...agents.keys()] });
  const item = items.find((entry) => entry.display_path === request.path);
  if (!item) throw new StudioError(404, "item not found");
  const rows = await listItemChanges(deps.db, scope.actor.orgId, {
    displayPath: item.display_path,
    collectionId: item.collection_id,
    noteId: item.note_id,
    op: request.op,
    before: parseHistoryCursor(request.cursor),
    limit: STATE_HISTORY_PAGE + 1,
  });
  const page = rows.slice(0, STATE_HISTORY_PAGE);
  const last = page.at(-1);
  return {
    history: page.map((row) => historyEntry(row, item, agents)),
    next_cursor:
      rows.length > STATE_HISTORY_PAGE && last ? `${new Date(String(last.created_at)).toISOString()}~${String(last.id)}` : null,
  };
}

function historyEntry(row: ItemChangeRow, item: StateItem, agents: ReadonlyMap<string, string>): Record<string, unknown> {
  const own = String(row.display_path);
  return {
    at: new Date(String(row.created_at)).toISOString(),
    operation: String(row.operation),
    actor: changeActor(row, agents),
    link: changeLink(row),
    record: own === item.display_path ? null : own,
    summary: row.summary ?? null,
  };
}
