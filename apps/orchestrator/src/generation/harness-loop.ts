import { HARNESS_INFO, type TurnHarness } from "../coding/harnesses.js";
import type { AgentRow } from "../db/agents.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { listMessages, mergeRunMetadata, type MessageRow, type RunRow } from "../db/runs.js";
import type { Harness, RunConfigSnapshot, RunHarnessTurn, ToolCall } from "../db/schema/index.js";
import { errorMessage, writeLog } from "../observability/log.js";
import { callSegment } from "../toolbox/code.js";
import { CODE_TASK_DEFAULT_MINUTES } from "../toolbox/harness.js";
import {
  endHarnessTurn,
  HARNESS_POLL_FAILURES_MAX,
  harnessLogPath,
  launchHarness,
  opsRun,
  pause,
  pollHarness,
  stopHarness,
  stringOrNull,
  type HarnessPollResult,
  type Settled,
  type TurnEnding,
} from "../toolbox/harness-ops.js";
import { failureDetail } from "../toolbox/harness-result.js";
import type { ToolRun } from "../toolbox/index.js";
import { GenerationCancelled, HarnessTurnError } from "./errors.js";
import type { RunEventBus, RunGeneration } from "./events.js";
import {
  claudeCodeAssistantMessage,
  claudeCodeToolRecord,
  interruptedHarnessToolRecord,
} from "./harness-rows.js";
import {
  parseClaudeCodeEvents,
  type ClaudeCodeMessage,
  type ClaudeCodeToolResults,
} from "./parse-claude-code.js";
import { pendingToolCalls, toolCallsOf, type GenerationTools } from "./tool-calls.js";

/** How often a subscription agent's turn is polled, and how long its minutes are; tests shorten both. */
export const harnessTurnTiming = { pollMs: 1000, minuteMs: 60_000 };

/** How long a subscription agent's turn runs before its harness is stopped: a `code_task` call's default. */
export const HARNESS_TURN_MINUTES = CODE_TASK_DEFAULT_MINUTES;

/** A run's snapshot as the harness loop reads it: a subscription agent's, on the harness that runs its turns. */
export type HarnessRunConfigSnapshot = RunConfigSnapshot & { model: null; harness: TurnHarness };

/** A generation of a subscription agent's run, as it started, which its harness runs. */
export type SubscriptionGeneration = RunGeneration & {
  run: RunRow;
  agent: AgentRow;
  source: "subscription";
  snapshot: HarnessRunConfigSnapshot;
};

/** What a turn of the harness reads: the run's system prompt, and the messages that opened the generation. */
export type HarnessTurnPrompt = { system: string; prompt: string };

/**
 * What a turn of the harness reads from the run's rows: the system prompt the run starts with,
 * and the user messages added since the run's last reply, in the text a model is sent them.
 */
export function harnessTurnPrompt(rows: MessageRow[]): HarnessTurnPrompt {
  const system =
    rows.flatMap((row) => (row.payload.role === "system" ? [row.payload.content] : []))[0] ?? "";
  const lastReply = rows.findLastIndex(
    (row) => row.payload.role === "assistant" || row.payload.role === "tool",
  );
  const opening = rows
    .slice(lastReply + 1)
    .flatMap((row) => (row.payload.role === "user" ? [row.payload.content] : []));
  return { system, prompt: opening.join("\n\n") };
}

/** A call of the harness's own tool whose result has not come yet, and when its row was kept. */
type PendingCall = { call: ToolCall; seen: number };

/** A subscription agent's turn on its harness: what it runs under, and what its polls have seen so far. */
type HarnessRunTurn = {
  harness: TurnHarness;
  /** The run the harness ops run under. */
  ops: ToolRun;
  /** The id that names the turn's state and log on the machine. */
  call_id: string;
  log_path: string;
  deadline: number;
  session: string | null;
  offset: number;
  failures: number;
  pending: Map<string, PendingCall>;
};

