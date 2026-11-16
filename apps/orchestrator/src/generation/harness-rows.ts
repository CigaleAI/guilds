import type {
  AssistantMessage,
  Harness,
  HarnessMessageMetadata,
  ToolCall,
  ToolMessage,
  ToolResultMetadata,
} from "../db/schema/index.js";
import { HARNESS_MCP_TOOL_PREFIX, type TurnHarness } from "../coding/harnesses.js";
import { redact } from "../secrets/index.js";
import { identityOutput, processOutput, toolResultMaxBytes } from "../toolbox/index.js";
import {
  parseClaudeCodeEvents,
  type ClaudeCodeMessage,
  type ClaudeCodeToolUse,
} from "./parse-claude-code.js";
import { interruptionRecord } from "./tool-calls.js";

// The rows a subscription agent's run keeps of its harness's events: each message the harness
// writes, and each call of the harness's own tools with its result, in the shapes a model's
// messages and tool calls take, marked as the harness's. A call of a tool of the orchestrator's
// MCP server is kept as a tool call of the run where the server runs it, so its events make no row.

/** What a result row holds when the harness's tool returned something other than text. */
export const NOT_TEXT_OUTPUT = "(the tool returned no text)";

/** A call of a harness's own tool's result, as the run keeps it: the message, and the call's metadata marked as the harness's. */
export type HarnessToolRecord = [ToolMessage, ToolResultMetadata & HarnessMessageMetadata];

/** What one of a harness's own tools returned for the call `tool_use_id` names; `output` is null when it is not text. */
export type HarnessToolResult = { harness: Harness; tool_use_id: string; output: string | null };

/** The result of a call of a harness's own tool, with the call itself when the log did not announce it before its result. */
export type HarnessResultStep = { kind: "result"; result: HarnessToolResult; call: ToolCall | null };

/**
 * What an event of a harness's log makes of the run's rows: a message of the harness's, redacted,
 * whose calls of its own tools wait for their results; or the result of such a call.
 */
export type HarnessTurnStep = { kind: "message"; payload: AssistantMessage } | HarnessResultStep;

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
 * each message with text or calls of its own tools, and each result its tools returned. A result
 * names only its call, which its message announced.
 */
export function claudeCodeTurnSteps(raw: string, secrets: Record<string, string>): HarnessTurnStep[] {
  return parseClaudeCodeEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "user") {
      return event.results.map((result) => ({ kind: "result", result: { harness: "claude-code", ...result }, call: null }));
    }
    const payload = claudeCodeAssistantMessage(event, secrets);
    return payload === null ? [] : [{ kind: "message", payload }];
  });
}

/** The steps each harness that runs a subscription agent's turns makes of the raw lines of its log. */
export const HARNESS_TURN_STEPS: Record<TurnHarness, (raw: string, secrets: Record<string, string>) => HarnessTurnStep[]> = {
  "claude-code": claudeCodeTurnSteps,
};

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
