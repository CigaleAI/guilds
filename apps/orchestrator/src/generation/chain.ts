import { getAgent } from "../db/agents.js";
import type { AssistantMessage } from "../db/schema/index.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { completeRun, getRun, listMessages, mergeRunMetadata, type RunMessage, type RunRow } from "../db/runs.js";
import { INPUT_TOKEN_LIMIT_MESSAGE, type Completion } from "../llm/index.js";
import { remainingAfter, stampToolResult } from "../toolbox/index.js";
import { completionRequest, historyTokens, type ModelCompletion } from "./completion.js";
import { GenerationCancelled, RunLimitError } from "./errors.js";
import type { RunEvents } from "./events.js";
import type { Generation } from "./generate.js";
import type { Runs } from "./runs.js";
import { executedToolCalls, toolCallsOf, type GenerationTools } from "./tool-calls.js";

/**
 * Run chains. A coding run whose prompt reaches this share of `max_input_tokens` asks the
 * agent for a hand-off and continues in a new run with a freshly composed prompt, so each
 * run's rows stay exactly what the model saw.
 */
export const HANDOFF_FRACTION = 0.7;
export const MAX_CHAIN_RUNS = 5;

export const HANDOFF_REQUEST =
  "Hand-off: this run's history is close to its input limit, so the work continues in a " +
  "new run that starts from a fresh prompt. Reply now with text only, no tool calls: the " +
  "hand-off that run starts from. Give the goal, what is done, what is decided, what " +
  "remains, and the files that matter as path:line. The working tree, Memory, and notes " +
  "carry over; this conversation does not.";

export const HANDOFF_TOOL_REFUSED = "ERROR: a hand-off was requested; reply with text only";

export const MAX_CHAIN_MESSAGE = `This task reached ${MAX_CHAIN_RUNS} chained runs. Start a new run to continue.`;

export type ChainPosition = { root_run_id: string; index: number; previous_run_id: string | null };

/** Where a run sits in its chain: a run without `metadata.chain` is the first of its own. */
export function chainOf(run: Pick<RunRow, "id" | "metadata">): ChainPosition {
  return run.metadata.chain ?? { root_run_id: run.id, index: 1, previous_run_id: null };
}

/** The run that continued this one, when it did. */
export function continuedBy(run: Pick<RunRow, "metadata">): string | null {
  return run.metadata.continued_by_run_id ?? null;
}

/** The text of the agent's hand-off reply; empty when it wrote none. */
export function handoffText(payload: AssistantMessage): string {
  return payload.content.trim();
}

/** The one user message a continuation run opens with. */
export function continuationMessage(
  previousRunId: string,
  handoff: string,
): RunMessage {
  const body: Record<string, unknown> = { previous_run_id: previousRunId, handoff: handoff || null };
  if (!handoff) {
    body.note = "The previous run wrote no hand-off. Work from Memory, notes, and the working tree.";
  }
  return [
    { role: "user", content: `Continuation: ${JSON.stringify(body, null, 2)}` },
    { generation: 1, source: "continuation", previous_run_id: previousRunId },
  ];
}

/** The db/ functions a chain is followed and handed off through. */
export type RunChainsDatabase = {
  getRun: BoundQuery<typeof getRun>;
  getAgent: BoundQuery<typeof getAgent>;
  listMessages: BoundQuery<typeof listMessages>;
  mergeRunMetadata: BoundQuery<typeof mergeRunMetadata>;
  completeRun: BoundQuery<typeof completeRun>;
};

/** The db/ functions a chain is followed and handed off through, on `db`. */
export function runChainsDatabase(db: Queryable): RunChainsDatabase {
  return {
    getRun: bindQuery(db, getRun),
    getAgent: bindQuery(db, getAgent),
    listMessages: bindQuery(db, listMessages),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
    completeRun: bindQuery(db, completeRun),
  };
}

/** Completes the run unless it already ended. */
export async function completeIfActive(
  db: Pick<RunChainsDatabase, "getRun" | "completeRun">,
  runId: string,
): Promise<void> {
  const run = await db.getRun(runId);
  if (run !== null && run.status === "active") {
    await db.completeRun(runId, new Date());
  }
}

/** What chains are handed off with, built once by the loop. */
export type RunChainsServices = {
  db: RunChainsDatabase;
  events: RunEvents;
  completion: ModelCompletion;
  runs: Pick<Runs, "createContinuation">;
};

/** The run chains of a loop: each hand-off, the continuation it creates, and the way to a chain's last run. */
export class RunChains {
  /** A run that handed off, to the run that continues it once its generation ends. */
  private readonly continuations = new Map<string, string>();