/** The run error each way a started turn can end other than a clean exit or a cancel. */
const SETTLED_CODE: Record<
  Exclude<TurnEnding["settled"], "exited" | "cancelled" | "not_started">,
  HarnessTurnError["code"]
> = {
  missing: "harness.lost",
  unreadable: "harness.lost",
  unresponsive: "harness.unresponsive",
  timed_out: "harness.timed_out",
};

const SETTLED_MESSAGE: Record<keyof typeof SETTLED_CODE, (label: string) => string> = {
  missing: (label) =>
    `${label}'s state is gone: the machine restarted or its container was recreated. Send a message to resume its session.`,
  unreadable: (label) => `${label} exited, and its result could not be read.`,
  unresponsive: (label) =>
    `${label} stopped answering, so it was stopped. Send a message to resume its session.`,
  timed_out: (label) =>
    `${label} was stopped after ${HARNESS_TURN_MINUTES} minutes. Send a message to resume its session.`,
};

/**
 * The run error a turn that ended `ending` fails its generation with; null for a turn whose CLI
 * exited cleanly. A harness that did not stop is named with its log.
 */
export function harnessTurnFailure(
  harness: Harness,
  ending: TurnEnding,
  logPath: string,
): HarnessTurnError | null {
  const label = HARNESS_INFO[harness].label;
  const unstopped =
    ending.stopped === false
      ? ` It did not stop and may still be running; its log is ${logPath}.`
      : "";
  if (ending.settled === "exited") {
    const result = ending.result ?? {};
    return result.exit_code === 0 && result.is_error !== true
      ? null
      : new HarnessTurnError(
          "harness.failed",
          `${label}'s turn failed (${failureDetail(harness, result, null)})`,
        );
  }
  if (ending.settled === "cancelled" || ending.settled === "not_started") {
    return null;
  }
  return new HarnessTurnError(
    SETTLED_CODE[ending.settled],
    SETTLED_MESSAGE[ending.settled](label) + unstopped,
  );
}

/** The db/ functions a subscription agent's turns read the run and keep its session through. */
export type HarnessLoopDatabase = {
  listMessages: BoundQuery<typeof listMessages>;
  mergeRunMetadata: BoundQuery<typeof mergeRunMetadata>;
};

/** The db/ functions a subscription agent's turns read the run and keep its session through, on `db`. */
export function harnessLoopDatabase(db: Queryable): HarnessLoopDatabase {
  return {
    listMessages: bindQuery(db, listMessages),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
  };
}

/** What subscription agents' turns are run with, built once by the loop. */
export type HarnessLoopServices = { db: HarnessLoopDatabase; events: RunEventBus };

/**
 * The harness loop: each generation of a subscription agent's run is one turn of its harness's
 * CLI in the agent's sandbox, on the run's system prompt and the messages that opened it, in the
 * run's session. The harness's messages and its own tool calls are kept as the run's rows while
 * the turn runs.
 */
export class HarnessLoop {
  constructor(private readonly services: HarnessLoopServices) {}

  /**
   * Runs the generation's turn on its harness until the CLI exits. A turn that does not start,
   * fails, is lost, stops answering, or runs past its time ends the generation with its run
   * error; a cancel stops the harness and throws `GenerationCancelled`. However it ends, each
   * call of the harness's own tools left without a result gets the interrupted one.
   */
  async runTurn(gen: SubscriptionGeneration, tools: GenerationTools): Promise<void> {
    if (tools.run.cancel_event?.aborted) {
      throw new GenerationCancelled();
    }
    const turn = this.openTurn(gen, tools);
    try {
      if (!(await this.startHarness(gen, turn))) {
        return;
      }
      const ending = await this.pollToEnd(gen, tools, turn);
      await this.noteSession(gen.runId, turn, stringOrNull(ending.result?.session_id));
      if (ending.settled === "cancelled") {
        throw new GenerationCancelled();
      }
      const failure = harnessTurnFailure(turn.harness, ending, turn.log_path);
      if (failure !== null) {
        await this.services.events.recordError(gen, failure.code, failure);
      }
    } finally {
      await this.resolveHarnessCalls(gen.runId, turn.harness);
    }
  }

