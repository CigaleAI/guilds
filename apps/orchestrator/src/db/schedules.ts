import type { InferSelectModel } from "drizzle-orm";
import type pg from "pg";
import { routineChange } from "../schedules/changes.js";
import type { ScheduleTiming } from "../schedules/timing.js";
import type { PlannedWake } from "../schedules/window.js";
import { tableColumns } from "./columns.js";
import { recordChangeIfAny, type ChangeActor } from "./config-changes.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { agents, guilds, schedules } from "./schema/index.js";

type Schedule = InferSelectModel<typeof schedules>;
type Agent = InferSelectModel<typeof agents>;

/** A routine's timing columns: a cron expression or a wake window, never both. */
export type ScheduleTimingColumns =
  | { cron: NonNullable<Schedule["cron"]>; wake_window: null }
  | { cron: null; wake_window: NonNullable<Schedule["wake_window"]> };

export type ScheduleDefinition = ScheduleTimingColumns &
  Pick<Schedule, "description" | "instruction" | "paused">;

export type ScheduleRow = Omit<Schedule, keyof ScheduleDefinition> & ScheduleDefinition;

export type AgentScheduleRow = ScheduleRow & {
  guild_routines_enabled: InferSelectModel<typeof guilds>["routines_enabled"];
};

export type GuildScheduleRow = AgentScheduleRow & {
  agent_name: Agent["name"];
  avatar_shape: Agent["avatar_shape"] | null;
  avatar_color: Agent["avatar_color"] | null;
};

export type NewSchedule = {
  scheduleId: string;
  agentId: string;
  timing: ScheduleTiming;
  description: string;
  instruction: string;
  wake: PlannedWake;
  paused?: boolean;
};

/** A routine, by its agent and its id. */
export type ScheduleKey = {
  agentId: string;
  scheduleId: string;
};

/** A routine's definition, validated. */
export type ScheduleFields = {
  timing: ScheduleTiming;
  description: string;
  instruction: string;
  paused: boolean;
};

/** A routine's new definition and its next wake-up; a null `wake` keeps the planned one. */
export type ScheduleUpdate = ScheduleFields & {
  wake: PlannedWake | null;
};

const SCHEDULE_COLUMNS = tableColumns(schedules);

/**
 * Runs `write` on one routine in a transaction, with the routine locked, and
 * logs what it changed against `actor`.
 */
async function changeSchedule(
  pool: Queryable,
  key: ScheduleKey,
  actor: ChangeActor,
  write: (client: pg.PoolClient) => Promise<ScheduleRow | null>,
): Promise<ScheduleRow | null> {
  return withTransaction(pool, async (client) => {
    const before =
      (
        await client.query<ScheduleRow>(
          `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = $1 AND agent_id = $2 FOR UPDATE`,
          [key.scheduleId, key.agentId],
        )
      ).rows[0] ?? null;
    const after = await write(client);
    await recordChangeIfAny(client, actor, before && after ? routineChange(before, after) : null);
    return after;
  });
}

export async function insertSchedule(
  pool: Queryable,
  schedule: NewSchedule,
  now: Date,
  actor: ChangeActor,
): Promise<ScheduleRow> {
  const paused = schedule.paused ?? false;
  return withTransaction(pool, async (client) => {
    const result = await client.query<ScheduleRow>(
      `INSERT INTO schedules (
         id, agent_id, cron, wake_window, description, instruction, next_run_at, window_fires,
         paused, created_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $10)
       RETURNING ${SCHEDULE_COLUMNS}`,
      [
        schedule.scheduleId,
        schedule.agentId,
        schedule.timing.cron,
        schedule.timing.window ? JSON.stringify(schedule.timing.window) : null,
        schedule.description,
        schedule.instruction,
        stamp(schedule.wake.at),
        schedule.wake.windowFires,
        paused,
        stamp(now),
      ],
    );
    const row = result.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("schedule insert failed");
    }
    await recordChangeIfAny(client, actor, routineChange(null, row));
    return row;
  });
}

export async function listSchedules(pool: Queryable, agentId: string): Promise<AgentScheduleRow[]> {
  const result = await pool.query<AgentScheduleRow>(
    `SELECT ${tableColumns(schedules, "s")},
            g.routines_enabled AS guild_routines_enabled
     FROM schedules s
     JOIN agents a ON a.id = s.agent_id
     JOIN guilds g ON g.id = a.guild_id
     WHERE s.agent_id = $1
     ORDER BY s.created_at`,
    [agentId],
  );
  return result.rows;
}

