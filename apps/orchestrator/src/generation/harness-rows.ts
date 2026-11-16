import type {
  AssistantMessage,
  CompletionMetadata,
  Harness,
  HarnessMessageMetadata,
  TokenUsage,
  ToolCall,
  ToolMessage,
  ToolResultMetadata,
} from "../db/schema/index.js";
import { HARNESS_MCP_TOOL_PREFIX, type TurnHarness } from "../coding/harnesses.js";
import type { JsonObject } from "../lib/json.js";
import { redact } from "../secrets/index.js";
import { identityOutput, processOutput, toolResultMaxBytes } from "../toolbox/index.js";
import {
  parseClaudeCodeEvents,
  type ClaudeCodeMessage,
  type ClaudeCodeToolUse,
} from "./parse-claude-code.js";
import { parseCodexEvents, type CodexToolItem } from "./parse-codex.js";
import { interruptionRecord } from "./tool-calls.js";

// The rows a subscription agent's run keeps of its harness's events: each message the harness
// writes, and each call of the harness's own tools with its result, in the shapes a model's
// messages and tool calls take, marked as the harness's, and the tokens its turn spent, kept on the
// turn's reply as a model call's are on its message. A call of a tool of the orchestrator's MCP
// server is kept as a tool call of the run where the server runs it, so its events make no row.

/** What a result row holds when the harness's tool returned something other than text. */
export const NOT_TEXT_OUTPUT = "(the tool returned no text)";

/** A call of a harness's own tool's result, as the run keeps it: the message, and the call's metadata marked as the harness's. */
export type HarnessToolRecord = [ToolMessage, ToolResultMetadata & HarnessMessageMetadata];

/** What one of a harness's own tools returned for the call `tool_use_id` names; `output` is null when it is not text. */
export type HarnessToolResult = { harness: Harness; tool_use_id: string; output: string | null };

/** The result of a call of a harness's own tool, with the call itself when the log did not announce it before its result. */
export type HarnessResultStep = { kind: "result"; result: HarnessToolResult; call: ToolCall | null };

/**
 * The tokens the harness reported at its turn's end: the turn's own, or its session's over every
 * turn of it, of which the turn's are what the run has not kept yet.
 */
export type HarnessUsageStep = { kind: "turn_usage"; usage: TokenUsage } | { kind: "session_usage"; usage: TokenUsage };

/**
 * What an event of a harness's log makes of the run's rows: a message of the harness's, redacted,
 * whose calls of its own tools wait for their results; the result of such a call; or the tokens
 * its turn spent.
 */
export type HarnessTurnStep = { kind: "message"; payload: AssistantMessage } | HarnessResultStep | HarnessUsageStep;

/** Whether `harness` called one of its own tools, named `name` to its model, rather than one of the orchestrator's MCP server. */
function isHarnessOwnTool(harness: TurnHarness, name: string): boolean {
  return !name.startsWith(HARNESS_MCP_TOOL_PREFIX[harness]);
}

/** A call of one of Claude Code's own tools, as a tool call of the run, its input redacted with `secrets`. */
function claudeCodeToolCall(use: ClaudeCodeToolUse, secrets: Record<string, string>): ToolCall {
  return {
    id: use.id,
    type: "function",
    function: { name: use.name, arguments: redact(JSON.stringify(use.input), secrets) },
  };
}

/**
 * The assistant message a message of Claude Code's makes: its text, redacted with `secrets`, and
 * its calls of its own tools; null for a message with neither. Its calls of the orchestrator's
 * MCP server's tools are left out.
 */
export function claudeCodeAssistantMessage(
  message: ClaudeCodeMessage,
  secrets: Record<string, string>,
): AssistantMessage | null {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  const calls = message.content.flatMap((block) =>
    block.type === "tool_use" && isHarnessOwnTool("claude-code", block.name) ? [claudeCodeToolCall(block, secrets)] : [],
  );
  if (!text.trim() && !calls.length) {
    return null;
  }
  const payload: AssistantMessage = { role: "assistant", content: redact(text, secrets) };
  return calls.length ? { ...payload, tool_calls: calls } : payload;
}

/**
 * The steps Claude Code's `stream-json` lines in `raw` make, in order, redacted with `secrets`:
 * each message with text or calls of its own tools, each result its tools returned, and the tokens
 * of its invocation, the turn's own. A result names only its call, which its message announced.
 */
export function claudeCodeTurnSteps(raw: string, secrets: Record<string, string>): HarnessTurnStep[] {
  return parseClaudeCodeEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "user") {
      return event.results.map((result) => ({ kind: "result", result: { harness: "claude-code", ...result }, call: null }));
    }
    if (event.type === "result") {
      return [{ kind: "turn_usage", usage: event.usage }];
    }
    const payload = claudeCodeAssistantMessage(event, secrets);
    return payload === null ? [] : [{ kind: "message", payload }];
  });
}

/** A call of one of Codex's tools as the run keeps it: the tool's name and the call's input. */
type CodexToolUse = { name: string; input: JsonObject };

/**
 * The call of one of Codex's tools its item reports: a shell command, a patch's changes, a web
 * search, or a call of an MCP server's tool under the name Codex gives its model,
 * `mcp__<server>__<tool>`.
 */
function codexToolUse(item: CodexToolItem): CodexToolUse {
  switch (item.type) {
    case "command_execution":
      return { name: item.type, input: { command: item.command } };
    case "file_change":
      return { name: item.type, input: { changes: item.changes } };
    case "web_search":
      return { name: item.type, input: { query: item.query } };
    case "mcp_tool_call":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
  }
}

