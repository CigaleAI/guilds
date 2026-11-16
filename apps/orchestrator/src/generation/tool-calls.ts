import { DEFAULT_MAX_TOOL_CALLS } from "../agents/config.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import { getRun, listMessages, type MessageRow } from "../db/runs.js";
import type { AssistantMessage, ToolCall, ToolMessage, ToolResultMetadata } from "../db/schema/index.js";
import type { FunctionTool } from "../lib/tool-schema.js";
import { callTool } from "../mcp/service.js";
import { errorMessage } from "../observability/log.js";
import { redact } from "../secrets/index.js";
import { repeatedReadStep, repeatedReadText, type ReadRow } from "../toolbox/code.js";
import {
  identityOutput,
  invokeTool,
  parseArguments,
  processOutput,
  remainingAfter,
  stampToolResult,
  toolResultMaxBytes,
  type ToolHooks,
  type ToolRun,
} from "../toolbox/index.js";
import type { ToolServices } from "../toolbox/services.js";
import type { ActiveGenerations } from "./active-generations.js";
import { GenerationBlocked, GenerationCancelled, logOperationFailure, type OperationFailure } from "./errors.js";
import type { RunEventBus, RunGeneration } from "./events.js";
import type { AgentMachines } from "./machines.js";
import type { ConnectionTarget } from "./offered-tools.js";
import type { ConnectorPool } from "./prepare.js";

/** The tool calls of a run's history: which are pending, how many ran, and the record of an interrupted one. */

export const INTERRUPTED_CONTENT = "ERROR: execution interrupted";

export function toolCallsOf(payload: AssistantMessage): ToolCall[] {
  return payload.tool_calls ?? [];
}

export function executedToolCalls(rows: Array<Pick<MessageRow, "payload">>): number {
  let total = 0;
  for (const row of rows) {
    if (row.payload.role === "tool") {
      total += 1;
    }
  }
  return total;
}

function rememberPendingAssistantCalls(
  pending: Map<string, [ToolCall, number]>,
  order: string[],
  payload: AssistantMessage,
  generation: number,
): void {
  for (const call of toolCallsOf(payload)) {
    if (!call.id) {
      continue;
    }
    if (!pending.has(call.id)) {
      order.push(call.id);
    }
    pending.set(call.id, [call, generation]);
  }
}

function forgetResolvedToolCall(pending: Map<string, [ToolCall, number]>, order: string[], payload: ToolMessage): void {
  const callId = payload.tool_call_id;
  pending.delete(callId);
  const index = order.indexOf(callId);
  if (index >= 0) {
    order.splice(index, 1);
  }
}

export function pendingToolCalls(
  rows: Array<Pick<MessageRow, "payload" | "metadata">>,
): Array<[ToolCall, number]> {
  const pending = new Map<string, [ToolCall, number]>();
  const order: string[] = [];
  for (const row of rows) {
    const payload = row.payload;
    const generation = row.metadata.generation || 1;
    if (payload.role === "assistant") {
      rememberPendingAssistantCalls(pending, order, payload, generation);
    } else if (payload.role === "tool") {
      forgetResolvedToolCall(pending, order, payload);
    }
  }
  return order.flatMap((callId) => {
    const item = pending.get(callId);
    return item ? [item] : [];
  });
}

/** A tool call's result as a run keeps it: the message the model reads, and its metadata. */
export type ToolRecord = [ToolMessage, ToolResultMetadata];

/** A tool call's result as a run keeps it, with the budget of tool calls it leaves. */
export type KeptToolRecord = [ToolMessage, ToolResultMetadata & { remaining_tool_calls: number }];

/**
 * The assistant message that holds a call a run's harness made through the orchestrator's MCP
 * server, its arguments redacted with `secrets`, as a model's message holds its calls.
 */
export function harnessMcpCallMessage(call: ToolCall, secrets: Record<string, string>): AssistantMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ ...call, function: { ...call.function, arguments: redact(call.function.arguments, secrets) } }],
  };
}

/** The result of a call whose execution was lost, as the run keeps it under a generation's number. */
export type InterruptedToolRecord = [ToolMessage, ToolResultMetadata & { generation: number }];

/** The result a call gets when its execution was lost, numbered `generation`. */
export function interruptionRecord(call: ToolCall, generation: number): InterruptedToolRecord {
  const name = call.function.name;
  const callId = call.id;
  const payload: ToolMessage = {
    role: "tool",
    tool_call_id: callId,
    content: INTERRUPTED_CONTENT,
  };
  const metadata: InterruptedToolRecord[1] = {
    generation,
    tool_name: name,
    tool_call_id: callId,
    duration_ms: 0,
    output_filter: "identity",
    truncated: false,
    original_bytes: Buffer.from(INTERRUPTED_CONTENT, "utf8").length,
    stored_bytes: Buffer.from(INTERRUPTED_CONTENT, "utf8").length,
    error: "execution interrupted",
  };
  if (name === "script_run" || name === "shell") {
    metadata.exit_code = null;
  }
  return [payload, metadata];
}

