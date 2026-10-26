import type { ArtifactActor, ArtifactStore } from "../artifacts/index.js";
import type { Repositories } from "../db/repositories.js";
import { stamp } from "../db/pg.js";
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

// The loaders behind Studio's State list: the items a guild's state holds,
// read with the operator's own permissions so the list never shows what the
// viewer cannot open, and the change and read rows of a window.

export type StateDeps = { repo: Repositories; artifacts: ArtifactStore };

type Row = Record<string, unknown>;

// The tools whose arguments name the item they read.
const READ_TOOLS = ["note_get", "record_list", "record_search", "script_run"];

export const STATE_HISTORY_PAGE = 50;

const CHANGE_COLUMNS = `fc.display_path, fc.operation, fc.actor_type, fc.actor_id, fc.actor_name,
       fc.run_id, fc.tool_call_id, fc.studio_session_id, fc.studio_seq, fc.created_at, fc.id,
       r.agent_id AS run_agent_id`;

async function listWindowFileChanges(deps: StateDeps, orgId: string, window: ActivityWindow): Promise<Row[]> {
  const result = await deps.repo.pool.query(
    `SELECT ${CHANGE_COLUMNS}
       FROM file_changes fc LEFT JOIN runs r ON r.id = fc.run_id
      WHERE fc.org_id = $1 AND fc.created_at >= $2 AND fc.created_at <= $3`,
    [orgId, stamp(window.since), stamp(window.until)],
  );
  return result.rows as Row[];
}

const CONFIG_COLUMNS = `cc.target_kind, cc.target_id, cc.operation, cc.actor_type, cc.actor_id, cc.actor_name,
       cc.run_id, cc.tool_call_id, cc.studio_session_id, cc.studio_seq, cc.created_at, cc.id, cc.summary,
       r.agent_id AS run_agent_id`;

// The config log's changes to tables and notes: a table's shape and access, a note's access.
async function listWindowConfigChanges(deps: StateDeps, orgId: string, window: ActivityWindow): Promise<Row[]> {
  const result = await deps.repo.pool.query(
    `SELECT ${CONFIG_COLUMNS}
       FROM config_changes cc LEFT JOIN runs r ON r.id = cc.run_id
      WHERE cc.org_id = $1 AND cc.target_kind IN ('collection', 'note') AND cc.created_at >= $2 AND cc.created_at <= $3`,
    [orgId, stamp(window.since), stamp(window.until)],
  );
  return result.rows as Row[];
}

async function listWindowRuns(deps: StateDeps, guildId: string, window: ActivityWindow): Promise<Row[]> {
  const result = await deps.repo.pool.query(
    `SELECT r.id, r.id AS run_id, r.agent_id, r.created_at, r.metadata->'task_source' AS task_source
       FROM runs r JOIN agents a ON a.id = r.agent_id
      WHERE a.guild_id = $1 AND r.created_at >= $2 AND r.created_at <= $3`,
    [guildId, stamp(window.since), stamp(window.until)],
  );
  return result.rows as Row[];
}

// Tool calls that read an item: the read tools and every script tool, with
// the arguments of the step that made each call.
async function listWindowReadCalls(
  deps: StateDeps,
  guildId: string,
  request: { window: ActivityWindow; tools: string[] },
): Promise<Row[]> {
  const result = await deps.repo.pool.query(
    `SELECT m.run_id, r.agent_id, m.created_at, m.metadata->>'tool_name' AS tool_name,
            m.metadata->>'tool_call_id' AS call_id,
            (SELECT call->'function'->>'arguments'
               FROM messages step, jsonb_array_elements(step.payload->'tool_calls') call
              WHERE step.run_id = m.run_id AND step.seq < m.seq AND step.payload->>'role' = 'assistant'
                AND call->>'id' = m.metadata->>'tool_call_id'
              ORDER BY step.seq DESC LIMIT 1) AS arguments
       FROM messages m
       JOIN runs r ON r.id = m.run_id
       JOIN agents a ON a.id = r.agent_id
      WHERE a.guild_id = $1 AND m.created_at >= $2 AND m.created_at <= $3
        AND m.payload->>'role' = 'tool' AND m.metadata->>'tool_name' = ANY($4::text[])`,
    [guildId, stamp(request.window.since), stamp(request.window.until), request.tools],
  );
  return result.rows as Row[];
}

/** The tables of the guild's state: its own and the organisation's. */
async function stateTables(deps: StateDeps, actor: ArtifactActor, guildId: string): Promise<StateItem[]> {
  const tables = await deps.artifacts.listCollections(actor, { counts: true });
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
  const files = await deps.artifacts.listStateArtifacts(actor, guild);
  const tables = await stateTables(deps, actor, guild.guildId);
  return [...files.map((file) => ({ ...file, collection_id: null })), ...tables];
}

