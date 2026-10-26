import { type Queryable, stamp } from "./pg.js";

export type GuildActivityRunRow = {
  id: string;
  agent_id: string;
  kind: string;
  status: string;
  errors: unknown[];
  metadata: Record<string, unknown>;
  schedule_id: string | null;
  group_chat_through_seq: number | null;
  created_at: string;
  updated_at: string;
  started_by_user_id: string | null;
  wake_seq: number | null;
  previous_through_seq: number | null;
};

export type RunActivityStatsRow = {
  run_id: string;
  last_seq: number | null;
  first_at: string | null;
  last_at: string | null;
  cost_usd: string;
};

export type RunGroupDeliveryRow = {
  run_id: string;
  metadata: Record<string, unknown>;
};

export type RunGroupPostRow = {
  run_id: string;
  seq: number;
  created_at: string;
  content: string | null;
  call_id: string | null;
};

export type RunActivityStepRow = {
  run_id: string;
  seq: number;
  created_at: string;
  role: string | null;
  tool_calls: unknown;
  text: string | null;
  tool_call_id: string | null;
  error: string | null;
  duration_ms: string | null;
};

export type RunOpeningRow = {
  run_id: string;
  text: string | null;
};

export type GuildToolCallStatRow = {
  tool_name: string;
  agent_id: string | null;
  calls: number;
  errors: number;
  median_ms: number | null;
  last_at: string | null;
};

export type GuildToolCallRow = {
  id: number;
  run_id: string;
  seq: number;
  created_at: string;
  agent_id: string;
  call_id: string | null;
  error: string | null;
  duration_ms: string | null;
  arguments: string | null;
};

export type RunFileChangeRow = {
  run_id: string | null;
  display_path: string;
  operation: string;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: string;
};

export type GuildToolCallPage = {
  since: Date;
  until: Date;
  errorsOnly: boolean;
  before: { at: Date; id: number } | null;
  limit: number;
};

// A tool result's duration when it recorded one as a number.
const TOOL_DURATION = `CASE WHEN jsonb_typeof(m.metadata->'duration_ms') = 'number'
  THEN (m.metadata->>'duration_ms')::numeric END`;

// A stored step's text: its string content, or the text parts of a content list.
const STEP_TEXT = `
  CASE jsonb_typeof(payload->'content')
    WHEN 'string' THEN left(payload->>'content', 2000)
    WHEN 'array' THEN left((
      SELECT string_agg(part->>'text', ' ')
      FROM jsonb_array_elements(payload->'content') AS part
      WHERE part->>'type' = 'text'
    ), 2000)
  END
`;

// Runs of a guild's agents active inside [since, until]. `previous_through_seq`
// is the group snapshot of the same agent's previous run of that kind.
export async function listGuildActivityRuns(
  pool: Queryable,
  guildId: string,
  since: Date,
  until: Date,
): Promise<GuildActivityRunRow[]> {
  const result = await pool.query<GuildActivityRunRow>(
    `SELECT * FROM (
       SELECT r.id, r.agent_id, r.kind, r.status, r.errors, r.metadata, r.schedule_id,
              r.group_chat_through_seq, r.created_at, r.updated_at,
              r.started_by_user_id, wm.seq AS wake_seq,
              LAG(r.group_chat_through_seq) OVER (
                PARTITION BY r.agent_id, r.kind ORDER BY r.created_at
              ) AS previous_through_seq
       FROM runs r
       JOIN agents a ON a.id = r.agent_id
       LEFT JOIN group_messages wm ON wm.id = r.wake_group_message_id
       WHERE a.guild_id = $1 AND r.created_at <= $3
     ) guild_runs
     WHERE created_at >= $2 OR updated_at >= $2
     ORDER BY created_at`,
    [guildId, stamp(since), stamp(until)],
  );
  return result.rows;
}

// Per-run step facts: the last step, the first and last step inside the
// window, and the cost of the steps inside it.
export async function listRunActivityStats(
  pool: Queryable,
  runIds: string[],
  since: Date,
): Promise<RunActivityStatsRow[]> {
  if (!runIds.length) {
    return [];
  }
  const result = await pool.query<RunActivityStatsRow>(
    `SELECT run_id,
            MAX(seq) AS last_seq,
            MIN(created_at) FILTER (WHERE created_at >= $2) AS first_at,
            MAX(created_at) AS last_at,
            COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= $2), 0) AS cost_usd
     FROM messages
     WHERE run_id = ANY($1::text[])
     GROUP BY run_id`,
    [runIds, stamp(since)],
  );
  return result.rows;
}

// The group delivery row each group run opened with.
export async function listRunGroupDeliveries(
  pool: Queryable,
  runIds: string[],
): Promise<RunGroupDeliveryRow[]> {
  if (!runIds.length) {
    return [];
  }
  const result = await pool.query<RunGroupDeliveryRow>(
    `SELECT DISTINCT ON (run_id) run_id, metadata
     FROM messages
     WHERE run_id = ANY($1::text[]) AND metadata->>'source' = 'group_chat'
     ORDER BY run_id, seq`,
    [runIds],
  );
  return result.rows;
}

// `group_post` results, which carry the tool call id and the posted sequence.
export async function listRunGroupPosts(
  pool: Queryable,
  runIds: string[],
): Promise<RunGroupPostRow[]> {
  if (!runIds.length) {
    return [];
  }
  const result = await pool.query<RunGroupPostRow>(
    `SELECT run_id, seq, created_at, payload->>'content' AS content, metadata->>'tool_call_id' AS call_id
     FROM messages
     WHERE run_id = ANY($1::text[])
       AND payload->>'role' = 'tool'
       AND metadata->>'tool_name' = 'group_post'
     ORDER BY run_id, seq`,
    [runIds],
  );
  return result.rows;
}

