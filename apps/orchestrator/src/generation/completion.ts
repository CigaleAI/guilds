import { attachmentImageCount, countRunInputTokens } from "../attachments/hydrate.js";
import { IMAGE_INPUT_TOKENS, type AttachmentService } from "../attachments/index.js";
import {
  AGENT_TOOL_RESULT_STUB_HINT,
  MIN_UNSTUBBED_TOOL_RESULTS,
  TOOL_RESULT_STUB_MIN_BYTES,
  projectToolResults,
} from "../conversation/projection.js";
import type { AgentRow } from "../db/agents.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import type { RunConfigSnapshot } from "../db/schema/index.js";
import { listMessages, type MessageRow } from "../db/runs.js";
import { modelCatalog } from "../llm/catalog.js";
import {
  ModelNotConnectedError,
  modelUsageOf,
  reportModelUsage,
  resolveModelCredentials,
  type ModelCredentials,
  type ModelCredentialsProvider,
} from "../llm/credentials.js";
import { streamCompletion } from "../llm/client.js";
import { LLMError, type Completion, type ModelEvent } from "../llm/completion.js";
import { countInputTokens } from "../llm/tokens.js";
import { PolicyError, type OrgPolicy } from "../policy/index.js";
import type { CancelEvent } from "../toolbox/index.js";
import type { ActiveGenerations } from "./active-generations.js";
import { GenerationCancelled, RunLimitError } from "./errors.js";
import type { RunEvents, RunGeneration } from "./events.js";

export const CANCEL_GRACE_MS = 2_000;
export const SHUTDOWN_TIMEOUT_MS = 15_000;

/** What generation calls the model with and how long it waits; tests replace these. */
export const generationLive = {
  streamCompletion,
  countInputTokens,
  cancelGraceMs: CANCEL_GRACE_MS,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
};

export const countInputTokensImpl = (
  ...args: Parameters<typeof countInputTokens>
): ReturnType<typeof countInputTokens> => generationLive.countInputTokens(...args);

/** The db/ functions a model call reads the run's history through. */
export type ModelCompletionDatabase = { listMessages: BoundQuery<typeof listMessages> };

/** The db/ functions a model call reads the run's history through, on `db`. */
export function modelCompletionDatabase(db: Queryable): ModelCompletionDatabase {
  return { listMessages: bindQuery(db, listMessages) };
}

/** What model calls are made with, built once by the loop. */
export type ModelCompletionServices = {
  db: ModelCompletionDatabase;
  generations: ActiveGenerations;
  events: RunEvents;
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;
  attachments: AttachmentService | null;
};

/** One call of the model: the history it is sent and the settings from the run's snapshot. */
export type CompletionRequest = {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools: unknown[] | null;
  thinking_level?: string;
};

/** A run's history as the model is sent it: the rows as projected, and their payloads with images. */
export type ModelHistory = {
  rows: MessageRow[];
  payloads: Array<Record<string, unknown>>;
};

/** The input tokens the run's history takes with the schemas it is offered. */
export function historyTokens(snapshot: RunConfigSnapshot, history: ModelHistory, schemas: unknown[]): number {
  return countRunInputTokens(snapshot.model, history.rows, schemas.length ? schemas : null, countInputTokensImpl);
}

/** A model call with the settings of the run's snapshot. */
export function completionRequest(
  snapshot: RunConfigSnapshot,
  messages: Array<Record<string, unknown>>,
  schemas: unknown[],
): CompletionRequest {
  return {
    model: snapshot.model,
    messages,
    temperature: snapshot.temperature,
    max_tokens: snapshot.max_tokens,
    tools: schemas.length ? schemas : null,
    thinking_level: snapshot.thinking_level,
  };
}

type RacedEvent =
  | { kind: "event"; result: IteratorResult<ModelEvent> }
  | { kind: "cancelled" }
  | { kind: "unwatched" };

/** The stream's next event. A cancel that comes first aborts the stream and ends the generation. */
async function nextEvent(
  iterator: AsyncIterator<ModelEvent>,
  cancelEvent: CancelEvent | null,
  abort: AbortController,
): Promise<IteratorResult<ModelEvent>> {
  const next = iterator.next();
  if (cancelEvent === null) {
    return next;
  }
  const watch = new AbortController();
  let raced: RacedEvent;
  try {
    raced = await Promise.race([
      next.then((result) => ({ kind: "event", result }) as const),
      cancelEvent.wait(watch.signal).then(
        () => ({ kind: "cancelled" }) as const,
        () => ({ kind: "unwatched" }) as const,
      ),
    ]);
  } finally {
    watch.abort();
  }
  if (raced.kind === "cancelled") {
    abort.abort();
    void next.catch(() => undefined);
    throw new GenerationCancelled();
  }
  return raced.kind === "event" ? raced.result : next;
}

