import type pg from "pg";
import { messageCostUsd } from "../usage.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { incrementUsage } from "./usage.js";

/** What a run listing filters on; every field left out matches every run. */
export type RunHeaderFilter = {
  kind?: string | undefined;
  status?: string | undefined;
  taskPromptHash?: string | undefined;
  scheduleId?: string | undefined;
  errorOnly?: boolean | undefined;
  limit: number;
  offset?: number | undefined;
};

export type RunBaseRow = {
  id: string;
  agent_id: string;
  status: string;
  errors: unknown[];
  created_at: string;
  updated_at: string;
  system_prompt_hash: string | null;
  task_prompt_hash: string | null;
  memory_prompt_hash: string | null;
  metadata: Record<string, unknown>;
  kind: string;
  group_chat_through_seq: number | null;
};

export type ActiveRunRow = RunBaseRow & {
  config_snapshot: Record<string, unknown>;
};

export type RunRow = ActiveRunRow & {
  schedule_id: string | null;
};

export type RunHeaderRow = RunBaseRow & {
  schedule_id: string | null;
};

export type MessageRow = {
  id: number;
  run_id: string;
  seq: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  cost_usd: string | null;
};

export type NewDirectRun = {
  runId: string;
  agentId: string;
  configSnapshot: Record<string, unknown>;
  systemContent: string;
  taskContent: string;
  userContent: string | null;
  systemPromptHash: string;
  taskPromptHash: string;
  memoryPromptHash: string;
  extraMessages?: Array<[Record<string, unknown>, Record<string, unknown>]> | undefined;
  runMetadata?: Record<string, unknown> | undefined;
  userMetadata?: Record<string, unknown> | undefined;
  startedByUserId?: string | null | undefined;
};

export type NewGroupRun = {
  runId: string;
  agentId: string;
  configSnapshot: Record<string, unknown>;
  systemContent: string;
  taskContent: string;
  projected: Array<[Record<string, unknown>, Record<string, unknown>]>;
  throughSeq: number;
  systemPromptHash: string;
  taskPromptHash: string;
  memoryPromptHash: string;
  runMetadata?: Record<string, unknown> | undefined;
  wakeGroupMessageId?: number | null | undefined;
};

export type NewScheduleRun = {
  runId: string;
  agentId: string;
  configSnapshot: Record<string, unknown>;
  systemContent: string;
  taskContent: string;
  projected: Array<[Record<string, unknown>, Record<string, unknown>]>;
  systemPromptHash: string;
  taskPromptHash: string;
  memoryPromptHash: string;
  scheduleId?: string | null | undefined;
  runMetadata?: Record<string, unknown> | undefined;
};

/** A run of any kind and the messages it opens with. */
export type NewRun = {
  runId: string;
  agentId: string;
  kind: string;
  configSnapshot: Record<string, unknown>;
  systemContent: string;
  taskContent: string;
  opening: Array<[Record<string, unknown>, Record<string, unknown>]>;
  systemPromptHash: string;
  taskPromptHash: string;
  memoryPromptHash: string;
  groupChatThroughSeq?: number | null | undefined;
  scheduleId?: string | null | undefined;
  runMetadata?: Record<string, unknown> | undefined;
  wakeGroupMessageId?: number | null | undefined;
  startedByUserId?: string | null | undefined;
};

