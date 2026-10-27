import { DEFAULT_MAX_TOOL_CALLS } from "../agents/validation.js";
import { getMcpServer } from "../connectors/servers.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { isPlainRecord, recordOf } from "../db/json.js";
import { getMcpConnection } from "../db/mcp.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { getRun, listMessages, type RunRow } from "../db/runs.js";
import type { Harness } from "../db/schema/index.js";
import { McpDisconnectedError, McpError, mcpDatabase } from "../mcp/index.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import { callSegment, repeatedReadStep, repeatedReadText } from "../toolbox/code.js";
import {
  identityOutput,
  invokeTool,
  parseArguments,
  processOutput,
  remainingAfter,
  stampToolResult,
  toolResultMaxBytes,
  type ToolContext,
} from "../toolbox/index.js";
import type { ActiveGenerations } from "./admission.js";
import type { CodingRuns } from "./coding.js";
import { GenerationCancelled } from "./errors.js";
import type { RunEvents, RunGeneration } from "./events.js";
import type { AgentMachines } from "./machines.js";
import type { ConnectorPool } from "./prepare.js";
import { positiveInt } from "./snapshot.js";

/** The tool calls of a run's history: which are pending, how many ran, and the record of an interrupted one. */

export const INTERRUPTED_CONTENT = "ERROR: execution interrupted";

/** A `code_task` call the orchestrator lost track of when it restarted. */
export type LostCodeTask = {
  harness: Harness;
  repository: string | null;
  session_id: string | null;
  log_path: string | null;
  run_id: string;
  call_id: string;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function callArguments(call: Record<string, unknown>): Record<string, unknown> {
  try {
    return parseArguments(call);
  } catch {
    return {};
  }
}

/** A lost `code_task` call, from what its run remembered about it and from the call's own arguments. */
export function lostCodeTask(
  run: Pick<RunRow, "id" | "metadata">,
  call: Record<string, unknown>,
  harness: Harness,
): LostCodeTask {
  const callId = callSegment(String(call.id ?? ""));
  const remembered = recordOf(run.metadata.harness_task);
  const known = remembered.call_id === callId ? remembered : {};
  const args = callArguments(call);
  return {
    harness,
    repository: optionalText(known.repository) ?? optionalText(args.repo),
    session_id: optionalText(known.session_id) ?? optionalText(args.session_id),
    log_path: optionalText(known.log_path),
    run_id: run.id,
    call_id: callId,
  };
}

export function toolCallsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls = payload.tool_calls;
  return Array.isArray(calls) ? calls.filter(isPlainRecord) : [];
}

export function executedToolCalls(rows: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const row of rows) {
    if (recordOf(row.payload).role === "tool") {
      total += 1;
    }
  }
  return total;
}

function assistantCallId(call: Record<string, unknown>): string | null {
  return typeof call.id === "string" && call.id ? call.id : null;
}

function rememberPendingAssistantCalls(
  pending: Map<string, [Record<string, unknown>, number]>,
  order: string[],
  payload: Record<string, unknown>,
  generation: number,
): void {
  for (const call of toolCallsOf(payload)) {
    const callId = assistantCallId(call);
    if (!callId) {
      continue;
    }
    if (!pending.has(callId)) {
      order.push(callId);
    }
    pending.set(callId, [call, generation]);
  }
}

function forgetResolvedToolCall(
  pending: Map<string, [Record<string, unknown>, number]>,
  order: string[],
  payload: Record<string, unknown>,
): void {
  const callId = payload.tool_call_id;
  if (typeof callId !== "string") {
    return;
  }
  pending.delete(callId);
  const index = order.indexOf(callId);
  if (index >= 0) {
    order.splice(index, 1);
  }
}

