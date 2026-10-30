import type { AttachmentRef } from "../attachments/index.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import {
  completeGroupDelivery,
  createGroupRun,
  createRun,
  createScheduleRun,
  getRun,
  type RunRow,
} from "../db/runs.js";
import type { RunMetadata } from "../db/schema/index.js";
import { listDueSchedules, markScheduleFired, type ScheduleRow } from "../db/schedules.js";
import { iso, runItem } from "../db/views.js";
import { DeliveryBusyError, DeliveryCreateError, type GroupDelivery } from "../groupchat/delivery.js";
import { groupChatUserMessage, wakeMessage } from "../groupchat/wake.js";
import { newId } from "../lib/ids.js";
import { sleep } from "../lib/event.js";
import { errorName, writeLog } from "../observability/log.js";
import { instructionHash, scheduleWakeUserMessage } from "../schedules/item.js";
import type { Schedules } from "../schedules/service.js";
import { planAfterFire, rowTiming } from "../schedules/timing.js";
import type { ActiveGenerations } from "./active-generations.js";
import { continuationMessage, type ChainPosition } from "./chain.js";
import { ConflictError, RunRequestError } from "./errors.js";
import type { RunPreparation } from "./prepare.js";
import {
  preparedPromptHashes,
  preparedRunMetadata,
  preparedSnapshot,
  type PreparedRun,
} from "./snapshot.js";

/** The db/ functions runs are created and delivered through, on `db`. */
export function runsDatabase(db: Queryable) {
  return {
    getRun: bindQuery(db, getRun),
    createRun: bindQuery(db, createRun),
    createGroupRun: bindQuery(db, createGroupRun),
    createScheduleRun: bindQuery(db, createScheduleRun),
    completeGroupDelivery: bindQuery(db, completeGroupDelivery),
    listDueSchedules: bindQuery(db, listDueSchedules),
    markScheduleFired: bindQuery(db, markScheduleFired),
  };
}

export type RunsDatabase = ReturnType<typeof runsDatabase>;

/** How a created run starts generating: the loop admits it, ends it, and generates it. */
export type GenerationStarter = {
  beginGeneration(runId: string, agentId: string): Promise<void>;
  endGeneration(runId: string): void;
  generateInBackground(runId: string, generation: number): void;
};

/** What runs are created with, built once by the loop. */
export type RunsServices = {
  db: RunsDatabase;
  preparation: RunPreparation;
  generations: ActiveGenerations;
  schedules: Schedules;
  starter: GenerationStarter;
};

/**
 * Creates the runs of a loop's agents: those an operator opens, those the group chat delivers,
 * those a schedule wakes, and the continuation of a run that handed off. A run created with a
 * message starts generating at once; the scheduler wakes the due schedules each tick.
 */
export class Runs {
  private readonly db: RunsDatabase;
  private readonly preparation: RunPreparation;
  private readonly generations: ActiveGenerations;
  private readonly schedules: Schedules;
  private readonly starter: GenerationStarter;
  private scheduler: { abort: AbortController; task: Promise<void> } | null = null;

  constructor(
    services: RunsServices,
    private readonly schedulerTickMs: number,
  ) {
    this.db = services.db;
    this.preparation = services.preparation;
    this.generations = services.generations;
    this.schedules = services.schedules;
    this.starter = services.starter;
  }