/** Aborts the stream and lets it finish; a stream that fails while closing has nothing left to send. */
async function closeStream(iterator: AsyncIterator<ModelEvent>, abort: AbortController): Promise<void> {
  abort.abort();
  try {
    await iterator.return?.(undefined);
  } catch {
    return;
  }
}

/**
 * The model calls of a loop's runs: each streamed to the run's subscribers as it comes, stopped
 * by the run's cancel, and billed to the organisation the run's agent was admitted under.
 */
export class ModelCompletion {
  constructor(private readonly services: ModelCompletionServices) {}

  /**
   * The run's history for a model call of this generation: tool results of older generations
   * stubbed to fit `max_input_tokens`, and images inlined for a model that takes them.
   */
  async modelHistory(
    turn: RunGeneration,
    agent: AgentRow | null,
    snapshot: RunConfigSnapshot,
    schemas: unknown[],
  ): Promise<ModelHistory> {
    const listed = await this.services.db.listMessages(turn.runId);
    const projectedPayloads = projectToolResults({
      history: listed,
      currentGeneration: turn.generation,
      keepGenerations: snapshot.keep_tool_result_generations,
      hint: AGENT_TOOL_RESULT_STUB_HINT,
      minUnstubbed: MIN_UNSTUBBED_TOOL_RESULTS,
      minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
      budget: {
        model: snapshot.model,
        schemas,
        maxInput: snapshot.max_input_tokens,
        countInputTokens: (model, messages, tools) =>
          countInputTokensImpl(model, messages, tools) + attachmentImageCount(listed) * IMAGE_INPUT_TOKENS,
      },
    });
    const rows = listed.map((row, index) => {
      const projected = projectedPayloads[index];
      return projected === undefined || projected === row.payload ? row : { ...row, payload: projected };
    });
    const { attachments } = this.services;
    if (!attachments) {
      return { rows, payloads: projectedPayloads };
    }
    const model = agent?.config.model;
    return {
      rows,
      payloads: await attachments.projectMessages(agent?.org_id ?? "", rows, typeof model === "string" ? model : ""),
    };
  }

  /**
   * Calls the model for the run, publishing its text and reasoning as they stream. A cancel
   * ends the call with `GenerationCancelled`; an organisation the policy bars, or a provider it
   * has not connected, ends the run with a `RunLimitError`.
   */
  async complete(runId: string, request: CompletionRequest): Promise<Completion> {
    const { generations, events, policy } = this.services;
    const orgId = generations.orgOf(runId);
    if (orgId) {
      const { blocked } = await policy.standing(orgId);
      if (blocked) {
        throw new RunLimitError("generation.subscription", blocked.message);
      }
    }
    const credentials = await this.modelCredentials(orgId ?? "", request.model);
    void modelCatalog.ensureFresh();
    const abort = new AbortController();
    const stream = generationLive.streamCompletion(request, credentials, abort.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const cancelEvent = generations.cancelEvent(runId);
    let completion: Completion | null = null;
    try {
      let result = await nextEvent(iterator, cancelEvent, abort);
      while (!result.done) {
        const [kind, value] = result.value;
        if (kind === "delta") {
          await events.publish(runId, "assistant.delta", { text: value });
        } else if (kind === "reasoning") {
          await events.publish(runId, "assistant.reasoning.delta", { text: value });
        } else {
          completion = value;
        }
        result = await nextEvent(iterator, cancelEvent, abort);
      }
    } finally {
      await closeStream(iterator, abort);
    }
    if (completion === null) {
      throw new LLMError("empty completion");
    }
    await reportModelUsage(credentials, modelUsageOf(runId, request.model, completion.metadata));
    return completion;
  }

  /** The credentials the run calls the model with; a provider that is not connected ends the run. */
  private async modelCredentials(orgId: string, model: string): Promise<ModelCredentials> {
    try {
      return await resolveModelCredentials(this.services.credentials, orgId, model);
    } catch (error) {
      if (error instanceof ModelNotConnectedError) {
        throw new RunLimitError("generation.model_key", error.message);
      }
      if (error instanceof PolicyError) {
        throw new RunLimitError("generation.model_credentials", error.message);
      }
      throw error;
    }
  }
}