export function pendingToolCalls(
  rows: Array<Record<string, unknown>>,
): Array<[Record<string, unknown>, number]> {
  const pending = new Map<string, [Record<string, unknown>, number]>();
  const order: string[] = [];
  for (const row of rows) {
    const payload = recordOf(row.payload);
    const generation = Number(recordOf(row.metadata).generation || 1);
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

export function toolCallNameAndId(call: Record<string, unknown>): { name: string; callId: string } {
  const fn = recordOf(call.function);
  return {
    name: typeof fn.name === "string" ? fn.name : "",
    callId: typeof call.id === "string" ? call.id : "",
  };
}

/** A tool call's result as a run keeps it: the message the model reads, and its metadata. */
export type ToolRecord = [Record<string, unknown>, Record<string, unknown>];

export function interruptionRecord(
  call: Record<string, unknown>,
  generation: number,
): [Record<string, unknown>, Record<string, unknown>] {
  const { name, callId } = toolCallNameAndId(call);
  const payload = {
    role: "tool",
    tool_call_id: callId,
    content: INTERRUPTED_CONTENT,
  };
  const metadata: Record<string, unknown> = {
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

/** The db/ functions tool calls read the run and call connections through, on `db`. */
export function toolCallsDatabase(db: Queryable) {
  return {
    ...mcpDatabase(db),
    getAgent: bindQuery(db, getAgent),
    getRun: bindQuery(db, getRun),
    listMessages: bindQuery(db, listMessages),
    getMcpConnection: bindQuery(db, getMcpConnection),
    getMcpServer: bindQuery(db, getMcpServer),
  };
}

export type ToolCallsDatabase = ReturnType<typeof toolCallsDatabase>;

/**
 * The tools a generation calls: their context, the schemas the model is offered, the values
 * their results are redacted with, the connection tools by name, and the run's tool budget.
 */
export type GenerationTools = {
  ctx: ToolContext;
  schemas: unknown[];
  secrets: Record<string, string>;
  connections: Record<string, [string, string]>;
  maxToolCalls: number;
};

/** What tool calls are made with, built once by the loop. */
export type ToolCallsServices = {
  db: ToolCallsDatabase;
  mcp: ConnectorPool;
  events: RunEvents;
  generations: ActiveGenerations;
  machines: AgentMachines;
  coding: CodingRuns;
};

/**
 * The tool calls of a loop's runs: each one the model makes, run in order and kept with the
 * budget it leaves, and each one a stopped generation left without a result.
 */
export class ToolCalls {
  constructor(private readonly services: ToolCallsServices) {}

  /** Runs the model's calls in order, each result kept as it comes; a cancel stops before the next one. */
  async execute(turn: RunGeneration, tools: GenerationTools, calls: Array<Record<string, unknown>>): Promise<void> {
    const { db, events, generations } = this.services;
    const history = await db.listMessages(turn.runId);
    let executed = executedToolCalls(history);
    const owner = await db.getAgent(tools.ctx.agent_id);
    const reads = history
      .filter((row) => recordOf(row.payload).role === "tool")
      .map((row) => ({ seq: row.seq, metadata: recordOf(row.metadata) }));
    for (const call of calls) {
      if (generations.isCancelled(turn.runId)) {
        throw new GenerationCancelled();
      }
      executed += 1;
      const [payload, metadata] = stampToolResult(
        ...(await this.callTool(call, tools, owner, reads)),
        remainingAfter(tools.maxToolCalls, executed),
      );
      const row = await events.commitMessage(turn.runId, payload, { generation: turn.generation, ...metadata });
      reads.push({ seq: row.seq, metadata });
    }
  }

  /**
   * Gives each call of the run's history that has no result the interrupted result, numbered
   * `generation` or its own; a lost `code_task` is stopped on its machine. Returns how many.
   */
  async resolveUnresolved(runId: string, generation: number | null): Promise<number> {
    const { db, events, coding } = this.services;
    const rows = await db.listMessages(runId);
    const pending = pendingToolCalls(rows);
    const run = await db.getRun(runId);
    const maxToolCalls = positiveInt(run?.config_snapshot.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
    let executed = executedToolCalls(rows);
    for (const [call, callGeneration] of pending) {
      let record = interruptionRecord(call, generation ?? callGeneration);
      if (record[1].tool_name === "code_task" && run) {
        record = await coding.interruptedCodeTask(run, call, record);
      }
      executed += 1;
      const [payload, metadata] = stampToolResult(...record, remainingAfter(maxToolCalls, executed));
      await events.commitMessage(runId, payload, metadata);
    }
    return pending.length;
  }

  /**
   * One call's result: from its connection when the run offers it as a connection tool, else
   * from the native tool, where a read of a range unchanged since an earlier read points to it.
   */
  private async callTool(
    call: Record<string, unknown>,
    tools: GenerationTools,
    owner: AgentRow | null,
    reads: Array<{ seq: number; metadata: Record<string, unknown> }>,
  ): Promise<ToolRecord> {
    const { ctx, connections, secrets } = tools;
    const { name } = toolCallNameAndId(call);
    const offered = ctx.offered_tools === null || ctx.offered_tools.has(name) || name in ctx.dynamic_tools;
    const target = Object.hasOwn(connections, name) ? connections[name] : undefined;
    if (offered && target !== undefined) {
      return this.callConnectionTool(call, target, owner, secrets);
    }
    const maxBytes = toolResultMaxBytes();
    const [payload, metadata] = await invokeTool(ctx, call, secrets, maxBytes);
    const step = repeatedReadStep(reads, metadata);
    if (step === null) {
      return [payload, metadata];
    }
    const [content, pipeline] = processOutput(repeatedReadText(metadata, step), identityOutput, secrets, maxBytes);
    return [
      { ...payload, content },
      { ...metadata, ...pipeline, repeat_of: step },
    ];
  }

  /** Calls `remoteName` on the connection; a failure is the call's result, as the model reads it. */
  private async callConnectionTool(
    call: Record<string, unknown>,
    [connectionId, remoteName]: [string, string],
    owner: AgentRow | null,
    secrets: Record<string, string>,
  ): Promise<ToolRecord> {
    const { db, mcp, machines } = this.services;
    const { name, callId } = toolCallNameAndId(call);
    const started = performance.now();
    let error: string | null = null;
    let raw: string;
    try {
      const connection = await db.getMcpConnection(connectionId);
      if (connection === null) {
        throw new McpDisconnectedError("connection not found");
      }
      const server = await db.getMcpServer(connection.mcp_server_id);
      if (server === null) {
        throw new McpError("mcp server not found");
      }
      raw = await mcp.call(db, connection, server, remoteName, parseArguments(call), {
        workspaceDir: await machines.agentWorkspace(owner),
        ...(owner?.org_id ? { orgId: owner.org_id } : {}),
      });
    } catch (caught) {
      writeLog("warn", errorMessage(caught), {
        operation: `tool.${name}`,
        run_id: callId,
        error_type: errorName(caught),
      });
      raw = `ERROR: ${errorMessage(caught)}`;
      error = errorMessage(caught);
    }
    const [content, pipeline] = processOutput(raw, identityOutput, secrets, toolResultMaxBytes());
    if (typeof pipeline.error === "string" && pipeline.error) {
      error = pipeline.error;
    }
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
}
