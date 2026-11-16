import { HARNESS_INFO, type TurnHarness } from "../coding/harnesses.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import {
  completeRun,
  getRun,
  listMessages,
  mergeRunMetadata,
  type ActiveRunRow,
  type MessageRow,
  type RunRow,
} from "../db/runs.js";
import {
  modelSourceOf,
  type Harness,
  type RunConfigSnapshot,
  type RunHarnessTurn,
  type ToolCall,
} from "../db/schema/index.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import { callSegment } from "../toolbox/code.js";
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
  type HarnessMcpAccess,
  type HarnessPollResult,
  type Settled,
} from "../toolbox/harness-ops.js";
import type { ToolRun } from "../toolbox/index.js";
import { completeIfActive } from "./chain.js";
import {
  GenerationBlocked,
  GenerationCancelled,
  HarnessTurnError,
  RunLimitError,
  TOOL_CALL_LIMIT_MESSAGE,
} from "./errors.js";
import type { RunEventBus, RunGeneration } from "./events.js";
import type { AgentMachines } from "./machines.js";
import {
  claudeCodeAssistantMessage,
  claudeCodeToolRecord,
  interruptedHarnessToolRecord,
} from "./harness-rows.js";
import { HARNESS_TURN_MINUTES, harnessTurnFailure, type HarnessTurnEnding } from "./harness-ending.js";
import type { HarnessGrant, HarnessMcpServer } from "./harness-mcp.js";
import {
  parseClaudeCodeEvents,
  type ClaudeCodeMessage,
  type ClaudeCodeToolResults,
} from "./parse-claude-code.js";
import { pendingToolCalls, toolCallsOf, type GenerationTools } from "./tool-calls.js";
import { maintenanceRun } from "./workspace.js";

/** How often a subscription agent's turn is polled, and how long its minutes are; tests shorten both. */
export const harnessTurnTiming = { pollMs: 1000, minuteMs: 60_000 };

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
  /** The turn's grant on the orchestrator's MCP server, where its harness calls its Guilds tools. */
  grant: HarnessGrant;
  /** The id that names the turn's state and log on the machine. */
  call_id: string;
  log_path: string;
  deadline: number;
  session: string | null;
  offset: number;
  failures: number;
  pending: Map<string, PendingCall>;
};

/** How a subscription agent's turn's poll loop ends: as a harness's does, or stopped because the run's tool calls asked. */
type TurnSettled = Settled | "stopped";

/** The db/ functions a subscription agent's turns read the run, keep its session, and complete it through. */
export type HarnessLoopDatabase = {
  getAgent: BoundQuery<typeof getAgent>;
  getRun: BoundQuery<typeof getRun>;
  completeRun: BoundQuery<typeof completeRun>;
  listMessages: BoundQuery<typeof listMessages>;
  mergeRunMetadata: BoundQuery<typeof mergeRunMetadata>;
};

/** The db/ functions a subscription agent's turns read the run, keep its session, and complete it through, on `db`. */
export function harnessLoopDatabase(db: Queryable): HarnessLoopDatabase {
  return {
    getAgent: bindQuery(db, getAgent),
    getRun: bindQuery(db, getRun),
    completeRun: bindQuery(db, completeRun),
    listMessages: bindQuery(db, listMessages),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
  };
}

/**
 * What subscription agents' turns are run with, built once by the loop: the machines a lost turn
 * is stopped on, and the MCP server each turn's harness calls its Guilds tools on.
 */
export type HarnessLoopServices = {
  db: HarnessLoopDatabase;
  events: RunEventBus;
  machines: AgentMachines;
  mcp: HarnessMcpServer;
};

/**
 * The harness loop: each generation of a subscription agent's run is one turn of its harness's
 * CLI in the agent's sandbox, on the run's system prompt and the messages that opened it, in the
 * run's session, given the orchestrator's MCP server under the generation's token. The harness's
 * messages and its own tool calls are kept as the run's rows while the turn runs; the calls it
 * makes of its Guilds tools are kept by the server.
 */
export class HarnessLoop {
  constructor(private readonly services: HarnessLoopServices) {}