export type NewMessage = {
  runId: string;
  seq: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type RoutineRunStatsQueryRow = RunHeaderRow & {
  schedule_id: string;
  run_count: number;
};

// The columns a run header reads: no config snapshot, and only the metadata keys a header shows.
const RUN_HEADER_COLUMNS = `id, agent_id, kind, status, errors, created_at, updated_at,
       system_prompt_hash, task_prompt_hash, memory_prompt_hash, group_chat_through_seq, schedule_id,
       jsonb_build_object('instruction_hash', metadata->'instruction_hash', 'task_source', metadata->'task_source') AS metadata`;

const RUN_HEADER_EQUALS: Array<[keyof RunHeaderFilter, string]> = [
  ["kind", "kind"],
  ["status", "status"],
  ["taskPromptHash", "task_prompt_hash"],
  ["scheduleId", "schedule_id"],
];

function runHeaderConditions(filter: RunHeaderFilter, values: unknown[]): string[] {
  const conditions: string[] = [];
  for (const [key, column] of RUN_HEADER_EQUALS) {
    if (filter[key]) {
      values.push(filter[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }
  if (filter.errorOnly) {
    conditions.push("jsonb_typeof(errors) = 'array' AND jsonb_array_length(errors) > 0");
  }
  return conditions;
}

export async function listActiveRuns(pool: Queryable): Promise<ActiveRunRow[]> {
  const result = await pool.query<ActiveRunRow>(
    `SELECT id, agent_id, status, config_snapshot, errors,
            created_at, updated_at,
            system_prompt_hash, task_prompt_hash, memory_prompt_hash,
            metadata, kind, group_chat_through_seq
     FROM runs
     WHERE status = 'active'
     ORDER BY created_at`,
  );
  return result.rows;
}

export async function listRuns(pool: Queryable, agentId: string): Promise<RunRow[]> {
  const result = await pool.query<RunRow>(
    `SELECT id, agent_id, status, config_snapshot, errors,
            created_at, updated_at,
            system_prompt_hash, task_prompt_hash, memory_prompt_hash,
            metadata, kind, group_chat_through_seq, schedule_id
     FROM runs WHERE agent_id = $1 ORDER BY updated_at DESC`,
    [agentId],
  );
  return result.rows;
}

/** One agent's runs, newest first: header columns only, filtered and paged in SQL. */
export async function listRunHeaders(
  pool: Queryable,
  agentId: string,
  filter: RunHeaderFilter,
): Promise<RunHeaderRow[]> {
  const values: unknown[] = [agentId];
  const conditions = ["agent_id = $1", ...runHeaderConditions(filter, values)];
  values.push(filter.limit, filter.offset ?? 0);
  const result = await pool.query<RunHeaderRow>(
    `SELECT ${RUN_HEADER_COLUMNS}
     FROM runs WHERE ${conditions.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows;
}

/** Each routine's run count and latest run header, keyed by schedule id. */
export async function routineRunStats(
  pool: Queryable,
  scheduleIds: string[],
): Promise<Map<string, { count: number; latest: RoutineRunStatsQueryRow }>> {
  if (!scheduleIds.length) {
    return new Map();
  }
  const result = await pool.query<RoutineRunStatsQueryRow>(
    `SELECT DISTINCT ON (schedule_id) ${RUN_HEADER_COLUMNS},
            COUNT(*) OVER (PARTITION BY schedule_id)::int AS run_count
     FROM runs WHERE schedule_id = ANY($1::text[])
     ORDER BY schedule_id, created_at DESC`,
    [scheduleIds],
  );
  return new Map(
    result.rows.map((row) => [row.schedule_id, { count: row.run_count, latest: row }]),
  );
}

export async function getRun(pool: Queryable, runId: string): Promise<RunRow | null> {
  const result = await pool.query<RunRow>(
    `SELECT id, agent_id, status, config_snapshot, errors,
            created_at, updated_at,
            system_prompt_hash, task_prompt_hash, memory_prompt_hash,
            metadata, kind, group_chat_through_seq, schedule_id
     FROM runs WHERE id = $1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

export async function insertRun(pool: pg.Pool, run: NewRun, now: Date): Promise<void> {
  const systemMetadata: Record<string, unknown> = { source: "system" };
  if (run.runMetadata?.task_source) {
    systemMetadata.task_source = run.runMetadata.task_source;
  }
  const rows: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ role: "system", content: run.systemContent }, systemMetadata],
    ...run.opening,
  ];
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO runs (
         id, agent_id, org_id, status, config_snapshot, created_at, updated_at,
         system_prompt_hash, task_prompt_hash, memory_prompt_hash,
         kind, group_chat_through_seq, metadata, schedule_id,
         wake_group_message_id, started_by_user_id
       )
       VALUES (
         $1, $2,
         (SELECT p.org_id FROM agents a JOIN guilds p ON p.id = a.guild_id WHERE a.id = $2),
         'active', $3::jsonb, $4, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13
       )`,
      [
        run.runId,
        run.agentId,
        JSON.stringify(run.configSnapshot),
        stamp(now),
        run.systemPromptHash,
        run.taskPromptHash,
        run.memoryPromptHash,
        run.kind,
        run.groupChatThroughSeq ?? null,
        JSON.stringify(run.runMetadata ?? {}),
        run.scheduleId ?? null,
        run.wakeGroupMessageId ?? null,
        run.startedByUserId ?? null,
      ],
    );
    for (const [seq, [payload, metadata]] of rows.entries()) {
      await client.query(
        `INSERT INTO messages (run_id, seq, payload, metadata, created_at, cost_usd)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        [
          run.runId,
          seq,
          JSON.stringify(payload),
          JSON.stringify(metadata),
          stamp(now),
          messageCostUsd(metadata),
        ],
      );
    }
  });
}

