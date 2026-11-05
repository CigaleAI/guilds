import {
  bindQuery,
  bindTransaction,
  type BoundQuery,
  type Queryable,
  type Transaction,
} from "../db/pg.js";
import {
  getRun,
  insertMessage,
  nextGeneration,
  nextSeq,
  reopenForWake,
  type RunRow,
} from "../db/runs.js";
import {
  cancelRunWake,
  countFiredRunWakes,
  getPendingRunWake,
  listDueRunWakes,
  markRunWakeFired,
  movePendingRunWake,
  type RunWakeRow,
} from "../db/wakes.js";
import { wakeUserMessage } from "../wakes/message.js";
import { wakeUpsLeft, WakeCancelled } from "../wakes/rules.js";
import type { ActiveGenerations } from "./active-generations.js";
import { terminalCapOf } from "./caps.js";
import { continuedBy, latestInChain } from "./chain.js";
import { ConflictError, logOperationFailure, type OperationFailure } from "./errors.js";
import type { RunEvents, RunGeneration } from "./events.js";
import type { GenerationStarter } from "./runs.js";

/** The db/ functions a wake-up fires through in one transaction, on `db`. */
function wakeFiringQueries(db: Queryable) {
  return {
    markRunWakeFired: bindQuery(db, markRunWakeFired),
    reopenForWake: bindQuery(db, reopenForWake),
    countFiredRunWakes: bindQuery(db, countFiredRunWakes),
    nextGeneration: bindQuery(db, nextGeneration),
    nextSeq: bindQuery(db, nextSeq),
    insertMessage: bindQuery(db, insertMessage),
  };
}

export type WakeFiringQueries = ReturnType<typeof wakeFiringQueries>;

/** The db/ functions the wake-ups of a loop's runs are fired and cancelled through. */
export type RunWakesDatabase = {
  getRun: BoundQuery<typeof getRun>;
  nextGeneration: BoundQuery<typeof nextGeneration>;
  listDueRunWakes: BoundQuery<typeof listDueRunWakes>;
  getPendingRunWake: BoundQuery<typeof getPendingRunWake>;
  cancelRunWake: BoundQuery<typeof cancelRunWake>;
  movePendingRunWake: BoundQuery<typeof movePendingRunWake>;
  wakeFiring: Transaction<WakeFiringQueries>;
};

/** The db/ functions the wake-ups of a loop's runs are fired and cancelled through, on `db`. */
export function runWakesDatabase(db: Queryable): RunWakesDatabase {
  return {
    getRun: bindQuery(db, getRun),
    nextGeneration: bindQuery(db, nextGeneration),
    listDueRunWakes: bindQuery(db, listDueRunWakes),
    getPendingRunWake: bindQuery(db, getPendingRunWake),
    cancelRunWake: bindQuery(db, cancelRunWake),
    movePendingRunWake: bindQuery(db, movePendingRunWake),
    wakeFiring: bindTransaction(db, wakeFiringQueries),
  };
}

/** What wake-ups are fired with, built once by the loop. */
export type RunWakesServices = {
  db: RunWakesDatabase;
  events: RunEvents;
  generations: ActiveGenerations;
  starter: GenerationStarter;
};

/**
 * Fires the wake-ups of a loop's runs: each due one whose agent is free opens the next
 * generation of its run, reopening a run that reached its conclusion. A run that ended on a cap
 * a resume cannot lift does not wake: its wake-up is cancelled and the run records why.
 */
export class RunWakes {
  constructor(private readonly services: RunWakesServices) {}

  /**
   * Fires each pending wake-up due at `now` whose agent is free. A wake-up whose agent is busy,
   * or becomes busy before its generation is admitted, stays due for the next tick; one that
   * fails to fire is logged and stays due.
   */
  async fireDueWakes(now?: Date): Promise<void> {
    const { db, generations } = this.services;
    for (const due of await db.listDueRunWakes(now ?? new Date())) {
      if (generations.isAgentBusy(due.agent_id)) {
        continue;
      }
      logOperationFailure(await this.fireOrFailure(due));
    }
  }

