import { newId } from "../lib/ids.js";
import { ScheduleError, validateInstruction, validateScheduleDescription } from "./cron.js";
import { formatScheduleRow, scheduleItem } from "./item.js";
import { planWake, rowTiming, validateTiming, type ScheduleTiming } from "./timing.js";
import type { PlannedWake } from "./window.js";
import type { ChangeActor } from "../db/config-changes.js";

export type ScheduleDatabase = {
  insertSchedule(
    scheduleId: string,
    agentId: string,
    timing: ScheduleTiming,
    description: string,
    instruction: string,
    wake: PlannedWake,
    now: Date,
    actor: ChangeActor,
    options?: { paused?: boolean },
  ): Promise<Record<string, unknown>>;
  deleteSchedule(agentId: string, scheduleId: string, actor: ChangeActor): Promise<Record<string, unknown> | null>;
  getSchedule(agentId: string, scheduleId: string): Promise<Record<string, unknown> | null>;
  setSchedulePaused(
    agentId: string,
    scheduleId: string,
    paused: boolean,
    wake: PlannedWake | null,
    now: Date,
    actor: ChangeActor,
  ): Promise<Record<string, unknown> | null>;
  listSchedules(agentId: string): Promise<Array<Record<string, unknown>>>;
  listSchedulesForGuild(guildId: string): Promise<Array<Record<string, unknown>>>;
  updateSchedule(
    agentId: string,
    scheduleId: string,
    fields: { timing: ScheduleTiming; description: string; instruction: string; paused: boolean },
    wake: PlannedWake | null,
    now: Date,
    actor: ChangeActor,
  ): Promise<Record<string, unknown> | null>;
  setScheduleNextRun(scheduleId: string, wake: PlannedWake, now: Date): Promise<void>;
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
  ): Promise<Record<string, unknown>> {
    const timing = validateTiming(when);
    const summary = validateScheduleDescription(description);
    const text = validateInstruction(instruction);
    const now = new Date();
    const scheduleId = newId("sch");
    const paused = Boolean(options.paused);
    const row = await this.db.insertSchedule(
      scheduleId,
      agentId,
      timing,
      summary,
      text,
      paused ? { at: now, windowFires: 0 } : planWake(timing, now),
      now,
      actor,
      { paused },
    );
    return row;
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

  async listForGuild(guildId: string): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    for (const row of await this.db.listSchedulesForGuild(guildId)) {
      const item = await this.view(row);
      item.agent = {
        id: row.agent_id,
        name: row.agent_name,
        avatar_shape: row.avatar_shape || "teardrop",
        avatar_color: row.avatar_color || "#7c5cff",
      };
      items.push(item);
    }
    return items;
  }

  async view(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const item = scheduleItem(row);
    item.instruction = await this.instructionFor(String(row.agent_id), row);
    item.description = rowDescription(row, String(item.instruction));
    return item;
  }

  async instructionFor(_agentId: string, row: Record<string, unknown>): Promise<string> {
    return String(row.instruction ?? "");
  }

  async delete(actor: ChangeActor, agentId: string, scheduleId: string): Promise<Record<string, unknown>> {
    const token = (scheduleId || "").trim();
    if (!token) {
      throw new ScheduleError("schedule_id is required");
    }
    const row = await this.db.deleteSchedule(agentId, token, actor);
    if (row === null) {
      throw new ScheduleError("schedule not found");
    }
    return row;
  }

  async setPaused(
    actor: ChangeActor,
    agentId: string,
    scheduleId: string,
    paused: boolean,
  ): Promise<Record<string, unknown>> {
    const token = (scheduleId || "").trim();
    if (!token) {
      throw new ScheduleError("schedule_id is required");
    }
    const row = await this.db.getSchedule(agentId, token);
    if (row === null) {
      throw new ScheduleError("schedule not found");
    }
    const now = new Date();
    const nxt = paused ? null : planWake(rowTiming(row), now);
    const updated = await this.db.setSchedulePaused(agentId, token, paused, nxt, now, actor);
    if (updated === null) {
      throw new ScheduleError("schedule not found");
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
  ): Promise<Record<string, unknown>> {
    const row = await this.db.getSchedule(agentId, (scheduleId || "").trim());
    if (row === null) {
      throw new ScheduleError("schedule not found");
    }
    const fields = changedFields(row, changes);
    const replan = !fields.paused && (changes.when !== undefined || Boolean(row.paused));
    const now = new Date();
    const updated = await this.db.updateSchedule(
      agentId,
      String(row.id),
      fields,
      replan ? planWake(fields.timing, now) : null,
      now,
      actor,
    );
    if (updated === null) {
      throw new ScheduleError("schedule not found");
    }
    return updated;
  }

  async releaseGuild(guildId: string): Promise<void> {
    const now = new Date();
    for (const row of await this.db.listSchedulesForGuild(guildId)) {
      if (row.paused) continue;
      const at = scheduleInstant(row.next_run_at);
      if (at === null || at > now.getTime()) continue;
      await this.db.setScheduleNextRun(String(row.id), planWake(rowTiming(row), now), now);
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

/** A routine's definition after `changes`, each changed field validated. */
export function changedFields(
  row: Record<string, unknown>,
  changes: ScheduleChanges,
): { timing: ScheduleTiming; description: string; instruction: string; paused: boolean } {
  return {
    timing: changes.when === undefined ? rowTiming(row) : validateTiming(changes.when),
    description:
      changes.description === undefined
        ? String(row.description ?? "")
        : validateScheduleDescription(changes.description),
    instruction:
      changes.instruction === undefined
        ? String(row.instruction ?? "")
        : validateInstruction(changes.instruction),
    paused: changes.paused === undefined ? Boolean(row.paused) : changes.paused,
  };
}

function scheduleInstant(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" && value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function rowDescription(row: Record<string, unknown>, instruction?: string | null): string {
  const raw = row.description;
  const text = String(raw ?? "").trim();
  if (text) {
    return text;
  }
  const body = instruction === undefined || instruction === null ? row.instruction : instruction;
  if (!body) {
    return "";
  }
  return String(body).split("\n")[0] ?? "";
}