export async function createRun(pool: pg.Pool, run: NewDirectRun, now: Date): Promise<void> {
  const opening = [...(run.extraMessages ?? [])];
  if (run.userContent !== null) {
    opening.push([
      { role: "user", content: run.userContent },
      { generation: 1, source: "ui", ...(run.userMetadata ?? {}) },
    ]);
  }
  await insertRun(
    pool,
    {
      runId: run.runId,
      agentId: run.agentId,
      kind: "direct",
      configSnapshot: run.configSnapshot,
      systemContent: run.systemContent,
      taskContent: run.taskContent,
      opening,
      systemPromptHash: run.systemPromptHash,
      taskPromptHash: run.taskPromptHash,
      memoryPromptHash: run.memoryPromptHash,
      startedByUserId: run.startedByUserId ?? null,
      ...(run.runMetadata ? { runMetadata: run.runMetadata } : {}),
    },
    now,
  );
}

export async function createGroupRun(pool: pg.Pool, run: NewGroupRun, now: Date): Promise<void> {
  await insertRun(
    pool,
    {
      runId: run.runId,
      agentId: run.agentId,
      kind: "group",
      configSnapshot: run.configSnapshot,
      systemContent: run.systemContent,
      taskContent: run.taskContent,
      opening: run.projected,
      systemPromptHash: run.systemPromptHash,
      taskPromptHash: run.taskPromptHash,
      memoryPromptHash: run.memoryPromptHash,
      groupChatThroughSeq: run.throughSeq,
      runMetadata: run.runMetadata,
      wakeGroupMessageId: run.wakeGroupMessageId,
    },
    now,
  );
}

export async function createScheduleRun(
  pool: pg.Pool,
  run: NewScheduleRun,
  now: Date,
): Promise<void> {
  await insertRun(
    pool,
    {
      runId: run.runId,
      agentId: run.agentId,
      kind: "schedule",
      configSnapshot: run.configSnapshot,
      systemContent: run.systemContent,
      taskContent: run.taskContent,
      opening: run.projected,
      systemPromptHash: run.systemPromptHash,
      taskPromptHash: run.taskPromptHash,
      memoryPromptHash: run.memoryPromptHash,
      scheduleId: run.scheduleId,
      runMetadata: run.runMetadata,
    },
    now,
  );
}

export async function insertMessage(
  pool: pg.Pool,
  message: NewMessage,
  now: Date,
): Promise<MessageRow> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<MessageRow>(
      `INSERT INTO messages (run_id, seq, payload, metadata, created_at, cost_usd)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       RETURNING id, run_id, seq, payload, metadata, created_at, cost_usd`,
      [
        message.runId,
        message.seq,
        JSON.stringify(message.payload),
        JSON.stringify(message.metadata),
        stamp(now),
        messageCostUsd(message.metadata),
      ],
    );
    const row = result.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("message insert failed");
    }
    await client.query(`UPDATE runs SET updated_at = $2 WHERE id = $1`, [
      message.runId,
      stamp(now),
    ]);
    await incrementUsage(client, message.runId, message.metadata, now);
    return row;
  });
}

