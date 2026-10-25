import { isoOrNull } from "../db/views.js";
import { promptHash } from "../prompts/index.js";
import { describeTiming, rowTiming, type ScheduleTiming } from "./timing.js";

function rowDescription(
  row: Record<string, unknown>,
  instruction?: string | null,
): string {
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

export function instructionHash(instruction: string): string {
  return promptHash(instruction);
}

/** The cron expression and its label, or the window label alone. */
export function timingText(timing: ScheduleTiming): string {
  return timing.cron ? `${timing.cron}  ${describeTiming(timing)}` : describeTiming(timing);
}

export function scheduleItem(row: Record<string, unknown>): Record<string, unknown> {
  const timing = rowTiming(row);
  const instruction = String(row.instruction ?? "");
  return {
    id: row.id,
    agent_id: row.agent_id,
    cron: timing.cron,
    window: timing.window,
    label: describeTiming(timing),
    description: rowDescription(row),
    instruction: row.instruction,
    instruction_hash: instructionHash(instruction),
    paused: Boolean(row.paused),
    ...("guild_routines_enabled" in row
      ? { guild_routines_enabled: row.guild_routines_enabled !== false }
      : {}),
    next_run_at: isoOrNull(row.next_run_at),
    last_run_at: isoOrNull(row.last_run_at),
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
  };
}

export function scheduleWakeUserMessage(row: {
  id: string;
  timing: ScheduleTiming;
  instruction: string;
  previousRunAt: string | null;
}): [{ role: string; content: string }, Record<string, unknown>] {
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

export function formatScheduleStamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().replace("+00:00", "Z");
  }
  if (typeof value === "string") {
    return value.replace("+00:00", "Z");
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  return String(value);
}

export function formatScheduleRow(
  row: Record<string, unknown>,
  instruction?: string | null,
): string {
  const stamp = formatScheduleStamp(row.next_run_at);
  const status = row.paused ? "paused" : `next ${stamp}`;
  const summary = rowDescription(row, instruction);
  return (
    `${row.id}  ${timingText(rowTiming(row))}  ${status}\n` +
    `${summary}`
  );
}

export { rowDescription };