  /**
   * Cancels the run's pending wake-up because the run ended on `cap`, and records
   * `wake.cancelled` naming the cap on the run; nothing when the run has none pending.
   */
  async cancelForCap(turn: RunGeneration, cap: string): Promise<void> {
    const { db, events } = this.services;
    const cancelled = await db.cancelRunWake(turn.runId, "limit");
    if (cancelled !== null) {
      await events.recordError(turn, "wake.cancelled", new WakeCancelled(cancelled.id, cap));
    }
  }

  /** Fires the wake-up; returns the failure of one that did not fire, after which the tick goes on. */
  private async fireOrFailure(due: RunWakeRow): Promise<OperationFailure | null> {
    try {
      await this.fire(due);
      return null;
    } catch (error) {
      return {
        message: "wake-up failed to fire",
        fields: { run_id: due.run_id, agent_id: due.agent_id, operation: "wake.fire" },
        error,
      };
    }
  }

  /**
   * Fires the wake-up on the run it wakes: its generation admitted, its message appended, and
   * the generation started in the background. A run on a terminal cap has it cancelled instead.
   */
  private async fire(due: RunWakeRow): Promise<void> {
    const { db, starter } = this.services;
    const run = await this.wakingRun(due);
    if (run === null) {
      return;
    }
    const cap = terminalCapOf(run);
    if (cap !== null) {
      const generation = (await db.nextGeneration(run.id)) - 1;
      await this.cancelForCap(
        { runId: run.id, generation, log: { run_id: run.id, agent_id: run.agent_id } },
        cap,
      );
      return;
    }
    try {
      await starter.beginGeneration(run.id, run.agent_id);
    } catch (error) {
      if (error instanceof ConflictError) {
        return;
      }
      throw error;
    }
    let generation: number | null;
    try {
      generation = await this.appendWake(run, due.id, new Date());
    } catch (error) {
      starter.endGeneration(run.id);
      throw error;
    }
    if (generation === null) {
      starter.endGeneration(run.id);
      return;
    }
    starter.generateInBackground(run.id, generation);
  }

  /**
   * The run the wake-up wakes now: its own, or, when that run continued in another, the last run
   * of its chain, where the wake-up moves. Null when the run is gone, or when the last run already
   * has a pending wake-up of its own, which replaces this one.
   */
  private async wakingRun(due: RunWakeRow): Promise<RunRow | null> {
    const { db } = this.services;
    const run = await db.getRun(due.run_id);
    const next = run === null ? null : continuedBy(run);
    if (next === null) {
      return run;
    }
    const latest = await latestInChain(db, next);
    if ((await db.getPendingRunWake(latest)) !== null) {
      await db.cancelRunWake(due.run_id, "replaced");
      return null;
    }
    await db.movePendingRunWake(due.run_id, latest);
    return db.getRun(latest);
  }

  /**
   * In one transaction: marks the wake-up fired, reopens the run when it is completed, and
   * appends the wake-up message as the run's next generation; once committed, the message is
   * published to the run's subscribers. Returns that generation; null when the wake-up was no
   * longer pending, and nothing is appended.
   */
  private async appendWake(run: RunRow, wakeId: string, now: Date): Promise<number | null> {
    const appended = await this.services.db.wakeFiring(async (tx) => {
      const fired = await tx.markRunWakeFired(wakeId, now);
      if (fired === null) {
        return null;
      }
      const generation = await tx.nextGeneration(run.id);
      const reopened = await tx.reopenForWake(run.id, generation, now);
      const left = wakeUpsLeft(
        run.config_snapshot.max_wake_ups,
        await tx.countFiredRunWakes(fired.root_run_id),
      );
      const [payload, metadata] = wakeUserMessage(fired, left, generation, reopened);
      const message = await tx.insertMessage(
        { runId: run.id, seq: await tx.nextSeq(run.id), payload, metadata },
        now,
      );
      return { generation, message };
    });
    if (appended === null) {
      return null;
    }
    await this.services.events.publishCommitted(appended.message);
    return appended.generation;
  }
}
