import { Type, type Static } from "typebox";
import type { TokenUsage } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, JsonObjectSchema } from "../lib/json.js";

// Claude Code's `stream-json` events, as its driver logs them in `runtime/guilds-harness`: each
// line one event. A subscription agent's run keeps two kinds as rows, an assistant message and
// the results of its tools, and reads the tokens the invocation spent from its `result`, and
// those of each model call from the message it returned; every other event, and every block of
// another shape, is dropped.

const TextBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ToolUseBlock = Type.Object({
  type: Type.Literal("tool_use"),
  id: Type.String(),
  name: Type.String(),
  input: JsonObjectSchema,
});
const ToolResultBlock = Type.Object({
  type: Type.Literal("tool_result"),
  tool_use_id: Type.String(),
  content: Type.Optional(Type.Unknown()),
  is_error: Type.Optional(Type.Boolean()),
});

/** The model call a message names: its id. */
const ModelCall = Type.Object({ id: Type.String() });

/** The tokens a `result` event, or a model call's message, reports, which Anthropic counts apart from the cache's. */
const ReportedUsage = Type.Object({
  input_tokens: Type.Number(),
  output_tokens: Type.Number(),
  cache_read_input_tokens: Type.Optional(Type.Number()),
  cache_creation_input_tokens: Type.Optional(Type.Number()),
});

/** A piece of text in a message of Claude Code's. */
export type ClaudeCodeText = Static<typeof TextBlock>;

/** A call Claude Code made of one of its own tools: its id, the tool, and its input. */
export type ClaudeCodeToolUse = Static<typeof ToolUseBlock>;

/**
 * What one of Claude Code's tools returned for the call `tool_use_id` names, and whether Claude
 * Code reports it failed; `output` is null when it is not text.
 */
export type ClaudeCodeToolResult = { tool_use_id: string; output: string | null; is_error: boolean };

/**
 * A message Claude Code wrote: its text and its calls of its own tools, in order, and the model
 * call that returned it, by its id, with the tokens it spent; each null when the event names none.
 * Claude Code writes each block of a model call's message as an event of its own, each with the
 * call's id and its tokens.
 */
export type ClaudeCodeMessage = {
  type: "assistant";
  content: Array<ClaudeCodeText | ClaudeCodeToolUse>;
  model_call: string | null;
  usage: TokenUsage | null;
};

/** The results of Claude Code's tools, which it hands back to its model as a user turn. */
export type ClaudeCodeToolResults = { type: "user"; results: ClaudeCodeToolResult[] };

/** The end of a Claude Code invocation: the tokens it spent, over every model call it made. */
export type ClaudeCodeResult = { type: "result"; usage: TokenUsage };

/** An event of Claude Code's that a run keeps as rows, or reads its turn's usage from. */
export type ClaudeCodeEvent = ClaudeCodeMessage | ClaudeCodeToolResults | ClaudeCodeResult;

/** The blocks of an event's `message.content`; none when the event carries no list there. */
function contentBlocks(event: unknown): unknown[] {
  const message = isJsonObject(event) ? event.message : undefined;
  const content = isJsonObject(message) ? message.content : undefined;
  return Array.isArray(content) ? content : [];
}

function messageBlock(block: unknown): ClaudeCodeText | ClaudeCodeToolUse | null {
  if (!isJsonObject(block)) {
    return null;
  }
  return keepMatching(TextBlock, block) ?? keepMatching(ToolUseBlock, block);
}

function toolResult(block: unknown): ClaudeCodeToolResult | null {
  const result = isJsonObject(block) ? keepMatching(ToolResultBlock, block) : null;
  if (result === null) {
    return null;
  }
  return {
    tool_use_id: result.tool_use_id,
    output: typeof result.content === "string" ? result.content : null,
    is_error: result.is_error === true,
  };
}

/**
 * The tokens of a `usage` a `result` event or a model call's message reports, its input counted
 * with the cache's reads and writes; null when it reports none.
 */
function reportedUsage(reported: unknown): TokenUsage | null {
  const usage = isJsonObject(reported) ? keepMatching(ReportedUsage, reported) : null;
  if (usage === null) {
    return null;
  }
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens;
  return {
    input_tokens: usage.input_tokens + read + (written ?? 0),
    output_tokens: usage.output_tokens,
    cache_read_tokens: read,
    ...(written === undefined ? {} : { cache_write_tokens: written }),
  };
}

/** The event one line of the log holds; null for a line that is not JSON or an event the run keeps no row of. */
function parseEvent(line: string): ClaudeCodeEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonObject(event)) {
    return null;
  }
  const kind = event.type;
  if (kind === "assistant") {
    const message = isJsonObject(event.message) ? event.message : {};
    return {
      type: "assistant",
      content: contentBlocks(event).flatMap((block) => messageBlock(block) ?? []),
      model_call: keepMatching(ModelCall, message)?.id ?? null,
      usage: reportedUsage(message.usage),
    };
  }
  if (kind === "user") {
    return {
      type: "user",
      results: contentBlocks(event).flatMap((block) => toolResult(block) ?? []),
    };
  }
  const usage = kind === "result" ? reportedUsage(event.usage) : null;
  return usage === null ? null : { type: "result", usage };
}

/** The events of Claude Code's `stream-json` lines in `raw` that a run keeps as rows or reads its usage from, in order. */
export function parseClaudeCodeEvents(raw: string): ClaudeCodeEvent[] {
  return raw.split("\n").flatMap((line) => (line.trim() ? (parseEvent(line) ?? []) : []));
}