  /**
   * Runs the generation's turn on its harness until the CLI exits. A turn that does not start,
   * fails, is lost, stops answering, or runs past its time ends the generation with its run
   * error; a turn whose tool calls reached the run's limit or filed a blocking issue is stopped,
   * and ends it as the model loop does; a cancel stops the harness and throws
   * `GenerationCancelled`. However it ends, the generation's token is revoked once its last call
   * is kept, and each call of the harness's own tools left without a result gets the interrupted
   * one.
   */
  async runTurn(gen: SubscriptionGeneration, tools: GenerationTools): Promise<void> {
    if (tools.run.cancel_event?.aborted) {
      throw new GenerationCancelled();
    }
    const { grant, access } = this.services.mcp.open(gen, tools);
    const turn = this.openTurn(gen, tools, grant);
    try {
      if (!(await this.startTurn(gen, turn, access))) {
        return;
      }
      const ending = await this.pollToEnd(gen, tools, turn);
      await this.noteSession(gen.runId, turn, stringOrNull(ending.result?.session_id));
      if (ending.settled === "cancelled") {
        throw new GenerationCancelled();
      }
      await this.recordEnding(gen, turn, ending);
    } finally {
      await this.services.mcp.close(grant);
      await this.resolveHarnessCalls(gen.runId, turn.harness);
    }
  }

  /**
   * Ends the generation as its turn ended: with the stop the run's tool calls asked for, the way
   * the model loop ends on them, else with the run error of a turn that did not exit cleanly.
   */
  private async recordEnding(gen: SubscriptionGeneration, turn: HarnessRunTurn, ending: HarnessTurnEnding): Promise<void> {
    const { db, events } = this.services;
    const stop = turn.grant.stop;
    if (stop?.kind === "blocked") {
      await events.recordError(gen, "generation.blocked", new GenerationBlocked(stop.issueId));
      return;
    }
    if (stop?.kind === "max_tool_calls") {
      await events.recordError(
        gen,
        "generation.max_tool_calls",
        new RunLimitError("generation.max_tool_calls", TOOL_CALL_LIMIT_MESSAGE),
      );
      await completeIfActive(db, gen.runId);
      return;
    }
    const failure = harnessTurnFailure(turn.harness, ending, turn.log_path);
    if (failure !== null) {
      await events.recordError(gen, failure.code, failure);
    }
  }

  /**
   * Ends the turn a subscription agent's run lost when the orchestrator restarted: its harness is
   * stopped on the agent's machine while that runs, the session its result names is kept for the
   * run's next turn, and each call of the harness's own tools left without a result gets the
   * interrupted one. A run of no subscription agent, or with no turn, is left as it is.
   */
  async endLostTurn(run: ActiveRunRow): Promise<void> {
    const turn = run.metadata.harness_turn;
    if (turn === undefined || modelSourceOf(run.config_snapshot).kind !== "subscription") {
      return;
    }
    const session = await this.stopLostHarness(run, turn);
    if (session !== null && session !== turn.session_id) {
      await this.services.db.mergeRunMetadata(
        run.id,
        { harness_turn: { ...turn, session_id: session } },
        new Date(),
      );
    }
    await this.resolveHarnessCalls(run.id, turn.harness);
  }