  /** Gives each call of the harness's own tools in the run's history that has no result the interrupted one. */
  async resolveHarnessCalls(runId: string, harness: Harness): Promise<void> {
    const { db, events } = this.services;
    for (const [call, generation] of pendingToolCalls(await db.listMessages(runId))) {
      const [payload, metadata] = interruptedHarnessToolRecord(call, generation, harness);
      await events.commitMessage(runId, payload, metadata);
    }
  }

  /** The turn of the generation, its clock started, resuming the session the run's last turn left. */
  private openTurn(gen: SubscriptionGeneration, tools: GenerationTools): HarnessRunTurn {
    const callId = callSegment(`turn_${gen.generation}_${gen.runId}`);
    return {
      harness: gen.snapshot.harness,
      ops: opsRun(tools.run),
      call_id: callId,
      log_path: harnessLogPath(gen.runId, callId),
      deadline: Date.now() + HARNESS_TURN_MINUTES * harnessTurnTiming.minuteMs,
      session: gen.run.metadata.harness_turn?.session_id ?? null,
      offset: 0,
      failures: 0,
      pending: new Map(),
    };
  }

  /**
   * Starts the CLI on the run's system prompt with the generation's messages; false when it did
   * not start, and the run says why.
   */
  private async startHarness(gen: SubscriptionGeneration, turn: HarnessRunTurn): Promise<boolean> {
    const { system, prompt } = harnessTurnPrompt(await this.services.db.listMessages(gen.runId));
    try {
      await launchHarness(turn.ops, turn.call_id, {
        harness: turn.harness,
        prompt,
        repository: null,
        system_prompt: system,
        session_id: turn.session,
        model: gen.snapshot.harness_model,
        effort: gen.snapshot.harness_effort,
      });
      return true;
    } catch (error) {
      const label = HARNESS_INFO[turn.harness].label;
      const refused = new HarnessTurnError(
        "harness.start",
        `${label} did not start: ${errorMessage(error)}`,
        { cause: error },
      );
      await this.services.events.recordError(gen, refused.code, refused);
      return false;
    }
  }

  /**
   * Records the started turn on the run and polls it to the end; any way out but a clean exit or
   * lost state stops the harness.
   */
  private async pollToEnd(
    gen: SubscriptionGeneration,
    tools: GenerationTools,
    turn: HarnessRunTurn,
  ): Promise<TurnEnding> {
    let settled: Settled;
    try {
      await this.rememberTurn(gen.runId, turn);
      settled = await this.pollUntilSettled(gen, tools, turn);
    } catch (error) {
      await stopHarness(turn.ops, turn.call_id, turn.harness);
      throw error;
    }
    return endHarnessTurn(turn.ops, turn.call_id, turn.harness, settled);
  }

  /** Polls the harness, keeping its rows, until it exits, is lost, or must be stopped. */
  private async pollUntilSettled(
    gen: SubscriptionGeneration,
    tools: GenerationTools,
    turn: HarnessRunTurn,
  ): Promise<Settled> {
    for (;;) {
      const settled = interruption(tools.run, turn) ?? (await this.pollOnce(gen, tools, turn));
      if (settled !== null) {
        return settled;
      }
      await pause(
        Math.min(harnessTurnTiming.pollMs, Math.max(0, turn.deadline - Date.now())),
        tools.run.cancel_event,
      );
    }
  }