/** The db/ functions tool calls read the run through. */
export type ToolCallsDatabase = {
  getAgent: BoundQuery<typeof getAgent>;
  getRun: BoundQuery<typeof getRun>;
  listMessages: BoundQuery<typeof listMessages>;
};

/** The db/ functions tool calls read the run through, on `db`. */
export function toolCallsDatabase(db: Queryable): ToolCallsDatabase {
  return {
    getAgent: bindQuery(db, getAgent),
    getRun: bindQuery(db, getRun),
    listMessages: bindQuery(db, listMessages),
  };
}

/**
 * The tools a generation calls: their run record and hooks, the schemas the model is offered,
 * the values their results are redacted with, the connection tools by name, and the run's tool
 * budget.
 */
export type GenerationTools = {
  run: ToolRun;
  hooks: ToolHooks;
  schemas: FunctionTool[];
  secrets: Record<string, string>;
  connections: Map<string, ConnectionTarget>;
  maxToolCalls: number;
};

/** A connection's answer to a tool call: its text, or the failure the model reads as the call's result. */
type ConnectionAnswer = { ok: true; text: string } | { ok: false; failure: OperationFailure };

/**
 * What the next tool calls of a run are kept against: how many calls the run has made, the agent
 * whose connections they reach, and the reads its results record.
 */
type CallLedger = { executed: number; owner: AgentRow | null; reads: ReadRow[] };

/** What tool calls are made with, built once by the loop. */
export type ToolCallsServices = {
  db: ToolCallsDatabase;
  mcp: ConnectorPool;
  events: RunEventBus;
  generations: ActiveGenerations;
  machines: AgentMachines;
  tools: ToolServices;
};

/**
 * The tool calls of a loop's runs: each one the model makes, run in order and kept with the
 * budget it leaves, and each one a stopped generation left without a result.
 */
export class ToolCalls {
  constructor(private readonly services: ToolCallsServices) {}

  /**
   * Runs the model's calls in order, each result kept as it comes; a cancel stops before the next
   * one, and a call that filed a blocking issue ends the generation with `GenerationBlocked`.
   */
  async execute(turn: RunGeneration, tools: GenerationTools, calls: ToolCall[]): Promise<void> {
    const ledger = await this.callLedger(turn.runId, tools);
    for (const call of calls) {
      if (this.services.generations.isCancelled(turn.runId)) {
        throw new GenerationCancelled();
      }
      const [, metadata] = await this.keepCall(turn, tools, call, ledger);
      if (metadata.blocking_issue_id !== undefined) {
        throw new GenerationBlocked(metadata.blocking_issue_id);
      }
    }
  }

  /**
   * Runs a call the run's harness made through the orchestrator's MCP server, kept as a model's
   * call is: its assistant row, then its result with the budget it leaves. A call whose result
   * could not be kept gets the interrupted one before the failure is thrown. Returns the result.
   */
  async executeHarnessCall(turn: RunGeneration, tools: GenerationTools, call: ToolCall): Promise<KeptToolRecord> {
    const { events } = this.services;
    await events.commitMessage(turn.runId, harnessMcpCallMessage(call, tools.secrets), { generation: turn.generation });
    try {
      return await this.keepCall(turn, tools, call, await this.callLedger(turn.runId, tools));
    } catch (error) {
      await this.keepInterrupted(turn, tools, call);
      throw error;
    }
  }

  /** What the run's next calls are kept against, read from its history. */
  private async callLedger(runId: string, tools: GenerationTools): Promise<CallLedger> {
    const { db } = this.services;
    const history = await db.listMessages(runId);
    return {
      executed: executedToolCalls(history),
      owner: await db.getAgent(tools.run.agent_id),
      reads: history.filter((row) => row.payload.role === "tool").map((row) => ({ seq: row.seq, metadata: row.metadata })),
    };
  }

  /** Runs `call` and keeps its result with the budget it leaves; the call and its read join `ledger`. */
  private async keepCall(
    turn: RunGeneration,
    tools: GenerationTools,
    call: ToolCall,
    ledger: CallLedger,
  ): Promise<KeptToolRecord> {
    ledger.executed += 1;
    const [payload, metadata] = stampToolResult(
      ...(await this.callTool(call, tools, ledger.owner, ledger.reads)),
      remainingAfter(tools.maxToolCalls, ledger.executed),
    );
    const row = await this.services.events.commitMessage(turn.runId, payload, { generation: turn.generation, ...metadata });
    ledger.reads.push({ seq: row.seq, metadata });
    return [payload, metadata];
  }