  /**
   * Stops a lost turn's harness on its agent's machine; the session its result names, or null
   * when it names none, the machine is not running, or the stop did not go through, which is logged.
   */
  private async stopLostHarness(run: ActiveRunRow, turn: RunHarnessTurn): Promise<string | null> {
    const { db, machines } = this.services;
    try {
      const agent = await db.getAgent(run.agent_id);
      const sandbox = agent ? await machines.sandboxes.connectRunning(agent.machine_id) : null;
      if (agent === null || sandbox === null) {
        return null;
      }
      const { result } = await stopHarness(
        maintenanceRun(run.id, agent, sandbox),
        turn.call_id,
        turn.harness,
      );
      return stringOrNull(result?.session_id);
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: run.id,
        agent_id: run.agent_id,
        operation: "harness.stop",
        error_type: errorName(error),
      });
      return null;
    }
  }

  /**
   * Gives each call of the harness's own tools in the run's history that has no result the
   * interrupted one; the calls of its Guilds tools are the run's own, resolved as a model's are.
   */
  private async resolveHarnessCalls(runId: string, harness: Harness): Promise<void> {
    const { db, events } = this.services;
    const harnessRows = (await db.listMessages(runId)).filter((row) => row.metadata.from_harness !== undefined);
    for (const [call, generation] of pendingToolCalls(harnessRows)) {
      const [payload, metadata] = interruptedHarnessToolRecord(call, generation, harness);
      await events.commitMessage(runId, payload, metadata);
    }
  }

  /** The turn of the generation under `grant`, its clock started, resuming the session the run's last turn left. */
  private openTurn(gen: SubscriptionGeneration, tools: GenerationTools, grant: HarnessGrant): HarnessRunTurn {
    const callId = callSegment(`turn_${gen.generation}_${gen.runId}`);
    return {
      harness: gen.snapshot.harness,
      ops: opsRun(tools.run),
      grant,
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
   * Starts the CLI on the run's system prompt with the generation's messages, given the MCP server
   * at `mcp`; false when it did not start, and the run says why.
   */
  private async startTurn(gen: SubscriptionGeneration, turn: HarnessRunTurn, mcp: HarnessMcpAccess): Promise<boolean> {
    const { system, prompt } = harnessTurnPrompt(await this.services.db.listMessages(gen.runId));
    try {
      await launchHarness(turn.ops, turn.call_id, {
        harness: turn.harness,
        prompt,
        repository: null,
        system_prompt: system,
        mcp,
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
  ): Promise<HarnessTurnEnding> {
    let settled: TurnSettled;
    try {
      await this.rememberTurn(gen.runId, turn);
      settled = await this.pollUntilSettled(gen, tools, turn);
    } catch (error) {
      await stopHarness(turn.ops, turn.call_id, turn.harness);
      throw error;
    }
    if (settled === "stopped") {
      return { settled, ...(await stopHarness(turn.ops, turn.call_id, turn.harness)) };
    }
    return endHarnessTurn(turn.ops, turn.call_id, turn.harness, settled);
  }

  /** Polls the harness, keeping its rows, until it exits, is lost, or must be stopped. */
  private async pollUntilSettled(
    gen: SubscriptionGeneration,
    tools: GenerationTools,
    turn: HarnessRunTurn,
  ): Promise<TurnSettled> {
    for (;;) {
      const settled = turnInterruption(tools.run, turn) ?? (await this.pollTurnOnce(gen, turn));
      if (settled !== null) {
        return settled;
      }
      await pause(
        Math.min(harnessTurnTiming.pollMs, Math.max(0, turn.deadline - Date.now())),
        tools.run.cancel_event,
      );
    }
  }

  /** One poll of the turn, its new events kept as rows redacted with the turn's secrets and token. */
  private async pollTurnOnce(gen: SubscriptionGeneration, turn: HarnessRunTurn): Promise<Settled | null> {
    let polled: HarnessPollResult;
    try {
      polled = await pollHarness(turn.ops, turn.call_id, turn.harness, turn.offset);
    } catch (error) {
      return countFailedTurnPoll(turn, errorMessage(error));
    }
    turn.failures = 0;
    if (polled.poll.missing === true) {
      return "missing";
    }
    turn.offset = polled.poll.offset ?? turn.offset;
    await this.noteSession(gen.runId, turn, stringOrNull(polled.poll.session_id));
    await this.keepEvents(gen, turn.grant.tools.secrets, turn, polled.events);
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

/** Why the turn must end before its next poll: a cancel, the run's tool calls asking for its stop, or its time; null for none. */
function turnInterruption(run: ToolRun, turn: HarnessRunTurn): TurnSettled | null {
  if (run.cancel_event?.aborted) {
    return "cancelled";
  }
  if (turn.grant.stop !== null) {
    return "stopped";
  }
  return Date.now() >= turn.deadline ? "timed_out" : null;
}

function countFailedTurnPoll(turn: HarnessRunTurn, message: string): Settled | null {
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
