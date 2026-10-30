import type {
  ActivityToolCall,
  ActivityWake,
  ActivityWrite,
  ActivityWriteKind,
} from "../../../api/types/studio";
import { isRecord } from "../../../api/wire";

/** Tools whose calls a step shows as side effects rather than as plain tool calls. */
const EFFECT_TOOLS = new Set([
  "group_post",
  "memory_write",
  "record_add",
  "record_update",
  "note_write",
  "script_create",
  "script_run",
  "report_issue",
]);

/** Writes to one target: how many, by operation, the record ids touched, and the first write. */
export type WriteGroup = {
  kind: ActivityWriteKind;
  target: string;
  count: number;
  operations: Record<string, number>;
  ids: string[];
  first: ActivityWrite;
};

/** The record id at the end of a record's display path; null when the last part is not numeric. */
export function recordIdFromPath(displayPath: string | null | undefined): string | null {
  const last = (displayPath || "").split("/").pop() ?? "";
  return /^\d+$/.test(last) ? last : null;
}

/** Writes grouped by what they touched, in first-write order, with record ids and the first write. */
export function groupWrites(writes: readonly ActivityWrite[] | null | undefined): WriteGroup[] {
  const groups = new Map<string, WriteGroup>();
  for (const write of writes ?? []) {
    const key = `${write.kind}:${write.target}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: write.kind,
        target: write.target,
        count: 0,
        operations: {},
        ids: [],
        first: write,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.operations[write.operation] = (group.operations[write.operation] ?? 0) + 1;
    const id = write.kind === "record" ? recordIdFromPath(write.display_path) : null;
    if (id && !group.ids.includes(id)) group.ids.push(id);
  }
  return [...groups.values()];
}

/** A value and how often it came up, most frequent first. */
export type Tally = { value: string; count: number };

export function tally(values: readonly string[]): Tally[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count);
}

function argument(args: string, key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(args);
    const value = isRecord(parsed) ? parsed[key] : null;
    return typeof value === "string" ? value : null;
  } catch {
    return new RegExp(`"${key}"\\s*:\\s*"([^"]*)`).exec(args)?.[1] ?? null;
  }
}

/**
 * What a wake did, split the way a step shows it: tool calls other than posts, writes, script runs
 * and issue reports; the scripts it ran; the issues it reported; the calls that failed; its writes
 * by record, note and script; and whether it updated its memory.
 */
export type WakeEffects = {
  calls: ActivityToolCall[];
  scriptRuns: Tally[];
  issues: string[];
  failedCalls: ActivityToolCall[];
  records: WriteGroup[];
  notes: WriteGroup[];
  scripts: WriteGroup[];
  /** Repositories a coding wake changed, each with its diffstat. */
  code: ActivityWrite[];
  memory: boolean;
};

export function wakeEffects(wake: ActivityWake): WakeEffects {
  const writes = groupWrites(wake.writes);
  return {
    calls: wake.tool_calls.filter((call) => !EFFECT_TOOLS.has(call.name)),
    scriptRuns: tally(
      wake.tool_calls
        .filter((call) => call.name === "script_run")
        .map((call) => argument(call.arguments, "name") ?? "a script"),
    ),
    issues: wake.tool_calls
      .filter((call) => call.name === "report_issue")
      .map((call) => argument(call.arguments, "detail") ?? call.arguments),
    failedCalls: wake.tool_calls.filter((call) => call.error !== null),
    records: writes.filter((group) => group.kind === "record"),
    notes: writes.filter((group) => group.kind === "note"),
    scripts: writes.filter((group) => group.kind === "script"),
    code: wake.writes.filter((write) => write.kind === "code"),
    memory: writes.some((group) => group.kind === "memory"),
  };
}
