import type { ConfigChange, ConfigOperation } from "../db/config-changes.js";
import type { ScheduleRow } from "../db/schedules.js";
import { rowTiming } from "./timing.js";

// The fields a routine's change log names, each read so two rows compare.
const ROUTINE_FIELDS: Array<[string, (row: ScheduleRow) => string]> = [
  ["timing", (row) => JSON.stringify(rowTiming(row))],
  ["description", (row) => row.description],
  ["instruction", (row) => row.instruction],
];

function routineLabel(row: ScheduleRow): string {
  return `"${row.description.trim() || row.id}"`;
}

function joinWords(words: string[]): string {
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
    : (words[0] ?? "");
}

function changedFieldNames(before: ScheduleRow, after: ScheduleRow): string[] {
  return ROUTINE_FIELDS.filter(([, read]) => read(before) !== read(after)).map(([name]) => name);
}

function pauseVerb(before: ScheduleRow, after: ScheduleRow): string | null {
  if (before.paused === after.paused) {
    return null;
  }
  return after.paused ? "paused" : "resumed";
}

function fieldsVerb(before: ScheduleRow, after: ScheduleRow): string | null {
  const fields = changedFieldNames(before, after);
  return fields.length ? `changed the ${joinWords(fields)} of` : null;
}

/** What an edit did to a routine, in words; null when it changed nothing. */
export function routineUpdateSummary(before: ScheduleRow, after: ScheduleRow): string | null {
  const verbs = [pauseVerb(before, after), fieldsVerb(before, after)].filter(
    (verb): verb is string => verb !== null,
  );
  if (!verbs.length) {
    return null;
  }
  const text = `${verbs.join(" and ")} ${routineLabel(after)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function routineOperation(before: ScheduleRow | null, after: ScheduleRow | null): ConfigOperation {
  if (!before) {
    return "create";
  }
  return after ? "update" : "delete";
}

function routineSummary(before: ScheduleRow | null, after: ScheduleRow | null): string | null {
  if (before && after) {
    return routineUpdateSummary(before, after);
  }
  if (after) {
    return `Created ${routineLabel(after)}`;
  }
  return before ? `Deleted ${routineLabel(before)}` : null;
}

/**
 * The change-log entry for a routine going from `before` to `after`: no
 * `before` is a create, no `after` a delete. Null when nothing changed.
 */
export function routineChange(
  before: ScheduleRow | null,
  after: ScheduleRow | null,
): ConfigChange | null {
  const row = after ?? before;
  const summary = routineSummary(before, after);
  if (!row || !summary) {
    return null;
  }
  return {
    targetKind: "routine",
    targetId: row.id,
    agentId: row.agent_id,
    operation: routineOperation(before, after),
    summary,
  };
}