/** What a call of one of Codex's tools returned, as its completed item reports it; null when it reports no text. */
function codexToolOutput(item: CodexToolItem): string | null {
  switch (item.type) {
    case "command_execution":
      return item.aggregated_output ?? null;
    case "file_change":
      return item.changes.map((change) => `${change.kind ?? "change"} ${change.path}`).join("\n");
    case "web_search":
      return null;
    case "mcp_tool_call":
      return item.error?.message ?? item.result?.content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ?? null;
  }
}

/**
 * The steps Codex's `--json` lines in `raw` make, in order, redacted with `secrets`: each message
 * with text, each call of one of its own tools, when it starts and with its result when it
 * completes, and the tokens of its thread, the session's. Codex numbers its items afresh on each
 * turn, so a call's id is the item's under `turnId`, the turn's call id.
 */
export function codexTurnSteps(raw: string, secrets: Record<string, string>, turnId: string): HarnessTurnStep[] {
  return parseCodexEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "message") {
      return event.text.trim() ? [{ kind: "message", payload: { role: "assistant", content: redact(event.text, secrets) } }] : [];
    }
    if (event.type === "thread_usage") {
      return [{ kind: "session_usage", usage: event.usage }];
    }
    const use = codexToolUse(event.item);
    if (!isHarnessOwnTool("codex", use.name)) {
      return [];
    }
    const call: ToolCall = {
      id: `${turnId}.${event.item.id}`,
      type: "function",
      function: { name: use.name, arguments: redact(JSON.stringify(use.input), secrets) },
    };
    if (event.type === "tool_started") {
      return [{ kind: "message", payload: { role: "assistant", content: "", tool_calls: [call] } }];
    }
    return [{ kind: "result", result: { harness: "codex", tool_use_id: call.id, output: codexToolOutput(event.item) }, call }];
  });
}

/**
 * The steps each harness that runs a subscription agent's turns makes of the raw lines of its log,
 * redacted with the turn's secrets, under the turn's call id.
 */
export const HARNESS_TURN_STEPS: Record<
  TurnHarness,
  (raw: string, secrets: Record<string, string>, turnId: string) => HarnessTurnStep[]
> = {
  "claude-code": claudeCodeTurnSteps,
  codex: codexTurnSteps,
};

/** The tokens of `usages` together; cache writes only when one of them reports them. */
function totalUsage(usages: readonly TokenUsage[]): TokenUsage {
  const total: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  for (const usage of usages) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_read_tokens += usage.cache_read_tokens;
    if (usage.cache_write_tokens !== undefined) {
      total.cache_write_tokens = (total.cache_write_tokens ?? 0) + usage.cache_write_tokens;
    }
  }
  return total;
}

/**
 * The tokens of a session's latest turn: what its total `session` spent past the turns the run
 * kept, `kept`. A total below what the run kept is a new session's, all of it the turn's.
 */
export function sessionTurnUsage(session: TokenUsage, kept: readonly TokenUsage[]): TokenUsage {
  const before = totalUsage(kept);
  if (
    session.input_tokens < before.input_tokens ||
    session.output_tokens < before.output_tokens ||
    session.cache_read_tokens < before.cache_read_tokens
  ) {
    return session;
  }
  const turn: TokenUsage = {
    input_tokens: session.input_tokens - before.input_tokens,
    output_tokens: session.output_tokens - before.output_tokens,
    cache_read_tokens: session.cache_read_tokens - before.cache_read_tokens,
  };
  if (session.cache_write_tokens !== undefined) {
    turn.cache_write_tokens = Math.max(0, session.cache_write_tokens - (before.cache_write_tokens ?? 0));
  }
  return turn;
}

/**
 * What a harness turn's reply records of the tokens the turn spent, as a model call's message does:
 * the tokens, and no price, since the turn ran on the operator's subscription.
 */
export function subscriptionUsageRecord(usage: TokenUsage): Pick<CompletionMetadata, "usage" | "cost_usd" | "cost_source"> {
  return { usage, cost_usd: 0, cost_source: "subscription" };
}

/**
 * The row of `result`, the result of `call`, a call of one of its harness's own tools that took
 * `durationMs`: its output redacted with `secrets` and capped as a tool's output is.
 */
export function harnessToolRecord(
  result: HarnessToolResult,
  call: ToolCall,
  durationMs: number,
  secrets: Record<string, string>,
): HarnessToolRecord {
  const [content, output] = processOutput(
    result.output ?? NOT_TEXT_OUTPUT,
    identityOutput,
    secrets,
    toolResultMaxBytes(),
  );
  return [
    { role: "tool", tool_call_id: call.id, content },
    {
      tool_name: call.function.name,
      tool_call_id: call.id,
      duration_ms: durationMs,
      output_filter: "identity",
      ...output,
      from_harness: result.harness,
    },
  ];
}

/**
 * The result a call of `harness`'s own tool gets when the turn ended before the tool returned:
 * the interrupted result of generation `generation`, marked as the harness's.
 */
export function interruptedHarnessToolRecord(
  call: ToolCall,
  generation: number,
  harness: Harness,
): [ToolMessage, HarnessToolRecord[1] & { generation: number }] {
  const [payload, metadata] = interruptionRecord(call, generation);
  return [payload, { ...metadata, from_harness: harness }];
}