type StateScope = { actor: ArtifactActor; guildId: string; window: ActivityWindow };

/** The items and every change and read of them in the window. */
async function loadStateEvents(deps: StateDeps, scope: StateScope): Promise<{ items: StateItem[]; events: StateEvent[] }> {
  const agentRows = await deps.repo.listAgents(scope.guildId);
  const agents = new Map(agentRows.map((agent) => [String(agent.id), String(agent.name)]));
  const items = await loadStateItems(deps, scope.actor, { guildId: scope.guildId, agentIds: [...agents.keys()] });
  const scripts = items.filter((item) => item.kind === "script").map((item) => item.title);
  const [files, configs, runs, calls] = await Promise.all([
    listWindowFileChanges(deps, scope.actor.orgId, scope.window),
    listWindowConfigChanges(deps, scope.actor.orgId, scope.window),
    listWindowRuns(deps, scope.guildId, scope.window),
    listWindowReadCalls(deps, scope.guildId, { window: scope.window, tools: [...READ_TOOLS, ...scripts] }),
  ]);
  const context = { items, agents };
  return { items, events: [...changeEvents(files, configs, context), ...readEvents(runs, calls, context)] };
}

const STATE_KINDS: readonly StateKind[] = ["note", "memory", "script", "file", "table"];

/** A kind filter from the query: one of the item kinds, or none. */
export function parseStateKind(value: unknown): StateKind | null {
  if (value === undefined || value === null || value === "") return null;
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
export function parseOperation(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!OPERATIONS.includes(String(value))) throw new StudioUnprocessableError("op must be create, update, or delete");
  return String(value);
}

// An item's changes, newest first: its own file changes, for a table its
// records' changes, and its own changes from the config log.
async function listItemChanges(
  deps: StateDeps,
  orgId: string,
  page: { item: StateItem; op: string | null; before: { at: string; id: string } | null },
): Promise<Row[]> {
  const result = await deps.repo.pool.query(
    `SELECT * FROM (
       SELECT ${CHANGE_COLUMNS}, NULL::text AS summary
         FROM file_changes fc LEFT JOIN runs r ON r.id = fc.run_id
        WHERE fc.org_id = $1 AND (fc.display_path = $2 OR ($3::text IS NOT NULL AND fc.display_path LIKE $2 || '/%'))
       UNION ALL
       SELECT $2::text, cc.operation, cc.actor_type, cc.actor_id, cc.actor_name,
              cc.run_id, cc.tool_call_id, cc.studio_session_id, cc.studio_seq, cc.created_at, cc.id,
              r.agent_id, cc.summary
         FROM config_changes cc LEFT JOIN runs r ON r.id = cc.run_id
        WHERE cc.org_id = $1
          AND ((cc.target_kind = 'collection' AND cc.target_id = $3) OR (cc.target_kind = 'note' AND cc.target_id = $8))
     ) changes
     WHERE ($4::text IS NULL OR operation = $4)
       AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::text))
     ORDER BY created_at DESC, id DESC
     LIMIT $7`,
    [
      orgId,
      page.item.display_path,
      page.item.collection_id,
      page.op,
      page.before?.at ?? null,
      page.before?.id ?? null,
      STATE_HISTORY_PAGE + 1,
      page.item.note_id,
    ],
  );
  return result.rows as Row[];
}

/** One item's history, a page at a time, each entry with the step or coach message that made it. */
export async function loadStateHistory(
  deps: StateDeps,
  scope: { actor: ArtifactActor; guildId: string },
  request: { path: string; op: string | null; cursor: string | null },
): Promise<{ history: Array<Record<string, unknown>>; next_cursor: string | null }> {
  const agentRows = await deps.repo.listAgents(scope.guildId);
  const agents = new Map(agentRows.map((agent) => [String(agent.id), String(agent.name)]));
  const items = await loadStateItems(deps, scope.actor, { guildId: scope.guildId, agentIds: [...agents.keys()] });
  const item = items.find((entry) => entry.display_path === request.path);
  if (!item) throw new StudioError(404, "item not found");
  const rows = await listItemChanges(deps, scope.actor.orgId, {
    item,
    op: request.op,
    before: parseHistoryCursor(request.cursor),
  });
  const page = rows.slice(0, STATE_HISTORY_PAGE);
  const last = page.at(-1);
  return {
    history: page.map((row) => historyEntry(row, item, agents)),
    next_cursor:
      rows.length > STATE_HISTORY_PAGE && last ? `${new Date(String(last.created_at)).toISOString()}~${String(last.id)}` : null,
  };
}

function historyEntry(row: Row, item: StateItem, agents: ReadonlyMap<string, string>): Record<string, unknown> {
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