  private async pollOnce(
    gen: SubscriptionGeneration,
    tools: GenerationTools,
    turn: HarnessRunTurn,
  ): Promise<Settled | null> {
    let polled: HarnessPollResult;
    try {
      polled = await pollHarness(turn.ops, turn.call_id, turn.harness, turn.offset);
    } catch (error) {
      return countFailedPoll(turn, errorMessage(error));
    }
    turn.failures = 0;
    if (polled.poll.missing === true) {
      return "missing";
    }
    turn.offset = polled.poll.offset ?? turn.offset;
    await this.noteSession(gen.runId, turn, stringOrNull(polled.poll.session_id));
    await this.keepEvents(gen, tools.secrets, turn, polled.events);
    return polled.poll.exited === true ? "exited" : null;
  }

  /** Keeps the rows of the Claude Code events one poll read, in order. */
  private async keepEvents(
    gen: SubscriptionGeneration,
    secrets: Record<string, string>,
    turn: HarnessRunTurn,
    raw: string,
  ): Promise<void> {
    for (const event of parseClaudeCodeEvents(raw)) {
      if (event.type === "assistant") {
        await this.keepMessage(gen, secrets, turn, event);
      } else {
        await this.keepResults(gen, secrets, turn, event);
      }
    }
  }

  /** Keeps a message of the harness's as an assistant row; its tool calls wait for their results. */
  private async keepMessage(
    gen: SubscriptionGeneration,
    secrets: Record<string, string>,
    turn: HarnessRunTurn,
    message: ClaudeCodeMessage,
  ): Promise<void> {
    const payload = claudeCodeAssistantMessage(message, secrets);
    if (payload === null) {
      return;
    }
    await this.services.events.commitMessage(gen.runId, payload, {
      generation: gen.generation,
      from_harness: turn.harness,
    });
    const seen = Date.now();
    for (const call of toolCallsOf(payload)) {
      turn.pending.set(call.id, { call, seen });
    }
  }

  /** Keeps each result of a call the harness made as its tool row; a result for no call it made is dropped. */
  private async keepResults(
    gen: SubscriptionGeneration,
    secrets: Record<string, string>,
    turn: HarnessRunTurn,
    event: ClaudeCodeToolResults,
  ): Promise<void> {
    for (const result of event.results) {
      const pending = turn.pending.get(result.tool_use_id);
      if (pending === undefined) {
        continue;
      }
      turn.pending.delete(result.tool_use_id);
      const [payload, metadata] = claudeCodeToolRecord(
        result,
        pending.call,
        Date.now() - pending.seen,
        secrets,
      );
      await this.services.events.commitMessage(gen.runId, payload, {
        generation: gen.generation,
        ...metadata,
      });
    }
  }

  /** Keeps the session the harness reported, so the run's next turn resumes it. */
  private async noteSession(
    runId: string,
    turn: HarnessRunTurn,
    seen: string | null,
  ): Promise<void> {
    if (seen === null || seen === turn.session) {
      return;
    }
    turn.session = seen;
    await this.rememberTurn(runId, turn);
  }

  private async rememberTurn(runId: string, turn: HarnessRunTurn): Promise<void> {
    const record: RunHarnessTurn = {
      call_id: turn.call_id,
      harness: turn.harness,
      session_id: turn.session,
      log_path: turn.log_path,
    };
    await this.services.db.mergeRunMetadata(runId, { harness_turn: record }, new Date());
  }
}

function interruption(run: ToolRun, turn: HarnessRunTurn): Settled | null {
  if (run.cancel_event?.aborted) {
    return "cancelled";
  }
  return Date.now() >= turn.deadline ? "timed_out" : null;
}

function countFailedPoll(turn: HarnessRunTurn, message: string): Settled | null {
  turn.failures += 1;
  if (turn.failures < HARNESS_POLL_FAILURES_MAX) {
    return null;
  }
  writeLog("warn", message, {
    run_id: turn.ops.run_id,
    agent_id: turn.ops.agent_id,
    operation: "harness.poll",
  });
  return "unresponsive";
}
