import type { BoundQuery } from "../db/pg.js";
import type { completeRun, getRun, RunRow } from "../db/runs.js";
import { terminalCapOf } from "./caps.js";

/**
 * Where a run stands. `open` takes an operator's message; `waiting` is active between
 * generations but takes none (a group or schedule run); `generating` has a generation under way;
 * `completed` ended and can be resumed; `capped` ended on a limit for good.
 */
export type RunStanding = "open" | "waiting" | "generating" | "completed" | "capped";

/** Whether an operator resumed the run, which then stays open for their messages. */
export function runWasResumed(run: Pick<RunRow, "metadata">): boolean {
  return Boolean(run.metadata.resumed_at);
}

/**
 * Where the run stands, from its row and whether a generation of it is under way. An active run
 * takes messages when it is direct or resumed; an ended run is capped when it ended on a terminal
 * cap, and completed otherwise.
 */
export function runStanding(
  run: Pick<RunRow, "status" | "kind" | "errors" | "metadata">,
  generating: boolean,
): RunStanding {
  if (generating) {
    return "generating";
  }
  if (run.status === "active") {
    return run.kind === "direct" || runWasResumed(run) ? "open" : "waiting";
  }
  return terminalCapOf(run) === null ? "completed" : "capped";
}

/** The db/ functions a run is completed through. */
export type RunCompletionDatabase = {
  getRun: BoundQuery<typeof getRun>;
  completeRun: BoundQuery<typeof completeRun>;
};

/** Completes the run unless it already ended. */
export async function completeIfActive(db: RunCompletionDatabase, runId: string): Promise<void> {
  const run = await db.getRun(runId);
  if (run !== null && run.status === "active") {
    await db.completeRun(runId, new Date());
  }
}