  /**
   * Opens a direct run, started by `startedByUserId` when a person opened it. A run with a
   * message or images starts generating; one with neither waits for its first message.
   */
  async createRun(
    agentId: string,
    message: string | null,
    attachments: AttachmentRef[] = [],
    startedByUserId: string | null = null,
  ): Promise<Record<string, unknown>> {
    const opening = message === null && attachments.length ? "" : message;
    const prepared = await this.preparation.prepare(agentId, null);
    if (opening !== null && this.generations.isAgentBusy(agentId)) {
      throw new RunRequestError(409, "agent is already generating");
    }
    const runId = newId("r");
    const runMetadata = preparedRunMetadata(prepared);
    const create = () =>
      this.db.createRun(
        {
          runId,
          agentId,
          configSnapshot: preparedSnapshot(prepared, "direct"),
          systemContent: prepared.system,
          taskContent: prepared.task,
          userContent: opening,
          ...preparedPromptHashes(prepared),
          startedByUserId,
          ...(runMetadata ? { runMetadata } : {}),
          ...(attachments.length ? { userMetadata: { attachments } } : {}),
        },
        new Date(),
      );
    if (opening === null) {
      await create();
    } else {
      try {
        await this.startCreated(runId, agentId, create);
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new RunRequestError(409, error.message);
        }
        throw error;
      }
    }
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return runItem(row, this.generations.isGenerating(row.id));
  }

  /** Creates the group run a delivery asks for, waits for its generation, and completes the delivery. */
  async deliverGroupRun(delivery: GroupDelivery): Promise<void> {
    const { agentId, throughSeq, deliveredThrough, recipients } = delivery;
    const prepared = await this.preparedDelivery(agentId, throughSeq);
    const projected = [
      groupChatUserMessage({
        members: prepared.members,
        rows: prepared.historyRows,
        viewerName: prepared.agent.name,
        deliveredThrough,
      }),
    ];
    const runId = newId("r");
    const runMetadata = preparedRunMetadata(prepared, recipients ? { recipients } : null);
    const woke = wakeMessage(prepared.historyRows, agentId, deliveredThrough);
    await this.startDelivery(runId, agentId, () =>
      this.db.createGroupRun(
        {
          runId,
          agentId,
          configSnapshot: preparedSnapshot(prepared, "group"),
          systemContent: prepared.system,
          taskContent: prepared.task,
          projected,
          throughSeq,
          ...preparedPromptHashes(prepared),
          wakeGroupMessageId: woke ? Number(woke.id) : null,
          ...(runMetadata ? { runMetadata } : {}),
        },
        new Date(),
      ),
    );
    await this.generations.task(runId);
    await this.db.completeGroupDelivery(
      { id: runId, agent_id: agentId, group_chat_through_seq: throughSeq },
      new Date(),
    );
  }

  /** Creates and starts the run a due schedule wakes its agent with. */
  async deliverScheduleRun(schedule: ScheduleRow): Promise<void> {
    const agentId = schedule.agent_id;
    const prepared = await this.preparedDelivery(agentId, null);
    const instruction = await this.schedules.instructionFor(agentId, schedule);
    const projected = [
      scheduleWakeUserMessage({
        id: schedule.id,
        timing: rowTiming(schedule),
        instruction,
        previousRunAt: schedule.last_run_at ? iso(schedule.last_run_at) : null,
      }),
    ];
    const runId = newId("r");
    await this.startDelivery(runId, agentId, () =>
      this.db.createScheduleRun(
        {
          runId,
          agentId,
          configSnapshot: preparedSnapshot(prepared, "schedule"),
          systemContent: prepared.system,
          taskContent: prepared.task,
          projected,
          ...preparedPromptHashes(prepared),
          scheduleId: schedule.id,
          runMetadata: { ...(preparedRunMetadata(prepared) ?? {}), instruction_hash: instructionHash(instruction) },
        },
        new Date(),
      ),
    );
  }

  /**
   * Wakes each due schedule whose agent is free, and plans its next wake-up. A schedule whose
   * agent is busy stays due for the next tick; one whose run cannot be created is logged and
   * moves on.
   */
  async fireDueSchedules(now?: Date): Promise<void> {
    const when = now ?? new Date();
    for (const row of await this.db.listDueSchedules(when)) {
      if (this.generations.isAgentBusy(row.agent_id)) {
        continue;
      }
      try {
        await this.deliverScheduleRun(row);
      } catch (error) {
        if (error instanceof DeliveryBusyError) {
          continue;
        }
        if (error instanceof DeliveryCreateError) {
          writeLog("error", error.message, {
            agent_id: row.agent_id,
            operation: "schedule.fire",
          });
        } else {
          writeLog(
            "error",
            "schedule wake-up failed",
            {
              agent_id: row.agent_id,
              operation: "schedule.fire",
              error_type: errorName(error),
            },
            error,
          );
        }
      }
      await this.db.markScheduleFired(row.id, when, planAfterFire(row, when));
    }
  }

  startScheduler(): void {
    if (this.scheduler !== null) {
      return;
    }
    const abort = new AbortController();
    this.scheduler = { abort, task: this.tickSchedules(abort.signal) };
  }

  /** Stops the scheduler, waiting at most 50 ms for the tick under way. */
  async stopScheduler(): Promise<void> {
    const scheduler = this.scheduler;
    this.scheduler = null;
    if (scheduler === null) {
      return;
    }
    scheduler.abort.abort();
    const abortWait = new AbortController();
    await Promise.race([scheduler.task, sleep(50, abortWait.signal)]);
    abortWait.abort();
  }

  /**
   * The next run of a chain: same agent and kind, a freshly composed prompt, and one user
   * message carrying the hand-off. A group continuation keeps the delivery's snapshot, a
   * schedule continuation its routine.
   */
  async createContinuation(previous: RunRow, handoff: string, position: ChainPosition): Promise<string> {
    const throughSeq = previous.group_chat_through_seq;
    const prepared = await this.preparation.prepare(previous.agent_id, previous.kind === "group" ? throughSeq : null);
    const runId = newId("r");
    const now = new Date();
    const opening = continuationMessage(previous.id, handoff);
    const runMetadata: RunMetadata = {
      ...(preparedRunMetadata(prepared) ?? {}),
      chain: { root_run_id: position.root_run_id, index: position.index + 1, previous_run_id: previous.id },
    };
    const base = {
      runId,
      agentId: previous.agent_id,
      systemContent: prepared.system,
      taskContent: prepared.task,
      ...preparedPromptHashes(prepared),
      runMetadata,
    };
    if (previous.kind === "group") {
      await this.db.createGroupRun(
        { ...base, configSnapshot: preparedSnapshot(prepared, "group"), projected: [opening], throughSeq: throughSeq ?? 0 },
        now,
      );
    } else if (previous.kind === "schedule") {
      const instruction = previous.metadata.instruction_hash;
      await this.db.createScheduleRun(
        {
          ...base,
          configSnapshot: preparedSnapshot(prepared, "schedule"),
          projected: [opening],
          runMetadata: { ...runMetadata, ...(instruction ? { instruction_hash: instruction } : {}) },
          scheduleId: previous.schedule_id,
        },
        now,
      );
    } else {
      await this.db.createRun(
        { ...base, configSnapshot: preparedSnapshot(prepared, "direct"), userContent: null, extraMessages: [opening] },
        now,
      );
    }
    return runId;
  }

  /** The run a delivery creates, prepared; a delivery to a busy agent waits, one that cannot be prepared is dropped. */
  private async preparedDelivery(agentId: string, throughSeq: number | null): Promise<PreparedRun> {
    let prepared: PreparedRun;
    try {
      prepared = await this.preparation.prepare(agentId, throughSeq);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new DeliveryCreateError(error.detail);
      }
      throw error;
    }
    if (this.generations.isAgentBusy(agentId)) {
      throw new DeliveryBusyError();
    }
    return prepared;
  }

  /** Starts a delivered run; an agent that became busy meanwhile makes the delivery wait. */
  private async startDelivery(runId: string, agentId: string, create: () => Promise<void>): Promise<void> {
    try {
      await this.startCreated(runId, agentId, create);
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new DeliveryBusyError();
      }
      throw error;
    }
  }

  /** Admits the run's generation, creates the run, and generates it; a run that fails to be created frees its agent. */
  private async startCreated(runId: string, agentId: string, create: () => Promise<void>): Promise<void> {
    await this.starter.beginGeneration(runId, agentId);
    try {
      await create();
    } catch (error) {
      this.starter.endGeneration(runId);
      throw error;
    }
    this.starter.generateInBackground(runId, 1);
  }

  private async tickSchedules(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.schedulerTickMs, signal);
      if (signal.aborted) {
        return;
      }
      try {
        await this.fireDueSchedules();
      } catch (error) {
        writeLog(
          "error",
          "schedule tick failed",
          { operation: "schedule.tick", error_type: errorName(error) },
          error,
        );
      }
    }
  }
}
