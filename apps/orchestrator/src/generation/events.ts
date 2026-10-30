import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { appendRunError, insertMessage, nextSeq, type MessageRow } from "../db/runs.js";
import type { MessageMetadata, MessagePayload } from "../db/schema/index.js";
import { messageItem } from "../db/views.js";
import { EventQueue } from "../lib/event.js";
import { errorMessage, errorName, redactText, writeLog } from "../observability/log.js";

const EVENT_QUEUE_LIMIT = 4096;

/** One event on a run's stream: its name and its data. */
export type RunEvent = [string, Record<string, unknown>];

/** The db/ functions a run's messages and errors are written through. */
export type RunEventsDatabase = {
  nextSeq: BoundQuery<typeof nextSeq>;
  insertMessage: BoundQuery<typeof insertMessage>;
  appendRunError: BoundQuery<typeof appendRunError>;
};

/** The db/ functions a run's messages and errors are written through, on `db`. */
export function runEventsDatabase(db: Queryable): RunEventsDatabase {
  return {
    nextSeq: bindQuery(db, nextSeq),
    insertMessage: bindQuery(db, insertMessage),
    appendRunError: bindQuery(db, appendRunError),
  };
}

/** One generation of a run, and the fields each log line about it carries. */
export type RunGeneration = {
  runId: string;
  generation: number;
  /** `run_id`, and once the agent is known `agent_id`, `guild_id`, and `host_id`. */
  log: Record<string, string>;
};

/**
 * What a run's subscribers see: each event as it happens, each message once it is committed,
 * and each error once the run keeps it. A subscriber that falls 4096 events behind is dropped.
 */
export class RunEvents {
  private readonly subscribers = new Map<string, Set<EventQueue<RunEvent>>>();

  constructor(private readonly db: RunEventsDatabase) {}

  subscribe(runId: string): EventQueue<RunEvent> {
    const queue = new EventQueue<RunEvent>();
    const listeners = this.subscribers.get(runId) ?? new Set();
    listeners.add(queue);
    this.subscribers.set(runId, listeners);
    return queue;
  }

  unsubscribe(runId: string, queue: EventQueue<RunEvent>): void {
    const listeners = this.subscribers.get(runId);
    if (listeners) {
      listeners.delete(queue);
      if (!listeners.size) {
        this.subscribers.delete(runId);
      }
    }
  }

  async publish(runId: string, event: string, data: Record<string, unknown>): Promise<void> {
    for (const queue of [...(this.subscribers.get(runId) ?? [])]) {
      if (queue.size >= EVENT_QUEUE_LIMIT) {
        this.unsubscribe(runId, queue);
        continue;
      }
      await queue.put([event, data]);
    }
  }

  /** Appends the message to the run's history and publishes it. */
  async commitMessage(
    runId: string,
    payload: MessagePayload,
    metadata: MessageMetadata,
  ): Promise<MessageRow> {
    const seq = await this.db.nextSeq(runId);
    const row = await this.db.insertMessage({ runId, seq, payload, metadata }, new Date());
    await this.publish(runId, "message.committed", messageItem(row));
    return row;
  }

  /** Logs the error, keeps it, redacted, in the run's errors, and publishes it. */
  async recordError(turn: RunGeneration, operation: string, error: unknown): Promise<void> {
    writeLog(
      "error",
      errorMessage(error),
      {
        run_id: turn.log.run_id ?? turn.runId,
        agent_id: turn.log.agent_id ?? null,
        guild_id: turn.log.guild_id ?? null,
        operation,
        error_type: errorName(error),
      },
      error,
    );
    const now = new Date();
    const entry = {
      at: now.toISOString(),
      generation: turn.generation,
      operation,
      error_type: errorName(error),
      message: redactText(errorMessage(error)),
    };
    await this.db.appendRunError(turn.runId, entry, now);
    await this.publish(turn.runId, "run.error", entry);
  }
}