  /** Keeps the interrupted result of `call`, with the budget it leaves. */
  private async keepInterrupted(turn: RunGeneration, tools: GenerationTools, call: ToolCall): Promise<void> {
    const { db, events } = this.services;
    const executed = executedToolCalls(await db.listMessages(turn.runId)) + 1;
    const [payload, metadata] = stampToolResult(
      ...interruptionRecord(call, turn.generation),
      remainingAfter(tools.maxToolCalls, executed),
    );
    await events.commitMessage(turn.runId, payload, metadata);
  }

  /**
   * Gives each call of the run's history that has no result the interrupted result, numbered
   * `generation` or its own. Returns how many.
   */
  async resolveUnresolved(runId: string, generation: number | null): Promise<number> {
    const { db, events } = this.services;
    const rows = await db.listMessages(runId);
    const pending = pendingToolCalls(rows);
    const run = await db.getRun(runId);
    const maxToolCalls = run?.config_snapshot.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
    let executed = executedToolCalls(rows);
    for (const [call, callGeneration] of pending) {
      executed += 1;
      const [payload, metadata] = stampToolResult(
        ...interruptionRecord(call, generation ?? callGeneration),
        remainingAfter(maxToolCalls, executed),
      );
      await events.commitMessage(runId, payload, metadata);
    }
    return pending.length;
  }

  /**
   * One call's result: from its connection when the run offers it as a connection tool, else
   * from the native tool, where a read of a range unchanged since an earlier read points to it.
   */
  private async callTool(
    call: ToolCall,
    tools: GenerationTools,
    owner: AgentRow | null,
    reads: ReadRow[],
  ): Promise<ToolRecord> {
    const { run, hooks, connections, secrets } = tools;
    const name = call.function.name;
    const offered = run.offered_tools === null || run.offered_tools.has(name) || name in run.dynamic_tools;
    const target = connections.get(name);
    if (offered && target !== undefined) {
      return this.callConnectionTool(call, target, owner, secrets);
    }
    const [payload, metadata] = await invokeTool(this.services.tools, run, hooks, call);
    const step = repeatedReadStep(reads, metadata);
    if (step === null) {
      return [payload, metadata];
    }
    const [content, pipeline] = processOutput(
      repeatedReadText(metadata, step),
      identityOutput,
      secrets,
      toolResultMaxBytes(),
    );
    return [
      { ...payload, content },
      { ...metadata, ...pipeline, repeat_of: step },
    ];
  }

  /** Calls `remoteName` on the connection; a failure is the call's result, as the model reads it, and is logged. */
  private async callConnectionTool(
    call: ToolCall,
    target: ConnectionTarget,
    owner: AgentRow | null,
    secrets: Record<string, string>,
  ): Promise<ToolRecord> {
    const name = call.function.name;
    const callId = call.id;
    const started = performance.now();
    const answer = await this.askConnection(call, target, owner);
    if (!answer.ok) {
      logOperationFailure(answer.failure, "warn");
    }
    const raw = answer.ok ? answer.text : `ERROR: ${answer.failure.message}`;
    const [content, pipeline] = processOutput(raw, identityOutput, secrets, toolResultMaxBytes());
    const error = pipeline.error || (answer.ok ? null : answer.failure.message);
    return [
      { role: "tool", tool_call_id: callId, content },
      {
        tool_name: name,
        tool_call_id: callId,
        duration_ms: Math.trunc(performance.now() - started),
        output_filter: "identity",
        truncated: pipeline.truncated,
        original_bytes: pipeline.original_bytes,
        stored_bytes: pipeline.stored_bytes,
        error,
      },
    ];
  }

  /** What the connection answers the call with, or the failure of a call that did not go through. */
  private async askConnection(
    call: ToolCall,
    [connectionId, remoteName]: ConnectionTarget,
    owner: AgentRow | null,
  ): Promise<ConnectionAnswer> {
    const { mcp, machines } = this.services;
    try {
      const text = await callTool(mcp, {
        connectionId,
        tool: remoteName,
        arguments: parseArguments(call),
        caller: { orgId: owner?.org_id ?? null, workspaceDir: await machines.agentWorkspace(owner) },
      });
      return { ok: true, text };
    } catch (error) {
      return {
        ok: false,
        failure: { message: errorMessage(error), fields: { operation: `tool.${call.function.name}`, run_id: call.id }, error },
      };
    }
  }
}
