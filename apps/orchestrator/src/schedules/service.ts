import { newId } from "../lib/ids.js";
import { ScheduleError, validateInstruction, validateScheduleDescription } from "./cron.js";
import { routineChange } from "./changes.js";
import { formatScheduleRow, rowDescription, scheduleItem, type ScheduleItem } from "./item.js";
import { planWake, rowTiming, validateTiming } from "./timing.js";
import type { ChangeActor } from "../lib/change-actor.js";
import { recordChangeIfAny } from "../db/config-changes.js";
import type {
  ScheduleDefinition,
  ScheduleFields,
  ScheduleKey,
  ScheduleRow,
} from "../db/schedules.js";
import {
  deleteSchedule,
  getSchedule,
  insertSchedule,
  listSchedules,
  listSchedulesForGuild,
  lockSchedule,
  pauseSchedule,
  resumeSchedule,
  setScheduleNextRun,
  updateSchedule,
} from "../db/schedules.js";
import { bindQuery, bindTransaction, type Queryable, type Transaction } from "../db/pg.js";

/** The db/ functions routines are read and written through, on `db`. */
export function scheduleQueries(db: Queryable) {
  return {
    insertSchedule: bindQuery(db, insertSchedule),
    deleteSchedule: bindQuery(db, deleteSchedule),
    getSchedule: bindQuery(db, getSchedule),
    lockSchedule: bindQuery(db, lockSchedule),
    pauseSchedule: bindQuery(db, pauseSchedule),
    resumeSchedule: bindQuery(db, resumeSchedule),
    listSchedules: bindQuery(db, listSchedules),
    listSchedulesForGuild: bindQuery(db, listSchedulesForGuild),
    updateSchedule: bindQuery(db, updateSchedule),
    setScheduleNextRun: bindQuery(db, setScheduleNextRun),
    recordChangeIfAny: bindQuery(db, recordChangeIfAny),
  };
}

export type ScheduleQueries = ReturnType<typeof scheduleQueries>;

export type ScheduleDatabase = ScheduleQueries & { scheduleTransaction: Transaction<ScheduleQueries> };

/** The routines' queries on `db`, and a transaction that runs them on one client. */
export function scheduleDatabase(db: Queryable): ScheduleDatabase {
  return { ...scheduleQueries(db), scheduleTransaction: bindTransaction(db, scheduleQueries) };
}

/** A routine of a guild's listing, with the agent it wakes. */
export type GuildScheduleItem = ScheduleItem & {
  agent: { id: string; name: string; avatar_shape: string; avatar_color: string };
};

/**
 * Routines of agents. Every write takes the actor it is logged against in the
 * routine's change log.
 */
export class Schedules {
  constructor(public db: ScheduleDatabase) {}

  async create(
    actor: ChangeActor,
    agentId: string,
    when: { cron?: unknown; window?: unknown },
    description: unknown,
    instruction: unknown,
    options: { paused?: boolean } = {},
  ): Promise<ScheduleRow> {
    const timing = validateTiming(when);
    const summary = validateScheduleDescription(description);
    const text = validateInstruction(instruction);
    const now = new Date();
    const scheduleId = newId("sch");
    const paused = Boolean(options.paused);
    return this.db.scheduleTransaction(async (tx) => {
      const row = await tx.insertSchedule(
        {
          scheduleId,
          agentId,
          timing,
          description: summary,
          instruction: text,
          wake: paused ? { at: now, windowFires: 0 } : planWake(timing, now),
          paused,
        },
        now,
      );
      await tx.recordChangeIfAny(actor, routineChange(null, row));
      return row;
    });
  }

  async listForAgent(agentId: string): Promise<string> {
    const rows = await this.db.listSchedules(agentId);
    if (!rows.length) {
      return "no schedules";
    }
    const lines: string[] = [];
    for (const row of rows) {
      lines.push(formatScheduleRow(row, await this.instructionFor(agentId, row)));
    }
    return lines.join("\n\n");
  }

  async listForGuild(guildId: string): Promise<GuildScheduleItem[]> {
    const items: GuildScheduleItem[] = [];
    for (const row of await this.db.listSchedulesForGuild(guildId)) {
      const item = await this.view(row);
      items.push({
        ...item,
        agent: {
          id: row.agent_id,
          name: row.agent_name,
          avatar_shape: row.avatar_shape || "teardrop",
          avatar_color: row.avatar_color || "#7c5cff",
        },
      });
    }
    return items;
  }

  async viewsForAgent(agentId: string): Promise<ScheduleItem[]> {
    const items: ScheduleItem[] = [];
    for (const row of await this.db.listSchedules(agentId)) {
      items.push(await this.view(row));
    }
    return items;
  }

  async view(row: ScheduleRow): Promise<ScheduleItem> {
    const item = scheduleItem(row);
    const instruction = await this.instructionFor(row.agent_id, row);
    item.instruction = instruction;
    item.description = rowDescription(row, instruction);
    return item;
  }

