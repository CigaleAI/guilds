import type { RunRow } from "../db/runs.js";
import { terminalCapOf } from "./caps.js";
import { continuedBy } from "./chain.js";

/**
 * Where a run stands. `open` takes an operator's message; `waiting` is active between
 * generations but takes none (a group or schedule run); `generating` has a generation under way;
 * `completed` ended and can be resumed; `capped` ended on a limit for good; `continued` ended by
 * handing its work to another run.
 */
export type RunStanding = "open" | "waiting" | "generating" | "completed" | "capped" | "continued";

/** Whether an operator resumed the run, which then stays open for their messages. */
export function runWasResumed(run: Pick<RunRow, "metadata">): boolean {
  return Boolean(run.metadata.resumed_at);
}

/**
 * Where the run stands, from its row and whether a generation of it is under way. An active run
 * takes messages when it is direct or resumed and has not continued elsewhere; an ended run is
 * capped when it ended on a terminal cap, continued when it handed off, and completed otherwise.
 */
export function runStanding(
  run: Pick<RunRow, "status" | "kind" | "errors" | "metadata">,
  generating: boolean,
): RunStanding {
  if (generating) {
    return "generating";
  }
  if (run.status === "active") {
    const takesMessages =
      (run.kind === "direct" || runWasResumed(run)) && continuedBy(run) === null;
    return takesMessages ? "open" : "waiting";
  }
  if (terminalCapOf(run) !== null) {
    return "capped";
  }
  return continuedBy(run) === null ? "completed" : "continued";
}
