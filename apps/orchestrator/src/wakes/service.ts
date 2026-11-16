import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import {
  cancelRunWake,
  countFiredRunWakes,
  setRunWake,
  type RunWakeCancelReason,
  type RunWakeRow,
} from "../db/wakes.js";
import { newId } from "../lib/ids.js";
import { pendingWakeItem, type RunWakeChange } from "./item.js";
import { wakeUpsLeft } from "./rules.js";
import { WakeError } from "./validation.js";

const MINUTE_MS = 60_000;

/** The run a wake-up is set on: the run, its agent, and its snapshot's cap on wake-ups. */
export type WakingRun = { runId: string; agentId: string; maxWakeUps: number };

/** The wake-up a tool call asks for, validated: its delay, the agent's note, and the call. */
export type WakeRequest = { minutes: number; message: string | null; toolCallId: string };

/** A wake-up just set: it, the pending one it replaced, and the wake-ups the run has left once it fires. */
export type WakeSet = { wake: RunWakeRow; replaced: RunWakeRow | null; wakeUpsLeft: number };

/** The db/ functions a run's pending wake-up is set and cancelled through. */
export type WakesDatabase = {
  setRunWake: BoundQuery<typeof setRunWake>;
  cancelRunWake: BoundQuery<typeof cancelRunWake>;
  countFiredRunWakes: BoundQuery<typeof countFiredRunWakes>;
};

/** The stream a run's subscribers read, which each change of its pending wake-up is published on. */
export type WakeEvents = {
  publish(runId: string, event: "run.wake.changed", data: RunWakeChange): Promise<void>;
};

/** What a run's wake-ups are kept with: their database, and the runs' streams their changes are published on. */
export type WakesDependencies = { db: WakesDatabase; events: WakeEvents };

/**
 * A run's pending wake-up: set by its agent, cancelled by its agent, the operator, or the run's
 * end, and fired. Every change is published on the run's stream as
 * `run.wake.changed`, with the pending wake-up it leaves, or null.
 */
export class Wakes {
  constructor(private readonly deps: WakesDependencies) {}

  /**
   * Sets the run's wake-up `request.minutes` after `now`, replacing its pending one. Refused with
   * `WakeError` when the run's fired wake-ups reached its cap.
   */
  async set(run: WakingRun, request: WakeRequest, now: Date): Promise<WakeSet> {
    const { db } = this.deps;
    const left = wakeUpsLeft(run.maxWakeUps, await db.countFiredRunWakes(run.runId));
    if (left === 0) {
      throw new WakeError(`this run has no wake-ups left: it fired the ${run.maxWakeUps} it may`);
    }
    const set = await db.setRunWake(
      {
        wakeId: newId("wk"),
        runId: run.runId,
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
export function agentWakes(db: Queryable, events: WakeEvents): Wakes {
  return new Wakes({
    db: {
      setRunWake: bindQuery(db, setRunWake),
      cancelRunWake: bindQuery(db, cancelRunWake),
      countFiredRunWakes: bindQuery(db, countFiredRunWakes),
    },
    events,
  });
}
