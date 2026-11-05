import type { InferSelectModel } from "drizzle-orm";
import { tableColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { runWakes } from "./schema/index.js";

export type RunWakeRow = InferSelectModel<typeof runWakes>;

/** Why a wake-up was cancelled: another replaced it, the agent, the operator, or the run's limit. */
export type RunWakeCancelReason = NonNullable<RunWakeRow["cancel_reason"]>;

/** A wake-up a run's tool call sets: the run it wakes, its chain's first run, and when it is due. */
export type NewRunWake = {
  wakeId: string;
  runId: string;
  rootRunId: string;
  agentId: string;
  dueAt: Date;
  message: string | null;
  setToolCallId: string;
};

/** A wake-up just set, and the pending one it replaced; null when the run had none. */
export type RunWakeReplacement = { wake: RunWakeRow; replaced: RunWakeRow | null };

const RUN_WAKE_COLUMNS = tableColumns(runWakes);

/**
 * Sets `wake` as its run's pending wake-up. In one transaction, the run's pending wake-up, when
 * it has one, is cancelled as `replaced`. The run's row is locked first, so two sets on one run
 * take turns.
 */
export async function setRunWake(
  db: Queryable,
  wake: NewRunWake,
  now: Date,
): Promise<RunWakeReplacement> {
  return withTransaction(db, async (client) => {
    await client.query(`SELECT id FROM runs WHERE id = $1 FOR UPDATE`, [wake.runId]);
    const replaced = await cancelRunWake(client, wake.runId, "replaced");
    const result = await client.query<RunWakeRow>(
      `INSERT INTO run_wakes (
         id, run_id, root_run_id, agent_id, due_at, message, state, set_tool_call_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING ${RUN_WAKE_COLUMNS}`,
      [
        wake.wakeId,
        wake.runId,
        wake.rootRunId,
        wake.agentId,
        stamp(wake.dueAt),
        wake.message,
        wake.setToolCallId,
        stamp(now),
      ],
    );
    const row = result.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("run wake insert failed");
    }
    return { wake: row, replaced };
  });
}

/** Cancels the run's pending wake-up for `reason`; null when the run has none. */
export async function cancelRunWake(
  db: Queryable,
  runId: string,
  reason: RunWakeCancelReason,
): Promise<RunWakeRow | null> {
  const result = await db.query<RunWakeRow>(
    `UPDATE run_wakes SET state = 'cancelled', cancel_reason = $2
     WHERE run_id = $1 AND state = 'pending'
     RETURNING ${RUN_WAKE_COLUMNS}`,
    [runId, reason],
  );
  return result.rows[0] ?? null;
}

/** The run's pending wake-up; null when it has none. */
export async function getPendingRunWake(db: Queryable, runId: string): Promise<RunWakeRow | null> {
  const result = await db.query<RunWakeRow>(
    `SELECT ${RUN_WAKE_COLUMNS} FROM run_wakes WHERE run_id = $1 AND state = 'pending'`,
    [runId],
  );
  return result.rows[0] ?? null;
}

/** The pending wake-ups due at or before `now`, the earliest first. */
export async function listDueRunWakes(db: Queryable, now: Date): Promise<RunWakeRow[]> {
  const result = await db.query<RunWakeRow>(
    `SELECT ${RUN_WAKE_COLUMNS} FROM run_wakes
     WHERE state = 'pending' AND due_at <= $1
     ORDER BY due_at, id`,
    [stamp(now)],
  );
  return result.rows;
}

/** Marks a pending wake-up fired at `now`; null when it is no longer pending. */
export async function markRunWakeFired(
  db: Queryable,
  wakeId: string,
  now: Date,
): Promise<RunWakeRow | null> {
  const result = await db.query<RunWakeRow>(
    `UPDATE run_wakes SET state = 'fired', fired_at = $2
     WHERE id = $1 AND state = 'pending'
     RETURNING ${RUN_WAKE_COLUMNS}`,
    [wakeId, stamp(now)],
  );
  return result.rows[0] ?? null;
}

/**
 * Moves the pending wake-up of `fromRunId` to `toRunId`, the run that continues it; null when
 * `fromRunId` has none. The wake-up keeps its chain's first run.
 */
export async function movePendingRunWake(
  db: Queryable,
  fromRunId: string,
  toRunId: string,
): Promise<RunWakeRow | null> {
  const result = await db.query<RunWakeRow>(
    `UPDATE run_wakes SET run_id = $2
     WHERE run_id = $1 AND state = 'pending'
     RETURNING ${RUN_WAKE_COLUMNS}`,
    [fromRunId, toRunId],
  );
  return result.rows[0] ?? null;
}

/** How many wake-ups fired across the chain whose first run is `rootRunId`. */
export async function countFiredRunWakes(db: Queryable, rootRunId: string): Promise<number> {
  const result = await db.query<{ fired: number }>(
    `SELECT count(*)::int AS fired FROM run_wakes WHERE root_run_id = $1 AND state = 'fired'`,
    [rootRunId],
  );
  return result.rows[0]?.fired ?? 0;
}
