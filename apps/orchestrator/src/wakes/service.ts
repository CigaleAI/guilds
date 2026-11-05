import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import {
  cancelRunWake,
  countFiredRunWakes,
  movePendingRunWake,
  setRunWake,
  type RunWakeCancelReason,
  type RunWakeRow,
} from "../db/wakes.js";
import { newId } from "../lib/ids.js";
import type { ToolEvents } from "../toolbox/services.js";
import { pendingWakeItem } from "./item.js";
import { wakeUpsLeft } from "./rules.js";
import { WakeError } from "./validation.js";

const MINUTE_MS = 60_000;

/** The run a wake-up is set on: the run, the first run of its chain, its agent, and its snapshot's cap on wake-ups. */
export type WakingRun = { runId: string; rootRunId: string; agentId: string; maxWakeUps: number };

/** The wake-up a tool call asks for, validated: its delay, the agent's note, and the call. */
export type WakeRequest = { minutes: number; message: string | null; toolCallId: string };

/** A wake-up just set: it, the pending one it replaced, and the wake-ups the run has left once it fires. */
export type WakeSet = { wake: RunWakeRow; replaced: RunWakeRow | null; wakeUpsLeft: number };

/** The db/ functions a run's pending wake-up is set, cancelled, and moved through. */
export type WakesDatabase = {
  setRunWake: BoundQuery<typeof setRunWake>;
  cancelRunWake: BoundQuery<typeof cancelRunWake>;
  movePendingRunWake: BoundQuery<typeof movePendingRunWake>;
  countFiredRunWakes: BoundQuery<typeof countFiredRunWakes>;
};

/** What a run's wake-ups are kept with: their database, and the runs' streams their changes are published on. */
export type WakesDependencies = { db: WakesDatabase; events: ToolEvents };

/**
 * A run's pending wake-up: set by its agent, cancelled by its agent, the operator, or the run's
 * end, moved to a continuation, and fired. Every change is published on the run's stream as
 * `run.wake.changed`, with the pending wake-up it leaves, or null.
 */
export class Wakes {
  constructor(private readonly deps: WakesDependencies) {}

  /**
   * Sets the run's wake-up `request.minutes` after `now`, replacing its pending one. Refused with
   * `WakeError` when the wake-ups fired across the run's chain reached its cap.
   */
  async set(run: WakingRun, request: WakeRequest, now: Date): Promise<WakeSet> {
    const { db } = this.deps;
    const left = wakeUpsLeft(run.maxWakeUps, await db.countFiredRunWakes(run.rootRunId));
    if (left === 0) {
      throw new WakeError(`this run has no wake-ups left: it fired the ${run.maxWakeUps} it may`);
    }
    const set = await db.setRunWake(
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
    await this.publishPending(run.runId, set.wake);
    return { wake: set.wake, replaced: set.replaced, wakeUpsLeft: left - 1 };
  }

  /** Cancels the run's pending wake-up for `reason`; null when it has none, and nothing is published. */
  async cancel(runId: string, reason: RunWakeCancelReason): Promise<RunWakeRow | null> {
    const cancelled = await this.deps.db.cancelRunWake(runId, reason);
    if (cancelled !== null) {
      await this.publishPending(runId, null);
    }
    return cancelled;
  }

  /** Moves the pending wake-up of `fromRunId` to `toRunId`, the run that continues it; null when there is none. */
  async move(fromRunId: string, toRunId: string): Promise<RunWakeRow | null> {
    const moved = await this.deps.db.movePendingRunWake(fromRunId, toRunId);
    if (moved !== null) {
      await this.publishPending(fromRunId, null);
      await this.publishPending(toRunId, moved);
    }
    return moved;
  }

  /** Tells the run's subscribers its wake-up fired, once the firing committed: it has none pending. */
  async announceFired(runId: string): Promise<void> {
    await this.publishPending(runId, null);
  }

  /** Publishes `run.wake.changed` on the run's stream, with the pending wake-up the change left. */
  private async publishPending(runId: string, pending: RunWakeRow | null): Promise<void> {
    await this.deps.events.publish(runId, "run.wake.changed", {
      pending_wake: pending === null ? null : pendingWakeItem(pending),
    });
  }
}

/** The wake-ups of the runs on `db`, their changes published on `events`. */
export function agentWakes(db: Queryable, events: ToolEvents): Wakes {
  return new Wakes({
    db: {
      setRunWake: bindQuery(db, setRunWake),
      cancelRunWake: bindQuery(db, cancelRunWake),
      movePendingRunWake: bindQuery(db, movePendingRunWake),
      countFiredRunWakes: bindQuery(db, countFiredRunWakes),
    },
    events,
  });
}