export async function nextSeq(pool: Queryable, runId: string): Promise<number> {
  const result = await pool.query<{ value: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS value FROM messages WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0]?.value ?? 0;
}

export async function nextGeneration(pool: Queryable, runId: string): Promise<number> {
  const result = await pool.query<{ value: number }>(
    `SELECT COALESCE(MAX((metadata->>'generation')::int), 0) + 1 AS value
     FROM messages WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0]?.value ?? 1;
}

export async function listMessages(pool: Queryable, runId: string): Promise<MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT id, run_id, seq, payload, metadata, created_at, cost_usd
     FROM messages WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return result.rows;
}

/** The metadata of a run's result for one tool call, or null when the call has no result. */
export async function getToolResultMetadata(
  pool: Queryable,
  runId: string,
  toolCallId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<Pick<MessageRow, "metadata">>(
    `SELECT metadata FROM messages
     WHERE run_id = $1 AND payload->>'role' = 'tool' AND metadata->>'tool_call_id' = $2
     ORDER BY seq LIMIT 1`,
    [runId, toolCallId],
  );
  return result.rows[0]?.metadata ?? null;
}

export async function listPayloads(
  pool: Queryable,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await listMessages(pool, runId)).map((row) => row.payload);
}

export async function appendRunError(
  pool: Queryable,
  runId: string,
  entry: Record<string, unknown>,
  now: Date,
): Promise<unknown[]> {
  const result = await pool.query<{ errors: unknown[] }>(
    `UPDATE runs
     SET errors = errors || $2::jsonb, updated_at = $3
     WHERE id = $1
     RETURNING errors`,
    [runId, JSON.stringify([entry]), stamp(now)],
  );
  return result.rows[0]?.errors ?? [];
}

export async function mergeRunMetadata(
  pool: Queryable,
  runId: string,
  extra: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await pool.query(
    `UPDATE runs
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = $3
     WHERE id = $1`,
    [runId, JSON.stringify(extra), stamp(now)],
  );
}

export async function completeRun(pool: Queryable, runId: string, now: Date): Promise<void> {
  await pool.query(`UPDATE runs SET status = 'completed', updated_at = $2 WHERE id = $1`, [
    runId,
    stamp(now),
  ]);
}

export async function reopenRun(pool: Queryable, runId: string, now: Date): Promise<void> {
  await pool.query(
    `UPDATE runs
     SET status = 'active',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = $3
     WHERE id = $1 AND status = 'completed'`,
    [runId, JSON.stringify({ resumed_at: now.toISOString() }), stamp(now)],
  );
}

export async function completeGroupDelivery(
  pool: pg.Pool,
  runId: string,
  agentId: string,
  throughSeq: number,
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`UPDATE runs SET status = 'completed', updated_at = $2 WHERE id = $1`, [
      runId,
      stamp(now),
    ]);
    await client.query(
      `UPDATE agents
       SET group_chat_delivered_through = GREATEST(group_chat_delivered_through, $2)
       WHERE id = $1`,
      [agentId, throughSeq],
    );
  });
}

export async function updateRunSecrets(
  pool: Queryable,
  runId: string,
  secrets: Array<Record<string, string>>,
  now: Date,
): Promise<void> {
  await pool.query(
    `UPDATE runs
     SET config_snapshot = jsonb_set(config_snapshot, '{secrets}', $2::jsonb),
         updated_at = $3
     WHERE id = $1`,
    [runId, JSON.stringify(secrets), stamp(now)],
  );
}

export async function updateRunScripts(
  pool: Queryable,
  runId: string,
  scripts: unknown[],
  now: Date,
): Promise<void> {
  await pool.query(
    `UPDATE runs
     SET config_snapshot = jsonb_set(config_snapshot, '{scripts}', $2::jsonb),
         updated_at = $3
     WHERE id = $1`,
    [runId, JSON.stringify(scripts), stamp(now)],
  );
}