  constructor(private readonly services: RunChainsServices) {}

  /** The run that continues `runId` once its generation ends, taken once; null when it handed off to none. */
  takeContinuation(runId: string): string | null {
    const next = this.continuations.get(runId) ?? null;
    this.continuations.delete(runId);
    return next;
  }

  /** The last run of the chain that `runId` belongs to, following each continuation. */
  async latestInChain(runId: string): Promise<string> {
    let current = runId;
    for (let hop = 0; hop < MAX_CHAIN_RUNS; hop += 1) {
      const row = await this.services.db.getRun(current);
      const next = row ? continuedBy(row) : null;
      if (next === null) {
        return current;
      }
      current = next;
    }
    return current;
  }

  /**
   * A coding run's prompt reached the hand-off share of its input limit: the agent is asked
   * for a hand-off, given one step, and the run continues in a new one of the same kind.
   * The fifth run of a chain completes with `generation.max_chain` instead.
   */
  async handOff(gen: Generation, tools: GenerationTools): Promise<void> {
    const { db, events, runs } = this.services;
    const position = chainOf(gen.run);
    if (position.index >= MAX_CHAIN_RUNS) {
      await events.recordError(gen, "generation.max_chain", new RunLimitError("generation.max_chain", MAX_CHAIN_MESSAGE));
      await completeIfActive(db, gen.runId);
      return;
    }
    await events.commitMessage(
      gen.runId,
      { role: "user", content: HANDOFF_REQUEST },
      { generation: gen.generation, source: "handoff" },
    );
    const reply = await this.handoffReply(gen, tools);
    if (reply === null) {
      return;
    }
    await events.commitMessage(gen.runId, reply.payload, { generation: gen.generation, ...reply.metadata });
    await this.refuseToolCalls(gen, tools, reply);
    let next: string;
    try {
      next = await runs.createContinuation(gen.run, handoffText(reply.payload), position);
    } catch (error) {
      await events.recordError(gen, "generation.continue", error);
      return;
    }
    await db.mergeRunMetadata(gen.runId, { continued_by_run_id: next }, new Date());
    await db.completeRun(gen.runId, new Date());
    this.continuations.set(gen.runId, next);
  }

  /**
   * The agent's reply to the hand-off request; null when the history no longer fits the input
   * limit or the model fails, and the run says why.
   */
  private async handoffReply(gen: Generation, tools: GenerationTools): Promise<Completion | null> {
    const { db, events, completion } = this.services;
    const agent = await db.getAgent(gen.run.agent_id);
    const history = await completion.modelHistory(gen, agent, gen.snapshot, tools.schemas);
    if (historyTokens(gen.snapshot, history, tools.schemas) > gen.snapshot.max_input_tokens) {
      await events.recordError(
        gen,
        "generation.max_input_tokens",
        new RunLimitError("generation.max_input_tokens", INPUT_TOKEN_LIMIT_MESSAGE),
      );
      await completeIfActive(db, gen.runId);
      return null;
    }
    try {
      return await completion.complete(gen.runId, completionRequest(gen.snapshot, history.payloads, tools.schemas));
    } catch (error) {
      if (error instanceof GenerationCancelled) {
        throw error;
      }
      await events.recordError(gen, "llm.complete", error);
      return null;
    }
  }

  /**
   * Tool schemas stay fixed for the run, so the model may still call one in its hand-off: each
   * call gets a refusal, which keeps the history valid, and is not run.
   */
  private async refuseToolCalls(gen: Generation, tools: GenerationTools, reply: Completion): Promise<void> {
    const { db, events } = this.services;
    let executed = executedToolCalls(await db.listMessages(gen.runId));
    for (const call of toolCallsOf(reply.payload)) {
      const name = call.function.name;
      const callId = call.id;
      executed += 1;
      const [payload, metadata] = stampToolResult(
        { role: "tool", tool_call_id: callId, content: HANDOFF_TOOL_REFUSED },
        {
          tool_name: name,
          tool_call_id: callId,
          duration_ms: 0,
          output_filter: "identity",
          truncated: false,
          original_bytes: Buffer.byteLength(HANDOFF_TOOL_REFUSED),
          stored_bytes: Buffer.byteLength(HANDOFF_TOOL_REFUSED),
          error: "a hand-off was requested",
        },
        remainingAfter(tools.maxToolCalls, executed),
      );
      await events.commitMessage(gen.runId, payload, { generation: gen.generation, ...metadata });
    }
  }
}