// Assistant and tool steps inside the window: each assistant step's tool
// calls and text, and each tool result's call id, error, and duration.
export async function listRunActivitySteps(
  pool: Queryable,
  runIds: string[],
  since: Date,
): Promise<RunActivityStepRow[]> {
  if (!runIds.length) {
    return [];
  }
  const result = await pool.query<RunActivityStepRow>(
    `SELECT run_id, seq, created_at,
            payload->>'role' AS role,
            CASE WHEN payload->>'role' = 'assistant' THEN payload->'tool_calls' END AS tool_calls,
            CASE WHEN payload->>'role' = 'assistant' THEN ${STEP_TEXT} END AS text,
            metadata->>'tool_call_id' AS tool_call_id,
            metadata->>'error' AS error,
            metadata->>'duration_ms' AS duration_ms
     FROM messages
     WHERE run_id = ANY($1::text[])
       AND created_at >= $2
       AND payload->>'role' IN ('assistant', 'tool')
     ORDER BY run_id, seq`,
    [runIds, stamp(since)],
  );
  return result.rows;
}

// The first user message inside the window of each run.
export async function listRunOpenings(
  pool: Queryable,
  runIds: string[],
  since: Date,
): Promise<RunOpeningRow[]> {
  if (!runIds.length) {
    return [];
  }
  const result = await pool.query<RunOpeningRow>(
    `SELECT DISTINCT ON (run_id) run_id, ${STEP_TEXT} AS text
     FROM messages
     WHERE run_id = ANY($1::text[])
       AND created_at >= $2
       AND payload->>'role' = 'user'
     ORDER BY run_id, seq`,
    [runIds, stamp(since)],
  );
  return result.rows;
}

// Per tool and agent, the guild's agent tool calls in a window: how many,
// how many failed, the median duration, and the last one. A row with a null
// agent_id holds the tool's totals over every agent.
export async function listGuildToolCallStats(
  pool: Queryable,
  guildId: string,
  since: Date,
  until: Date,
): Promise<GuildToolCallStatRow[]> {
  const result = await pool.query<GuildToolCallStatRow>(
    `SELECT m.metadata->>'tool_name' AS tool_name, r.agent_id,
            COUNT(*)::int AS calls,
            (COUNT(*) FILTER (WHERE COALESCE(m.metadata->>'error', '') <> ''))::int AS errors,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ${TOOL_DURATION}) AS median_ms,
            MAX(m.created_at) AS last_at
     FROM messages m
     JOIN runs r ON r.id = m.run_id
     JOIN agents a ON a.id = r.agent_id
     WHERE a.guild_id = $1 AND m.created_at >= $2 AND m.created_at <= $3
       AND m.payload->>'role' = 'tool' AND COALESCE(m.metadata->>'tool_name', '') <> ''
     GROUP BY GROUPING SETS ((m.metadata->>'tool_name', r.agent_id), (m.metadata->>'tool_name'))`,
    [guildId, stamp(since), stamp(until)],
  );
  return result.rows;
}

// One tool's calls by the guild's agents in a window, newest first, with the
// arguments from the assistant step that made each call. `before` pages on
// (created_at, id).
export async function listGuildToolCalls(
  pool: Queryable,
  guildId: string,
  tool: string,
  page: GuildToolCallPage,
): Promise<GuildToolCallRow[]> {
  const result = await pool.query<GuildToolCallRow>(
    `SELECT m.id, m.run_id, m.seq, m.created_at, r.agent_id,
            m.metadata->>'tool_call_id' AS call_id,
            m.metadata->>'error' AS error,
            ${TOOL_DURATION} AS duration_ms,
            (SELECT call->'function'->>'arguments'
             FROM messages step, jsonb_array_elements(step.payload->'tool_calls') call
             WHERE step.run_id = m.run_id AND step.seq < m.seq
               AND step.payload->>'role' = 'assistant'
               AND call->>'id' = m.metadata->>'tool_call_id'
             ORDER BY step.seq DESC LIMIT 1) AS arguments
     FROM messages m
     JOIN runs r ON r.id = m.run_id
     JOIN agents a ON a.id = r.agent_id
     WHERE a.guild_id = $1 AND m.created_at >= $2 AND m.created_at <= $3
       AND m.payload->>'role' = 'tool' AND m.metadata->>'tool_name' = $4
       AND (NOT $5 OR COALESCE(m.metadata->>'error', '') <> '')
       AND ($6::timestamptz IS NULL OR (m.created_at, m.id) < ($6::timestamptz, $7::bigint))
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $8`,
    [
      guildId,
      stamp(page.since),
      stamp(page.until),
      tool,
      page.errorsOnly,
      page.before ? stamp(page.before.at) : null,
      page.before?.id ?? null,
      page.limit,
    ],
  );
  return result.rows;
}

export async function listRunFileChanges(
  pool: Queryable,
  runIds: string[],
): Promise<RunFileChangeRow[]> {
  if (!runIds.length) {
    return [];
  }
  const result = await pool.query<RunFileChangeRow>(
    `SELECT run_id, display_path, operation, tool_name, tool_call_id, created_at
     FROM file_changes
     WHERE run_id = ANY($1::text[])
     ORDER BY created_at, id`,
    [runIds],
  );
  return result.rows;
}
