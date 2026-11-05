import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { cancelRunWake, countFiredRunWakes, setRunWake, type RunWakeRow } from "../db/wakes.js";
import { newId } from "../lib/ids.js";
import { wakeUpsLeft } from "./rules.js";
import { WakeError } from "./validation.js";

const MINUTE_MS = 60_000;

/** The run a wake-up is set on: the run, the first run of its chain, its agent, and its snapshot's cap on wake-ups. */
export type WakingRun = { runId: string; rootRunId: string; agentId: string; maxWakeUps: number };

/** The wake-up a tool call asks for, validated: its delay, the agent's note, and the call. */
export type WakeRequest = { minutes: number; message: string | null; toolCallId: string };

/** A wake-up just set: it, the pending one it replaced, and the wake-ups the run has left once it fires. */
export type WakeSet = { wake: RunWakeRow; replaced: RunWakeRow | null; wakeUpsLeft: number };

/** The db/ functions an agent's wake-ups are set and cancelled through. */
export type WakesDatabase = {
  setRunWake: BoundQuery<typeof setRunWake>;
  cancelRunWake: BoundQuery<typeof cancelRunWake>;
  countFiredRunWakes: BoundQuery<typeof countFiredRunWakes>;
};

/** The wake-ups an agent sets on its own runs, and cancels. */
export class Wakes {
  constructor(private readonly db: WakesDatabase) {}

  /**
   * Sets the run's wake-up `request.minutes` after `now`, replacing its pending one. Refused with
   * `WakeError` when the wake-ups fired across the run's chain reached its cap.
   */
  async set(run: WakingRun, request: WakeRequest, now: Date): Promise<WakeSet> {
    const left = wakeUpsLeft(run.maxWakeUps, await this.db.countFiredRunWakes(run.rootRunId));
    if (left === 0) {
      throw new WakeError(`this run has no wake-ups left: it fired the ${run.maxWakeUps} it may`);
    }
    const set = await this.db.setRunWake(
      {
        wakeId: newId("wk"),
        runId: run.runId,
        rootRunId: run.rootRunId,
        agentId: run.agentId,
        dueAt: new Date(now.getTime() + request.minutes * MINUTE_MS),
        message: request.message,
        setToolCallId: request.toolCallId,
      },
      now,
    );
    return { wake: set.wake, replaced: set.replaced, wakeUpsLeft: left - 1 };
  }

  /** Cancels the run's pending wake-up, as its agent asks; null when it has none. */
  cancel(runId: string): Promise<RunWakeRow | null> {
    return this.db.cancelRunWake(runId, "agent");
  }
}

/** The wake-ups of the runs on `db`. */
export function agentWakes(db: Queryable): Wakes {
  return new Wakes({
    setRunWake: bindQuery(db, setRunWake),
    cancelRunWake: bindQuery(db, cancelRunWake),
    countFiredRunWakes: bindQuery(db, countFiredRunWakes),
  });
}
