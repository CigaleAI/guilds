import type { InferSelectModel } from "drizzle-orm";
import { type Queryable, stamp } from "./pg.js";
import type { configChanges, fileChanges, messages, runs } from "./schema/index.js";

type FileChange = InferSelectModel<typeof fileChanges>;
type ConfigChange = InferSelectModel<typeof configChanges>;
type Run = InferSelectModel<typeof runs>;

// The change and read rows behind Studio's State list: what changed a guild's
// items, and which tool calls read them, within a window or for one item.

/** A span of time the State list reads. */
export type StateWindow = { since: Date; until: Date };

/** A file change with the agent of the run that made it, when a run did. */
export type FileChangeEventRow = Pick<
  FileChange,
  | "display_path"
  | "operation"
  | "actor_type"
  | "actor_id"
  | "actor_name"
  | "run_id"
  | "tool_call_id"
  | "studio_session_id"
  | "studio_seq"
  | "created_at"
  | "id"
> & { run_agent_id: Run["agent_id"] | null };

/** A config change to a table or a note, with the agent of the run that made it, when a run did. */
export type ConfigChangeEventRow = Pick<
  ConfigChange,
  | "target_kind"
  | "target_id"
  | "operation"
  | "actor_type"
  | "actor_id"
  | "actor_name"
  | "run_id"
  | "tool_call_id"
  | "studio_session_id"
  | "studio_seq"
  | "created_at"
  | "id"
  | "summary"
> & { run_agent_id: Run["agent_id"] | null };

/** A run of the guild's agents, with the task source it was started from. */
export type WindowRunRow = Pick<Run, "id" | "agent_id" | "created_at"> & { run_id: string; task_source: unknown };

/** A read tool's call, with the arguments of the step that made it. */
export type ReadCallRow = Pick<InferSelectModel<typeof messages>, "run_id" | "created_at"> & {
  agent_id: Run["agent_id"];
  tool_name: string | null;
  call_id: string | null;
  arguments: string | null;
};

/** One change of an item's history: a file change, or a config change under the item's display path. */
export type ItemChangeRow = FileChangeEventRow & { summary: string | null };

const CHANGE_COLUMNS = `fc.display_path, fc.operation, fc.actor_type, fc.actor_id, fc.actor_name,
       fc.run_id, fc.tool_call_id, fc.studio_session_id, fc.studio_seq, fc.created_at, fc.id,
       r.agent_id AS run_agent_id`;

const CONFIG_COLUMNS = `cc.target_kind, cc.target_id, cc.operation, cc.actor_type, cc.actor_id, cc.actor_name,
       cc.run_id, cc.tool_call_id, cc.studio_session_id, cc.studio_seq, cc.created_at, cc.id, cc.summary,
       r.agent_id AS run_agent_id`;

/** The organisation's file changes within the window. */
export async function listWindowFileChanges(
  db: Queryable,
  orgId: string,
  window: StateWindow,
): Promise<FileChangeEventRow[]> {
  const result = await db.query<FileChangeEventRow>(
    `SELECT ${CHANGE_COLUMNS}
       FROM file_changes fc LEFT JOIN runs r ON r.id = fc.run_id
      WHERE fc.org_id = $1 AND fc.created_at >= $2 AND fc.created_at <= $3`,
    [orgId, stamp(window.since), stamp(window.until)],
  );
  return result.rows;
}

/** The config log's changes to tables and notes within the window: a table's shape and access, a note's access. */
export async function listWindowConfigChanges(
  db: Queryable,
  orgId: string,
  window: StateWindow,
): Promise<ConfigChangeEventRow[]> {
  const result = await db.query<ConfigChangeEventRow>(
    `SELECT ${CONFIG_COLUMNS}
       FROM config_changes cc LEFT JOIN runs r ON r.id = cc.run_id
      WHERE cc.org_id = $1 AND cc.target_kind IN ('collection', 'note') AND cc.created_at >= $2 AND cc.created_at <= $3`,
    [orgId, stamp(window.since), stamp(window.until)],
  );
  return result.rows;
}

/** The runs of the guild's agents started within the window. */
export async function listWindowRuns(db: Queryable, guildId: string, window: StateWindow): Promise<WindowRunRow[]> {
  const result = await db.query<WindowRunRow>(
    `SELECT r.id, r.id AS run_id, r.agent_id, r.created_at, r.metadata->'task_source' AS task_source
       FROM runs r JOIN agents a ON a.id = r.agent_id
      WHERE a.guild_id = $1 AND r.created_at >= $2 AND r.created_at <= $3`,
    [guildId, stamp(window.since), stamp(window.until)],
  );
  return result.rows;
}

/**
 * The calls of `tools` the guild's agents made within the window, with the arguments of the step
 * that made each call.
 */
export async function listWindowReadCalls(
  db: Queryable,
  guildId: string,
  request: { window: StateWindow; tools: string[] },
): Promise<ReadCallRow[]> {
  const result = await db.query<ReadCallRow>(
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
  return result.rows;
}

/** One page of an item's history: the item at its display path, a table's collection, a note's id. */
export type ItemHistoryPage = {
  displayPath: string;
  collectionId: string | null;
  noteId: string | null;
  op: string | null;
  before: { at: string; id: string } | null;
  limit: number;
};

/**
 * An item's changes, newest first: its own file changes, for a table its records' changes, and
 * its own changes from the config log.
 */
export async function listItemChanges(db: Queryable, orgId: string, page: ItemHistoryPage): Promise<ItemChangeRow[]> {
  const result = await db.query<ItemChangeRow>(
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
      page.displayPath,
      page.collectionId,
      page.op,
      page.before?.at ?? null,
      page.before?.id ?? null,
      page.limit,
      page.noteId,
    ],
  );
  return result.rows;
}
