import type { AgentScheduleRow, ScheduleDefinition, ScheduleRow } from "../db/schedules.js";
import { iso, isoOrNull } from "../db/views.js";
import { promptHash } from "../prompts/index.js";
import { describeTiming, rowTiming, type ScheduleTiming } from "./timing.js";

/** A routine as the API and the tools show it. */
export type ScheduleItem = ScheduleTiming & {
  id: string;
  agent_id: string;
  label: string;
  description: string;
  instruction: string;
  instruction_hash: string;
  paused: boolean;
  guild_routines_enabled?: boolean;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The metadata of the user message a routine's wake-up opens its run with. */
export type ScheduleWakeMetadata = {
  generation: number;
  source: "schedule";
  schedule_id: string;
  instruction_hash: string;
};

function rowDescription(row: ScheduleDefinition, instruction?: string | null): string {
  const text = row.description.trim();
  if (text) {
    return text;
  }
  const body = instruction === undefined || instruction === null ? row.instruction : instruction;
  if (!body) {
    return "";
  }
  return body.split("\n")[0] ?? "";
}

export function instructionHash(instruction: string): string {
  return promptHash(instruction);
}

/** The cron expression and its label, or the window label alone. */
export function timingText(timing: ScheduleTiming): string {
  return timing.cron ? `${timing.cron}  ${describeTiming(timing)}` : describeTiming(timing);
}

export function scheduleItem(row: ScheduleRow | AgentScheduleRow): ScheduleItem {
  const timing = rowTiming(row);
  return {
    id: row.id,
    agent_id: row.agent_id,
    ...timing,
    label: describeTiming(timing),
    description: rowDescription(row),
    instruction: row.instruction,
    instruction_hash: instructionHash(row.instruction),
    paused: row.paused,
    ...("guild_routines_enabled" in row
      ? { guild_routines_enabled: row.guild_routines_enabled !== false }
      : {}),
    next_run_at: iso(row.next_run_at),
    last_run_at: isoOrNull(row.last_run_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function scheduleWakeUserMessage(row: {
  id: string;
  timing: ScheduleTiming;
  instruction: string;
  previousRunAt: string | null;
}): [{ role: string; content: string }, ScheduleWakeMetadata] {
  const info = {
    id: row.id,
    ...(row.timing.cron ? { cron: row.timing.cron } : { window: row.timing.window }),
    instruction: row.instruction,
    previous_run_at: row.previousRunAt,
  };
  return [
    {
      role: "user",
      content: `Schedule wake-up: ${JSON.stringify(info, null, 2)}`,
    },
    {
      generation: 1,
      source: "schedule",
      schedule_id: row.id,
      instruction_hash: instructionHash(row.instruction),
    },
  ];
}

export function formatScheduleStamp(value: string): string {
  return value.replace("+00:00", "Z");
}

export function formatScheduleRow(row: ScheduleRow, instruction?: string | null): string {
  const stamp = formatScheduleStamp(row.next_run_at);
  const status = row.paused ? "paused" : `next ${stamp}`;
  const summary = rowDescription(row, instruction);
  return (
    `${row.id}  ${timingText(rowTiming(row))}  ${status}\n` +
    `${summary}`
  );
}

export { rowDescription };