  async instructionFor(_agentId: string, row: ScheduleDefinition): Promise<string> {
    return row.instruction;
  }

  async delete(actor: ChangeActor, agentId: string, scheduleId: string): Promise<ScheduleRow> {
    const token = (scheduleId || "").trim();
    if (!token) {
      throw new ScheduleError("schedule_id is required");
    }
    const row = await this.db.scheduleTransaction(async (tx) => {
      const deleted = await tx.deleteSchedule(agentId, token);
      await tx.recordChangeIfAny(actor, deleted ? routineChange(deleted, null) : null);
      return deleted;
    });
    if (row === null) {
      throw new ScheduleError("schedule not found", 404);
    }
    return row;
  }

  async setPaused(
    actor: ChangeActor,
    agentId: string,
    scheduleId: string,
    paused: boolean,
  ): Promise<ScheduleRow> {
    const token = (scheduleId || "").trim();
    if (!token) {
      throw new ScheduleError("schedule_id is required");
    }
    const row = await this.db.getSchedule(agentId, token);
    if (row === null) {
      throw new ScheduleError("schedule not found", 404);
    }
    const now = new Date();
    const key = { agentId, scheduleId: token };
    const updated = await this.changeSchedule(key, actor, (tx) =>
      paused ? tx.pauseSchedule(key, now) : tx.resumeSchedule(key, planWake(rowTiming(row), now), now),
    );
    if (updated === null) {
      throw new ScheduleError("schedule not found", 404);
    }
    return updated;
  }

  /**
   * Changes a routine's timing, description, instruction, or paused state;
   * a field left out keeps its value. A new timing, or a resume, plans the
   * next wake-up from now; otherwise the planned one stays.
   */
  async update(
    actor: ChangeActor,
    agentId: string,
    scheduleId: string,
    changes: ScheduleChanges,
  ): Promise<ScheduleRow> {
    const row = await this.db.getSchedule(agentId, (scheduleId || "").trim());
    if (row === null) {
      throw new ScheduleError("schedule not found", 404);
    }
    const fields = changedFields(row, changes);
    const replan = !fields.paused && (changes.when !== undefined || row.paused);
    const now = new Date();
    const key = { agentId, scheduleId: row.id };
    const updated = await this.changeSchedule(key, actor, (tx) =>
      tx.updateSchedule(key, { ...fields, wake: replan ? planWake(fields.timing, now) : null }, now),
    );
    if (updated === null) {
      throw new ScheduleError("schedule not found", 404);
    }
    return updated;
  }

  /** Runs `write` on one routine, locked, and logs what it changed against `actor`. */
  private changeSchedule(
    key: ScheduleKey,
    actor: ChangeActor,
    write: (tx: ScheduleQueries) => Promise<ScheduleRow | null>,
  ): Promise<ScheduleRow | null> {
    return this.db.scheduleTransaction(async (tx) => {
      const before = await tx.lockSchedule(key);
      const after = await write(tx);
      await tx.recordChangeIfAny(actor, before && after ? routineChange(before, after) : null);
      return after;
    });
  }

  async releaseGuild(guildId: string): Promise<void> {
    const now = new Date();
    for (const row of await this.db.listSchedulesForGuild(guildId)) {
      if (row.paused) continue;
      const at = scheduleInstant(row.next_run_at);
      if (at === null || at > now.getTime()) continue;
      await this.db.setScheduleNextRun(row.id, planWake(rowTiming(row), now), now);
    }
  }
}

/** What an update may change; a key left out keeps the routine's value. */
export type ScheduleChanges = {
  when?: { cron?: unknown; window?: unknown };
  description?: unknown;
  instruction?: unknown;
  paused?: boolean;
};

/**
 * The changes a request or tool call names: `cron` or `window` for a new
 * timing, `description`, `instruction`, and a boolean `paused`. A key it
 * leaves out is left out of the changes.
 */
export function scheduleChanges(input: Record<string, unknown>): ScheduleChanges {
  const timed = input.cron !== undefined || input.window !== undefined;
  return {
    ...(timed ? { when: { cron: input.cron, window: input.window } } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(typeof input.paused === "boolean" ? { paused: input.paused } : {}),
  };
}

/**
 * A routine's definition after `changes`, each changed field validated. A field
 * `changes` leaves out keeps `before`'s value; with no `before`, the routine is
 * new, so its timing, description, and instruction are required and it starts
 * unpaused unless `changes` pauses it.
 */
export function changedFields(
  before: ScheduleDefinition | null,
  changes: ScheduleChanges,
): ScheduleFields {
  return {
    timing:
      changes.when === undefined && before
        ? rowTiming(before)
        : validateTiming(changes.when ?? {}),
    description:
      changes.description === undefined && before
        ? before.description
        : validateScheduleDescription(changes.description),
    instruction:
      changes.instruction === undefined && before
        ? before.instruction
        : validateInstruction(changes.instruction),
    paused: changes.paused ?? before?.paused ?? false,
  };
}

function scheduleInstant(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