export async function listSchedulesForGuild(
  pool: Queryable,
  guildId: string,
): Promise<GuildScheduleRow[]> {
  const result = await pool.query<GuildScheduleRow>(
    `SELECT ${tableColumns(schedules, "s")},
            a.name AS agent_name, a.avatar_shape, a.avatar_color,
            g.routines_enabled AS guild_routines_enabled
     FROM schedules s
     JOIN agents a ON a.id = s.agent_id
     JOIN guilds g ON g.id = a.guild_id
     WHERE a.guild_id = $1
     ORDER BY a.created_at, s.created_at`,
    [guildId],
  );
  return result.rows;
}

export async function deleteSchedule(
  pool: Queryable,
  agentId: string,
  scheduleId: string,
  actor: ChangeActor,
): Promise<ScheduleRow | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ScheduleRow>(
      `DELETE FROM schedules WHERE id = $1 AND agent_id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [scheduleId, agentId],
    );
    const row = result.rows[0] ?? null;
    await recordChangeIfAny(client, actor, row ? routineChange(row, null) : null);
    return row;
  });
}

export async function getSchedule(
  pool: Queryable,
  agentId: string,
  scheduleId: string,
): Promise<ScheduleRow | null> {
  const result = await pool.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS}
     FROM schedules WHERE id = $1 AND agent_id = $2`,
    [scheduleId, agentId],
  );
  return result.rows[0] ?? null;
}

export async function pauseSchedule(
  pool: Queryable,
  key: ScheduleKey,
  now: Date,
  actor: ChangeActor,
): Promise<ScheduleRow | null> {
  return changeSchedule(pool, key, actor, async (client) => {
    const result = await client.query<ScheduleRow>(
      `UPDATE schedules SET paused = true, updated_at = $3
       WHERE id = $1 AND agent_id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [key.scheduleId, key.agentId, stamp(now)],
    );
    return result.rows[0] ?? null;
  });
}

/** Resumes a routine, which next wakes at `wake`. */
export async function resumeSchedule(
  pool: Queryable,
  key: ScheduleKey,
  wake: PlannedWake,
  now: Date,
  actor: ChangeActor,
): Promise<ScheduleRow | null> {
  return changeSchedule(pool, key, actor, async (client) => {
    const result = await client.query<ScheduleRow>(
      `UPDATE schedules SET paused = false, next_run_at = $3, window_fires = $4, updated_at = $5
       WHERE id = $1 AND agent_id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [key.scheduleId, key.agentId, stamp(wake.at), wake.windowFires, stamp(now)],
    );
    return result.rows[0] ?? null;
  });
}

/** Replaces a routine's definition. */
export async function updateSchedule(
  pool: Queryable,
  key: ScheduleKey,
  update: ScheduleUpdate,
  now: Date,
  actor: ChangeActor,
): Promise<ScheduleRow | null> {
  return changeSchedule(pool, key, actor, async (client) => {
    const result = await client.query<ScheduleRow>(
      `UPDATE schedules
          SET cron = $3, wake_window = $4::jsonb, description = $5, instruction = $6, paused = $7,
              next_run_at = COALESCE($8, next_run_at), window_fires = COALESCE($9, window_fires),
              updated_at = $10
        WHERE id = $1 AND agent_id = $2
        RETURNING ${SCHEDULE_COLUMNS}`,
      [
        key.scheduleId,
        key.agentId,
        update.timing.cron,
        update.timing.window ? JSON.stringify(update.timing.window) : null,
        update.description,
        update.instruction,
        update.paused,
        update.wake ? stamp(update.wake.at) : null,
        update.wake ? update.wake.windowFires : null,
        stamp(now),
      ],
    );
    return result.rows[0] ?? null;
  });
}

export async function setScheduleNextRun(
  pool: Queryable,
  scheduleId: string,
  wake: PlannedWake,
  now: Date,
): Promise<void> {
  await pool.query(
    `UPDATE schedules SET next_run_at = $2, window_fires = $3, updated_at = $4
     WHERE id = $1 AND paused = false`,
    [scheduleId, stamp(wake.at), wake.windowFires, stamp(now)],
  );
}

export async function listDueSchedules(pool: Queryable, now: Date): Promise<ScheduleRow[]> {
  const result = await pool.query<ScheduleRow>(
    `SELECT ${tableColumns(schedules, "s")}
     FROM schedules s
     JOIN agents a ON a.id = s.agent_id
     JOIN guilds g ON g.id = a.guild_id
     WHERE s.next_run_at <= $1 AND s.paused = false AND g.routines_enabled
     ORDER BY s.next_run_at`,
    [stamp(now)],
  );
  return result.rows;
}

export async function markScheduleFired(
  pool: Queryable,
  scheduleId: string,
  now: Date,
  wake: PlannedWake,
): Promise<void> {
  await pool.query(
    `UPDATE schedules SET last_run_at = $2, next_run_at = $3, window_fires = $4, updated_at = $2
     WHERE id = $1`,
    [scheduleId, stamp(now), stamp(wake.at), wake.windowFires],
  );
}
