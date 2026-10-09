import type { Run, RunKind, Schedule } from "../../api/types";
import type { StatusBadgeStatus } from "@guildsrun/ui";
export const runKindLabel: Record<RunKind, string> = {
  direct: "Direct session",
  group: "Group chat",
  schedule: "Routine wake-up",
};

/** A run's name in lists: routine runs take their routine's description while it exists. */
export function runTitle(run: Run, schedules?: readonly Schedule[]): string {
  if (run.kind !== "schedule") return runKindLabel[run.kind];
  return (
    schedules?.find((schedule) => schedule.id === run.schedule_id)?.description ||
    runKindLabel.schedule
  );
}

/** Run errors that stop a run for good: it cannot be resumed, only replaced by a new one. */
export function runIsCapped(run: Run): boolean {
  return run.errors.some(
    (error) =>
      error.operation === "generation.max_tool_calls" ||
      error.operation === "generation.max_input_tokens" ||
      error.operation === "generation.max_chain",
  );
}

export type RunState = {
  status: StatusBadgeStatus;
  label: string;
  /** The error that ended the run. */
  detail?: string;
};

/**
 * Where a run stands. An open run takes more messages whatever failed before; an ended run is
 * judged by the last error it recorded.
 */
export function runState(run: Run): RunState {
  if (run.generating) return { status: "running", label: "Generating" };
  if (run.archived_at) return { status: "idle", label: "Archived" };
  if (run.status === "active") return { status: "queued", label: "Open" };
  const last = run.errors.at(-1);
  if (!last) return { status: "ok", label: "Completed" };
  const detail = last.message || last.operation;
  if (last.operation === "generation.cancelled")
    return { status: "idle", label: "Cancelled", detail };
  if (last.operation.startsWith("generation.max_"))
    return { status: "warning", label: "Hit a limit", detail };
  return { status: "failed", label: "Failed", detail };
}
