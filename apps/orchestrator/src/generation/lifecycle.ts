import type { RunRow } from "../db/runs.js";

/** Whether an operator resumed the run, which then stays open for their messages. */
export function runWasResumed(run: Pick<RunRow, "metadata">): boolean {
  return Boolean(run.metadata.resumed_at);
}
